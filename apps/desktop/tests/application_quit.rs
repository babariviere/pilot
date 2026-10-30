//! Separate, hidden native application processes. No real profile or daemon.
#[cfg(target_os = "macos")]
fn main() {
    pilot_desktop::run_application_quit_probe();
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("application Quit qualification requires macOS");
}
