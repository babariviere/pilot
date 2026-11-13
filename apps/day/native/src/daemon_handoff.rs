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
}
impl Request {
    fn parse(args: Vec<OsString>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let action = args
            .next()
            .and_then(|s| s.into_string().ok())
            .ok_or("missing action")?;
        if !["preflight", "apply", "inspect"].contains(&action.as_str()) {
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
        if !values.is_empty()
            || !profile.is_absolute()
            || !saved.is_absolute()
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
        return Ok(json!({"state":"observed","record":record,"service":service,
            "release":release,"complete":complete,"releaseReceipt":release_receipt,"replayed":false}));
    }
    let preflight = bundled_service::preflight(&connection, &target, &cancel).map_err(failure)?;
    if request.action == "preflight" {
        return Ok(json!({"state":"ready","service":preflight,"changed":false}));
    }
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
        "operation":operation,"preflight":preflight,"savedState":request.saved,"captureHash":digest(&bytes)});
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
}
