//! Local diagnostic log for Pilot Day.
//!
//! Writes JSON lines to `~/Library/Logs/Pilot/day.log`, beside the daemon's
//! `pilotd.log`. `PILOT_DAY_LOG_DIR` selects another directory (tests). The log
//! rotates at 1 MiB and keeps `day.log.1` to `day.log.3`. Files are private (0600).
//!
//! Callers pass only launch facts, states, stages, identifiers and error kinds.
//! Never pass message contents, drafts, prompts, model output or credentials.
//! [`event`] also masks secret-looking text in every string field, but that is
//! a second guard, not permission to log content. Write errors are ignored.
use serde_json::{Map, Value};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
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

static LOG: Mutex<Option<Log>> = Mutex::new(None);
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Turns the home log on. Only the app executable calls this, so library and
/// integration tests never write to the user's log.
pub fn enable() {
    ENABLED.store(true, Ordering::SeqCst);
}

/// Appends one event. Never panics and never reports failure to the caller.
pub fn event(event: &str, fields: Value) {
    let Some(dir) = directory() else { return };
    let line = line(event, fields);
    let mut log = LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = append(&mut log, &dir, &line);
}

fn directory() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PILOT_DAY_LOG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if !ENABLED.load(Ordering::SeqCst) {
        return None;
    }
    let home = PathBuf::from(std::env::var_os("HOME").filter(|h| !h.is_empty())?);
    home.is_absolute().then(|| home.join("Library/Logs/Pilot"))
}

fn line(event: &str, fields: Value) -> Vec<u8> {
    let mut line = Map::new();
    line.insert("at".into(), now().into());
    line.insert("pid".into(), std::process::id().into());
    line.insert("event".into(), redact(event).into());
    match fields {
        Value::Object(fields) => {
            for (key, value) in fields {
                if !line.contains_key(&key) {
                    line.insert(key, redact_value(value));
                }
            }
        }
        Value::Null => {}
        value => {
            line.insert("value".into(), redact_value(value));
        }
    }
    let mut bytes = serde_json::to_vec(&Value::Object(line)).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_value).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, redact_value(v))).collect())
        }
        value => value,
    }
}

fn append(slot: &mut Option<Log>, dir: &Path, line: &[u8]) -> std::io::Result<()> {
    if slot.as_ref().is_some_and(|log| log.dir != dir) {
        *slot = None;
    }
    if slot
        .as_ref()
        .is_some_and(|log| log.size > 0 && log.size + line.len() as u64 > MAX_BYTES)
    {
        *slot = None;
        rotate(dir);
    }
    if slot.is_none() {
        *slot = Some(open(dir)?);
    }
    let Some(log) = slot.as_mut() else {
        return Ok(());
    };
    log.file.write_all(line)?;
    log.size += line.len() as u64;
    Ok(())
}

fn open(dir: &Path) -> std::io::Result<Log> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(dir.join("day.log"))?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    if meta.mode() & 0o777 != 0o600 {
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(Log {
        dir: dir.to_path_buf(),
        file,
        size: meta.len(),
    })
}

/// day.log -> day.log.1 -> day.log.2 -> day.log.3. The oldest is replaced.
fn rotate(dir: &Path) {
    for index in (1..KEPT).rev() {
        let _ = std::fs::rename(
            dir.join(format!("day.log.{index}")),
            dir.join(format!("day.log.{}", index + 1)),
        );
    }
    let _ = std::fs::rename(dir.join("day.log"), dir.join("day.log.1"));
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
/// authorization keys, and bearer tokens. UUIDs stay readable.
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
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'_' | b'-')
}

fn secret_run(run: &str) -> bool {
    let core = run.trim_matches(|c| c == '/' || c == '=' || c == '-');
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
        dir
    }

    #[test]
    fn rotates_at_one_mebibyte_and_keeps_three_private_files() {
        let dir = temp();
        let mut slot = None;
        let record = line("test", serde_json::json!({"fill": "x".repeat(200)}));
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
        assert_eq!(value["port"], 4319);
        assert_eq!(value["error"], "failed token=[redacted]");
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
            "8f14e45f-ceea-467f-a0a8-2c2b1f3b0c11",
            "token missing",
        ] {
            assert_eq!(redact(kept), kept);
        }
        assert_eq!(redact(&"é".repeat(400)).chars().count(), 300);
    }

    #[test]
    fn timestamp_is_rfc3339_utc() {
        let at = now();
        assert_eq!(at.len(), 24, "{at}");
        assert!(at.starts_with("20") && &at[10..11] == "T" && at.ends_with('Z'));
    }
}
