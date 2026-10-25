//! Owned offscreen startup UI fixture only. No bundled daemon or Local discovery is started.
#[cfg(feature = "native-probes")]
fn main() {
    let mut cx = gpui_kit::HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        std::sync::Arc::new(pilot_desktop::ChromeAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        pilot_desktop::init_appearance(cx);
    });
    pilot_desktop::BundledRuntimeView::run_probe(&mut cx);
}
#[cfg(not(feature = "native-probes"))]
fn main() {
    eprintln!("This synthetic startup UI probe requires --features native-probes.");
    std::process::exit(2);
}
