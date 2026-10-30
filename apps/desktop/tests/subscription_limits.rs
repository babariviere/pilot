//! Subscription holds and native Paused presentation, with owned synthetic data.
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
        pilot_desktop::LocalViewer::bind_keys(cx);
        pilot_desktop::TranscriptView::bind_keys(cx);
    });
    pilot_desktop::run_subscription_limit_probe(&mut cx);
}
