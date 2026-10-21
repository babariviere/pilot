//! Synthetic production UI corpus. No real daemon, draft store, writes or visible window.
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    px, size,
    test::{TestQueryExt, TestWindowExt},
};
use pilot_desktop::{ChromeAssets, LocalViewer, PreviewState, TranscriptView};
use std::{sync::Arc, time::Instant};
fn main() {
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(ChromeAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        pilot_desktop::init_appearance(cx);
        TranscriptView::bind_keys(cx);
        LocalViewer::bind_keys(cx);
    });
    let directory = std::env::var_os("PILOT_NEXT_CHROME_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &directory {
        std::fs::create_dir_all(dir).unwrap();
    }
    let start = Instant::now();
    let mut count = 0;
    for (width, height) in [(680., 640.), (1100., 760.)] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for (name, state) in [
                ("chat", PreviewState::Conversation),
                ("empty", PreviewState::Empty),
                ("loading", PreviewState::Loading),
                ("error", PreviewState::Unavailable),
            ] {
                cx.update(|cx| Theme::change(mode, None, cx));
                let (handle, view) = cx.update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(height)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |window, cx| cx.new(|cx| LocalViewer::preview(state, window, cx)),
                    )
                    .unwrap()
                });
                cx.run_until_parked();
                assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    let sidebar = window.find("chat-sidebar").bounds();
                    let conversation = window.find("conversation").bounds();
                    assert!(sidebar.size.width <= px(240.));
                    assert!(conversation.right() <= px(width + 1.));
                    assert!(conversation.size.width > px(320.));
                    if !matches!(state, PreviewState::Empty) {
                        let composer = window.find_by_label("Local chat message").bounds();
                        assert!(composer.size.width > px(240.));
                        assert!(composer.right() <= px(width + 1.));
                        assert!(window.find("local-send").disabled().unwrap_or(false));
                    }
                    window.click("view-details", cx);
                })
                .unwrap();
                cx.run_until_parked();
                let shot = cx
                    .capture_screenshot(handle)
                    .expect("native GPU corpus renderer");
                if let Some(dir) = &directory {
                    shot.save(dir.join(format!("{}-{}-{name}.png", width as u32, mode.name())))
                        .unwrap();
                }
                count += 1;
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .unwrap();
                cx.run_until_parked();
            }
        }
    }
    println!(
        "Native synthetic chrome: {count} narrow/wide/light/dark/chat/empty/loading/error scenes, {:.1} ms total. No transport or real data; not visible smoothness evidence.",
        start.elapsed().as_secs_f64() * 1000.
    );
}
