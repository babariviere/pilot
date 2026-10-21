//! Real renderer, production view, no visible window. Not smoothness evidence.
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    assets::Assets,
    px, size,
    test::{TestQueryExt, TestWindowExt},
};
use pilot_desktop::{LocalViewer, TranscriptView};
use std::{sync::Arc, time::Instant};

fn main() {
    let large = std::env::var_os("PILOT_NEXT_LARGE_RENDER").is_some();
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        TranscriptView::bind_keys(cx);
    });
    let (handle, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(760.)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        if large {
                            TranscriptView::with_fixture(
                                Some(pilot_desktop::giant_fixture()),
                                window,
                                cx,
                            )
                        } else {
                            TranscriptView::new(window, cx)
                        }
                    })
                },
            )
        })
        .expect("open offscreen fixture");
    let parse = Instant::now();
    cx.run_until_parked();
    assert!(
        cx.update(|cx| view.read(cx).text_parsers_ready(cx)),
        "fixture source must really be parsed before measuring a frame"
    );
    println!(
        "Headless parser drain: {:.3} ms; giant source: {large}.",
        parse.elapsed().as_secs_f64() * 1000.
    );
    let first = Instant::now();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window
                .find_by_label("Local echo composer")
                .bounds()
                .size
                .height
                > px(0.)
        );
        if !large {
            window.input("Offscreen local echo", cx);
            window.click("send", cx);
        }
    })
    .unwrap();
    println!(
        "Headless CPU first render_frame: {:.3} ms; giant source: {large}. Not display/frame-pacing evidence.",
        first.elapsed().as_secs_f64() * 1000.
    );
    let screenshot = cx
        .capture_screenshot(handle)
        .expect("real GPU renderer is required");
    assert!(screenshot.width() >= 960 && screenshot.height() >= 760);
    let bytes = screenshot.as_raw();
    assert!(
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .any(|pixel| pixel != &bytes[..4]),
        "nonuniform rendered image"
    );
    if let Some(path) = std::env::var_os("GPUI_FIXTURE_SCREENSHOT") {
        screenshot
            .save(path)
            .expect("save explicitly requested fixture screenshot");
    }
    println!(
        "Native offscreen render: {}x{}; composer echo exercised: {}. This does not validate visible interaction, IME, accessibility or smoothness.",
        screenshot.width(),
        screenshot.height(),
        !large
    );
    let (viewer, _state) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(760.)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| LocalViewer::synthetic(window, cx)),
            )
        })
        .unwrap();
    cx.update_window(viewer, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.find("earlier").disabled().unwrap_or(false));
        window.click("latest", cx);
    })
    .unwrap();
    let shot = cx
        .capture_screenshot(viewer)
        .expect("native readonly browser renderer");
    if let Some(path) = std::env::var_os("PILOT_NEXT_VIEWER_SCREENSHOT") {
        shot.save(path).unwrap();
    }
    println!(
        "Native readonly browser rendered using 48 synthetic rows, no transport or real data."
    );
}
