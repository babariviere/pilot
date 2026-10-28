//! Native platform menu construction and dispatch, with no visible window or profile.
#[cfg(target_os = "macos")]
fn main() {
    pilot_desktop::app_menu::run_native_probe();
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("UNSUPPORTED: native menu verification requires macOS");
}
