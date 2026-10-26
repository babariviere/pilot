//! Packaged-only startup. Blocking validation is called exclusively on the startup worker.
//! Integrity hashes are not publisher authentication. Production update trust remains separate.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;

const CAP: u64 = 8 * 1024 * 1024;
const FILES: usize = 30_000;
const TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MANIFEST: &str = "Contents/Resources/bundled-runtime.json";
type Failure = &'static str;
#[cfg(target_os = "macos")]
static UPDATE_RECEIPT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
#[cfg(target_os = "macos")]
pub fn set_update_receipt(path: PathBuf) -> Result<(), Failure> {
    if !path.is_absolute() {
        return Err("Update startup receipt must be an absolute transaction path.");
    }
    UPDATE_RECEIPT
        .set(path)
        .map_err(|_| "Update startup receipt was already set.")
}
#[cfg(target_os = "macos")]
pub(crate) fn update_receipt() -> Option<PathBuf> {
    UPDATE_RECEIPT.get().cloned()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    kind: String,
    build: Build,
    files: Vec<Entry>,
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Build {
    schema: u32,
    source: String,
    version: String,
    protocol: u32,
    platform: String,
    arch: String,
    node: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Entry {
    #[serde(rename = "file")]
    File {
        path: String,
        bytes: u64,
        mode: u32,
        sha256: String,
    },
    #[serde(rename = "directory")]
    Directory { path: String, mode: u32 },
    #[serde(rename = "link")]
    Link { path: String, target: String },
}
impl Entry {
    fn path(&self) -> &str {
        match self {
            Self::File { path, .. } | Self::Directory { path, .. } | Self::Link { path, .. } => {
                path
            }
        }
    }
}

/// A bundle-shaped launch must fail visibly if damaged, never silently become a fixture.
pub fn packaged(executable: &Path) -> bool {
    executable.parent().is_some_and(|p| {
        p.file_name().is_some_and(|n| n == "MacOS")
            && p.parent()
                .is_some_and(|p| p.file_name().is_some_and(|n| n == "Contents"))
    })
}
/// Explicit external/fixture/help modes never start a bundled daemon, even inside an app.
pub fn requested(args: &[String], executable: &Path) -> bool {
    args == ["--bundled"] || (args.is_empty() && packaged(executable))
}
fn relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\0')
        && value.len() <= 4096
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && !value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}
fn check(cancel: &AtomicBool, deadline: Instant) -> Result<(), Failure> {
    if cancel.load(Ordering::Relaxed) {
        Err("Runtime startup canceled. An activated daemon is left running to preserve work.")
    } else if Instant::now() >= deadline {
        Err(
            "Runtime startup timed out. An activated daemon may still be starting; no existing process was stopped.",
        )
    } else {
        Ok(())
    }
}
fn file(path: &Path, cap: u64) -> Result<File, Failure> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "Bundled runtime resource is missing or unsafe.")?;
    let info = file
        .metadata()
        .map_err(|_| "Cannot inspect bundled runtime.")?;
    if !info.is_file() || info.len() > cap || info.nlink() != 1 {
        return Err("Bundled runtime resource exceeds policy.");
    }
    Ok(file)
}
fn enumerate(
    root: &Path,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<BTreeSet<String>, Failure> {
    let mut directories = vec![root.to_path_buf()];
    let mut paths = BTreeSet::new();
    while let Some(directory) = directories.pop() {
        check(cancel, deadline)?;
        for entry in fs::read_dir(directory).map_err(|_| "Cannot inspect bundle inventory.")? {
            let entry = entry.map_err(|_| "Cannot inspect bundle entry.")?;
            let path = entry.path();
            let name = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or("Invalid bundle path.")?;
            if name == "Contents/_CodeSignature" || name.starts_with("Contents/_CodeSignature/") {
                continue;
            }
            if name != MANIFEST && name != "Contents/MacOS/pilot-desktop" {
                paths.insert(name.to_string());
            }
            if paths.len() > FILES {
                return Err("Bundle has too many entries.");
            }
            if entry
                .file_type()
                .map_err(|_| "Cannot inspect bundle entry.")?
                .is_dir()
            {
                directories.push(path);
            }
        }
    }
    Ok(paths)
}
fn validate(root: &Path, cancel: &AtomicBool, deadline: Instant) -> Result<(), Failure> {
    let root = root
        .canonicalize()
        .map_err(|_| "Cannot locate app bundle.")?;
    let mut raw = Vec::new();
    file(&root.join(MANIFEST), CAP)?
        .take(CAP + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "Cannot read bundled runtime manifest.")?;
    if raw.len() as u64 > CAP {
        return Err("Bundled runtime manifest is too large.");
    }
    let manifest: Manifest =
        serde_json::from_slice(&raw).map_err(|_| "Bundled runtime manifest is malformed.")?;
    let build = &manifest.build;
    if manifest.schema != 1
        || manifest.kind != "development-bundled-runtime"
        || build.schema != 1
        || build.source.len() != 40
        || !build
            .source
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || build.platform != "darwin"
        || build.arch != "arm64"
        || build.protocol != 1
        || !build.node.starts_with("24.")
        || !version(&build.node)
        || !version(&build.version)
        || manifest.files.len() > FILES
    {
        return Err("Bundled runtime platform/version is incompatible.");
    }
    let mut stamp = Vec::new();
    file(
        &root.join("Contents/Resources/runtime/runtime-build.json"),
        4096,
    )?
    .take(4097)
    .read_to_end(&mut stamp)
    .map_err(|_| "Cannot read runtime build identity.")?;
    if serde_json::from_slice::<Build>(&stamp).ok().as_ref() != Some(build) {
        return Err("Runtime manifest/build identity mismatch.");
    }
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for entry in manifest.files {
        check(cancel, deadline)?;
        let name = entry.path();
        if !relative(name) || !paths.insert(name.to_owned()) {
            return Err("Invalid or duplicate bundled runtime path.");
        }
        let path = root.join(name);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "Bundled runtime resource is missing.")?;
        if !metadata.file_type().is_symlink() && metadata.permissions().mode() & 0o6022 != 0 {
            return Err("Unsafe bundle permissions.");
        }
        match entry {
            Entry::Directory { mode, .. } => {
                if !metadata.is_dir() || metadata.permissions().mode() & 0o7777 != mode {
                    return Err("Bundle directory changed.");
                }
            }
            Entry::Link { target, .. } => {
                if !metadata.file_type().is_symlink()
                    || fs::read_link(&path).ok().as_deref() != Some(Path::new(&target))
                    || Path::new(&target).is_absolute()
                    || !path
                        .canonicalize()
                        .map_err(|_| "Broken runtime link.")?
                        .starts_with(&root)
                {
                    return Err("Bundled runtime link escapes its app.");
                }
            }
            Entry::File {
                bytes,
                mode,
                sha256,
                ..
            } => {
                total = total.checked_add(bytes).ok_or("Runtime size overflow.")?;
                if bytes > 256 * 1024 * 1024
                    || total > TOTAL
                    || !metadata.is_file()
                    || metadata.len() != bytes
                    || metadata.permissions().mode() & 0o7777 != mode
                {
                    return Err("Runtime resource size/type changed.");
                }
                let mut stream = file(&path, bytes)?;
                let mut hash = Sha256::new();
                let mut buffer = [0u8; 64 * 1024];
                let mut read = 0u64;
                loop {
                    check(cancel, deadline)?;
                    let count = stream
                        .read(&mut buffer)
                        .map_err(|_| "Cannot read runtime resource.")?;
                    if count == 0 {
                        break;
                    }
                    read += count as u64;
                    if read > bytes {
                        return Err("Runtime resource grew during validation.");
                    }
                    hash.update(&buffer[..count]);
                }
                if read != bytes || format!("{:x}", hash.finalize()) != sha256 {
                    return Err("Bundled runtime hash mismatch.");
                }
            }
        }
    }
    for required in [
        "Contents/Resources/runtime/node/bin/node",
        "Contents/Resources/runtime/runtime-build.json",
        "Contents/Resources/runtime/packages/daemon/src/runtime-launch.ts",
        "Contents/Resources/runtime/packages/daemon/src/main.ts",
        "Contents/MacOS/pilot-visual-worker",
        "Contents/Helpers/PilotPower",
        "Contents/Helpers/PilotSystemEvents.app/Contents/MacOS/PilotSystemEvents",
    ] {
        if !paths.contains(required) {
            return Err("Required bundled runtime resource is absent.");
        }
    }
    if paths != enumerate(&root, cancel, deadline)? {
        return Err("Bundle inventory changed.");
    }
    Ok(())
}
fn version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() < 9 && p.bytes().all(|b| b.is_ascii_digit()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    schema: u32,
    result: Option<String>,
    error: Option<String>,
    cleanup: Cleanup,
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Cleanup {
    NoOwnedChild,
    PreactivationReaped,
    ActivationPossible,
    Unconfirmed,
}
fn failure(code: &str) -> Failure {
    match code {
        "runtime_profile_unproven" => {
            "This Local profile has no safe startup proof. Nothing was moved or restarted. Use an explicitly managed compatible daemon, or explicit --local for an existing daemon."
        }
        "runtime_profile_owned" | "runtime_owner_unconfirmed" | "runtime_owner_still_starting" => {
            "Local is already owned or still starting. No competing daemon was started. Verify the existing runtime before trying again."
        }
        "runtime_incompatible" | "runtime_identity_changed" | "runtime_proof_invalid" => {
            "The existing Local runtime does not match this app's identity/version. It was not stopped or replaced."
        }
        "runtime_startup_unconfirmed" | "runtime_activation_unconfirmed" => {
            "Local startup is unconfirmed. An activated daemon may still be starting. It was left running to preserve work."
        }
        _ => {
            "The bundled runtime could not start safely. No existing daemon was stopped or replaced."
        }
    }
}

/// One bounded worker calls this; no environment mutation, shell, PATH lookup or production restart.
pub fn start(executable: PathBuf, cancel: Arc<AtomicBool>) -> Result<crate::LocalOptions, Failure> {
    let deadline = Instant::now() + Duration::from_secs(45);
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("Bundled runtime requires arm64 macOS.");
    }
    let root = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("Cannot locate bundled runtime.")?;
    validate(root, &cancel, deadline)?;
    #[cfg(target_os = "macos")]
    let pinned = if let Some(receipt) = update_receipt() {
        let trust = pilot_desktop_updater::helper::compiled_trust()
            .map_err(|_| "Update startup trust is unconfigured.")?;
        Some(pilot_desktop_updater::coordination::Guard::startup_runtime(&receipt,&root.canonicalize().map_err(|_|"Cannot resolve app bundle.")?,&trust)
            .map_err(|_|"Update startup configuration/retained-runtime proof failed. No daemon was started or update acknowledged.")?)
    } else {
        None
    };
    let runtime_root = root.to_path_buf();
    #[cfg(target_os = "macos")]
    let runtime_root = if let Some((root, _)) = &pinned {
        root.clone()
    } else if let Ok(trust) = pilot_desktop_updater::helper::compiled_trust() {
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable.")?);
        let store = home
            .join("Library/Application Support")
            .join(pilot_desktop_updater::runtime::STORE_NAME);
        let canonical = root
            .canonicalize()
            .map_err(|_| "Cannot resolve app bundle.")?;
        let capsule=pilot_desktop_updater::runtime::publish_cancellable(&canonical,&store,&trust,&pilot_desktop_updater::installer::MacPlatform,deadline,&cancel)
            .map_err(|_|"The immutable runtime capsule could not be verified/published. Existing runtimes were preserved.")?;
        let location = runtime_location()?;
        pilot_desktop_updater::coordination::selected(&location,&capsule,&trust)
            .map_err(|_|"The running daemon has no exact supported retained runtime. It was left running; startup was refused.")?
    } else {
        runtime_root
    };
    let runtime = runtime_root.join("Contents/Resources/runtime");
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable.")?;
    let mut command = tokio::process::Command::new(runtime.join("node/bin/node"));
    command
        .arg(runtime.join("packages/daemon/src/runtime-launch.ts"))
        .current_dir(&runtime)
        .env_clear()
        .env("HOME", home)
        .env(
            "PATH",
            format!(
                "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                runtime.join("node/bin").display()
            ),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    for (name, mut value) in configured_environment(|name| std::env::var_os(name)) {
        if name.ends_with("HOME") || name.ends_with("DIR") {
            if value.is_empty() {
                return Err("Configured Local path is empty; no runtime was started.");
            }
            let path = PathBuf::from(&value);
            if path.is_relative() {
                value = std::env::current_dir()
                    .map_err(|_| "Cannot resolve configured runtime path.")?
                    .join(path)
                    .into_os_string();
            }
        }
        command.env(name, value);
    }
    #[cfg(target_os = "macos")]
    if let Some((_, location)) = &pinned {
        // A relaunch receipt, not the launch-service environment, owns the exact
        // configured profile and denial policies. Never silently retarget Local.
        command
            .env("PILOT_HOME", &location.home)
            .env("PILOT_PORT", location.port.to_string());
        for name in pilot_desktop_updater::coordination::POLICY_NAMES {
            command.env_remove(name);
        }
        for (name, value) in &location.policy {
            command.env(name, value);
        }
    }
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Cannot start runtime worker.")?;
    executor.block_on(async {
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot launch bundled Node runtime.")?;
        supervise(&mut child, &cancel, deadline).await?;
        #[cfg(target_os = "macos")]
        if let Some((_, location)) = pinned {
            return crate::LocalOptions::discover_at(location);
        }
        crate::LocalOptions::discover()
    })
}
#[cfg(target_os = "macos")]
fn runtime_location() -> Result<pilot_desktop_updater::coordination::Location, Failure> {
    let port = std::env::var("PILOT_PORT")
        .unwrap_or_else(|_| "4319".into())
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or("Invalid Local port.")?;
    let home = if let Some(home) = std::env::var_os("PILOT_HOME") {
        PathBuf::from(home)
    } else {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or(
                PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable.")?)
                    .join(".local/share"),
            );
        data.join("pilot")
    };
    let home = if home.is_absolute() {
        home
    } else {
        std::env::current_dir()
            .map_err(|_| "Cannot resolve Local profile.")?
            .join(home)
    };
    Ok(pilot_desktop_updater::coordination::Location {
        home,
        port,
        policy: pilot_desktop_updater::coordination::captured_policy()
            .map_err(|_| "Configured runtime policy is invalid.")?,
    })
}

// Preserve explicit denial and retention policy without forwarding broker authority,
// Node injection, provider credentials or arbitrary PILOT_* environment variables.
fn configured_environment(
    get: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<(&'static str, std::ffi::OsString)> {
    [
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "PILOT_HOME",
        "PILOT_PORT",
        "PILOT_AGENT_DIR",
        "PILOT_MODEL_SCOPE_READ_ONLY",
        "PILOT_MCP_SETUP_READ_ONLY",
        "PILOT_IDLE_PARK_MS",
        "PILOT_WORKSPACE_RETENTION_DAYS",
        "PILOT_ENVIRONMENT_SETUP",
    ]
    .into_iter()
    .filter_map(|name| get(name).map(|value| (name, value)))
    .collect()
}
async fn receive_reply(
    reader: &mut tokio::task::JoinHandle<Result<Reply, Failure>>,
    received: &mut bool,
    wire: &mut Option<Reply>,
) -> Result<(), Failure> {
    let result = reader.await;
    *received = true;
    *wire = Some(result.map_err(|_| "Runtime result reader stopped.")??);
    Ok(())
}
async fn supervise(
    child: &mut tokio::process::Child,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(), Failure> {
    // The launcher may own a preactivation child. SIGKILL or kill-on-drop would
    // bypass its finally/reap path. Closing the lifetime pipe requests cancellation.
    let Some(output) = child.stdout.take() else {
        drop(child.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        return Err("Runtime result pipe/cleanup is unconfirmed. No existing daemon was stopped.");
    };
    let mut reader = tokio::spawn(async move {
        let mut raw = Vec::new();
        output
            .take(4097)
            .read_to_end(&mut raw)
            .await
            .map_err(|_| "Cannot read runtime startup result.")?;
        if raw.len() > 4096 {
            return Err("Runtime startup output exceeded its bound.");
        }
        serde_json::from_slice::<Reply>(&raw)
            .map_err(|_| "Runtime returned an invalid startup result.")
    });
    let mut received = false;
    let mut wire = None;
    let work = async {
        receive_reply(&mut reader, &mut received, &mut wire).await?;
        let status = child
            .wait()
            .await
            .map_err(|_| "Cannot await runtime launcher.")?;
        let reply = wire.as_ref().ok_or("Runtime result is unavailable.")?;
        if reply.schema != 1 || reply.cleanup == Cleanup::Unconfirmed {
            return Err("Runtime result/cleanup is unconfirmed.");
        }
        if let Some(code) = &reply.error {
            return Err(failure(code));
        }
        if !status.success() || !matches!(reply.result.as_deref(), Some("started" | "reused")) {
            return Err("Runtime startup was not confirmed.");
        }
        Ok(())
    };
    let outcome = tokio::select! {
        result = work => result,
        _ = async { loop { tokio::time::sleep(Duration::from_millis(50)).await; if check(cancel, deadline).is_err() { break; } } } =>
            Err("Runtime startup canceled or timed out. An activated daemon was left running to preserve work."),
    };
    if outcome.is_err() {
        drop(child.stdin.take());
        let cleanup = tokio::time::timeout(Duration::from_secs(2), async {
            if !received {
                let _ = receive_reply(&mut reader, &mut received, &mut wire).await;
            }
            child.wait().await.map_err(|_| ())?;
            if wire
                .as_ref()
                .is_some_and(|reply| reply.schema == 1 && reply.cleanup != Cleanup::Unconfirmed)
            {
                Ok(())
            } else {
                Err(())
            }
        })
        .await;
        reader.abort();
        if !matches!(cleanup, Ok(Ok(()))) {
            return Err(
                "Runtime launcher cleanup is unconfirmed. Its helper was left to finish owned-child cleanup; no existing daemon was stopped.",
            );
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[test]
    fn runtime_environment_retains_restrictive_and_resource_policy_without_ambient_authority() {
        let values = std::collections::BTreeMap::from([
            ("PILOT_MODEL_SCOPE_READ_ONLY", "1"),
            ("PILOT_MCP_SETUP_READ_ONLY", "1"),
            ("PILOT_WORKSPACE_RETENTION_DAYS", "0"),
            ("PILOT_IDLE_PARK_MS", "1234"),
            ("PILOT_ENVIRONMENT_SETUP", "0"),
            ("NODE_OPTIONS", "must-not-cross"),
            ("PILOT_CREDENTIAL_BROKER_SOCKET", "must-not-cross"),
            ("OPENAI_API_KEY", "must-not-cross"),
        ]);
        let forwarded: std::collections::BTreeMap<_, _> = configured_environment(|name| {
            values
                .get(name)
                .map(|value| std::ffi::OsString::from(*value))
        })
        .into_iter()
        .collect();
        for name in [
            "PILOT_MODEL_SCOPE_READ_ONLY",
            "PILOT_MCP_SETUP_READ_ONLY",
            "PILOT_WORKSPACE_RETENTION_DAYS",
            "PILOT_IDLE_PARK_MS",
            "PILOT_ENVIRONMENT_SETUP",
        ] {
            assert_eq!(forwarded[name], std::ffi::OsString::from(values[name]));
        }
        assert_eq!(forwarded.len(), 5);
    }
    fn faux(script: &str) -> tokio::process::Child {
        tokio::process::Command::new("/bin/sh")
            .args(["-c", script])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .unwrap()
    }
    #[tokio::test]
    async fn runtime_supervisor_reaps_oversized_failed_and_malformed_owned_helpers() {
        for (script, success) in [
            (
                "printf '%s' '{\"schema\":1,\"result\":\"started\",\"cleanup\":\"activation-possible\"}'",
                true,
            ),
            (
                "printf '%s' '{\"schema\":1,\"result\":\"reused\",\"cleanup\":\"no-owned-child\"}'",
                true,
            ),
            (
                "printf '%s' '{\"schema\":1,\"error\":\"runtime_incompatible\",\"cleanup\":\"no-owned-child\"}'",
                false,
            ),
            (
                "printf '%s' '{\"schema\":1,\"schema\":1,\"result\":\"started\"}'",
                false,
            ),
            ("printf '{'; exit 2", false),
            ("printf '%4097s' x; read -r ignored || :", false),
        ] {
            let mut child = faux(script);
            let result = supervise(
                &mut child,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(2),
            )
            .await;
            assert_eq!(result.is_ok(), success, "faux launcher result: {script}");
            assert!(
                child.try_wait().unwrap().is_some(),
                "actual owned child handle was reaped"
            );
        }
    }
    #[tokio::test]
    async fn runtime_supervisor_cancellation_and_deadline_reap_only_the_owned_helper() {
        for canceled in [false, true] {
            let mut child = faux(
                "/bin/sleep 60 & owned=$!; read -r ignored || :; kill \"$owned\"; wait \"$owned\" 2>/dev/null || :; printf '%s' '{\"schema\":1,\"error\":\"runtime_startup_canceled\",\"cleanup\":\"preactivation-reaped\"}'",
            );
            let result = supervise(
                &mut child,
                &AtomicBool::new(canceled),
                Instant::now() + Duration::from_millis(20),
            )
            .await;
            assert!(result.is_err());
            assert!(child.try_wait().unwrap().is_some());
        }
    }
    #[tokio::test]
    async fn runtime_supervisor_does_not_force_kill_an_unconfirmed_cleanup_owner() {
        let mut child = faux("exec /bin/sleep 60");
        let result = supervise(&mut child, &AtomicBool::new(true), Instant::now()).await;
        assert!(result.unwrap_err().contains("cleanup is unconfirmed"));
        assert!(
            child.try_wait().unwrap().is_none(),
            "do not bypass a launcher's child cleanup"
        );
        // Only this fixture has no nested/activated child; the test owns its actual handle.
        child.kill().await.unwrap();
    }
    struct Fixture {
        root: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("next-bundle-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let fixture = Self { root };
            for name in [
                "Contents/Resources/runtime/node/bin/node",
                "Contents/Resources/runtime/packages/daemon/src/runtime-launch.ts",
                "Contents/Resources/runtime/packages/daemon/src/main.ts",
                "Contents/MacOS/pilot-visual-worker",
                "Contents/Helpers/PilotPower",
                "Contents/Helpers/PilotSystemEvents.app/Contents/MacOS/PilotSystemEvents",
            ] {
                let path = fixture.root.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"synthetic only").unwrap();
            }
            fs::write(
                fixture
                    .root
                    .join("Contents/Resources/runtime/runtime-build.json"),
                serde_json::to_vec(&Self::build()).unwrap(),
            )
            .unwrap();
            fixture.seal();
            fixture
        }
        fn build() -> Value {
            json!({"schema":1,"source":"a".repeat(40),"version":"1.64.0","protocol":1,"platform":"darwin","arch":"arm64","node":"24.21.0"})
        }
        fn seal(&self) {
            let mut directories = vec![self.root.clone()];
            let mut entries = Vec::new();
            while let Some(directory) = directories.pop() {
                for item in fs::read_dir(directory).unwrap() {
                    let item = item.unwrap();
                    let path = item.path();
                    let name = path.strip_prefix(&self.root).unwrap().to_str().unwrap();
                    if name == MANIFEST {
                        continue;
                    }
                    let metadata = fs::symlink_metadata(&path).unwrap();
                    if metadata.is_dir() {
                        entries.push(json!({"path":name,"kind":"directory","mode":metadata.permissions().mode() & 0o7777}));
                        directories.push(path);
                    } else {
                        let bytes = fs::read(&path).unwrap();
                        entries.push(json!({"path":name,"kind":"file","bytes":bytes.len(),"mode":metadata.permissions().mode() & 0o7777,"sha256":format!("{:x}",Sha256::digest(bytes))}));
                    }
                }
            }
            let manifest = json!({"schema":1,"kind":"development-bundled-runtime","build":Self::build(),"files":entries});
            fs::write(
                self.root.join(MANIFEST),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        }
        fn validate(&self) -> Result<(), Failure> {
            validate(
                &self.root,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(10),
            )
        }
        fn edit(&self, change: impl FnOnce(&mut Value)) {
            let path = self.root.join(MANIFEST);
            let mut value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            change(&mut value);
            fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
    }
    #[test]
    fn runtime_inventory_relocates_and_detects_tamper() {
        let fixture = Fixture::new();
        assert_eq!(fixture.validate(), Ok(()));
        fs::write(
            fixture
                .root
                .join("Contents/Resources/runtime/node/bin/node"),
            b"tampered bytes",
        )
        .unwrap();
        assert!(fixture.validate().is_err());
    }
    #[test]
    fn runtime_manifest_rejects_metadata_mix_truncation_duplicates_and_escape() {
        let fixture = Fixture::new();
        fixture.edit(|m| m["build"]["source"] = json!("b".repeat(40)));
        assert!(fixture.validate().is_err());
        fixture.seal();
        fixture.edit(|m| {
            let first = m["files"][0].clone();
            m["files"].as_array_mut().unwrap().push(first);
        });
        assert!(fixture.validate().is_err());
        fixture.seal();
        fixture.edit(|m| m["files"][0]["path"] = json!("../escape"));
        assert!(fixture.validate().is_err());
        fs::write(fixture.root.join(MANIFEST), b"{").unwrap();
        assert!(fixture.validate().is_err());
    }
    #[test]
    fn runtime_inventory_refuses_unrecorded_resources_and_missing_required_nodes() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("unexpected"), "extra").unwrap();
        assert!(fixture.validate().is_err());
        fs::remove_file(fixture.root.join("unexpected")).unwrap();
        fs::remove_file(fixture.root.join("Contents/Helpers/PilotPower")).unwrap();
        fixture.seal();
        assert!(fixture.validate().is_err());
    }
    #[test]
    fn runtime_cancel_and_deadline_prevent_late_validation() {
        let fixture = Fixture::new();
        assert!(
            validate(
                &fixture.root,
                &AtomicBool::new(true),
                Instant::now() + Duration::from_secs(1)
            )
            .is_err()
        );
        assert!(validate(&fixture.root, &AtomicBool::new(false), Instant::now()).is_err());
    }
    #[test]
    fn runtime_bundle_shape_never_silently_falls_back_to_fixture() {
        assert!(packaged(Path::new(
            "/tmp/Damaged.app/Contents/MacOS/pilot-desktop"
        )));
        assert!(!packaged(Path::new("/tmp/target/dev/pilot-desktop")));
        let app = Path::new("/tmp/Pilot Next.app/Contents/MacOS/pilot-desktop");
        assert!(requested(&[], app));
        assert!(requested(&["--bundled".into()], app));
        for args in [
            vec!["--local".into()],
            vec!["--local-check".into()],
            vec!["--help".into()],
            vec!["--fixture".into(), "giant".into()],
        ] {
            assert!(!requested(&args, app));
        }
        assert!(!requested(&[], Path::new("/tmp/pilot-desktop")));
        for name in ["../bad", "a/../b", "/absolute", "a//b", "a/./b", ""] {
            assert!(!relative(name));
        }
    }
}
