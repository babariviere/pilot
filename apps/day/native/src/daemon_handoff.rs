//! Windowless service handoff for an already installed, signed full Day bundle.
//! The caller saves/closes its GUI first. This entry never closes a GUI or swaps
//! an app; app replacement remains the official NSH installer's responsibility.
use pilot_desktop_updater::{
    app_update::Connection,
    coordination::{self, GlobalUpdateAction, Location},
    daemon_upgrade::bundled_service::{self, Runtime},
    helper,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
    sync::atomic::AtomicBool,
};

struct Request {
    action: String,
    profile: PathBuf,
    port: u16,
    daemon: String,
    lineage: String,
    operation: String,
    source: String,
    build: String,
    saved: PathBuf,
    old_app: Option<PathBuf>,
}
impl Request {
    fn parse(args: Vec<OsString>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let action = args
            .next()
            .and_then(|s| s.into_string().ok())
            .ok_or("missing action")?;
        if !["preflight", "apply", "inspect", "retire"].contains(&action.as_str()) {
            return Err("invalid action".into());
        }
        let mut values = BTreeMap::new();
        while let Some(key) = args.next() {
            let key = key.into_string().map_err(|_| "invalid flag")?;
            let value = args.next().ok_or("missing value")?;
            if values.insert(key, value).is_some() {
                return Err("duplicate flag".into());
            }
        }
        let mut take = |key: &str| values.remove(key).ok_or_else(|| format!("missing {key}"));
        let profile = PathBuf::from(take("--profile")?);
        let saved = PathBuf::from(take("--saved-state")?);
        let mut string = |key| {
            take(key)?
                .into_string()
                .map_err(|_| "invalid text".to_string())
        };
        let port = string("--port")?
            .parse::<u16>()
            .map_err(|_| "invalid port")?;
        let daemon = string("--daemon-id")?;
        let lineage = string("--lineage-id")?;
        let operation = string("--operation-id")?;
        let source = string("--source")?;
        let build = string("--build")?;
        let old_app = values.remove("--old-app").map(PathBuf::from);
        if !values.is_empty()
            || !profile.is_absolute()
            || !saved.is_absolute()
            || old_app.as_ref().is_some_and(|p| !p.is_absolute())
            || (action == "retire" && old_app.is_none())
            || port == 0
            || daemon.is_empty()
            || lineage.is_empty()
            || uuid::Uuid::parse_str(&operation).is_err()
            || source.len() != 40
            || !source
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("invalid selection".into());
        }
        Ok(Self {
            action,
            profile,
            port,
            daemon,
            lineage,
            operation,
            source,
            build,
            saved,
            old_app,
        })
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn failure(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}
fn private_json(path: &std::path::Path) -> Result<Value, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(failure)?;
    let meta = file.metadata().map_err(failure)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 1024 * 1024
    {
        return Err("unsafe retained record".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > 1024 * 1024 {
        return Err("oversized retained record".into());
    }
    serde_json::from_slice(&bytes).map_err(failure)
}
fn write_new(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(failure)?;
    file.write_all(&serde_json::to_vec(value).map_err(failure)?)
        .map_err(failure)?;
    file.sync_all().map_err(failure)?;
    File::open(path.parent().ok_or("missing parent")?)
        .and_then(|f| f.sync_all())
        .map_err(failure)
}

/// Runs without creating AppKit or NSH. Machine-readable output has no secrets.
/// All effects require a fresh explicit apply; inspect never re-enters them.
pub fn run(args: Vec<OsString>) -> Value {
    match Request::parse(args).and_then(execute) {
        Ok(value) => value,
        Err(error) => {
            json!({"state":"unknown","error":error,"recovery":"Inspect the original operation. Do not repeat apply after an entered or lost reply."})
        }
    }
}
fn execute(request: Request) -> Result<Value, String> {
    let trust = helper::compiled_trust().map_err(|error| {
        format!("This Day executable has no configured updater trust: {error:?}")
    })?;
    if trust.current_build != request.build {
        return Err("compiled build differs from selected build".into());
    }
    let app = pilot_desktop_updater::layout::running_root().map_err(failure)?;
    let target = Runtime::verify(&app, &app, &trust, &request.source, &request.build)
        .map_err(|error| format!("Full signed Day bundle/runtime verification failed: {error}"))?;
    let connection = Connection::new(
        Location {
            home: request.profile.clone(),
            port: request.port,
            policy: Default::default(),
        },
        request.daemon.clone(),
        request.lineage.clone(),
    );
    let cancel = AtomicBool::new(false);
    let path = request
        .profile
        .join(format!(".day-daemon-handoff-{}.json", request.operation));
    if request.action == "retire" {
        return retire(&request, &path, &connection, &target, &trust);
    }
    if request.action == "inspect" {
        let record = private_json(&path)?;
        if record["source"] != request.source
            || record["build"] != request.build
            || record["profile"] != json!(request.profile)
            || record["port"] != request.port
            || record["operation"]["operationId"] != request.operation
            || record["operation"]["destination"]["daemonId"] != request.daemon
            || record["operation"]["destination"]["lineageId"] != request.lineage
        {
            return Err("retained selection differs".into());
        }
        let service = bundled_service::lookup(&connection, &record["operation"]).ok();
        let release = match path
            .with_extension("release.json")
            .try_exists()
            .map_err(failure)?
        {
            true => Some(private_json(&path.with_extension("release.json"))?),
            false => None,
        };
        let complete = match path
            .with_extension("complete.json")
            .try_exists()
            .map_err(failure)?
        {
            true => Some(private_json(&path.with_extension("complete.json"))?),
            false => None,
        };
        let release_receipt = release.as_ref().and_then(|r| {
            coordination::global_update(
                connection.location(),
                &r["release"],
                GlobalUpdateAction::Inspect,
            )
            .ok()
        });
        let mut retirement = serde_json::Map::new();
        for (name, extension) in [("intent", "retirement.json"), ("complete", "retired.json")] {
            let file = path.with_extension(extension);
            if file.try_exists().map_err(failure)? {
                retirement.insert(name.into(), private_json(&file)?);
            }
        }
        return Ok(json!({"state":"observed","record":record,"service":service,
            "release":release,"complete":complete,"releaseReceipt":release_receipt,"retirement":retirement,"replayed":false}));
    }
    let preflight = bundled_service::preflight(&connection, &target, &cancel).map_err(failure)?;
    if request.action == "preflight" {
        return Ok(json!({"state":"ready","service":preflight,"changed":false}));
    }
    let old_identity = request
        .old_app
        .as_ref()
        .map(|old| old_app_unused(old, &app, &request.profile, &trust).map(|(_, hash)| hash))
        .transpose()?;
    // Own a private, fully saved caller capture. This is not a fabricated native
    // window ACK: callers must finish their existing save/close before invoking.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&request.saved)
        .map_err(failure)?;
    let meta = file.metadata().map_err(failure)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 1024 * 1024
    {
        return Err("saved state must be a private file, at most 1 MiB".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > 1024 * 1024 {
        return Err("saved state too large".into());
    }
    file.sync_all().map_err(failure)?;
    let payload = json!({"captureHash":digest(&bytes),"app":{"source":request.source,"build":request.build},"replacement":target.replacement()}).to_string();
    let destination =
        json!({"hostId":"daemon","daemonId":request.daemon,"lineageId":request.lineage});
    let operation = json!({"schemaVersion":1,"operationId":request.operation,"producerId":request.operation,"sequence":1,
        "origin":destination,"destination":destination,"targetId":"global-update","kind":"global-update-prepare",
        "payloadHash":digest(payload.as_bytes()),"payload":payload});
    let mut record = json!({"schema":1,"state":"entered","source":request.source,"build":request.build,"profile":request.profile,"port":request.port,
        "operation":operation,"preflight":preflight,"savedState":request.saved,"captureHash":digest(&bytes),
        "oldApp":request.old_app,"oldAppIdentity":old_identity});
    // Exclusive creation is the one-shot fence, including across cold restart.
    write_new(&path, &record)?;
    let receipt = coordination::global_update(
        connection.location(),
        &operation,
        GlobalUpdateAction::Prepare,
    )
    .map_err(failure)?;
    let fresh = coordination::global_update(
        connection.location(),
        &operation,
        GlobalUpdateAction::Verify,
    )
    .map_err(failure)?;
    if fresh["receipt"] != receipt {
        return Err("preparation receipt changed".into());
    }
    let uncertainty = bundled_service::dogfood_uncertainty(&fresh).map_err(failure)?;
    let stopped =
        bundled_service::stop(&connection, &target, &operation, &cancel)
            .map_err(|error| format!("Existing daemon shutdown was not confirmed: {error}. Keep admission held and inspect this operation"))?;
    let completed =
        if record["preflight"]["previousRuntime"] == target.replacement()["runtimeRoot"] {
            stopped.start()
        } else {
            stopped.start_or_rollback()
        }
        .map_err(failure)?;
    record["completion"] = completed.evidence().clone();
    record["uncertainty"] = json!(uncertainty);
    let payload =
        json!({"prepareId":operation["operationId"],"prepareHash":operation["payloadHash"]})
            .to_string();
    let release = json!({"schemaVersion":1,"operationId":uuid::Uuid::new_v4().to_string(),"producerId":request.operation,"sequence":2,
        "origin":destination,"destination":destination,"targetId":"global-update","kind":"global-update-release","payload":payload,"payloadHash":digest(payload.as_bytes())});
    record["release"] = release.clone();
    // Preserve entered bytes and append release intent to a separate exclusive
    // file before sending. Neither retained file reconstructs a capability.
    write_new(&path.with_extension("release.json"), &record)?;
    let receipt = completed
        .release(&connection, &operation, &release)
        .map_err(failure)?;
    if receipt["state"] != "accepted"
        || receipt["operationId"] != release["operationId"]
        || receipt["payloadHash"] != release["payloadHash"]
    {
        return Err("release acknowledgement unknown".into());
    }
    record["state"] = "complete".into();
    record["releaseReceipt"] = receipt;
    write_new(&path.with_extension("complete.json"), &record)?;
    Ok(record)
}

// Reuse the updater's native bundle-user census, not a process-name/pgrep check.
unsafe extern "C" {
    fn pnu_bundle_unused(
        root: *const libc::c_char,
        ignored_fd: libc::c_int,
        timeout_ms: u32,
    ) -> bool;
    fn pnu_bundle_build(
        path: *const libc::c_char,
        output: *mut libc::c_char,
        capacity: usize,
    ) -> bool;
}

fn old_app_unused(
    old: &std::path::Path,
    current: &std::path::Path,
    profile: &std::path::Path,
    trust: &pilot_desktop_updater::manifest::Trust,
) -> Result<(File, String), String> {
    use pilot_desktop_updater::installer::{NativePlatform, Platform};
    use std::{
        ffi::{CStr, CString},
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
    };
    if old.file_name().is_none_or(|n| n != "Pilot Next.app")
        || old.canonicalize().map_err(failure)? != old
        || current.starts_with(old)
        || profile.starts_with(old)
        || old.starts_with(profile)
    {
        return Err(
            "Old app must be an explicit separate canonical Pilot Next.app, outside profile data"
                .into(),
        );
    }
    let lease = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(old)
        .map_err(failure)?;
    if lease.metadata().map_err(failure)?.uid() != unsafe { libc::geteuid() } {
        return Err("Old app is not owned by this user".into());
    }
    let path = CString::new(old.as_os_str().as_bytes()).map_err(failure)?;
    let mut bytes = [0 as libc::c_char; 128];
    // SAFETY: valid bounded output and NUL-terminated path; platform verification runs off AppKit.
    if !unsafe { pnu_bundle_build(path.as_ptr(), bytes.as_mut_ptr(), bytes.len()) } {
        return Err("Cannot verify old app build".into());
    }
    let build = unsafe { CStr::from_ptr(bytes.as_ptr()) }
        .to_str()
        .map_err(failure)?;
    NativePlatform
        .verify(old, trust, build, None)
        .map_err(failure)?;
    let identity = pilot_desktop_updater::runtime::identity(old).map_err(failure)?;
    // SAFETY: owned directory descriptor, live C string and bounded read-only inspection.
    if !unsafe { pnu_bundle_unused(path.as_ptr(), lease.as_raw_fd(), 5000) } {
        return Err(
            "Old GUI/runtime still in use or inspection uncertain. Close normally; nothing retired"
                .into(),
        );
    }
    let actual = std::fs::symlink_metadata(old).map_err(failure)?;
    let pinned = lease.metadata().map_err(failure)?;
    if (actual.dev(), actual.ino()) != (pinned.dev(), pinned.ino()) {
        return Err("Old app changed during inspection".into());
    }
    Ok((lease, identity))
}

fn retire(
    request: &Request,
    path: &std::path::Path,
    connection: &Connection,
    target: &Runtime,
    trust: &pilot_desktop_updater::manifest::Trust,
) -> Result<Value, String> {
    let record = private_json(&path.with_extension("complete.json"))?;
    let service = bundled_service::lookup(connection, &record["operation"]).map_err(failure)?;
    let live =
        bundled_service::preflight(connection, target, &AtomicBool::new(false)).map_err(failure)?;
    let release = coordination::global_update(
        connection.location(),
        &record["release"],
        GlobalUpdateAction::Inspect,
    )
    .map_err(failure)?;
    require_retirement(
        (&request.source, &request.build, &request.operation),
        &record,
        &service,
        &live,
        &release,
        &target.replacement(),
    )?;
    let old = request
        .old_app
        .as_ref()
        .ok_or("Retirement requires explicit --old-app")?;
    if record["oldApp"] != json!(old) {
        return Err("Old app differs from the original handoff selection".into());
    }
    let retired = path.with_extension("retired.json");
    if retired.try_exists().map_err(failure)? {
        return Ok(
            json!({"state":"observed","retirement":private_json(&retired)?,"replayed":false}),
        );
    }
    let current = pilot_desktop_updater::layout::running_root().map_err(failure)?;
    let (lease, identity) = old_app_unused(old, &current, &request.profile, trust)?;
    if record["oldAppIdentity"] != identity {
        return Err("Old app bytes changed since handoff; nothing retired".into());
    }
    let intent = path.with_extension("retirement.json");
    write_new(
        &intent,
        &json!({"state":"entered","oldApp":old,"operationId":request.operation}),
    )?;
    // Only the exact owned, sealed, separately selected app is removed. Never its parent or data folders.
    std::fs::remove_dir_all(old).map_err(failure)?;
    File::open(old.parent().ok_or("Old app has no parent")?)
        .and_then(|f| f.sync_all())
        .map_err(failure)?;
    drop(lease);
    let support = PathBuf::from(std::env::var_os("HOME").ok_or("HOME unavailable")?)
        .join("Library/Application Support");
    let mut stores = Vec::new();
    for name in [
        pilot_desktop_updater::runtime::SERVICE_STORE_NAME,
        pilot_desktop_updater::runtime::STORE_NAME,
    ] {
        let store = support.join(name);
        let result = match pilot_desktop_updater::runtime::cleanup_obsolete(&store, trust) {
            Ok(v) => json!({"store":store,"removed":v.removed,"preserved":v.preserved}),
            Err(e) => json!({"store":store,"preserved":true,"error":format!("{e:?}")}),
        };
        stores.push(result);
    }
    let result = json!({"state":"retired","oldApp":old,"stores":stores,"operationId":request.operation,
        "dataPreserved":true,"warning":"Unknown, live, other-profile and over-budget runtime entries are kept. No blanket deletion."});
    write_new(&retired, &result)?;
    Ok(result)
}

fn require_retirement(
    (source, build, operation): (&str, &str, &str),
    record: &Value,
    service: &Value,
    live: &Value,
    release: &Value,
    replacement: &Value,
) -> Result<(), String> {
    if record["state"] != "complete"
        || record["source"] != source
        || record["build"] != build
        || record["operation"]["operationId"] != operation
        || record["completion"]["role"] != "successor"
        || service["completion"] != record["completion"]
        || live["previousRuntime"] != replacement["runtimeRoot"]
        || live["boot"] != record["completion"]["boot"]
        || live["pid"] != record["completion"]["pid"]
        || *release != record["releaseReceipt"]
        || release["state"] != "accepted"
    {
        return Err("Retirement requires the original completed successor and accepted release, still current".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_cli_cannot_reach_service_authority() {
        for args in [
            vec![],
            vec!["apply"],
            vec!["restart"],
            vec![
                "inspect",
                "--profile",
                "/tmp/profile",
                "--profile",
                "/tmp/other",
            ],
        ] {
            assert!(Request::parse(args.into_iter().map(OsString::from).collect()).is_err());
        }
    }

    #[test]
    fn retirement_requires_successor_release_and_exact_live_identity() {
        let completion = json!({"role":"successor","boot":"boot","pid":42});
        let release = json!({"state":"accepted","operationId":"release"});
        let record = json!({"state":"complete","source":"source","build":"1","operation":{"operationId":"op"},"completion":completion,"releaseReceipt":release});
        let service = json!({"completion":completion});
        let live = json!({"previousRuntime":"/new/runtime","boot":"boot","pid":42});
        let replacement = json!({"runtimeRoot":"/new/runtime"});
        assert!(
            require_retirement(
                ("source", "1", "op"),
                &record,
                &service,
                &live,
                &release,
                &replacement
            )
            .is_ok()
        );
        for pointer in [
            "/state",
            "/source",
            "/build",
            "/operation/operationId",
            "/completion/role",
            "/completion/boot",
            "/completion/pid",
            "/releaseReceipt/state",
        ] {
            let mut changed = record.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert!(
                require_retirement(
                    ("source", "1", "op"),
                    &changed,
                    &service,
                    &live,
                    &release,
                    &replacement
                )
                .is_err(),
                "{pointer}"
            );
        }
        assert!(
            require_retirement(
                ("source", "1", "op"),
                &record,
                &service,
                &json!({"previousRuntime":"/old/runtime","boot":"boot","pid":42}),
                &release,
                &replacement
            )
            .is_err()
        );
    }

    #[test]
    fn retirement_intent_is_exclusive_and_never_overwrites_prior_evidence() {
        let dir = std::env::temp_dir().join(format!("day-retire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("retirement.json");
        write_new(&path, &json!({"state":"entered"})).unwrap();
        assert!(write_new(&path, &json!({"state":"complete"})).is_err());
        assert_eq!(private_json(&path).unwrap()["state"], "entered");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
