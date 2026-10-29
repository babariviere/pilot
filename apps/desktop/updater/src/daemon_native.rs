//! Native primitives shared by the two narrow user-service adapters.
use super::Failure;
use crate::{
    coordination::{self, Location},
    installer,
};
use ring::hmac;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn verified<T>(r: Result<T, crate::Error>) -> Result<T, Failure> {
    r.map_err(|_| Failure::Unverified)
}
fn io<T>(r: std::io::Result<T>) -> Result<T, Failure> {
    r.map_err(|_| Failure::Unverified)
}
pub(super) fn lock(location: &Location) -> Result<fs::File, Failure> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    };
    io(fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&location.home))?;
    let profile = io(fs::symlink_metadata(&location.home))?;
    if !profile.is_dir()
        || profile.uid() != unsafe { libc::geteuid() }
        || profile.mode() & 0o077 != 0
        || io(location.home.canonicalize())? != location.home
    {
        return Err(Failure::Unverified);
    }
    verified(installer::acl_policy(&location.home, 2))?;
    let file = io(fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(location.home.join(".daemon-upgrade.lock")))?;
    let meta = io(file.metadata())?;
    // SAFETY: permanent owned descriptor, nonblocking lock, released only on close.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
        || unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err(Failure::Busy);
    }
    Ok(file)
}
pub(super) fn no_incomplete_handoff(location: &Location) -> Result<(), Failure> {
    let path = location.home.join(".daemon-upgrade.json");
    if path.try_exists().map_err(|_| Failure::Unverified)?
        && verified(coordination::private_json(&path, 65536))?["phase"] != "complete"
    {
        return Err(Failure::Unknown);
    }
    Ok(())
}
pub(super) fn fresh_profile(location: &Location) -> Result<(), Failure> {
    // First registration cannot adopt an unguarded legacy profile whose old
    // daemon might use another listener. Existing services use the handoff path.
    for entry in io(fs::read_dir(&location.home))? {
        if io(entry)?.file_name() != ".daemon-upgrade.lock" {
            return Err(Failure::Unsupported);
        }
    }
    Ok(())
}
pub(super) fn journal(location: &Location, value: &Value) -> Result<(), Failure> {
    let temp = location.home.join(format!(
        ".daemon-upgrade-{}.pending",
        verified(coordination::random_hex())?
    ));
    verified(installer::write_new(
        &temp,
        &serde_json::to_vec(value).map_err(|_| Failure::Unverified)?,
    ))?;
    io(fs::rename(
        &temp,
        location.home.join(".daemon-upgrade.json"),
    ))?;
    io(io(fs::File::open(&location.home))?.sync_all())
}
pub(super) fn registration_intent(location: &Location, root: &Path) -> Result<(), Failure> {
    journal(location, &serde_json::json!({"schema":1,"phase":"registering","capsule":root,"profile":location.home,"port":location.port})).map_err(|_|Failure::Unknown)
}
pub(super) fn registration_complete(location: &Location) -> Result<(), Failure> {
    let mut value = verified(coordination::private_json(
        &location.home.join(".daemon-upgrade.json"),
        65536,
    ))?;
    value["phase"] = serde_json::json!("complete");
    journal(location, &value).map_err(|_| Failure::Unknown)
}
pub(super) fn running(location: &Location, root: &Path) -> Result<Value, Failure> {
    let owner = verified(coordination::record(location))?;
    let expected: Value = serde_json::from_slice(&io(fs::read(
        root.join(crate::layout::RUNTIME).join("runtime-build.json"),
    ))?)
    .map_err(|_| Failure::Unverified)?;
    let pid = owner["pid"]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| *n > 1)
        .ok_or(Failure::Unverified)?;
    if owner["runtimeRoot"].as_str() != root.join(crate::layout::RUNTIME).to_str()
        || owner["build"] != expected
        || !coordination::owner_live(&location.home)
        || verified(crate::helper::process_executable(pid))?
            != io(root
                .join(crate::layout::RUNTIME)
                .join("node/bin/node")
                .canonicalize())?
    {
        return Err(Failure::Unverified);
    }
    let daemon = io(fs::read_to_string(location.home.join("daemon-id")))?;
    let lineage = io(fs::read_to_string(location.home.join("storage-lineage")))?;
    prove(location, &owner, daemon.trim(), lineage.trim())?;
    Ok(owner)
}
pub(super) fn wait_registered(location: &Location, root: &Path) -> Result<Value, Failure> {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(owner) = running(location, root) {
            return Ok(owner);
        }
        if Instant::now() >= end {
            return Err(Failure::Unknown);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
pub(super) fn command(program: &str, args: &[&std::ffi::OsStr]) -> Result<Vec<u8>, Failure> {
    let mut child = io(Command::new(program)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .envs(if program == "/usr/bin/systemctl" {
            ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
                .into_iter()
                .filter_map(|k| std::env::var_os(k).map(|v| (k, v)))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        })
        .spawn())?;
    let timeout = if args
        .iter()
        .any(|a| *a == std::ffi::OsStr::new("bootout") || *a == std::ffi::OsStr::new("stop"))
    {
        150
    } else {
        15
    };
    let end = Instant::now() + Duration::from_secs(timeout);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut bytes = Vec::new();
                io(child
                    .stdout
                    .take()
                    .ok_or(Failure::Unverified)?
                    .take(65537)
                    .read_to_end(&mut bytes))?;
                return if bytes.len() <= 65536 {
                    Ok(bytes)
                } else {
                    Err(Failure::Unverified)
                };
            }
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Unverified);
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub(super) fn plist(path: &Path) -> Result<Value, Failure> {
    let data = command(
        "/usr/bin/plutil",
        &[
            "-convert".as_ref(),
            "json".as_ref(),
            "-o".as_ref(),
            "-".as_ref(),
            path.as_os_str(),
        ],
    )?;
    serde_json::from_slice(&data).map_err(|_| Failure::Unverified)
}
pub(super) fn private_regular(path: &Path) -> Result<fs::Metadata, Failure> {
    let meta = io(fs::symlink_metadata(path))?;
    // SAFETY: current identity query only. No other user's service is admitted.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o022 != 0
        || meta.len() > 65536
    {
        return Err(Failure::Unverified);
    }
    verified(installer::acl_policy(path, 2))?;
    Ok(meta)
}
// Ordinary runtime attestation binds the live boot/profile/hello, even for build:null.
// It is NOT retained-runtime proof and does not grant the private updater endpoint.
pub(super) fn prove(
    location: &Location,
    expected: &Value,
    daemon: &str,
    lineage: &str,
) -> Result<(), Failure> {
    let fresh = verified(coordination::record(location))?;
    if &fresh != expected {
        return Err(Failure::Unverified);
    }
    let nonce = verified(coordination::random_hex())?;
    let secret = fresh["secret"].as_str().ok_or(Failure::Unverified)?;
    let key = (0..64)
        .step_by(2)
        .map(|ix| u8::from_str_radix(&secret[ix..ix + 2], 16).map_err(|_| Failure::Unverified))
        .collect::<Result<Vec<_>, _>>()?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Failure::Unverified)?;
    let mut response = client
        .get(format!(
            "http://127.0.0.1:{}/__pilot_runtime/v1?challenge={nonce}",
            location.port
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| Failure::Unverified)?;
    let mut bytes = Vec::new();
    io(response.by_ref().take(16385).read_to_end(&mut bytes))?;
    if bytes.len() > 16384 {
        return Err(Failure::Unverified);
    }
    let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unverified)?;
    let body = envelope["body"].as_str().ok_or(Failure::Unverified)?;
    let mac = envelope["mac"]
        .as_str()
        .filter(|v| v.len() == 64 && v.is_ascii())
        .ok_or(Failure::Unverified)?;
    let signature = (0..64)
        .step_by(2)
        .map(|ix| u8::from_str_radix(&mac[ix..ix + 2], 16).map_err(|_| Failure::Unverified))
        .collect::<Result<Vec<_>, _>>()?;
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, &key),
        body.as_bytes(),
        &signature,
    )
    .map_err(|_| Failure::Unverified)?;
    let body: Value = serde_json::from_str(body).map_err(|_| Failure::Unverified)?;
    if body["schema"] != 1
        || body["challenge"] != nonce
        || body["ready"] != true
        || body["hello"]["daemonId"] != daemon
        || body["hello"]["lineageId"] != lineage
        || body["hello"]["capabilities"]["independentExecution"] != true
        || body["hello"]["protocolVersion"]
            .as_u64()
            .is_none_or(|v| v < 1)
        || body["hello"]["minimumClientProtocolVersion"]
            .as_u64()
            .is_none_or(|v| v != 1)
    {
        return Err(Failure::Unverified);
    }
    for field in ["boot", "home", "port", "pid", "build", "runtimeRoot"] {
        if body[field] != expected[field] {
            return Err(Failure::Unverified);
        }
    }
    if verified(coordination::record(location))? != fresh {
        return Err(Failure::Unverified);
    }
    Ok(())
}
