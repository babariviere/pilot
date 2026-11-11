//! The Day executable, not the stock NSH packaged runner.
fn main() -> std::process::ExitCode {
    #[cfg(target_os = "macos")]
    if pilot_day_native::bootstrap::run(std::env::args_os().skip(1).collect()).is_ok() {
        return std::process::ExitCode::SUCCESS;
    }
    eprintln!("Day could not open its verified package and explicit native selection.");
    std::process::ExitCode::FAILURE
}
