//! Explicit two-phase helper handshake. Parent EOF/ordinary quit without COMMIT aborts.
use crate::{Error, installer::Staged, manifest::Trust};
#[cfg(all(target_os = "macos", feature = "native-macos"))]
use std::{fs::File, path::PathBuf, time::Instant};
use std::{
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    time::Duration,
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
    acknowledgement: Receiver<Result<(), Error>>,
}
impl PreparedExit {
    /// Worker-only. The helper verifies its own compiled trust root; no trust key in argv.
    pub fn launch(
        staged: &Staged,
        helper_stopped: impl Fn(Error) + Send + 'static,
    ) -> Result<Self, Error> {
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
        let control_number = control_fd.as_raw_fd();
        let lock_number = lock_fd.as_raw_fd();
        let mut command = Command::new(executable);
        command
            .arg("--transaction")
            .arg(&staged.root)
            .arg("--control-fd")
            .arg(control_number.to_string())
            .arg("--lock-fd")
            .arg(lock_number.to_string())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe fcntl after fork. Preserve owned high fds,
        // never clobber std::process's private exec-error pipe with dup2 destinations.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(control_fd.as_raw_fd(), libc::F_SETFD, 0) < 0
                    || libc::fcntl(lock_fd.as_raw_fd(), libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(|_| Error::Native)?;
        // Release closure-owned copies of the child's endpoint before waiting for
        // READY. Otherwise a failed child cannot produce EOF on our parent socket.
        drop(command);
        drop(child_control);
        let (receipt, acknowledgement) = mpsc::sync_channel(1);
        let mut prepared = Self {
            control,
            child,
            acknowledgement,
        };
        let mut ready = [0; 6];
        prepared
            .control
            .read_exact(&mut ready)
            .map_err(|_| Error::Native)?;
        if &ready != b"READY\n" {
            return Err(Error::Native);
        }
        prepared
            .control
            .set_read_timeout(None)
            .map_err(|_| Error::Native)?;
        let reader = prepared.control.try_clone().map_err(|_| Error::Native)?;
        std::thread::Builder::new()
            .name("updater-helper-status".into())
            .spawn(move || {
                watch_control(reader, receipt, helper_stopped);
            })
            .map_err(|_| Error::Native)?;
        Ok(prepared)
    }

    /// Call only after a FRESH exact-revision safety acknowledgement, with admission
    /// fences held through actual parent exit. A transport error is commit-uncertain.
    pub fn commit(&mut self) -> Result<(), Error> {
        self.control
            .write_all(b"COMMIT\n")
            .map_err(|_| Error::CommitUncertain)?;
        self.acknowledgement
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| Error::CommitUncertain)?
    }
}

pub(crate) fn watch_control(
    mut reader: impl Read,
    acknowledgement: SyncSender<Result<(), Error>>,
    stopped: impl Fn(Error),
) {
    loop {
        let mut frame = Vec::new();
        let mut byte = [0; 1];
        while frame.len() < 32 {
            if reader.read_exact(&mut byte).is_err() {
                let _ = acknowledgement.try_send(Err(Error::CommitUncertain));
                stopped(Error::RecoveryRequired);
                return;
            }
            frame.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        if frame == b"COMMITTED\n" {
            let _ = acknowledgement.try_send(Ok(()));
        } else {
            let _ = acknowledgement.try_send(Err(Error::CommitUncertain));
            stopped(if frame == b"ABORTED\n" {
                Error::Cancelled
            } else {
                Error::RecoveryRequired
            });
            return;
        }
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
#[cfg(any(test, all(target_os = "macos", feature = "native-macos")))]
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
    // COMMIT is already durable. A lost acknowledgement makes the parent uncertain,
    // but cannot silently undo the committed intent. Continue to the OS exit gate.
    let _ = control.write_all(b"COMMITTED\n");
    Ok(())
}

#[cfg(all(target_os = "macos", any(test, feature = "native-macos")))]
pub(crate) struct ParentWatch {
    queue: OwnedFd,
}
#[cfg(all(target_os = "macos", any(test, feature = "native-macos")))]
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
pub fn run_native(
    root: PathBuf,
    control_fd: libc::c_int,
    lock_fd: libc::c_int,
) -> Result<(), Error> {
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
    if control_fd < 10
        || lock_fd < 10
        || control_fd == lock_fd
        || unsafe { libc::fcntl(control_fd, libc::F_GETFD) } < 0
        || unsafe { libc::fcntl(lock_fd, libc::F_GETFD) } < 0
    {
        return Err(Error::Identity);
    }
    // SAFETY: restore close-on-exec on checked inherited descriptors before any
    // launcher is created, so /usr/bin/open cannot retain our lock or control pipe.
    if unsafe { libc::fcntl(control_fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || unsafe { libc::fcntl(lock_fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
    {
        return Err(Error::Native);
    }
    let mut peer = std::mem::MaybeUninit::<libc::sockaddr_storage>::zeroed();
    let mut peer_length = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    let mut peer_uid = 0;
    let mut peer_gid = 0;
    // SAFETY: bounded initialized output allocations and an already checked fd.
    if unsafe { libc::getpeername(control_fd, peer.as_mut_ptr().cast(), &mut peer_length) } != 0
        || unsafe { peer.assume_init() }.ss_family as libc::c_int != libc::AF_UNIX
        || unsafe { libc::getpeereid(control_fd, &mut peer_uid, &mut peer_gid) } != 0
        || peer_uid != unsafe { libc::geteuid() }
    {
        return Err(Error::Identity);
    }
    // SAFETY: checked descriptor is passed by PreparedExit; helper owns it now.
    let lock = unsafe { File::from_raw_fd(lock_fd) };
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
    let _guard = crate::coordination::Guard::load(
        &root,
        &root.join("payload").join(&trust.bundle_name),
        staged.build(),
        &trust,
    )?;
    // SAFETY: checked descriptor is the inherited private handshake socket.
    let mut control = unsafe { UnixStream::from_raw_fd(control_fd) };
    control
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|_| Error::Native)?;
    control
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| Error::Native)?;
    if let Err(error) = await_commit(&mut control, &staged) {
        let _ = control.write_all(b"ABORTED\n");
        return Err(error);
    }
    let exit = match watch.wait(Duration::from_secs(120)) {
        Ok(exit) => exit,
        Err(error) => {
            let _ = control.write_all(b"ABORTED\n");
            return Err(error);
        }
    };
    staged.apply_after_exit_checked(&trust, &MacPlatform, exit, |candidate| {
        // Successful verification after OS-observed parent exit proves the same
        // reservation remained uninterrupted through exit. Expiry/owner death
        // refuses installation even if COMMIT had already been acknowledged.
        crate::coordination::Guard::load(&root, candidate, staged.build(), &trust).map(|_| ())
    })
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub(crate) fn run_command(command: &mut Command, timeout: Duration) -> Result<(), Error> {
    run_command_checked(command, timeout, || Ok(()))
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub(crate) fn run_command_checked(
    command: &mut Command,
    timeout: Duration,
    check: impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
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
        if let Err(error) = check() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
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
