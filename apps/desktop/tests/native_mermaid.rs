//! Offscreen production artifact renderer, synthetic content only.
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
    pilot_desktop::run_native_mermaid_probe(&mut cx);
    if std::env::var_os("PILOT_MERMAID_BASELINE").is_none() {
        pilot_desktop::run_native_mermaid_root_probe(&mut cx);
    }
}
