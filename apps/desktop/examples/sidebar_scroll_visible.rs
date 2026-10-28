//! Opt-in visible sidebar wheel frame-pacing benchmark on a synthetic fixture.
//! Opens and focuses a window for about 15 seconds; no Local profile.
fn main() {
    gpui_kit::application()
        .with_assets(pilot_desktop::ChromeAssets)
        .run(|cx| {
            gpui_kit::init(cx);
            pilot_desktop::init_appearance(cx);
            pilot_desktop::enable_glass(cx);
            pilot_desktop::TranscriptView::bind_keys(cx);
            pilot_desktop::LocalViewer::bind_keys(cx);
            pilot_desktop::run_visible_sidebar_scroll_probe(cx);
        });
}
