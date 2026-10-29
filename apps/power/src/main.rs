//! Daemon-owned macOS power helper. No GUI or daemon policy lives here.
#[cfg(any(test, target_os = "macos"))]
mod guardian;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(test, target_os = "macos"))]
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
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("PilotPower requires macOS");
        std::process::exit(1);
    }
}
