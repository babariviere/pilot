//! Fixed authorization commands and per-user ownership. Never use PILOT_HOME or GUI paths.
use super::{cf_bool, ffi::*, property};
use crate::{
    guardian::LidSleep,
    support::{self, OverrideWriter, SleepOverride},
};
use core_foundation::{
    array::CFArray,
    base::{CFType, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use serde_json::{Value, json};
use std::{
    ffi::CStr,
    fs::File,
    io::Read,
    os::fd::AsRawFd,
    path::PathBuf,
    process::{Command, Stdio},
    ptr,
    time::{Duration, Instant},
};

fn command(file: &str, args: &[&str], timeout: Duration) -> (bool, String) {
    let Ok(mut child) = Command::new(file)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return (false, String::new());
    };
    let mut stdout = child.stdout.take().expect("command stdout piped");
    // SAFETY: stdout owns a valid pipe FD. Nonblocking drain avoids waiting for full reads or descendants' EOF.
    let nonblocking = unsafe {
        let flags = libc::fcntl(stdout.as_raw_fd(), libc::F_GETFL);
        flags >= 0 && libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) == 0
    };
    if !nonblocking {
        let _ = child.kill();
        let _ = child.wait();
        return (false, String::new());
    }
    let mut data = Vec::new();
    let mut drain = |data: &mut Vec<u8>| {
        let mut bytes = [0; 4096];
        loop {
            match stdout.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    let keep = count.min(65536 - data.len());
                    data.extend_from_slice(&bytes[..keep]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    };
    let start = Instant::now();
    let ok = loop {
        drain(&mut data);
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Err(_) => break false,
            _ => {}
        }
        if start.elapsed() >= timeout {
            // SAFETY: child.id is our unreaped fixed-command child, not an arbitrary process.
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    drain(&mut data);
    (ok, String::from_utf8_lossy(&data).into_owned())
}
pub(super) fn permission_ready() -> bool {
    let (ok, listing) = command("/usr/bin/sudo", &["-n", "-k", "-l"], Duration::from_secs(5));
    support::permission_ready(ok, &listing)
}
pub(super) fn authorize() -> bool {
    // SAFETY: getuid has no preconditions; only the numeric UID enters the fixed script.
    let apple = support::authorization_script(unsafe { libc::getuid() });
    command(
        "/usr/bin/osascript",
        &["-e", &apple],
        Duration::from_secs(115),
    )
    .0 && permission_ready()
}
pub(super) struct NativeWriter;
impl OverrideWriter for NativeWriter {
    fn read_disabled(&mut self) -> Option<bool> {
        let (ok, report) = command("/usr/bin/pmset", &["-g"], Duration::from_secs(5));
        support::sleep_disabled(ok, &report)
    }
    fn write_disabled(&mut self, on: bool) -> bool {
        command(
            "/usr/bin/sudo",
            &support::sudo_arguments(on),
            Duration::from_secs(5),
        )
        .0
    }
}
impl LidSleep for NativeWriter {
    fn restore_lid_sleep(&mut self) {
        for _ in 0..6 {
            if sleep_closed_lid() {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
fn user_home() -> Option<PathBuf> {
    // SAFETY: getpwuid_r fills our passwd and buffer; pw_dir is read before that buffer is dropped.
    unsafe {
        let mut entry: libc::passwd = std::mem::zeroed();
        let mut result = ptr::null_mut();
        let mut buffer = vec![0; 16384];
        if libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
            || entry.pw_dir.is_null()
        {
            return None;
        }
        use std::os::unix::ffi::OsStrExt;
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(
            CStr::from_ptr(entry.pw_dir).to_bytes(),
        )))
    }
}
pub(super) fn override_lock() -> Option<(File, SleepOverride<NativeWriter>)> {
    let directory = user_home()?.join("Library/Application Support/Pilot/Power");
    let file = support::lock_directory(&directory)?;
    Some((
        file,
        SleepOverride::new(directory.join("override"), NativeWriter),
    ))
}

pub(super) fn sleep_closed_lid() -> bool {
    // SAFETY: IOKit returns owned service and connection handles; every early exit releases them below.
    unsafe {
        let root = IOServiceGetMatchingService(0, IOServiceMatching(c"IOPMrootDomain".as_ptr()));
        if root == 0 {
            return false;
        }
        let closed = property(root, "AppleClamshellState")
            .as_ref()
            .and_then(cf_bool);
        let causes_sleep = property(root, "AppleClamshellCausesSleep")
            .as_ref()
            .and_then(cf_bool);
        IOObjectRelease(root);
        if closed != Some(true) || causes_sleep != Some(true) {
            return true;
        }
        let mut snapshot = ptr::null();
        if IOPMCopyAssertionsByProcess(&mut snapshot) != 0 || snapshot.is_null() {
            return false;
        }
        let processes = CFDictionary::<CFType, CFType>::wrap_under_create_rule(snapshot);
        for raw in processes.get_keys_and_values().1 {
            let Some(array) = CFType::wrap_under_get_rule(raw).downcast::<CFArray>() else {
                return false;
            };
            for raw in array.iter() {
                let Some(entry) = CFType::wrap_under_get_rule(*raw).downcast::<CFDictionary>()
                else {
                    return false;
                };
                let mut value = serde_json::Map::new();
                for key in [
                    "AssertType",
                    "AppliesOnLidClose",
                    "ProcessingHotPlug",
                    "AssertLevel",
                ] {
                    if let Some(v) = entry.find(CFString::new(key).as_CFTypeRef()) {
                        let v = CFType::wrap_under_get_rule(*v);
                        let converted = if let Some(v) = v.downcast::<CFString>() {
                            json!(v.to_string())
                        } else if let Some(v) = v.downcast::<CFBoolean>() {
                            json!(bool::from(v))
                        } else if let Some(v) = v.downcast::<CFNumber>() {
                            json!(v.to_i64())
                        } else {
                            Value::Null
                        };
                        value.insert(key.into(), converted);
                    }
                }
                if support::protects_lid(&Value::Object(value)) {
                    return true;
                }
            }
        }
        let connection = IOPMFindPowerManagement(0);
        if connection == 0 {
            return false;
        }
        let ok = IOPMSleepSystem(connection) == 0;
        IOServiceClose(connection);
        ok
    }
}
