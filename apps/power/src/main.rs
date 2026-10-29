//! Daemon-owned native power helper. No GUI or daemon policy lives here.
#[cfg(any(test, target_os = "macos"))]
mod guardian;
#[cfg(any(test, target_os = "linux"))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
mod protocol;
#[cfg(any(test, target_os = "macos"))]
mod runtime;
#[cfg(any(test, target_os = "macos"))]
mod support;
#[cfg(test)]
mod tests;

fn main() {
    #[cfg(target_os = "macos")]
    macos::run();
    #[cfg(target_os = "linux")]
    linux::run();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        eprintln!("PilotPower requires macOS");
        std::process::exit(1);
    }
}
