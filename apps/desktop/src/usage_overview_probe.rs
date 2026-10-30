//! Mounted production Usage page, synthetic GET-only server, offscreen only.
use crate::{
    usage_overview::{DAY, Range},
    usage_overview_fixture as f,
    usage_overview_view::Usage,
};
use gpui_kit::{
    AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use std::time::{Duration, Instant};
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, v: &Entity<Usage>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).state.busy) {
        assert!(Instant::now() < end, "bounded Local usage response");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
pub fn run_usage_overview_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let s = f::Server::start();
            let range = Range::preset(7, 1_730_000_000_000).unwrap();
            f::install(&s, range);
            let mut delayed = f::Reply::json(200, f::report(range, false));
            delayed.delay_ms = 180;
            s.reply(&f::path(&s.options, range, false), delayed);
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(960.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        let v = cx.new(|cx| Usage::new(Some(s.options.clone()), cx));
                        v.update(cx, |v, cx| {
                            v.focus(w, cx);
                            v.request(range, w, cx);
                        });
                        v
                    },
                )
                .unwrap()
            });
            // Opening a window follows system appearance. Set and verify the
            // fixture mode afterwards so both theme passes exercise real modes.
            cx.update_window(h, |_, w, cx| {
                Theme::change(mode, Some(w), cx);
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-loading").is_some());
                assert!(w.try_find("usage-empty").is_none());
            })
            .unwrap();
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.error.is_none()));
            cx.update_window(h, |_, w, cx| {
                for id in [
                    "usage-title",
                    "usage-controls",
                    "usage-coverage",
                    "usage-summaries",
                    "usage-trend",
                    "usage-bars",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.left() >= px(0.) && b.right() <= px(width),
                        "{id} contained at {width}"
                    );
                }
                let bars = w.find("usage-bars").bounds();
                let a = w.find(format!("usage-day-{}", range.from + DAY)).bounds();
                assert!(a.left() >= bars.left() && a.right() <= bars.right());
                w.click("usage-details", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-details-body").is_some())
            })
            .unwrap();
            // A known partial subtotal draws a bar (it used to vanish); missing days do not.
            cx.update_window(h, |_, w, _| {
                let bar = |i: u64| w.try_find(format!("usage-bar-{}", range.from + i * DAY));
                let complete = bar(1).expect("complete day bar").bounds();
                let partial = bar(2).expect("partial subtotal bar").bounds();
                assert!(complete.size.height > px(0.));
                assert!(partial.size.height > complete.size.height, "60K above 48K");
                for i in [0, 3, 4, 5, 6] {
                    assert!(
                        bar(i).is_none(),
                        "outside/empty/zero/unknown day {i} has no bar"
                    );
                }
                let axis = w.find("usage-axis").bounds();
                let top = w.find("usage-tick-3").bounds();
                let zero = w.find("usage-tick-0").bounds();
                assert!(top.bottom() < zero.top() && top.left() >= axis.left() - px(1.));
                let off = f32::from(partial.top() - top.center().y).abs();
                assert!(off <= 3., "partial reaches the 60K tick ({off})");
                assert!(w.try_find("usage-legend").is_some());
            })
            .unwrap();
            // Capture the overview, not the expanded diagnostic detail.
            cx.update_window(h, |_, w, cx| w.click("usage-details", cx))
                .unwrap();
            settle(cx, h);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("usage-{width}-{mode:?}.png")))
                    .unwrap();
            }
            // Longer ranges, billions per day and a 30-day retention floor stay contained.
            for days in [30u64, 90] {
                let long = Range::preset(days, range.to - 1).unwrap();
                for buckets in [false, true] {
                    s.reply(
                        &f::path(&s.options, long, buckets),
                        f::Reply::json(200, f::long_report(long, buckets)),
                    );
                }
                cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.request(long, w, cx)))
                    .unwrap();
                until(cx, h, &v);
                assert!(cx.update(|cx| {
                    v.read(cx)
                        .state
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| s.trend.is_ok())
                }));
                cx.update_window(h, |_, w, _| {
                    let bars = w.find("usage-bars").bounds();
                    let labels = w.find("usage-days").bounds();
                    assert!(bars.right() <= px(width) && labels.right() <= px(width));
                    let last = w
                        .find(format!("usage-day-{}", long.to / DAY * DAY))
                        .bounds();
                    assert!(
                        last.right() <= bars.right() + px(1.),
                        "{days} days contained"
                    );
                    assert!(w.try_find("usage-tick-1").is_some());
                })
                .unwrap();
                if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(
                            std::path::PathBuf::from(dir)
                                .join(format!("usage-{days}d-{width}-{mode:?}.png")),
                        )
                        .unwrap();
                }
            }
            // Real range control cancels/replaces reads and clears old-range values.
            cx.update_window(h, |_, w, cx| w.click("usage-range-30", cx))
                .unwrap();
            settle(cx, h);
            until(cx, h, &v);
            cx.update(|cx| {
                let state = &v.read(cx).state;
                assert!(state.snapshot.is_none());
                let r = state.range.unwrap();
                assert!(r.to - r.from > 29 * DAY && r.to - r.from <= 30 * DAY);
                assert!(state.error.is_some());
            });
            // Explicit retry installs a known faux response. Empty is not unknown=0.
            let empty = Range::preset(30, range.to - 1).unwrap();
            let mut report = f::report(empty, false);
            report["total"]["records"] = 0.into();
            report["total"]["unpriced"] = 0.into();
            s.reply(
                &f::path(&s.options, empty, false),
                f::Reply::json(200, report),
            );
            s.reply(
                &f::path(&s.options, empty, true),
                f::Reply::json(503, serde_json::json!({})),
            );
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.request(empty, w, cx)))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| assert!(w.try_find("usage-empty").is_some()))
                .unwrap();
            // Failed same-range refresh retains its dated summary, visibly stale.
            s.reply(
                &f::path(&s.options, empty, false),
                f::Reply::json(503, serde_json::json!({})),
            );
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.request(empty, w, cx)))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-error").is_some());
                assert!(w.try_find("usage-summaries").is_some());
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.focus(w, cx));
                w.focus_next(cx);
                w.press("space", cx);
            })
            .unwrap();
            settle(cx, h);
            until(cx, h, &v);
            cx.update(|cx| {
                let state = &v.read(cx).state;
                let range = state.range.unwrap();
                assert!(
                    range.to - range.from <= 7 * DAY,
                    "keyboard reaches the first native range control"
                );
                assert!(
                    state.snapshot.is_none(),
                    "keyboard range change clears previous-range data"
                );
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.close(cx));
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            assert!(s.all_gets());
        }
    }
}
