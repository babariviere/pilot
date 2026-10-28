//! Explicit daemon upgrade section. Synthetic worker only; never launchctl or a real profile.
use gpui_kit::HeadlessAppContext;
use std::sync::Arc;
fn main() {
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(pilot_desktop::ChromeAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        pilot_desktop::init_appearance(cx);
    });
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pilot_desktop::run_daemon_upgrade_probe(&mut cx);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pilot_desktop::run_daemon_upgrade_lifecycle_probe(&mut cx);
}
