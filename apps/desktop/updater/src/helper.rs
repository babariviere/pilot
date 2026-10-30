//! Explicit two-phase helper handshake. Parent EOF/ordinary quit without COMMIT aborts.
use crate::{Error, installer::Staged, manifest::Trust};
#[cfg(all(target_os = "macos", feature = "native-macos"))]
use std::time::Instant;
#[cfg(any(
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
use std::{fs::File, path::PathBuf};
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

#[cfg(target_os = "linux")]
const SESSION_ENVIRONMENT: [&str; 11] = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
    "LIBGL_ALWAYS_SOFTWARE",
    "WGPU_BACKEND",
];
#[cfg(target_os = "linux")]
fn forward_session_environment(command: &mut Command) {
    for name in SESSION_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}
#[cfg(target_os = "linux")]
const SCOPE_LAUNCHER: &str = "/usr/bin/systemd-run";
#[cfg(target_os = "linux")]
const SCOPE_ARGS: [&str; 5] = ["--user", "--scope", "--quiet", "--collect", "--"];

/// True when this process runs in a systemd `.service` unit. Stopping a service kills
/// its whole cgroup once the main process exits; scopes and plain sessions do not.
#[cfg(target_os = "linux")]
pub(crate) fn in_service_cgroup(cgroup: &str) -> bool {
    cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .and_then(|path| path.trim_end().rsplit('/').next())
        .is_some_and(|unit| unit.ends_with(".service"))
}

/// The scope launcher, only when the app runs in a service and a probe proves it can
/// create a user scope. Otherwise the helper starts directly, as before.
#[cfg(target_os = "linux")]
fn own_scope_launcher() -> Option<&'static str> {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    if !in_service_cgroup(&cgroup) || !std::path::Path::new(SCOPE_LAUNCHER).is_file() {
        return None;
    }
    let mut probe = Command::new(SCOPE_LAUNCHER);
    probe
        .args(SCOPE_ARGS)
        .arg("/bin/true")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    forward_session_environment(&mut probe);
    let mut child = probe.spawn().ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success().then_some(SCOPE_LAUNCHER),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
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
        let executable = staged.target.join(crate::layout::HELPER);
        let metadata = std::fs::symlink_metadata(&executable).map_err(|_| Error::Unconfigured)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Error::Identity);
        }
        let (control, child_control) = UnixStream::pair().map_err(|_| Error::Native)?;
        control
            .set_read_timeout(Some(Duration::from_secs(
                if cfg!(all(target_os = "macos", feature = "native-macos")) {
                    // Full extraction/fsync moved before READY, not into blackout.
                    // This only bounds preparation; COMMIT/exit/lease gates are unchanged.
                    120
                } else {
                    30
                },
            )))
            .map_err(|_| Error::Native)?;
        control
            .set_write_timeout(Some(Duration::from_secs(1)))
            .map_err(|_| Error::Native)?;
        let control_fd = duplicate_high(child_control.as_raw_fd())?;
        let lock_fd = duplicate_high(staged.lock.as_raw_fd())?;
        let control_number = control_fd.as_raw_fd();
        let lock_number = lock_fd.as_raw_fd();
        // A desktop launcher may run the app as a systemd service, whose stop kills
        // every process in its cgroup, including this helper and the app it relaunches.
        // `systemd-run --scope` moves the helper into its own scope and then execs it in
        // place, keeping its parent and inherited descriptors.
        #[cfg(target_os = "linux")]
        let mut command = match own_scope_launcher() {
            Some(launcher) => {
                let mut command = Command::new(launcher);
                command.args(SCOPE_ARGS).arg(&executable);
                command
            }
            None => Command::new(&executable),
        };
        #[cfg(not(target_os = "linux"))]
        let mut command = Command::new(&executable);
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
        #[cfg(target_os = "linux")]
        forward_session_environment(&mut command);
        #[cfg(feature = "fixture")]
        if crate::fixture::enabled() {
            command.stderr(Stdio::inherit());
            command.env(
                "PILOT_NEXT_UPDATER_FIXTURE",
                std::env::var_os("PILOT_NEXT_UPDATER_FIXTURE").ok_or(Error::Identity)?,
            );
        }
        #[cfg(feature = "lifecycle-timings")]
        command.stderr(Stdio::inherit());
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
#[cfg(any(
    test,
    any(
        all(target_os = "macos", feature = "native-macos"),
        all(target_os = "linux", feature = "native-linux")
    )
))]
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
        bundle_name: crate::layout::BUNDLE.into(),
        public_key: bytes.try_into().map_err(|_| Error::Unconfigured)?,
        code_requirement: required(option_env!("PILOT_NEXT_UPDATER_CODE_REQUIREMENT"))?,
    };
    trust.validate()?;
    Ok(trust)
}

#[cfg(any(
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
pub fn run_native(
    root: PathBuf,
    control_fd: libc::c_int,
    lock_fd: libc::c_int,
) -> Result<(), Error> {
    #[cfg(feature = "fixture")]
    let validation_started = std::time::Instant::now();
    use crate::installer::{NativePlatform, Platform};
    let ready_timing = crate::timing::Phase::start();
    let trust = compiled_trust()?; // no journal access at all in development/unconfigured builds
    let executable = std::env::current_exe().map_err(|_| Error::Unconfigured)?;
    let target = executable
        .ancestors()
        .nth(crate::layout::HELPER.split('/').count())
        .ok_or(Error::Identity)?
        .canonicalize()
        .map_err(|_| Error::Filesystem)?;
    if executable != target.join(crate::layout::HELPER) {
        return Err(Error::Identity);
    }
    NativePlatform.verify(&target, &trust, &trust.current_build, None)?;
    #[cfg(feature = "fixture")]
    if crate::fixture::enabled() {
        eprintln!(
            "fixture-helper-target-verified-seconds={:.3}",
            validation_started.elapsed().as_secs_f64()
        );
    }
    // Watch only the real parent, and require the GUI binary in this very bundle.
    // A shell, a different application or an orphaned helper cannot authorize exit.
    // SAFETY: process identity query, bounded path buffer, no other process inspected.
    let parent_pid = unsafe { libc::getppid() };
    if parent_pid <= 1 {
        return Err(Error::Identity);
    }
    let watch = ParentWatch::new(parent_pid)?;
    let parent_executable = process_executable(parent_pid)?;
    #[cfg(feature = "fixture")]
    if crate::fixture::enabled() {
        eprintln!(
            "fixture-helper-parent-executable={parent_executable:?} expected={:?}",
            target.join(crate::layout::GUI)
        );
    }
    if parent_executable
        != target
            .join(crate::layout::GUI)
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
    verify_peer(control_fd, parent_pid)?;
    #[cfg(feature = "fixture")]
    if crate::fixture::enabled() {
        eprintln!("fixture-helper-peer-verified");
    }
    if unsafe { libc::getppid() } != parent_pid {
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
    #[cfg(feature = "fixture")]
    if crate::fixture::enabled() {
        eprintln!("fixture-helper-stage-reopened");
    }
    let _guard = crate::app_update::ExitGuard::load(
        &root,
        &crate::installer::preview_bundle(&root, &trust)?,
        staged.build(),
        &trust,
    )?;
    #[cfg(feature = "fixture")]
    if crate::fixture::enabled() {
        eprintln!(
            "fixture-helper-ready-seconds={:.3}",
            validation_started.elapsed().as_secs_f64()
        );
    }
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    let payload = staged.prepare_payload(&trust, &NativePlatform)?;
    // SAFETY: checked descriptor is the inherited private handshake socket.
    let mut control = unsafe { UnixStream::from_raw_fd(control_fd) };
    control
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|_| Error::Native)?;
    control
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| Error::Native)?;
    ready_timing.finish("helper_prepare");
    let commit_timing = crate::timing::Phase::start();
    if let Err(error) = await_commit(&mut control, &staged) {
        #[cfg(all(target_os = "macos", feature = "native-macos"))]
        payload.discard()?;
        let _ = control.write_all(b"ABORTED\n");
        return Err(error);
    }
    commit_timing.finish("commit_wait");
    let exit_timing = crate::timing::Phase::start();
    let exit = match watch.wait(Duration::from_secs(120)) {
        Ok(exit) => exit,
        Err(error) => {
            let _ = control.write_all(b"ABORTED\n");
            return Err(error);
        }
    };
    exit_timing.finish("parent_exit_wait");
    let check = |candidate: &std::path::Path| {
        // Successful verification after OS-observed parent exit proves the same
        // reservation remained uninterrupted through exit. Expiry/owner death
        // refuses installation even if COMMIT had already been acknowledged.
        crate::app_update::ExitGuard::load(&root, candidate, staged.build(), &trust).map(|_| ())
    };
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    {
        payload.apply_after_exit(&trust, &NativePlatform, exit, check)
    }
    #[cfg(all(target_os = "linux", feature = "native-linux"))]
    {
        staged.apply_after_exit_checked(&trust, &NativePlatform, exit, check)
    }
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

#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub(crate) fn process_executable(pid: libc::pid_t) -> Result<std::path::PathBuf, Error> {
    let mut bytes = [0_u8; 4096];
    if unsafe { libc::proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as _) } <= 0 {
        return Err(Error::Identity);
    }
    let end = bytes.iter().position(|b| *b == 0).ok_or(Error::Identity)?;
    use std::os::unix::ffi::OsStrExt;
    std::path::Path::new(std::ffi::OsStr::from_bytes(&bytes[..end]))
        .canonicalize()
        .map_err(|_| Error::Identity)
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub(crate) fn process_owned(pid: libc::pid_t) -> Result<(), Error> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: correctly sized output buffer, initialized only on complete read.
    if pid <= 1
        || unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as _,
            )
        } != size as i32
    {
        return Err(Error::Identity);
    }
    // SAFETY: proc_pidinfo returned the entire structure.
    let info = unsafe { info.assume_init() };
    // SAFETY: current user identity query only.
    let uid = unsafe { libc::geteuid() };
    if info.pbi_pid != pid as u32 || info.pbi_uid != uid || info.pbi_ruid != uid {
        return Err(Error::Identity);
    }
    Ok(())
}
#[cfg(all(target_os = "linux", feature = "native-linux"))]
pub(crate) fn process_executable(pid: libc::pid_t) -> Result<std::path::PathBuf, Error> {
    std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|_| Error::Identity)
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn verify_peer(fd: libc::c_int, _parent: libc::pid_t) -> Result<(), Error> {
    let mut peer = std::mem::MaybeUninit::<libc::sockaddr_storage>::zeroed();
    let mut length = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeername(fd, peer.as_mut_ptr().cast(), &mut length) } != 0
        || unsafe { peer.assume_init() }.ss_family as libc::c_int != libc::AF_UNIX
        || unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::geteuid() }
    {
        return Err(Error::Identity);
    }
    Ok(())
}
#[cfg(all(target_os = "linux", feature = "native-linux"))]
fn verify_peer(fd: libc::c_int, parent: libc::pid_t) -> Result<(), Error> {
    let mut peer = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            peer.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
    {
        return Err(Error::Identity);
    }
    let peer = unsafe { peer.assume_init() };
    if peer.pid != parent || peer.uid != unsafe { libc::geteuid() } {
        return Err(Error::Identity);
    }
    Ok(())
}
#[cfg(all(target_os = "linux", feature = "native-linux"))]
pub(crate) struct ParentWatch {
    process: OwnedFd,
}
#[cfg(all(target_os = "linux", feature = "native-linux"))]
impl ParentWatch {
    pub(crate) fn new(pid: libc::pid_t) -> Result<Self, Error> {
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if descriptor < 0 {
            return Err(Error::Native);
        }
        Ok(Self {
            process: unsafe { OwnedFd::from_raw_fd(descriptor as libc::c_int) },
        })
    }
    pub(crate) fn wait(self, timeout: Duration) -> Result<ExitedParent, Error> {
        let mut poll = libc::pollfd {
            fd: self.process.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let count = unsafe {
            libc::poll(
                &mut poll,
                1,
                timeout.as_millis().try_into().map_err(|_| Error::Native)?,
            )
        };
        if count != 1 || poll.revents & libc::POLLIN == 0 {
            return Err(Error::ParentStillRunning);
        }
        Ok(ExitedParent { _private: () })
    }
}
