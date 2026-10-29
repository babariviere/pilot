fn main() {
    #[cfg(any(
        all(target_os = "macos", feature = "native-macos"),
        all(target_os = "linux", feature = "native-linux")
    ))]
    {
        let mut arguments = std::env::args_os().skip(1);
        let mode = arguments.next();
        #[cfg(all(target_os = "macos", feature = "native-macos"))]
        if mode.as_deref() == Some(std::ffi::OsStr::new("--migrate-stopped")) {
            if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--app")) {
                std::process::exit(2);
            }
            let Some(app) = arguments.next() else {
                std::process::exit(2);
            };
            if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--confirm"))
                || arguments.next().is_some()
            {
                std::process::exit(2);
            }
            // Native signature/build APIs refuse AppKit's main thread.
            let result = std::thread::spawn(move || {
                pilot_desktop_updater::helper::compiled_trust()
                    .map_err(|_| "compiled updater trust is unavailable".to_owned())
                    .and_then(|trust| {
                        pilot_desktop_updater::daemon_upgrade::migrate_stopped(
                            std::path::Path::new(&app),
                            &trust,
                            &std::sync::atomic::AtomicBool::new(false),
                        )
                        .map_err(|error| error.to_string())
                    })
            })
            .join()
            .unwrap_or_else(|_| {
                Err("migration worker failed; inspect service state before retrying".to_owned())
            });
            if let Err(error) = result {
                eprintln!("{error}");
                std::process::exit(1);
            }
            println!("stopped service migration verified");
            return;
        }
        if mode.as_deref() != Some(std::ffi::OsStr::new("--transaction")) {
            std::process::exit(2);
        }
        let Some(root) = arguments.next() else {
            std::process::exit(2);
        };
        let mut descriptor = |flag: &str| {
            if arguments.next().as_deref() != Some(std::ffi::OsStr::new(flag)) {
                std::process::exit(2);
            }
            arguments
                .next()
                .and_then(|value| value.to_str().and_then(|value| value.parse::<i32>().ok()))
                .filter(|fd| *fd >= 10)
                .unwrap_or_else(|| std::process::exit(2))
        };
        let control = descriptor("--control-fd");
        let lock = descriptor("--lock-fd");
        if arguments.next().is_some() {
            std::process::exit(2);
        }
        // Platform validation and all file I/O happen off AppKit's main thread.
        let result = std::thread::spawn(move || {
            pilot_desktop_updater::helper::run_native(root.into(), control, lock)
        })
        .join();
        #[cfg(feature = "fixture")]
        if pilot_desktop_updater::fixture::enabled() {
            eprintln!("fixture-helper-result={result:?}");
        }
        if !matches!(result, Ok(Ok(()))) {
            std::process::exit(1);
        }
    }
    #[cfg(not(any(
        all(target_os = "macos", feature = "native-macos"),
        all(target_os = "linux", feature = "native-linux")
    )))]
    std::process::exit(2);
}
