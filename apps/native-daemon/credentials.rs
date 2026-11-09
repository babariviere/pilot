//! Shared native app capability-file contract. Never registered in a script VM.
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

/// Read the existing daemon-issued, private, identity-bound Local capability.
pub fn capability(home: &Path, daemon: &str, lineage: &str) -> Result<String, &'static str> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(home.join("github-app-capability"))
        .map_err(|_| "Native authorization is unavailable.")?;
    let meta = file
        .metadata()
        .map_err(|_| "Native authorization is unavailable.")?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > 4096
    {
        return Err("Native authorization failed its private-file checks.");
    }
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read native authorization.")?;
    if bytes.len() > 4096 {
        return Err("Native authorization exceeds its limit.");
    }
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid native authorization.")?;
    if v["daemonId"] != daemon || v["lineageId"] != lineage {
        return Err("Native authorization belongs to another installation.");
    }
    v["token"]
        .as_str()
        .filter(|t| {
            t.len() == 64
                && t.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_owned)
        .ok_or("Invalid native authorization.")
}
