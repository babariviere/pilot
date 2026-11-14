//! The Day executable, not the stock NSH packaged runner.
fn main() -> std::process::ExitCode {
    #[cfg(unix)]
    pilot_day_native::day_log::enable();
    #[cfg(target_os = "macos")]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|s| s == "--daemon-handoff")
    {
        let args = std::env::args_os().skip(2).collect();
        // Security.framework verification must run off the AppKit main thread.
        let result = std::thread::spawn(move || pilot_day_native::daemon_handoff::run(args)).join();
        if let Ok(value) = result {
            println!("{value}");
            return if ["ready", "complete", "observed", "retired"]
                .iter()
                .any(|s| value["state"] == *s)
            {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            };
        }
        return std::process::ExitCode::FAILURE;
    }
    #[cfg(target_os = "macos")]
    if pilot_desktop_updater::build_input::requested() {
        return if pilot_desktop_updater::build_input::write().is_ok() {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::FAILURE
        };
    }
    #[cfg(target_os = "macos")]
    match pilot_day_native::bootstrap::run(std::env::args_os().skip(1).collect()) {
        Ok(()) => return std::process::ExitCode::SUCCESS,
        Err(error) => {
            pilot_day_native::day_log::event(
                "exit.failed",
                serde_json::json!({"error": format!("{error:?}")}),
            );
            eprintln!(
                "Pilot could not open its verified package and native selection: {error}. Details: ~/Library/Logs/Pilot/day.log"
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    eprintln!("Pilot's connected native executable requires macOS.");
    std::process::ExitCode::FAILURE
}
