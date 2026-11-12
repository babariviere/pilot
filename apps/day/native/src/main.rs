//! The Day executable, not the stock NSH packaged runner.
fn main() -> std::process::ExitCode {
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
        Err(error) => eprintln!(
            "Pilot could not open its verified package and explicit native selection: {error}"
        ),
    }
    #[cfg(not(target_os = "macos"))]
    eprintln!("Pilot's connected native executable requires macOS.");
    std::process::ExitCode::FAILURE
}
