//! Existing Swift support contracts, with injected global override operations.
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::Write,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) fn lock_directory(directory: &Path) -> Option<File> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .ok()?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join("owner.lock"))
        .ok()?;
    // SAFETY: file owns a valid FD; nonblocking exclusive flock matches Swift and releases on close.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return None;
    }
    Some(file)
}

pub(crate) const PREPARATION_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const LEASE: Duration = Duration::from_secs(20);
pub(crate) const HEARTBEAT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(crate) struct SleepAcknowledgement {
    pub generation: u64,
    argument: Option<isize>,
}
impl SleepAcknowledgement {
    pub fn begin(&mut self, argument: isize) -> u64 {
        self.generation += 1;
        self.argument = Some(argument);
        self.generation
    }
    pub fn take(&mut self, generation: u64) -> Option<isize> {
        if generation == self.generation {
            self.argument.take()
        } else {
            None
        }
    }
    pub fn woke(&mut self) {
        self.argument = None;
    }
}

pub(crate) trait OverrideWriter {
    fn read_disabled(&mut self) -> Option<bool>;
    fn write_disabled(&mut self, enabled: bool) -> bool;
}

pub(crate) struct SleepOverride<W> {
    marker: PathBuf,
    confirmed: bool,
    pub writer: W,
}
impl<W: OverrideWriter> SleepOverride<W> {
    pub fn new(marker: PathBuf, writer: W) -> Self {
        Self {
            marker,
            confirmed: false,
            writer,
        }
    }
    pub fn owns_override(&self) -> bool {
        self.marker.exists()
    }
    pub fn set_enabled(&mut self, enabled: bool) -> bool {
        if !enabled {
            if !self.owns_override() {
                return true;
            }
            if !self.writer.write_disabled(false) {
                return false;
            }
            self.confirmed = false;
            return fs::remove_file(&self.marker).is_ok();
        }
        if self.owns_override() {
            if !self.confirmed {
                self.confirmed = self.writer.write_disabled(true);
            }
            return self.confirmed;
        }
        if self.writer.read_disabled() != Some(false) {
            return false;
        }
        // Atomic marker publication before pmset, including uncertain writes, just as in Swift.
        let temporary = self
            .marker
            .with_extension(format!("{}.tmp", std::process::id()));
        let written = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(b"owned\n")?;
            fs::rename(&temporary, &self.marker)?;
            fs::set_permissions(&self.marker, fs::Permissions::from_mode(0o600))
        })();
        if written.is_err() {
            let _ = fs::remove_file(temporary);
            return false;
        }
        self.confirmed = self.writer.write_disabled(true);
        self.confirmed
    }
}

pub(crate) fn permission_rule(uid: u32) -> String {
    format!(
        "#{uid} ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0"
    )
}
pub(crate) fn install_script(uid: u32) -> String {
    format!(
        "set -eu; /bin/mkdir -p /etc/sudoers.d; tmp=$(/usr/bin/mktemp /etc/sudoers.d/.pilot-power.XXXXXX); trap '/bin/rm -f \"$tmp\"' EXIT; /usr/bin/printf '%s\\n' '{}' > \"$tmp\"; /usr/sbin/chown root:wheel \"$tmp\"; /bin/chmod 0440 \"$tmp\"; /usr/sbin/visudo -c -f \"$tmp\"; /bin/mv -f \"$tmp\" /etc/sudoers.d/pilot-power",
        permission_rule(uid)
    )
}
pub(crate) fn permission_ready(ok: bool, listing: &str) -> bool {
    ok && listing
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .contains("NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0")
}

pub(crate) fn sudo_arguments(on: bool) -> [&'static str; 5] {
    [
        "-n",
        "-k",
        "/usr/bin/pmset",
        "disablesleep",
        if on { "1" } else { "0" },
    ]
}
pub(crate) fn authorization_script(uid: u32) -> String {
    let script = install_script(uid)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!(
        "do shell script \"{script}\" with administrator privileges with prompt \"Allow Pilot to keep working with the lid closed. Only two sleep commands are authorized.\""
    )
}
pub(crate) fn sleep_disabled(ok: bool, report: &str) -> Option<bool> {
    ok.then(|| {
        report.match_indices("SleepDisabled").any(|(index, _)| {
            let rest = &report[index + "SleepDisabled".len()..];
            rest.starts_with(char::is_whitespace) && rest.trim_start().starts_with('1')
        })
    })
}

/// Same lid-specific exclusions as the Swift helper, not ordinary idle assertions.
pub(crate) fn protects_lid(assertion: &serde_json::Value) -> bool {
    let kind = assertion["AssertType"].as_str();
    (kind.is_none()
        || matches!(
            kind,
            Some("UserIsActive" | "DisplayWake" | "PreventSystemSleep")
        ))
        && (json_bool(&assertion["AppliesOnLidClose"]) == Some(true)
            || json_bool(&assertion["ProcessingHotPlug"]) == Some(true))
        && assertion["AssertLevel"]
            .as_i64()
            .or_else(|| assertion["AssertLevel"].as_bool().map(i64::from))
            != Some(0)
}
pub(crate) fn json_bool(value: &serde_json::Value) -> Option<bool> {
    value.as_bool().or_else(|| match value.as_i64() {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None,
    })
}
