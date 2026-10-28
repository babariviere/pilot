//! Exact retained-root proof, agent pause and update reservation, using only the configured
//! private profile record. Not a provider credential lookup or remote-host API.
#[cfg(target_os = "macos")]
use crate::runtime;
use crate::{
    Error,
    installer::{self, NativePlatform, Platform},
    manifest::Trust,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    pub home: PathBuf,
    pub port: u16,
    #[serde(default)]
    pub policy: std::collections::BTreeMap<String, String>,
}
pub const POLICY_NAMES: [&str; 7] = [
    "PILOT_AGENT_DIR",
    "PILOT_MODEL_SCOPE_READ_ONLY",
    "PILOT_MCP_SETUP_READ_ONLY",
    "PILOT_IDLE_PARK_MS",
    "PILOT_WORKSPACE_RETENTION_DAYS",
    "PILOT_ENVIRONMENT_SETUP",
    "XDG_CONFIG_HOME",
];
pub fn captured_policy() -> Result<std::collections::BTreeMap<String, String>, Error> {
    let mut result = std::collections::BTreeMap::new();
    for name in POLICY_NAMES {
        if let Some(raw) = std::env::var_os(name) {
            let mut value = raw.into_string().map_err(|_| Error::Identity)?;
            if name == "PILOT_AGENT_DIR" || name == "XDG_CONFIG_HOME" {
                if value.is_empty() {
                    return Err(Error::Identity);
                }
                if Path::new(&value).is_relative() {
                    value = std::env::current_dir()
                        .map_err(|_| Error::Filesystem)?
                        .join(value)
                        .to_str()
                        .ok_or(Error::Identity)?
                        .into();
                }
            }
            if value.len() > 4096 || value.contains('\0') {
                return Err(Error::Identity);
            }
            result.insert(name.into(), value);
        }
    }
    Ok(result)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guard {
    #[serde(default)]
    ui_only: bool,
    location: Location,
    boot: String,
    capsule: PathBuf,
    capsule_id: String,
    bundle_build: String,
    build: Value,
    receipt: Value,
    transaction: PathBuf,
    target_build: String,
    policy_hash: String,
    configuration: String,
}
pub(crate) fn private_json(path: &Path, cap: u64) -> Result<Value, Error> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Error::RuntimeUnverified)?;
    let meta = file.metadata().map_err(|_| Error::Filesystem)?;
    // SAFETY: current identity query only.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > cap
    {
        return Err(Error::RuntimeUnverified);
    }
    installer::acl_policy(path, 2)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Filesystem)?;
    if bytes.len() as u64 > cap {
        return Err(Error::RuntimeUnverified);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::RuntimeUnverified)
}
pub(crate) fn record(location: &Location) -> Result<Value, Error> {
    use sha2::{Digest, Sha256};
    if location.policy.len() > POLICY_NAMES.len()
        || location.policy.iter().any(|(key, value)| {
            !POLICY_NAMES.contains(&key.as_str()) || value.len() > 4096 || value.contains('\0')
        })
    {
        return Err(Error::Identity);
    }
    if location.port == 0
        || !location.home.is_absolute()
        || location
            .home
            .canonicalize()
            .map_err(|_| Error::RuntimeUnverified)?
            != location.home
    {
        return Err(Error::RuntimeUnverified);
    }
    let m = fs::symlink_metadata(&location.home).map_err(|_| Error::RuntimeUnverified)?;
    // SAFETY: current identity query only.
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
        return Err(Error::RuntimeUnverified);
    }
    installer::acl_policy(&location.home, 2)?;
    let record = private_json(&location.home.join(".daemon-owner.json"), 16_384)?;
    let home = location.home.to_str().ok_or(Error::Identity)?;
    if record["home"] != crate::transport::hex(&Sha256::digest(home.as_bytes())) {
        return Err(Error::Identity);
    }
    if record["schema"] != 1
        || record["port"] != location.port
        || !hex(record["boot"].as_str())
        || !hex(record["secret"].as_str())
    {
        return Err(Error::RuntimeUnverified);
    }
    Ok(record)
}
fn hex(value: Option<&str>) -> bool {
    value.is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
#[cfg(target_os = "macos")]
fn code_build(capsule: &Path) -> Result<String, Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn pnu_bundle_build(
            path: *const libc::c_char,
            output: *mut libc::c_char,
            capacity: usize,
        ) -> bool;
    }
    let meta =
        fs::symlink_metadata(capsule.join("Contents/Info.plist")).map_err(|_| Error::Identity)?;
    if !meta.is_file() || meta.len() > 65_536 {
        return Err(Error::Identity);
    }
    let path = CString::new(capsule.as_os_str().as_bytes()).map_err(|_| Error::Identity)?;
    let mut buffer = [0_u8; 64];
    // SAFETY: bounded output and valid path, native call off the UI thread.
    if !unsafe { pnu_bundle_build(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) } {
        return Err(Error::Identity);
    }
    let end = buffer.iter().position(|b| *b == 0).ok_or(Error::Identity)?;
    let build = std::str::from_utf8(&buffer[..end])
        .map_err(|_| Error::Version)?
        .to_owned();
    crate::manifest::Build::parse(&build)?;
    Ok(build)
}
#[cfg(target_os = "linux")]
fn code_build(capsule: &Path) -> Result<String, Error> {
    let value: Value = serde_json::from_slice(
        &fs::read(capsule.join(crate::linux::INVENTORY)).map_err(|_| Error::Identity)?,
    )
    .map_err(|_| Error::Identity)?;
    let build = value["bundle_build"]
        .as_str()
        .ok_or(Error::Identity)?
        .to_owned();
    crate::manifest::Build::parse(&build)?;
    Ok(build)
}
fn capsule_root(runtime_root: &Path) -> Result<PathBuf, Error> {
    runtime_root
        .ancestors()
        .nth(crate::layout::RUNTIME.split('/').count())
        .map(Path::to_owned)
        .ok_or(Error::Identity)
}
#[cfg(target_os = "linux")]
fn capsule_identity(root: &Path) -> Result<String, Error> {
    use sha2::{Digest, Sha256};
    Ok(crate::transport::hex(&Sha256::digest(
        fs::read(root.join(crate::linux::INVENTORY)).map_err(|_| Error::Identity)?,
    )))
}
#[cfg(target_os = "macos")]
fn capsule_identity(root: &Path) -> Result<String, Error> {
    runtime::identity(root)
}
pub fn policy(bundle: &Path) -> Result<(Vec<String>, String), Error> {
    use sha2::{Digest, Sha256};
    let path = bundle.join(crate::layout::POLICY);
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Error::RuntimeUnverified)?;
    if file.metadata().map_err(|_| Error::Filesystem)?.len() > 4096 {
        return Err(Error::RuntimeUnverified);
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Filesystem)?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Policy {
        schema: u8,
        accepted_capsules: Vec<String>,
    }
    let value: Policy = serde_json::from_slice(&bytes).map_err(|_| Error::RuntimeUnverified)?;
    if bytes.len() > 4096
        || value.schema != 1
        || value.accepted_capsules.len() > 4
        || value.accepted_capsules.iter().any(|id| !hex(Some(id)))
    {
        return Err(Error::RuntimeUnverified);
    }
    Ok((
        value.accepted_capsules,
        crate::transport::hex(&Sha256::digest(&bytes)),
    ))
}
/// Select a supported immutable owner without changing the launcher's exact-build
/// check. The old launcher's build is still its own exact signed source tuple.
pub fn selected(location: &Location, current: &Path, trust: &Trust) -> Result<PathBuf, Error> {
    let record = match record(location) {
        Ok(r) => r,
        Err(_) => return Ok(current.to_owned()),
    };
    // The owner record outlives its daemon. Once no daemon holds the profile lease,
    // start this app's own runtime rather than refusing or reviving the old one.
    if !owner_live(&location.home) {
        return Ok(current.to_owned());
    }
    let runtime_root = record["runtimeRoot"]
        .as_str()
        .ok_or(Error::RuntimeUnverified)?;
    let root = capsule_root(Path::new(runtime_root))?;
    let (accepted, _) = policy(current)?;
    let current_id = capsule_identity(current)?;
    validate_capsule(&root, trust, &accepted, Some(&current_id))?;
    Ok(root.to_owned())
}
/// Asks the profile's running daemon to pause its agents once their current tool calls
/// finish, as the Swift app does before installing. Each call renews the daemon's
/// 30 second pause lease; agents resume on their own once calls stop. Returns whether
/// every agent has paused. No daemon means nothing to pause.
pub fn pause_agents(location: &Location) -> Result<bool, Error> {
    if !owner_live(&location.home) {
        return Ok(true);
    }
    let pid = record(location)?["pid"]
        .as_i64()
        .filter(|p| *p > 1 && *p <= i32::MAX as i64)
        .ok_or(Error::RuntimeUnverified)? as i32;
    request_pause(location, pid)
}
fn request_pause(location: &Location, pid: i32) -> Result<bool, Error> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Error::Native)?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/api/update/pause",
            location.port
        ))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|_| Error::RuntimeUnverified)?;
    if response.len() > 4096 {
        return Err(Error::RuntimeUnverified);
    }
    let paused: Value = serde_json::from_slice(&response).map_err(|_| Error::RuntimeUnverified)?;
    if paused["processId"].as_i64() != Some(pid.into()) {
        return Err(Error::Identity);
    }
    Ok(paused["ready"] == true)
}
/// Whether a process holds the daemon's SQLite profile lease (`BEGIN EXCLUSIVE`
/// for the daemon's lifetime). Only queries the lock (F_GETLK); never takes it.
/// Unknown answers count as live, keeping the existing strict path.
pub(crate) fn owner_live(home: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(home.join(".daemon-owner.sqlite"))
    {
        Ok(file) => file,
        Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
    };
    // SAFETY: zeroed flock is a valid query; the fd is open for this call.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    // SAFETY: valid fd and flock out-pointer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) } != 0 {
        return true;
    }
    #[allow(clippy::useless_conversion)] // F_UNLCK is c_int on Linux, c_short on macOS.
    let unlocked = i32::from(libc::F_UNLCK);
    i32::from(lock.l_type) != unlocked
}
pub(crate) fn validate_capsule(
    root: &Path,
    trust: &Trust,
    accepted: &[String],
    current: Option<&str>,
) -> Result<(String, String), Error> {
    #[cfg(target_os = "macos")]
    installer::validate_target(root, trust)?;
    #[cfg(target_os = "linux")]
    {
        if root.file_name().is_none_or(|name| name != "payload")
            || root.canonicalize().map_err(|_| Error::Identity)? != root
        {
            return Err(Error::Identity);
        }
        installer::validate_parents(root)?;
        let meta = fs::symlink_metadata(root).map_err(|_| Error::Filesystem)?;
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(Error::Identity);
        }
    }
    let directory = root.parent().ok_or(Error::RuntimeUnverified)?;
    let id = directory
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(Error::RuntimeUnverified)?;
    let store = directory.parent().ok_or(Error::RuntimeUnverified)?;
    #[cfg(target_os = "macos")]
    let store_name = runtime::STORE_NAME;
    #[cfg(target_os = "linux")]
    let store_name = "runtimes";
    if store.file_name().is_none_or(|s| s != store_name) || !hex(Some(id)) {
        return Err(Error::RuntimeUnverified);
    }
    #[cfg(target_os = "macos")]
    runtime::validate_store(store)?;
    #[cfg(target_os = "linux")]
    {
        installer::validate_parents(store)?;
        let meta = fs::symlink_metadata(store).map_err(|_| Error::Identity)?;
        if meta.mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
            return Err(Error::Identity);
        }
        installer::acl_policy(store, 2)?;
    }
    if current != Some(id) && !accepted.iter().any(|v| v == id) {
        return Err(Error::Version);
    }
    let build = code_build(root)?;
    NativePlatform.verify(root, trust, &build, None)?;
    if capsule_identity(root)? != id {
        return Err(Error::Identity);
    }
    Ok((id.to_owned(), build))
}
impl Guard {
    pub fn prepare(
        location: Location,
        candidate: &Path,
        transaction: &Path,
        target_build: &str,
        trust: &Trust,
    ) -> Result<Self, Error> {
        Self::prepare_mode(location, candidate, transaction, target_build, trust, false)
    }
    pub fn prepare_ui(
        location: Location,
        candidate: &Path,
        transaction: &Path,
        target_build: &str,
        trust: &Trust,
    ) -> Result<Self, Error> {
        Self::prepare_mode(location, candidate, transaction, target_build, trust, true)
    }
    fn prepare_mode(
        location: Location,
        candidate: &Path,
        transaction: &Path,
        target_build: &str,
        trust: &Trust,
        ui_only: bool,
    ) -> Result<Self, Error> {
        let record = record(&location)?;
        let runtime_root = record["runtimeRoot"]
            .as_str()
            .ok_or(Error::RuntimeUnverified)?;
        let capsule = capsule_root(Path::new(runtime_root))?;
        if capsule.join(crate::layout::RUNTIME) != Path::new(runtime_root) {
            return Err(Error::Identity);
        }
        let (accepted, policy_hash) = policy(candidate)?;
        let (capsule_id, bundle_build) = validate_capsule(&capsule, trust, &accepted, None)?;
        let stamp = capsule
            .join(crate::layout::RUNTIME)
            .join("runtime-build.json");
        if fs::metadata(&stamp).map_err(|_| Error::Identity)?.len() > 4096 {
            return Err(Error::Identity);
        }
        let build: Value = serde_json::from_slice(&fs::read(stamp).map_err(|_| Error::Identity)?)
            .map_err(|_| Error::Identity)?;
        if build != record["build"] {
            return Err(Error::Identity);
        }
        let mut guard = Self {
            ui_only,
            location,
            boot: record["boot"].as_str().ok_or(Error::Identity)?.into(),
            capsule,
            capsule_id,
            bundle_build,
            build: record["build"].clone(),
            receipt: json!({"operationId":random_operation()?}),
            transaction: transaction.to_owned(),
            target_build: target_build.into(),
            policy_hash,
            configuration: configuration(trust),
        };
        guard.verify_process(&record)?;
        if ui_only {
            guard.request("inspect")?;
        } else {
            guard.receipt = guard.request("prepare")?;
        }
        Ok(guard)
    }
    fn verify_process(&self, r: &Value) -> Result<(), Error> {
        if r["boot"] != self.boot
            || r["build"] != self.build
            || r["runtimeRoot"].as_str() != self.capsule.join(crate::layout::RUNTIME).to_str()
        {
            return Err(Error::RuntimeUnverified);
        }
        let pid = r["pid"]
            .as_i64()
            .filter(|p| *p > 1 && *p <= i32::MAX as i64)
            .ok_or(Error::RuntimeUnverified)? as i32;
        if crate::helper::process_executable(pid)?
            != self
                .capsule
                .join(crate::layout::RUNTIME)
                .join("node/bin/node")
                .canonicalize()
                .map_err(|_| Error::Identity)?
        {
            return Err(Error::RuntimeUnverified);
        }
        Ok(())
    }
    fn request(&self, action: &str) -> Result<Value, Error> {
        use ring::hmac;
        let r = record(&self.location)?;
        self.verify_process(&r)?;
        let secret = r["secret"].as_str().ok_or(Error::Identity)?;
        let key: Vec<u8> = (0..64)
            .step_by(2)
            .map(|i| u8::from_str_radix(&secret[i..i + 2], 16).map_err(|_| Error::Identity))
            .collect::<Result<_, _>>()?;
        let nonce = random_hex()?;
        let body = serde_json::to_string(
            &json!({"boot":self.boot,"nonce":nonce,"action":action,"receipt":self.receipt}),
        )
        .map_err(|_| Error::Identity)?;
        let key = hmac::Key::new(hmac::HMAC_SHA256, &key);
        let proof = crate::transport::hex(
            hmac::sign(&key, format!("update/v1\n{body}").as_bytes()).as_ref(),
        );
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| Error::Native)?;
        let mut response = client
            .post(format!(
                "http://127.0.0.1:{}/__pilot_runtime_update/v1",
                self.location.port
            ))
            .header("x-pilot-update-proof", proof)
            .body(body)
            .send()
            .map_err(|_| Error::RuntimeUnverified)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Error::ActiveWork);
        }
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(16_385)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::RuntimeUnverified)?;
        if bytes.len() > 16_384 {
            return Err(Error::RuntimeUnverified);
        }
        let envelope: Value =
            serde_json::from_slice(&bytes).map_err(|_| Error::RuntimeUnverified)?;
        let body = envelope["body"].as_str().ok_or(Error::Identity)?;
        let signature = envelope["mac"]
            .as_str()
            .filter(|v| hex(Some(v)))
            .ok_or(Error::Identity)?;
        let signature: Vec<u8> = (0..64)
            .step_by(2)
            .map(|i| u8::from_str_radix(&signature[i..i + 2], 16).map_err(|_| Error::Identity))
            .collect::<Result<_, _>>()?;
        hmac::verify(&key, format!("update/v1\n{body}").as_bytes(), &signature)
            .map_err(|_| Error::Signature)?;
        let value: Value = serde_json::from_str(body).map_err(|_| Error::Identity)?;
        if value["schema"] != 1
            || value["boot"] != self.boot
            || value["nonce"] != nonce
            || value["build"] != self.build
            || value["runtimeRoot"] != r["runtimeRoot"]
            || value["port"] != self.location.port
            || value["home"] != r["home"]
            || record(&self.location)?["boot"] != self.boot
        {
            return Err(Error::Identity);
        }
        Ok(value["receipt"].clone())
    }
    pub fn verify(&self) -> Result<(), Error> {
        if self.ui_only {
            return self.request("inspect").map(|_| ());
        }
        if self.request("verify")? != self.receipt {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub fn cancel(&self) {
        if !self.ui_only {
            let _ = self.request("cancel");
        }
    }
    pub fn save(&self) -> Result<(), Error> {
        if installer::recovery_phase(&self.transaction)? != installer::Phase::Ready {
            return Err(Error::RecoveryRequired);
        }
        let target = self.transaction.join("runtime-guard.json");
        if target.try_exists().map_err(|_| Error::Filesystem)? {
            let previous: Self = serde_json::from_value(private_json(&target, 16_384)?)
                .map_err(|_| Error::RecoveryRequired)?;
            if previous.transaction != self.transaction
                || previous.configuration != self.configuration
                || previous.target_build != self.target_build
                || previous.policy_hash != self.policy_hash
            {
                return Err(Error::RecoveryRequired);
            }
            previous.cancel();
        }
        let pending = self.transaction.join("runtime-guard.pending");
        installer::write_new(
            &pending,
            &serde_json::to_vec(self).map_err(|_| Error::Identity)?,
        )?;
        fs::rename(pending, target).map_err(|_| Error::Filesystem)?;
        std::fs::File::open(&self.transaction)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::RecoveryRequired)
    }
    pub fn load(
        transaction: &Path,
        candidate: &Path,
        build: &str,
        trust: &Trust,
    ) -> Result<Self, Error> {
        Self::load_checked(transaction, candidate, build, trust, true)
    }
    fn load_checked(
        transaction: &Path,
        candidate: &Path,
        build: &str,
        trust: &Trust,
        reserved: bool,
    ) -> Result<Self, Error> {
        let guard: Self = serde_json::from_value(private_json(
            &transaction.join("runtime-guard.json"),
            16_384,
        )?)
        .map_err(|_| Error::Identity)?;
        let (accepted, hash) = policy(candidate)?;
        #[cfg(feature = "fixture")]
        if crate::fixture::enabled() {
            eprintln!(
                "fixture-guard-config={} transaction={} build={} policy={}",
                guard.configuration == configuration(trust),
                guard.transaction == transaction,
                guard.target_build == build,
                guard.policy_hash == hash
            );
        }
        if guard.configuration != configuration(trust)
            || guard.transaction != transaction
            || guard.target_build != build
            || guard.policy_hash != hash
        {
            return Err(Error::Identity);
        }
        let (id, bundle_build) = validate_capsule(&guard.capsule, trust, &accepted, None)?;
        if guard.capsule_id != id || guard.bundle_build != bundle_build {
            return Err(Error::Identity);
        }
        if reserved {
            guard.verify()?;
        } else {
            guard.request("inspect")?;
        }
        Ok(guard)
    }
    pub fn acknowledge_startup(
        transaction: &Path,
        target: &Path,
        trust: &Trust,
    ) -> Result<(), Error> {
        let guard = Self::load_checked(transaction, target, &trust.current_build, trust, false)?;
        installer::acknowledge_startup(
            transaction,
            &trust.current_build,
            trust,
            &NativePlatform,
            target,
        )?;
        guard.cancel();
        Ok(())
    }
    pub fn startup_runtime(
        transaction: &Path,
        target: &Path,
        trust: &Trust,
    ) -> Result<(PathBuf, Location), Error> {
        Self::startup_connection(transaction, target, trust)
            .map(|(root, location, _)| (root, location))
    }
    /// A UI-only receipt is a reconnect contract, never permission to launch a daemon.
    pub fn startup_connection(
        transaction: &Path,
        target: &Path,
        trust: &Trust,
    ) -> Result<(PathBuf, Location, bool), Error> {
        NativePlatform.verify(target, trust, &trust.current_build, None)?;
        let guard = Self::load_checked(transaction, target, &trust.current_build, trust, false)?;
        Ok((guard.capsule, guard.location, guard.ui_only))
    }
}
pub(crate) fn random_hex() -> Result<String, Error> {
    use ring::rand::SecureRandom;
    let mut b = [0; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| Error::Native)?;
    Ok(crate::transport::hex(&b))
}
pub(crate) fn configuration(trust: &Trust) -> String {
    use sha2::{Digest, Sha256};
    // Struct field order is stable even when the GUI enables serde_json's
    // preserve_order feature and the standalone helper does not.
    #[derive(Serialize)]
    struct Configuration<'a> {
        application: &'a str,
        channel: &'a str,
        repository: &'a str,
        key: &'a [u8; 32],
        requirement: &'a str,
    }
    let bytes = serde_json::to_vec(&Configuration {
        application: &trust.application_id,
        channel: &trust.channel,
        repository: &trust.repository,
        key: &trust.public_key,
        requirement: &trust.code_requirement,
    })
    .expect("public configuration serializes");
    crate::transport::hex(&Sha256::digest(bytes))
}

fn random_operation() -> Result<String, Error> {
    let s = random_hex()?;
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..32]
    ))
}

#[cfg(test)]
mod configuration_tests {
    use super::*;

    #[test]
    fn public_configuration_fingerprint_is_independent_of_json_map_features() {
        let trust = Trust {
            application_id: "com.example.synthetic.next".into(),
            channel: "desktop-stable".into(),
            repository: "synthetic/fixture-only".into(),
            public_key: [7; 32],
            code_requirement: "signed-linux-inventory-v1".into(),
            current_build: "100.1".into(),
            bundle_name: "Pilot Next".into(),
        };
        assert_eq!(
            configuration(&trust),
            "449aa55cf231edc8b52a5c1dca6420757eddf877307a35ba9ac9ca4fbce80ef9"
        );
        let mut next = trust.clone();
        next.current_build = "101.1".into();
        assert_eq!(configuration(&next), configuration(&trust));
        next.repository = "synthetic/other".into();
        assert_ne!(configuration(&next), configuration(&trust));
    }

    #[test]
    fn agent_pause_reports_readiness_only_for_the_recorded_daemon() {
        use std::io::{BufRead, BufReader, Write};
        let dir = crate::owned_tests::Temp::new();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let location = Location {
            home: dir.path().to_owned(),
            port: listener.local_addr().unwrap().port(),
            policy: Default::default(),
        };
        assert_eq!(
            pause_agents(&location),
            Ok(true),
            "no daemon owns the profile, so nothing needs pausing"
        );
        let replies = [
            r#"{"ready":false,"processId":42}"#,
            r#"{"ready":true,"processId":42}"#,
            r#"{"ready":true,"processId":7}"#,
        ];
        let server = std::thread::spawn(move || {
            let mut paths = Vec::new();
            for body in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                paths.push(request.trim().to_owned());
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            paths
        });
        assert_eq!(request_pause(&location, 42), Ok(false));
        assert_eq!(request_pause(&location, 42), Ok(true));
        assert_eq!(
            request_pause(&location, 42),
            Err(Error::Identity),
            "another process answering the port is never treated as paused"
        );
        assert!(
            server
                .join()
                .unwrap()
                .iter()
                .all(|line| line == "POST /api/update/pause HTTP/1.1")
        );
    }

    #[test]
    fn owner_is_live_only_while_another_process_holds_the_lease() {
        use std::io::{BufRead, BufReader, Write};
        let dir = crate::owned_tests::Temp::new();
        assert!(
            !owner_live(dir.path()),
            "no lease file: nothing owns the profile"
        );
        let lease = dir.path().join(".daemon-owner.sqlite");
        fs::write(&lease, b"").unwrap();
        assert!(!owner_live(dir.path()), "stale lease: its daemon exited");
        let mut holder = std::process::Command::new("python3")
            .args([
                "-c",
                "import fcntl,sys;f=open(sys.argv[1],'r+');fcntl.lockf(f,fcntl.LOCK_EX);print('locked',flush=True);sys.stdin.read()",
            ])
            .arg(&lease)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(holder.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "locked");
        assert!(owner_live(dir.path()));
        holder.stdin.take().unwrap().flush().unwrap();
        holder.wait().unwrap();
        assert!(!owner_live(dir.path()));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn private_json_refuses_read_acl_without_repairing_it() {
        let dir = crate::owned_tests::Temp::new();
        let path = dir.path().join("private.json");
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(private_json(&path, 1024).is_ok());
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone allow read"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(private_json(&path, 1024).is_err());
        assert!(
            installer::acl_policy(&path, 2).is_err(),
            "existing ACL must not be stripped"
        );
    }
}
