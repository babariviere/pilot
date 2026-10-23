//! Explicit two-phase helper handshake. Parent EOF/ordinary quit without COMMIT aborts.
use crate::{Error, installer::Staged, manifest::Trust};
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// Not constructible by an application. Created only by the native process-exit monitor.
pub struct ExitedParent {
    _private: (),
}
impl ExitedParent {
    pub(crate) fn consume(self) {}
    #[cfg(test)]
    pub(crate) fn synthetic() -> Self {
        Self { _private: () }
    }
}

pub struct PreparedExit {
    control: UnixStream,
    child: Child,
}
impl PreparedExit {
    /// Worker-only. The helper verifies its own compiled trust root; no trust key in argv.
    pub fn launch(staged: &Staged) -> Result<Self, Error> {
        let executable = staged
            .target
            .join("Contents/Helpers/pilot-desktop-update-helper");
        let metadata = std::fs::symlink_metadata(&executable).map_err(|_| Error::Unconfigured)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Error::Identity);
        }
        let (control, child_control) = UnixStream::pair().map_err(|_| Error::Native)?;
        control
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|_| Error::Native)?;
        control
            .set_write_timeout(Some(Duration::from_secs(1)))
            .map_err(|_| Error::Native)?;
        let control_fd = duplicate_high(child_control.as_raw_fd())?;
        let lock_fd = duplicate_high(staged.lock.as_raw_fd())?;
        let mut command = Command::new(executable);
        command
            .arg("--transaction")
            .arg(&staged.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: after fork only async-signal-safe libc dup2/fcntl calls. High source
        // fds cannot alias the fixed control3/lock4 destinations. Owned sources stay alive.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(control_fd.as_raw_fd(), 3) < 0
                    || libc::dup2(lock_fd.as_raw_fd(), 4) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(|_| Error::Native)?;
        drop(child_control);
        let mut prepared = Self { control, child };
        let mut ready = [0; 6];
        prepared
            .control
            .read_exact(&mut ready)
            .map_err(|_| Error::Native)?;
        if &ready != b"READY\n" {
            return Err(Error::Native);
        }
        Ok(prepared)
    }

    /// Call only after a FRESH exact-revision safety acknowledgement, with admission
    /// fences held through actual parent exit. A transport error is commit-uncertain.
    pub fn commit(&mut self) -> Result<(), Error> {
        self.control
            .write_all(b"COMMIT\n")
            .map_err(|_| Error::CommitUncertain)?;
        let mut receipt = [0; 10];
        self.control
            .read_exact(&mut receipt)
            .map_err(|_| Error::CommitUncertain)?;
        if &receipt != b"COMMITTED\n" {
            return Err(Error::CommitUncertain);
        }
        Ok(())
    }
}
impl Drop for PreparedExit {
    fn drop(&mut self) {
        // Before COMMIT this causes an abort. After COMMIT the helper still cannot
        // replace a bundle while this parent lives. Never kill/restart a user process.
        let _ = self.control.shutdown(std::net::Shutdown::Both);
        // Reap our own helper off-thread, without blocking the UI or dropping a zombie.
        // A duplicated wait handle is not available; move the actual Child out safely.
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        let pid = self.child.id();
        std::thread::spawn(move || {
            // SAFETY: PID identifies this process's owned child; waitpid only reaps it.
            unsafe {
                libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), 0);
            }
        });
    }
}

fn duplicate_high(fd: libc::c_int) -> Result<OwnedFd, Error> {
    // SAFETY: fcntl duplicates a valid borrowed fd, returning a fresh owned descriptor.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if duplicate < 0 {
        return Err(Error::Native);
    }
    // SAFETY: successful duplication transferred ownership to this scope.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

/// Pure protocol seam used by native helper and synthetic exit/ordinary-quit tests.
pub(crate) fn await_commit(
    control: &mut (impl Read + Write),
    staged: &Staged,
) -> Result<(), Error> {
    control.write_all(b"READY\n").map_err(|_| Error::Native)?;
    let mut message = [0; 7];
    control
        .read_exact(&mut message)
        .map_err(|_| Error::Cancelled)?;
    if &message != b"COMMIT\n" {
        return Err(Error::Cancelled);
    }
    staged.mark_committed()?;
    control
        .write_all(b"COMMITTED\n")
        .map_err(|_| Error::CommitUncertain)
}

#[cfg(target_os = "macos")]
pub(crate) struct ParentWatch {
    queue: OwnedFd,
}
#[cfg(target_os = "macos")]
impl ParentWatch {
    pub(crate) fn new(pid: libc::pid_t) -> Result<Self, Error> {
        // SAFETY: kqueue returns a new owned descriptor; NOTE_EXIT attaches to the
        // currently living process object, avoiding PID-reuse polling heuristics.
        let queue = unsafe { libc::kqueue() };
        if queue < 0 {
            return Err(Error::Native);
        }
        // SAFETY: queue is newly owned and nonnegative.
        let queue = unsafe { OwnedFd::from_raw_fd(queue) };
        let event = libc::kevent {
            ident: pid as usize,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: valid arrays and descriptor; no output events requested.
        if unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                &event,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(Error::Native);
        }
        Ok(Self { queue })
    }
    pub(crate) fn wait(self, timeout: Duration) -> Result<ExitedParent, Error> {
        let mut result = std::mem::MaybeUninit::<libc::kevent>::uninit();
        let timeout = libc::timespec {
            tv_sec: timeout.as_secs() as _,
            tv_nsec: 0,
        };
        // SAFETY: one properly allocated output slot and valid timeout pointer.
        let count = unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                std::ptr::null(),
                0,
                result.as_mut_ptr(),
                1,
                &timeout,
            )
        };
        if count != 1 {
            return Err(Error::ParentStillRunning);
        }
        // SAFETY: kevent returned exactly one initialized output event.
        let result = unsafe { result.assume_init() };
        if result.flags & libc::EV_ERROR != 0 || result.fflags & libc::NOTE_EXIT == 0 {
            return Err(Error::ParentStillRunning);
        }
        Ok(ExitedParent { _private: () })
    }
}

pub fn compiled_trust() -> Result<Trust, Error> {
    use base64::Engine as _;
    let required = |value: Option<&str>| value.map(str::to_owned).ok_or(Error::Unconfigured);
    let key = required(option_env!("PILOT_NEXT_UPDATER_PUBLIC_KEY"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| Error::Unconfigured)?;
    let trust = Trust {
        repository: required(option_env!("PILOT_NEXT_UPDATER_REPOSITORY"))?,
        application_id: required(option_env!("PILOT_NEXT_UPDATER_APPLICATION_ID"))?,
        channel: "desktop-stable".into(),
        current_build: required(option_env!("PILOT_NEXT_UPDATER_BUILD"))?,
        bundle_name: "Pilot Next.app".into(),
        public_key: bytes.try_into().map_err(|_| Error::Unconfigured)?,
        code_requirement: required(option_env!("PILOT_NEXT_UPDATER_CODE_REQUIREMENT"))?,
    };
    trust.validate()?;
    Ok(trust)
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub fn run_native(root: PathBuf) -> Result<(), Error> {
    use crate::installer::{MacPlatform, Platform};
    let trust = compiled_trust()?; // no journal access at all in development/unconfigured builds
    let executable = std::env::current_exe().map_err(|_| Error::Unconfigured)?;
    let target = executable
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name == trust.bundle_name.as_str())
        })
        .ok_or(Error::Identity)?
        .canonicalize()
        .map_err(|_| Error::Filesystem)?;
    MacPlatform.verify(&target, &trust, &trust.current_build, None)?;
    // Watch only the real parent, and require the GUI binary in this very bundle.
    // A shell, a different application or an orphaned helper cannot authorize exit.
    // SAFETY: process identity query, bounded path buffer, no other process inspected.
    let parent_pid = unsafe { libc::getppid() };
    if parent_pid <= 1 {
        return Err(Error::Identity);
    }
    let watch = ParentWatch::new(parent_pid)?;
    let mut parent_path = [0_u8; 4096];
    // SAFETY: buffer is initialized/writable and length matches allocation.
    let path_length = unsafe {
        libc::proc_pidpath(
            parent_pid,
            parent_path.as_mut_ptr().cast(),
            parent_path.len() as _,
        )
    };
    if path_length <= 0 {
        return Err(Error::Identity);
    }
    let path_end = parent_path
        .iter()
        .position(|b| *b == 0)
        .ok_or(Error::Identity)?;
    use std::os::unix::ffi::OsStrExt;
    let parent_executable =
        std::path::Path::new(std::ffi::OsStr::from_bytes(&parent_path[..path_end]))
            .canonicalize()
            .map_err(|_| Error::Identity)?;
    if parent_executable
        != target
            .join("Contents/MacOS/pilot-desktop")
            .canonicalize()
            .map_err(|_| Error::Identity)?
    {
        return Err(Error::Identity);
    }
    // SAFETY: check descriptor existence before taking ownership; arbitrary manual
    // invocation must fail normally, not trigger Rust's invalid-fd IO-safety abort.
    if unsafe { libc::fcntl(3, libc::F_GETFD) } < 0 || unsafe { libc::fcntl(4, libc::F_GETFD) } < 0
    {
        return Err(Error::Identity);
    }
    // SAFETY: fixed descriptors are passed by PreparedExit; helper owns them now.
    let lock = unsafe { File::from_raw_fd(4) };
    let expected = target
        .parent()
        .ok_or(Error::Filesystem)?
        .join(".pilot-next-updater.lock");
    use std::os::unix::fs::MetadataExt;
    let actual = lock.metadata().map_err(|_| Error::Filesystem)?;
    let expected = std::fs::symlink_metadata(expected).map_err(|_| Error::Filesystem)?;
    // SAFETY: lock is valid; this duplicates/retains the inherited open-description lock.
    if actual.ino() != expected.ino()
        || actual.dev() != expected.dev()
        || !expected.is_file()
        || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err(Error::Busy);
    }
    let staged = Staged::reopen(&root, &target, &trust, lock)?;
    // SAFETY: descriptor3 is the owned, inherited private handshake socket.
    let mut control = unsafe { UnixStream::from_raw_fd(3) };
    control
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|_| Error::Native)?;
    control
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| Error::Native)?;
    await_commit(&mut control, &staged)?;
    let exit = watch.wait(Duration::from_secs(120))?;
    staged.apply_after_exit(&trust, &MacPlatform, exit)
}

pub(crate) fn run_command(command: &mut Command, timeout: Duration) -> Result<(), Error> {
    let mut child = command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::Native)?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(Error::Native)
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Native);
            }
        }
    }
}
