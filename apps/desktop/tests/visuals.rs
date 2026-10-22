//! Native expected-tree corpus only. No runtime, service, real data, writes or visible window.
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, ScrollDelta, SharedString, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use pilot_desktop::{ChromeAssets, LocalViewer, TranscriptView};
use std::sync::Arc;
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
    let directory = std::env::var_os("PILOT_NEXT_VISUAL_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &directory {
        std::fs::create_dir_all(dir).unwrap();
    }
    let mut count = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for case in 0..14 {
                cx.update(|cx| Theme::change(mode, None, cx));
                let (handle, view) = cx.update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(760.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |window, cx| cx.new(|cx| LocalViewer::visual_preview(case, window, cx)),
                    )
                    .unwrap()
                });
                cx.run_until_parked();
                assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
                if case == 9 {
                    let b = cx
                        .update_window(handle, |_, window, cx| {
                            window.render_frame(cx);
                            window.find("0.1").bounds()
                        })
                        .unwrap();
                    assert!((f32::from(b.size.height) - 180.).abs() < 0.5);
                    view.update(&mut cx, |v, cx| {
                        v.resize_synthetic_canvas(f32::from(b.size.width) as f64, cx)
                    });
                    cx.run_until_parked();
                }
                cx.update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    let b = window.find("artifact-detail").bounds();
                    assert!(
                        b.size.width > px(300.)
                            && b.right() <= px(width + 1.)
                            && b.size.height > px(200.)
                    );
                    assert!(window.find("local-send").disabled().unwrap_or(false));
                })
                .unwrap();
                let shot = cx.capture_screenshot(handle).unwrap();
                if case == 9 {
                    let b = cx
                        .update_window(handle, |_, window, _| window.find("0.1").bounds())
                        .unwrap();
                    let scale = shot.width() as f32 / width;
                    let rgba = &shot;
                    let sample = |x: f32, y: f32| {
                        rgba.get_pixel(
                            ((f32::from(b.origin.x) + x) * scale) as u32,
                            ((f32::from(b.origin.y) + y) * scale) as u32,
                        )
                        .0
                    };
                    let inside = sample(40., 60.);
                    let outside = sample(f32::from(b.size.width) * 0.52, 60.);
                    assert!(
                        inside
                            .iter()
                            .zip(outside)
                            .take(3)
                            .map(|(a, b)| (*a as i32 - b as i32).abs())
                            .sum::<i32>()
                            > 30,
                        "native canvas must paint, not merely mount an empty placeholder"
                    );
                }
                if case == 10 || case == 12 {
                    let b = cx
                        .update_window(handle, |_, window, cx| {
                            window.render_frame(cx);
                            window.find("chart-plot").bounds()
                        })
                        .unwrap();
                    let image = cx.capture_screenshot(handle).unwrap();
                    let scale = image.width() as f32 / width;
                    let sample = |normalized: f32| {
                        image
                            .get_pixel(
                                ((f32::from(b.left()) + 12. + (f32::from(b.size.width) - 24.) / 6.)
                                    * scale) as u32,
                                ((f32::from(b.top())
                                    + 8.
                                    + (1. - normalized) * (f32::from(b.size.height) - 16.))
                                    * scale) as u32,
                            )
                            .0
                    };
                    let samples = if case == 10 {
                        [sample(7. / 11.), sample(9.5 / 11.), sample(5.5 / 11.)]
                    } else {
                        [sample(4. / 6.), sample(5.5 / 6.), sample(2.5 / 6.)]
                    };
                    let [blue, amber, green] = samples;
                    assert!(blue[2] > blue[0] && blue[2] > blue[1]);
                    assert!(amber[0] > amber[2] && amber[1] > amber[2]);
                    assert!(green[1] > green[0] && green[1] > green[2]);
                    for i in 1..samples.len() {
                        assert!(
                            samples[0]
                                .iter()
                                .zip(samples[i])
                                .take(3)
                                .map(|(a, b)| (*a as i32 - b as i32).abs())
                                .sum::<i32>()
                                > 30,
                            "same-column signed layers must actually paint distinct native colors"
                        );
                    }
                }
                if let Some(dir) = &directory {
                    shot.save(dir.join(format!("{}-{}-{case}.png", width as u32, mode.name())))
                        .unwrap();
                }
                if width == 1100. && mode == ThemeMode::Light && case == 1 {
                    cx.update_window(handle, |_, window, cx| {
                        let b = window.find("0.0").bounds();
                        window.drag(
                            b.origin + point(px(1.), b.size.height / 2.),
                            b.bottom_right() - point(px(1.), b.size.height / 2.),
                            cx,
                        );
                        window.render_frame(cx);
                        assert_eq!(
                            gpui_kit::base::TextSelection::selected_text(window, cx),
                            "Latency by region"
                        );
                        window.press("secondary-c", cx);
                        assert_eq!(
                            cx.read_from_clipboard().and_then(|c| c.text()),
                            Some("Latency by region".into())
                        );
                        window.click("artifact-source", cx);
                        window.render_frame(cx);
                        assert!(window.find("artifact-source-text").bounds().size.height > px(1.));
                        window.click("artifact-copy-source", cx);
                        assert!(
                            cx.read_from_clipboard()
                                .and_then(|c| c.text())
                                .is_some_and(|s| s.contains("ui.column"))
                        );
                    })
                    .unwrap();
                }
                if width == 1100. && mode == ThemeMode::Light && case == 0 {
                    cx.update_window(handle, |_, window, cx| {
                        let before = window.find("0.0").bounds().origin.y;
                        let target = SharedString::from("synthetic:synthetic-visual:1");
                        window.scroll(
                            target.clone(),
                            ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                            cx,
                        );
                        window.render_frame(cx);
                        assert!(window.find("0.0").bounds().origin.y < before);
                        window.scroll(target, ScrollDelta::Pixels(point(px(0.), px(100_000.))), cx);
                        window.render_frame(cx);
                        assert!(
                            (f32::from(window.find("0.0").bounds().origin.y - before)).abs() < 1.
                        );
                    })
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
        "Native visual corpus: {count} narrow/wide/light/dark expected-tree scenes; synthetic selection/copy/scroll/source disclosure, fake clipboard. No generated source execution, real data or canonical writes. Not visible smoothness evidence."
    );
}
