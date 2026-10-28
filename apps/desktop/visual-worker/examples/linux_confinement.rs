//! Synthetic native qualification only. Never linked into the product helper.
#[cfg(target_os = "linux")]
#[path = "../src/isolation.rs"]
mod isolation;
#[cfg(target_os = "linux")]
#[path = "../src/watchdog.rs"]
mod watchdog;

#[cfg(target_os = "linux")]
fn main() {
    use std::{ffi::CString, io::Read, sync::mpsc};
    // The driver supplies only paths beneath its fresh fixture root.
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 5);
    let path = CString::new(args[1].as_bytes()).unwrap();
    let executable = CString::new(args[2].as_bytes()).unwrap();
    let mode = args[3].clone();
    let port = args[4].parse().unwrap();
    isolation::prepare().expect("prepare");
    let (go, ready) = mpsc::channel();
    let (report, result) = mpsc::channel();
    let (finish, finished) = mpsc::channel();
    let other_path = path.clone();
    let other_executable = executable.clone();
    let thread = std::thread::spawn(move || {
        ready.recv().unwrap();
        report
            .send(attacks(&other_path, &other_executable))
            .unwrap();
        finished.recv().unwrap();
    });
    let watchdog = watchdog::Watchdog::new().expect("watchdog");
    isolation::install().expect("install with TSYNC");
    // Exercise the production startup probes too, with an owned executable.
    assert!(isolation::probes(&executable, port));
    go.send(()).unwrap();
    let main = attacks(&path, &executable);
    let other = result.recv().unwrap();
    println!(
        "{}",
        serde_json::json!({"main": main, "preexisting_thread": other})
    );
    if mode == "watchdog" {
        watchdog.begin();
        loop {
            std::hint::spin_loop();
        }
    }
    assert_eq!(mode, "inspect");
    // Keep both pre-existing threads alive for independent /proc task checks.
    std::io::stdin().read_exact(&mut [0]).unwrap();
    watchdog.finish();
    finish.send(()).unwrap();
    thread.join().unwrap();
}

#[cfg(target_os = "linux")]
fn attacks(path: &std::ffi::CStr, executable: &std::ffi::CStr) -> serde_json::Value {
    use libc::*;
    let mut checks = serde_json::Map::new();
    let mut denied = |name: &str, result: c_long| {
        let errno = std::io::Error::last_os_error().raw_os_error();
        assert_eq!((result, errno), (-1, Some(EPERM)), "{name}");
        checks.insert(name.into(), serde_json::json!("EPERM"));
    };
    unsafe {
        denied(
            "open-read",
            syscall(SYS_openat, AT_FDCWD, path.as_ptr(), O_RDONLY, 0),
        );
        denied(
            "open-write",
            syscall(SYS_openat, AT_FDCWD, path.as_ptr(), O_WRONLY, 0),
        );
        denied(
            "create",
            syscall(
                SYS_openat,
                AT_FDCWD,
                path.as_ptr(),
                O_CREAT | O_EXCL | O_WRONLY,
                0o600,
            ),
        );
        denied("unlink", syscall(SYS_unlinkat, AT_FDCWD, path.as_ptr(), 0));
        denied(
            "rename",
            syscall(
                SYS_renameat,
                AT_FDCWD,
                path.as_ptr(),
                AT_FDCWD,
                path.as_ptr(),
            ),
        );
        denied(
            "mkdir",
            syscall(SYS_mkdirat, AT_FDCWD, path.as_ptr(), 0o700),
        );
        denied("socket-inet", syscall(SYS_socket, AF_INET, SOCK_STREAM, 0));
        denied(
            "socket-inet6",
            syscall(SYS_socket, AF_INET6, SOCK_STREAM, 0),
        );
        denied("socket-unix", syscall(SYS_socket, AF_UNIX, SOCK_STREAM, 0));
        let mut pair = [-1; 2];
        denied(
            "socketpair",
            syscall(SYS_socketpair, AF_UNIX, SOCK_STREAM, 0, pair.as_mut_ptr()),
        );
        // Invalid/closed descriptors still yield policy EPERM, not EBADF.
        denied(
            "connect",
            syscall(SYS_connect, 102, std::ptr::null::<c_void>(), 0),
        );
        denied(
            "sendto",
            syscall(
                SYS_sendto,
                102,
                c"x".as_ptr(),
                1,
                MSG_DONTWAIT,
                std::ptr::null::<c_void>(),
                0,
            ),
        );
        let argv = [executable.as_ptr(), std::ptr::null()];
        let envp = [std::ptr::null::<c_char>()];
        denied(
            "execve",
            syscall(
                SYS_execve,
                executable.as_ptr(),
                argv.as_ptr(),
                envp.as_ptr(),
            ),
        );
        denied(
            "execveat",
            syscall(
                SYS_execveat,
                AT_FDCWD,
                executable.as_ptr(),
                argv.as_ptr(),
                envp.as_ptr(),
                0,
            ),
        );
        // Invalid flags/arguments cannot create a child even if policy regresses.
        denied("clone", syscall(SYS_clone, c_ulong::MAX, 0, 0, 0, 0));
        denied("clone3", syscall(SYS_clone3, std::ptr::null::<c_void>(), 0));
        denied(
            "ptrace",
            syscall(SYS_ptrace, PTRACE_PEEKDATA, getpid(), 0, 0),
        );
        denied(
            "io_uring",
            syscall(SYS_io_uring_setup, 0, std::ptr::null::<c_void>()),
        );
        denied(
            "bpf",
            syscall(SYS_bpf, c_uint::MAX, std::ptr::null::<c_void>(), 0),
        );
        denied("prctl", syscall(SYS_prctl, PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
        denied("seccomp-replace", syscall(SYS_seccomp, c_uint::MAX, 0, 0));
        denied("getppid", syscall(SYS_getppid));
        denied("kill", syscall(SYS_kill, getpid(), 0));
        denied("pidfd", syscall(SYS_pidfd_open, getpid(), 0));
        denied(
            "process-vm-read",
            syscall(SYS_process_vm_readv, getpid(), 0, 0, 0, 0, 0),
        );
        denied("dup", syscall(SYS_dup, 1));
        denied("pipe", syscall(SYS_pipe2, pair.as_mut_ptr(), O_CLOEXEC));
        denied("eventfd", syscall(SYS_eventfd2, 0, EFD_CLOEXEC));
        denied(
            "memfd",
            syscall(SYS_memfd_create, c"fixture".as_ptr(), MFD_CLOEXEC),
        );
        denied("epoll", syscall(SYS_epoll_create1, EPOLL_CLOEXEC));
        denied(
            "mmap-exec",
            syscall(
                SYS_mmap,
                0,
                4096,
                PROT_READ | PROT_EXEC,
                MAP_PRIVATE | MAP_ANONYMOUS,
                -1,
                0,
            ),
        );
        let memory = mmap(
            std::ptr::null_mut(),
            4096,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1,
            0,
        );
        assert_ne!(
            memory, MAP_FAILED,
            "ordinary engine data mappings remain usable"
        );
        denied(
            "mprotect-exec",
            syscall(SYS_mprotect, memory, 4096, PROT_READ | PROT_EXEC),
        );
        assert_eq!(munmap(memory, 4096), 0);
        let oversized = mmap(
            std::ptr::null_mut(),
            400 * 1024 * 1024,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1,
            0,
        );
        assert_eq!(oversized, MAP_FAILED);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(ENOMEM));
        checks.insert("address-space-limit".into(), serde_json::json!("ENOMEM"));
        for fd in 100..=102 {
            let mut stat: stat = std::mem::zeroed();
            assert_eq!(fstat(fd, &mut stat), -1);
            assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(EBADF));
            checks.insert(format!("inherited-fd-{fd}"), serde_json::json!("EBADF"));
        }
        let mut byte = 0u8;
        assert_eq!(read(100, (&mut byte as *mut u8).cast(), 1), -1);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(EBADF));
        assert_eq!(write(101, c"x".as_ptr().cast(), 1), -1);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(EBADF));
        checks.insert("inherited-read".into(), serde_json::json!("EBADF"));
        checks.insert("inherited-write".into(), serde_json::json!("EBADF"));
    }
    checks.into()
}

#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("This qualification probe requires native Linux");
}
