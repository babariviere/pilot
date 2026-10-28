//! Opt-in hidden native sidebar wheel journey; no Local profile or activation.
fn main() {
    gpui_kit::Application::with_platform(gpui_kit::platform::current_platform(false))
        .with_assets(pilot_desktop::ChromeAssets)
        .with_windowing(gpui_kit::WindowingRequest::Headless)
        .run(|cx| {
            gpui_kit::init(cx);
            pilot_desktop::init_appearance(cx);
            pilot_desktop::TranscriptView::bind_keys(cx);
            pilot_desktop::LocalViewer::bind_keys(cx);
            pilot_desktop::run_native_sidebar_scroll_probe(cx);
        });
}
