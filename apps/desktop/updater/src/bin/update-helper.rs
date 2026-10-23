fn main() {
    #[cfg(target_os = "macos")]
    {
        let mut arguments = std::env::args_os().skip(1);
        if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--transaction")) {
            std::process::exit(2);
        }
        let Some(root) = arguments.next() else {
            std::process::exit(2);
        };
        if arguments.next().is_some() {
            std::process::exit(2);
        }
        // Platform validation and all file I/O happen off AppKit's main thread.
        let result =
            std::thread::spawn(move || pilot_desktop_updater::helper::run_native(root.into()))
                .join();
        if !matches!(result, Ok(Ok(()))) {
            std::process::exit(1);
        }
    }
    #[cfg(not(target_os = "macos"))]
    std::process::exit(2);
}
