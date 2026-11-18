//! Local diagnostic log for Pilot Day.
//!
//! Writes JSON lines to `~/Library/Logs/Pilot/day.log`, beside the daemon's
//! `pilotd.log`. `PILOT_DAY_LOG_DIR` selects another directory (tests). The log
//! rotates at 1 MiB and keeps `day.log.1` to `day.log.3`. Files are private (0600).
//!
//! Collection stays off until verified service controls arrive. Only closed
//! event/error codes and numeric fields are recorded, never arbitrary strings.
//! A limited worker queue keeps filesystem work off the UI thread. Disable and
//! clear fence queued records; clear acknowledges only this process's writer.
use serde_json::{Map, Value};
use std::{
    fs::File,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 1024 * 1024;
const KEPT: usize = 3;
const MAX_TEXT: usize = 300;
const REDACTED: &str = "[redacted]";

struct Log {
    dir: PathBuf,
    file: File,
    size: u64,
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static WRITER: std::sync::OnceLock<Writer> = std::sync::OnceLock::new();
struct Writer {
    sender: std::sync::mpsc::SyncSender<LogWork>,
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    revoked: std::sync::Arc<std::sync::atomic::AtomicU64>,
}
enum LogWork {
    Event(u64, Vec<u8>),
    ConfirmOff(u64, u64, std::sync::mpsc::SyncSender<bool>),
    Control {
        token: u64,
        next: Option<Control>,
        confirmed_off: bool,
        clear: bool,
        reply: std::sync::mpsc::SyncSender<bool>,
    },
}
#[derive(Clone, PartialEq, Eq)]
struct Control {
    binding: String,
    epoch: u64,
}

impl Writer {
    fn confirm_off(&self, token: u64, authority: u64) -> bool {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.sender
            .send(LogWork::ConfirmOff(token, authority, tx))
            .is_ok()
            && rx.recv().unwrap_or(false)
    }
    fn new(dir: Option<PathBuf>) -> Self {
        let (sender, rx) = std::sync::mpsc::sync_channel(256);
        let generation = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let revoked = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let current = generation.clone();
        let hold = revoked.clone();
        let _ = std::thread::Builder::new()
            .name("day-log".into())
            .spawn(move || {
                let mut slot = None;
                let mut control: Option<Control> = None;
                let mut released = 0_u64;
                let mut applied = 0_u64;
                while let Ok(work) = rx.recv() {
                    match work {
                        LogWork::ConfirmOff(token, authority, reply) => {
                            // A newer observation may already be queued, but
                            // only a newer user revoke can supersede this exact
                            // receipt. Never erase a later applied consent.
                            if authority < hold.load(Ordering::SeqCst) {
                                let _ = reply.send(false);
                                continue;
                            }
                            released = released.max(authority);
                            if applied <= token {
                                slot = None;
                                control = None;
                                applied = token;
                            }
                            let _ = reply.send(true);
                        }
                        LogWork::Control {
                            token,
                            next,
                            confirmed_off,
                            clear,
                            reply,
                        } => {
                            if token != current.load(Ordering::SeqCst) {
                                let _ = reply.send(false);
                                continue;
                            }
                            slot = None;
                            let ok = !clear
                                || dir
                                    .clone()
                                    .or_else(directory)
                                    .is_some_and(|dir| clear_files(&dir).is_ok());
                            // A local Clear never grants collection or changes the
                            // verified watcher's latest consent. It only fences bytes.
                            if !clear {
                                if confirmed_off {
                                    released = released.max(token);
                                }
                                control = next;
                                applied = token;
                            }
                            let _ = reply.send(ok);
                        }
                        LogWork::Event(generation, bytes) => {
                            if hold.load(Ordering::SeqCst) > released {
                                continue;
                            }
                            let Some(dir) = dir.clone().or_else(directory) else {
                                continue;
                            };
                            let _ = write_event(
                                &mut slot,
                                &dir,
                                control.as_ref(),
                                generation,
                                current.load(Ordering::SeqCst),
                                &bytes,
                            );
                        }
                    }
                }
            });
        Self {
            sender,
            generation,
            revoked,
        }
    }
    fn admit(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
    fn revoke(&self) -> u64 {
        let token = self.admit();
        self.revoked.fetch_max(token, Ordering::SeqCst);
        token
    }
    fn configure(&self, token: u64, binding: &str, settings: &Value, clear: bool) -> bool {
        let supported = settings["nextDiagnostics"]["schemaVersion"] == 1
            && settings["nextDiagnostics"]["epoch"]
                .as_u64()
                .is_some_and(|n| n <= 281_474_976_710_655)
            && settings["localDiagnostics"].is_boolean();
        let next = if supported && settings["localDiagnostics"] == true {
            Some(Control {
                binding: binding.into(),
                epoch: settings["nextDiagnostics"]["epoch"].as_u64().unwrap_or(0),
            })
        } else {
            None
        };
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.sender
            .send(LogWork::Control {
                token,
                next,
                confirmed_off: supported && settings["localDiagnostics"] == false,
                clear,
                reply: tx,
            })
            .is_ok()
            && rx.recv().unwrap_or(false)
    }
}
fn writer() -> &'static Writer {
    WRITER.get_or_init(|| Writer::new(None))
}
fn write_event(
    slot: &mut Option<Log>,
    dir: &Path,
    control: Option<&Control>,
    generation: u64,
    current: u64,
    bytes: &[u8],
) -> std::io::Result<()> {
    if generation != current {
        return Ok(());
    }
    let Some(c) = control else { return Ok(()) };
    let mut value: Value = serde_json::from_slice(bytes)?;
    value["schemaVersion"] = 1.into();
    value["binding"] = c.binding.clone().into();
    value["epoch"] = c.epoch.into();
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    append(slot, dir, &bytes)
}

/// Installs the facade, but collection stays off until verified service controls arrive.
pub fn enable() {
    ENABLED.store(true, Ordering::SeqCst);
    if log::set_logger(&FACADE).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
}
struct Facade;
static FACADE: Facade = Facade;
impl log::Log for Facade {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        #[cfg(all(target_os = "macos", feature = "macos-host"))]
        if record.target() == "js" && record.level() == log::Level::Error {
            let message = record.args().to_string();
            if let Some(reason) = message.strip_prefix("stopped: ") {
                crate::macos_artifact::engine_stopped(reason);
            }
        }
        // Do not format or keep arbitrary JS/native messages. They may contain drafts or secrets.
        let name = match (record.target(), record.level()) {
            ("js", log::Level::Error) => "js.error",
            ("js", _) => "js.warning",
            (_, log::Level::Error) => "native.error",
            _ => "native.warning",
        };
        event(name, Value::Null);
    }
    fn flush(&self) {}
}

/// Changes the managed writer off the UI thread and waits for its queue fence.
/// Unknown controls stop collection. Clear only confirms this process's writer.
pub(crate) fn configure(token: u64, binding: &str, settings: &Value, clear: bool) -> bool {
    // Library/headless hosts never own the user's app writer.
    if !ENABLED.load(Ordering::SeqCst) {
        return false;
    }
    writer().configure(token, binding, settings, clear)
}

/// Reserve before asynchronous reads or scheduling; obsolete controls cannot undo it.
pub(crate) fn admit_control() -> u64 {
    if ENABLED.load(Ordering::SeqCst) {
        writer().admit()
    } else {
        0
    }
}
/// A user hold takes effect before filesystem or service work.
pub(crate) fn revoke_control() -> u64 {
    if ENABLED.load(Ordering::SeqCst) {
        writer().revoke()
    } else {
        0
    }
}
/// Called only after the native owner verified an exact all-false service receipt.
pub(crate) fn confirm_off(token: u64, authority: u64) -> bool {
    ENABLED.load(Ordering::SeqCst) && writer().confirm_off(token, authority)
}
pub(crate) fn revoke_authority() -> u64 {
    if ENABLED.load(Ordering::SeqCst) {
        writer().revoked.load(Ordering::SeqCst)
    } else {
        0
    }
}

/// Appends only closed operational fields through a limited off-main queue.
pub fn event(event: &str, fields: Value) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let _ = writer().sender.try_send(LogWork::Event(
        writer().generation.load(Ordering::SeqCst),
        line(event, fields),
    ));
}
fn directory() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PILOT_DAY_LOG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = PathBuf::from(std::env::var_os("HOME").filter(|h| !h.is_empty())?);
    home.is_absolute().then(|| home.join("Library/Logs/Pilot"))
}
fn line(event: &str, fields: Value) -> Vec<u8> {
    let mut line = Map::new();
    line.insert("at".into(), now().into());
    line.insert("pid".into(), std::process::id().into());
    // The event catalogue is fixed. Unknown names cannot smuggle content.
    line.insert(
        "event".into(),
        match event {
            "startup" | "launch.selected" | "launch.refused" | "service.start" | "exit.failed"
            | "host.open" | "focus.changed" | "read.failed" | "refresh.failed"
            | "read.shape_error" | "connection.open" | "connection.lost" | "close.requested"
            | "close.refused" | "close.cancelled" | "close.seal_failed" | "close.timeout"
            | "handoff.requested" | "handoff.finished" | "handoff.stage" | "js.error"
            | "js.warning" | "native.error" | "native.warning" | "ui.error" | "forms.unsaved" => {
                event
            }
            // How long a project switch took to show the chosen project, and
            // why a scope read was refused.
            "scope.switch" | "scope.read_refused" => event,
            _ => "other",
        }
        .into(),
    );
    for key in ["generation", "protocol", "ms"] {
        if let Some(v) = fields
            .get(key)
            .filter(|v| v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
        {
            line.insert(key.into(), v.clone());
        }
    }
    if let Some(cause) = fields["cause"]
        .as_str()
        .filter(|c| matches!(*c, "catalog_changed" | "project_gone"))
    {
        line.insert("cause".into(), cause.into());
    }
    // A method or read name only, such as "day.delivery.read": letters and dots, never content.
    if let Some(command) = fields["command"].as_str().filter(|c| {
        !c.is_empty() && c.len() <= 48 && c.bytes().all(|b| b.is_ascii_alphabetic() || b == b'.')
    }) {
        line.insert("command".into(), command.into());
    }
    for key in ["wasConnected", "update"] {
        if let Some(v) = fields.get(key).filter(|v| v.is_boolean()) {
            line.insert(key.into(), v.clone());
        }
    }
    if let Some(error) = fields["error"].as_str().filter(|e| {
        matches!(
            *e,
            "Identity"
                | "Offline"
                | "Unavailable"
                | "Invalid"
                | "Stale"
                | "Storage"
                | "Unknown"
                | "Closed"
                | "Busy"
                | "Capacity"
                | "focus"
                | "thread"
        )
    }) {
        line.insert("error".into(), error.into());
    }
    let mut bytes = serde_json::to_vec(&Value::Object(line)).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}
fn append(slot: &mut Option<Log>, dir: &Path, line: &[u8]) -> std::io::Result<()> {
    if slot.as_ref().is_some_and(|log| log.dir != dir) {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(open(dir)?);
    }
    if slot
        .as_ref()
        .is_some_and(|log| log.size > 0 && log.size + line.len() as u64 > MAX_BYTES)
    {
        *slot = None;
        rotate(dir)?;
    }
    if slot.is_none() {
        *slot = Some(open(dir)?);
    }
    if let Some(log) = slot.as_mut() {
        log.file.write_all(line)?;
        log.size += line.len() as u64;
    }
    Ok(())
}

fn safe_directory(dir: &Path) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let mut current = File::open("/")?;
    for part in dir.components() {
        let std::path::Component::Normal(name) = part else {
            if part == std::path::Component::RootDir {
                continue;
            }
            return Err(std::io::ErrorKind::PermissionDenied.into());
        };
        let name = std::ffi::CString::new(name.as_encoded_bytes())?;
        // SAFETY: owned dirfd, NUL-terminated single component, fixed private mode.
        unsafe {
            libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700);
        }
        // SAFETY: owned dirfd and basename; no symlink traversal or blocking special files.
        let fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_NOFOLLOW
                    | libc::O_DIRECTORY
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a fresh owned descriptor.
        current = unsafe { File::from_raw_fd(fd) };
        let m = current.metadata()?;
        // macOS /var is a symlink; caller supplies canonical paths for test roots.
        if m.mode() & 0o022 != 0 && m.mode() & 0o1000 == 0 {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
    }
    // SAFETY: geteuid has no memory preconditions.
    if current.metadata()?.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    current.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    Ok(current)
}
fn open(dir: &Path) -> std::io::Result<Log> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let directory = safe_directory(dir)?;
    // SAFETY: owned dirfd, fixed basename and private mode, never follows links.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"day.log".as_ptr(),
            libc::O_WRONLY
                | libc::O_APPEND
                | libc::O_CREAT
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: openat returned a fresh owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata()?;
    // SAFETY: geteuid has no memory preconditions.
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(Log {
        dir: dir.into(),
        file,
        size: meta.len(),
    })
}
fn rotate(dir: &Path) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let directory = safe_directory(dir)?;
    for index in (0..KEPT).rev() {
        let from = std::ffi::CString::new(if index == 0 {
            "day.log".into()
        } else {
            format!("day.log.{index}")
        })?;
        let to = std::ffi::CString::new(format!("day.log.{}", index + 1))?;
        // SAFETY: same owned dirfd and fixed basenames. No traversal.
        if unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                from.as_ptr(),
                directory.as_raw_fd(),
                to.as_ptr(),
            )
        } < 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}
fn clear_files(dir: &Path) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let directory = safe_directory(dir)?;
    for index in 0..=KEPT {
        let name = std::ffi::CString::new(if index == 0 {
            "day.log".into()
        } else {
            format!("day.log.{index}")
        })?;
        // SAFETY: fixed basename beneath owned dirfd. unlinkat removes links, never their targets.
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } < 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    directory.sync_all()
}
/// RFC 3339 UTC with milliseconds.
fn now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs();
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60,
        elapsed.subsec_millis()
    )
}

/// Masks secret-looking values and keeps at most 300 characters.
/// Masks long hex or base64 runs, values after token, secret, password or
/// authorization keys, and bearer tokens. UUIDs stay readable. '/' separates
/// runs, so each path segment is judged alone.
pub fn redact(text: &str) -> String {
    let text = redact_keys(text);
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if is_token_byte(bytes[i]) {
            let end = i + bytes[i..].iter().take_while(|b| is_token_byte(**b)).count();
            let run = &text[i..end];
            out.push_str(if secret_run(run) { REDACTED } else { run });
            i = end;
        } else {
            let Some(ch) = text[i..].chars().next() else {
                break;
            };
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out.chars().take(MAX_TEXT).collect()
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'=' | b'_' | b'-')
}

fn secret_run(run: &str) -> bool {
    let core = run.trim_matches(|c| c == '=' || c == '-');
    if core.len() < 32 || is_uuid(core) {
        return false;
    }
    core.bytes().all(|b| b.is_ascii_hexdigit())
        || (core.bytes().any(|b| b.is_ascii_digit())
            && core.bytes().any(|b| b.is_ascii_alphabetic()))
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Replaces the value after a secret key (key=value, key: value) or "bearer".
fn redact_keys(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let (bytes, low) = (text.as_bytes(), lower.as_bytes());
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(start) = secret_value(low, i) {
            let end = start
                + bytes[start..]
                    .iter()
                    .take_while(|b| !b.is_ascii_whitespace() && !b"\"',;&}]".contains(b))
                    .count();
            out.push_str(&text[i..start]);
            if end > start {
                out.push_str(REDACTED);
            }
            i = end;
            continue;
        }
        let Some(ch) = text[i..].chars().next() else {
            break;
        };
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn secret_value(low: &[u8], i: usize) -> Option<usize> {
    let skip = |mut j: usize, f: fn(&u8) -> bool| {
        while low.get(j).is_some_and(f) {
            j += 1;
        }
        j
    };
    if low[i..].starts_with(b"bearer ") {
        let start = skip(i + 7, |b| *b == b' ');
        return (start < low.len()).then_some(start);
    }
    let key = ["token", "secret", "password", "authorization"]
        .iter()
        .find(|key| low[i..].starts_with(key.as_bytes()))?;
    let mut j = skip(i + key.len(), |b| {
        b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-'
    });
    j = skip(j, |b| matches!(b, b'"' | b'\'' | b' '));
    if !matches!(low.get(j), Some(b'=' | b':')) {
        return None;
    }
    j = skip(j + 1, |b| matches!(b, b'"' | b'\'' | b' '));
    for scheme in [&b"bearer "[..], b"basic "] {
        if low[j..].starts_with(scheme) {
            j = skip(j + scheme.len(), |b| *b == b' ');
        }
    }
    Some(j)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("day-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn rotates_at_one_mebibyte_and_keeps_three_private_files() {
        let dir = temp();
        let mut slot = None;
        let record = line("startup", serde_json::json!({"generation": 100}));
        let lines = (MAX_BYTES as usize / record.len()) * 5;
        for _ in 0..lines {
            append(&mut slot, &dir, &record).unwrap();
        }
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["day.log", "day.log.1", "day.log.2", "day.log.3"]);
        for name in &names {
            let meta = std::fs::metadata(dir.join(name)).unwrap();
            assert!(meta.len() <= MAX_BYTES, "{name}");
            assert_eq!(meta.mode() & 0o777, 0o600, "{name}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lines_are_private_json_with_redacted_strings() {
        let dir = temp().join("Logs");
        let mut slot = None;
        let hex = "ab".repeat(32);
        let record = line(
            "startup",
            serde_json::json!({"error": format!("failed token={hex}"), "port": 4319, "at": "spoof"}),
        );
        append(&mut slot, &dir, &record).unwrap();
        drop(slot);
        let meta = std::fs::metadata(dir.join("day.log")).unwrap();
        assert_eq!(meta.mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let text = std::fs::read_to_string(dir.join("day.log")).unwrap();
        assert!(!text.contains(&hex));
        let value: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(value["event"], "startup");
        assert_eq!(value["pid"], std::process::id());
        assert!(value.get("port").is_none());
        assert!(value.get("error").is_none());
        assert!(value["at"].as_str().unwrap().ends_with('Z'));
        assert_ne!(value["at"], "spoof");
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn symlinked_log_is_refused() {
        let dir = temp();
        let target = dir.join("elsewhere");
        std::fs::write(&target, "").unwrap();
        std::os::unix::fs::symlink(&target, dir.join("day.log")).unwrap();
        assert!(append(&mut None, &dir, b"{}\n").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn redacts_secret_looking_values() {
        let hex = "0123456789abcdef".repeat(4);
        assert_eq!(redact(&format!("key {hex} end")), "key [redacted] end");
        assert_eq!(redact("token=abc123"), "token=[redacted]");
        assert_eq!(
            redact("access_token: \"abc\" x"),
            "access_token: \"[redacted]\" x"
        );
        assert_eq!(
            redact("Password=hunter2&next=1"),
            "Password=[redacted]&next=1"
        );
        assert_eq!(
            redact("Authorization: Bearer abc.def"),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(redact("sent bearer xyz now"), "sent bearer [redacted] now");
        assert_eq!(
            redact("dGhpcyBpcyBhIHNlY3JldCB2YWx1ZTEyMzQ1Njc4OTA="),
            "[redacted]"
        );
        for kept in [
            "/Users/someone/Library/Application Support/Pilot Day/window-journal",
            "/Users/someone/.local/share/pilot",
            "/Users/x/Downloads/Pilot-20261114.205-3af8362b/Pilot.app",
            "8f14e45f-ceea-467f-a0a8-2c2b1f3b0c11",
            "token missing",
        ] {
            assert_eq!(redact(kept), kept);
        }
        assert_eq!(redact(&"é".repeat(400)).chars().count(), 300);
    }

    #[test]
    fn disable_and_clear_fence_queued_records_and_do_not_touch_other_copies() {
        let dir = temp();
        let mut slot = None;
        let c = Control {
            binding: "a".repeat(64),
            epoch: 7,
        };
        let bytes = line(
            "ui.error",
            serde_json::json!({"message":"private prompt without secret markers", "nested":{"password":"private"}, "error":"Unknown"}),
        );
        write_event(&mut slot, &dir, None, 0, 0, &bytes).unwrap();
        assert!(!dir.join("day.log").exists());
        write_event(&mut slot, &dir, Some(&c), 0, 1, &bytes).unwrap();
        assert!(!dir.join("day.log").exists());
        write_event(&mut slot, &dir, Some(&c), 1, 1, &bytes).unwrap();
        let text = std::fs::read_to_string(dir.join("day.log")).unwrap();
        assert!(!text.contains("private"));
        let row: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(row["epoch"], 7);
        assert_eq!(row["binding"], "a".repeat(64));
        slot = None;
        std::fs::write(dir.join("manual-export"), "kept").unwrap();
        clear_files(&dir).unwrap();
        write_event(&mut slot, &dir, Some(&c), 1, 2, &bytes).unwrap();
        assert!(!dir.join("day.log").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("manual-export")).unwrap(),
            "kept"
        );
        write_event(&mut slot, &dir, Some(&c), 2, 2, &bytes).unwrap();
        assert!(dir.join("day.log").exists());
        drop(slot);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn real_writer_queue_rejects_late_controls_and_requires_supported_consent() {
        let dir = temp();
        let w = Writer::new(Some(dir.clone()));
        let binding = "a".repeat(64);
        let on = serde_json::json!({"localDiagnostics":true,"nextDiagnostics":{"schemaVersion":1,"epoch":7}});
        let off = serde_json::json!({"localDiagnostics":false,"nextDiagnostics":{"schemaVersion":1,"epoch":8}});
        let old = w.admit();
        let stop = w.revoke();
        assert!(w.configure(stop, &binding, &Value::Null, false));
        assert!(
            !w.configure(old, &binding, &on, false),
            "late enable must not undo acknowledged stop"
        );
        let token = w.admit();
        assert!(w.configure(token, &binding, &on, false));
        w.sender
            .send(LogWork::Event(token, line("startup", Value::Null)))
            .unwrap();
        assert!(w.configure(token, &binding, &on, false));
        assert!(
            !dir.join("day.log").exists(),
            "old consent cannot lift the local user hold"
        );
        let token = w.admit();
        let mut unknown = off.clone();
        unknown["nextDiagnostics"]["schemaVersion"] = 2.into();
        assert!(w.configure(token, &binding, &unknown, false));
        let token = w.admit();
        assert!(w.configure(token, &binding, &on, false));
        w.sender
            .send(LogWork::Event(token, line("startup", Value::Null)))
            .unwrap();
        assert!(w.configure(token, &binding, &on, false));
        assert!(!dir.join("day.log").exists());
        let token = w.admit();
        assert!(w.configure(token, &binding, &off, false));
        let token = w.admit();
        assert!(w.configure(token, &binding, &on, false));
        w.sender
            .send(LogWork::Event(token, line("startup", Value::Null)))
            .unwrap();
        assert!(w.configure(token, &binding, &on, false));
        assert!(dir.join("day.log").exists());
        let clear = w.admit();
        assert!(w.configure(clear, &binding, &Value::Null, true));
        w.sender
            .send(LogWork::Event(token, line("startup", Value::Null)))
            .unwrap();
        assert!(w.configure(clear, &binding, &on, false));
        assert!(
            !dir.join("day.log").exists(),
            "clear fences old queued events"
        );
        let token = w.admit();
        let mut bad = on.clone();
        bad["nextDiagnostics"]["schemaVersion"] = 2.into();
        assert!(w.configure(token, &binding, &bad, false));
        w.sender
            .send(LogWork::Event(token, line("startup", Value::Null)))
            .unwrap();
        assert!(w.configure(token, &binding, &bad, false));
        assert!(!dir.join("day.log").exists());
        let revoke = w.revoke();
        assert!(w.configure(revoke, &binding, &Value::Null, false));
        let stale_read = w.admit();
        let receipt = w.admit();
        assert!(w.confirm_off(receipt, revoke));
        assert!(
            !w.configure(stale_read, &binding, &on, false),
            "off receipt fences older enabled reads"
        );
        let explicit_enable = w.admit();
        assert!(w.configure(explicit_enable, &binding, &on, false));
        w.sender
            .send(LogWork::Event(
                explicit_enable,
                line("startup", Value::Null),
            ))
            .unwrap();
        assert!(w.configure(explicit_enable, &binding, &on, false));
        assert!(
            dir.join("day.log").exists(),
            "new explicit consent works even when no off WS frame was observed"
        );
        let revoke = w.revoke();
        assert!(w.configure(revoke, &binding, &Value::Null, false));
        let receipt = w.admit();
        let later_observation = w.admit();
        assert!(w.configure(later_observation, &binding, &on, false));
        assert!(
            w.confirm_off(receipt, revoke),
            "an ordinary later observation must not lose the off receipt"
        );
        let before = std::fs::metadata(dir.join("day.log")).unwrap().len();
        w.sender
            .send(LogWork::Event(
                later_observation,
                line("startup", Value::Null),
            ))
            .unwrap();
        assert!(w.configure(later_observation, &binding, &on, false));
        assert!(
            std::fs::metadata(dir.join("day.log")).unwrap().len() > before,
            "later consent must append after the matching off receipt releases its hold"
        );
        let newer_revoke = w.revoke();
        assert!(w.configure(newer_revoke, &binding, &Value::Null, false));
        assert!(
            !w.confirm_off(w.admit(), revoke),
            "a historical receipt with a fresh fence cannot release a newer local revoke"
        );
        let old_lookup = crate::bridge::Command::DiagnosisCheck("older-revoke".into());
        let accepted = serde_json::json!({"outcome":{"state":"accepted"}});
        let release = crate::host::diagnosis::off_receipt_authority(&old_lookup, &accepted, revoke);
        assert_eq!(
            release, None,
            "the native caller must not remint release authority from an old lookup"
        );
        if let Some(authority) = release {
            w.confirm_off(w.admit(), authority);
        }
        let size = std::fs::metadata(dir.join("day.log")).unwrap().len();
        let token = w.admit();
        w.configure(token, &binding, &on, false);
        w.sender
            .send(LogWork::Event(token, line("startup", Value::Null)))
            .unwrap();
        w.configure(token, &binding, &on, false);
        assert_eq!(
            std::fs::metadata(dir.join("day.log")).unwrap().len(),
            size,
            "newer unresolved hold survives an accepted historical lookup through native release dispatch and real writer queue"
        );
        drop(w);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reopening_a_full_segment_rotates_before_the_first_append() {
        let dir = temp();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("day.log"), vec![b'x'; MAX_BYTES as usize]).unwrap();
        let mut slot = None;
        append(&mut slot, &dir, &line("startup", Value::Null)).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            std::fs::metadata(dir.join("day.log.1")).unwrap().len(),
            MAX_BYTES
        );
        assert!(std::fs::metadata(dir.join("day.log")).unwrap().len() < MAX_BYTES);
        drop(slot);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn timestamp_is_rfc3339_utc() {
        let at = now();
        assert_eq!(at.len(), 24, "{at}");
        assert!(at.starts_with("20") && &at[10..11] == "T" && at.ends_with('Z'));
    }
}
