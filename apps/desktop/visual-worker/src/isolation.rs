//! Trusted bootstrap only. Apply OS confinement before reading a request or evaluating source.
use std::{io, os::fd::RawFd};
fn denied() -> bool {
    matches!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::EPERM | libc::EACCES)
    )
}
pub fn prepare() -> Result<(), ()> {
    unsafe {
        #[cfg(target_os = "macos")]
        {
            let mut fds = vec![
                libc::proc_fdinfo {
                    proc_fd: 0,
                    proc_fdtype: 0
                };
                4096
            ];
            let capacity = std::mem::size_of_val(fds.as_slice());
            let n = libc::proc_pidinfo(
                libc::getpid(),
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                capacity as i32,
            );
            if n <= 0 || n as usize >= capacity {
                return Err(());
            }
            for fd in &fds[..n as usize / std::mem::size_of::<libc::proc_fdinfo>()] {
                if fd.proc_fd >= 3 {
                    libc::close(fd.proc_fd);
                }
            }
            let n = libc::proc_pidinfo(
                libc::getpid(),
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                capacity as i32,
            );
            if n <= 0
                || fds[..n as usize / std::mem::size_of::<libc::proc_fdinfo>()]
                    .iter()
                    .any(|fd| fd.proc_fd >= 3)
            {
                return Err(());
            }
        }
        #[cfg(target_os = "linux")]
        {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                || libc::prctl(libc::PR_SET_DUMPABLE, 0) != 0
                || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            {
                return Err(());
            }
            if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) < 0 {
                return Err(());
            }
        }
        for (resource, limit) in [
            (libc::RLIMIT_CORE, 0),
            (libc::RLIMIT_FSIZE, 0),
            (libc::RLIMIT_NOFILE, 16),
            (libc::RLIMIT_CPU, 60),
        ] {
            let limit = libc::rlimit {
                rlim_cur: limit,
                rlim_max: limit,
            };
            if libc::setrlimit(resource, &limit) != 0 {
                return Err(());
            }
        }
    }
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn install() -> Result<(), ()> {
    unsafe extern "C" {
        fn sandbox_init(
            profile: *const libc::c_char,
            flags: u64,
            error: *mut *mut libc::c_char,
        ) -> i32;
        fn sandbox_free_error(error: *mut libc::c_char);
    }
    let mut error = std::ptr::null_mut();
    let status = unsafe {
        sandbox_init(
            c"(version 1)(deny default)(allow process-info* (target self))".as_ptr(),
            0,
            &mut error,
        )
    };
    if !error.is_null() {
        unsafe { sandbox_free_error(error) }
    }
    if status == 0 { Ok(()) } else { Err(()) }
}
#[cfg(target_os = "linux")]
pub fn install() -> Result<(), ()> {
    use libc::{sock_filter as F, sock_fprog};
    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xc00000b7;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Err(());
    fn op(code: u16, k: u32, jt: u8, jf: u8) -> F {
        F { code, jt, jf, k }
    }
    const ALLOW: u32 = 0x7fff0000;
    const DENY: u32 = 0x00050000 | libc::EPERM as u32;
    let mut filter = vec![
        op(0x20, 4, 0, 0),
        op(0x15, ARCH, 1, 0),
        op(0x06, 0x80000000, 0, 0),
        op(0x20, 0, 0, 0),
    ];
    for nr in [libc::SYS_mmap, libc::SYS_mprotect] {
        filter.extend([
            op(0x15, nr as u32, 0, 4),
            op(0x20, 32, 0, 0),
            op(0x45, libc::PROT_EXEC as u32, 0, 1),
            op(0x06, DENY, 0, 0),
            op(0x06, ALLOW, 0, 0),
        ]);
    }
    for nr in [
        libc::SYS_read,
        libc::SYS_write,
        libc::SYS_close,
        libc::SYS_fstat,
        libc::SYS_lseek,
        libc::SYS_munmap,
        libc::SYS_mremap,
        libc::SYS_madvise,
        libc::SYS_brk,
        libc::SYS_futex,
        libc::SYS_clock_gettime,
        libc::SYS_clock_getres,
        libc::SYS_getpid,
        libc::SYS_gettid,
        libc::SYS_getuid,
        libc::SYS_geteuid,
        libc::SYS_getrandom,
        libc::SYS_rt_sigreturn,
        libc::SYS_rt_sigaction,
        libc::SYS_rt_sigprocmask,
        libc::SYS_sigaltstack,
        libc::SYS_exit,
        libc::SYS_exit_group,
    ] {
        filter.extend([op(0x15, nr as u32, 0, 1), op(0x06, ALLOW, 0, 0)]);
    }
    filter.push(op(0x06, DENY, 0, 0));
    let program = sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    unsafe {
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
            || libc::prctl(libc::PR_SET_DUMPABLE, 0) != 0
            || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        {
            return Err(());
        }
        let limit = libc::rlimit {
            rlim_cur: 320 * 1024 * 1024,
            rlim_max: 320 * 1024 * 1024,
        };
        if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
            return Err(());
        }
        // Apply to the pre-created watchdog as well. Any TSYNC failure refuses source.
        if libc::syscall(
            libc::SYS_seccomp,
            1u32,
            1u32,
            &program as *const libc::sock_fprog,
        ) != 0
        {
            return Err(());
        }
    }
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn install() -> Result<(), ()> {
    Err(())
}

pub fn probes(executable: &std::ffi::CStr, port: u16) -> bool {
    unsafe {
        let file = libc::open(executable.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC);
        let file_denied = file < 0 && denied();
        if file >= 0 {
            libc::close(file);
        }
        let socket: RawFd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
        let mut network_denied = socket < 0 && denied();
        if socket >= 0 {
            let mut address: libc::sockaddr_in = std::mem::zeroed();
            address.sin_family = libc::AF_INET as _;
            address.sin_port = port.to_be();
            address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
            #[cfg(target_os = "macos")]
            {
                address.sin_len = std::mem::size_of_val(&address) as _;
            }
            network_denied = libc::connect(
                socket,
                (&address as *const libc::sockaddr_in).cast(),
                std::mem::size_of_val(&address) as _,
            ) != 0
                && denied();
            libc::close(socket);
        }
        let args = [c"true".as_ptr(), std::ptr::null()];
        libc::execv(c"/usr/bin/true".as_ptr(), args.as_ptr());
        let exec_denied = denied();
        file_denied && network_denied && exec_denied
    }
}
