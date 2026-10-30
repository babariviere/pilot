//! Mounted production Usage page, synthetic GET-only server, offscreen only.
use crate::{
    usage_overview::{DAY, Filter, Range, View},
    usage_overview_fixture as f,
    usage_overview_view::Usage,
};
use gpui_kit::{
    AppContext, Bounds, Entity, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    point, px, size,
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
fn reveal(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| {
        let viewport = w.find("usage-page").bounds();
        let target = w.find(id).bounds();
        w.scroll(
            "usage-page",
            ScrollDelta::Pixels(point(px(0.), viewport.top() + px(24.) - target.top())),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
}
fn records_until(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, v: &Entity<Usage>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).records.busy) {
        assert!(Instant::now() < end, "bounded records read");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn keyboard(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, id: &str) {
    for _ in 0..70 {
        let focused = cx
            .update_window(h, |_, w, _| w.find(id.to_owned()).focused() == Some(true))
            .unwrap();
        if focused {
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            return;
        }
        cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
        settle(cx, h);
    }
    panic!("keyboard reaches {id}");
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
                            v.project_names.insert(
                                f::PROJECT.into(),
                                "研究 👩‍💻 é · very long project label, historical usage".into(),
                            );
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
            cx.update_window(h, |_, w, _| {
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
            })
            .unwrap();
            reveal(cx, h, "usage-details");
            cx.update_window(h, |_, w, cx| w.click("usage-details", cx))
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
            reveal(cx, h, "usage-title");
            if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("usage-{width}-{mode:?}.png")))
                    .unwrap();
            }
            // Retained records use the production reader, real keyboard actions
            // and clipboard. No page is requested until explicit disclosure.
            assert!(
                !s.state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .any(|(_, p)| p.starts_with("/api/usage-history/page"))
            );
            let first_request = f::records_request(range);
            let first_page = f::records(range, 0, 25, true);
            let first_path = f::records_path(&s.options, &first_request);
            let mut delayed = f::Reply::json(200, first_page.clone());
            delayed.delay_ms = 240;
            s.reply(&first_path, delayed);
            reveal(cx, h, "usage-records-toggle");
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.focus(w, cx)))
                .unwrap();
            keyboard(cx, h, "usage-records-toggle");
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-records-loading").is_some())
            })
            .unwrap();
            records_until(cx, h, &v);
            reveal(cx, h, "usage-records");
            if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("usage-record-page-{width}-{mode:?}.png")),
                    )
                    .unwrap();
            }
            let row_id = cx.update(|cx| v.read(cx).records.page.as_ref().unwrap().rows[0].id());
            let details_id = format!("usage-record-details-{row_id}");
            keyboard(cx, h, &details_id);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-record-detail").is_some());
                let b = w.find("usage-record-detail").bounds();
                assert!(b.left() >= px(0.) && b.right() <= px(width));
            })
            .unwrap();
            keyboard(cx, h, "usage-record-copy");
            cx.update(|cx| {
                let view = v.read(cx);
                assert_eq!(
                    view.state.snapshot.as_ref().unwrap().summary.total.records,
                    2,
                    "authoritative total never rebuilt from 25 displayed rows"
                );
                let exact = view.records.page.as_ref().unwrap().rows[0].json();
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), exact);
            });
            reveal(cx, h, "usage-record-detail");
            cx.update_window(h, |_, w, cx| {
                let b = w.find("usage-record-data").bounds();
                let a = point(b.left() + px(1.), b.top() + px(7.));
                w.drag(a, a + point(px(140.), px(0.)), cx);
                let selected = gpui_kit::base::TextSelection::selected_text(w, cx);
                assert!(!selected.trim().is_empty());
                assert!(
                    v.read(cx).records.page.as_ref().unwrap().rows[0]
                        .json()
                        .contains(selected.trim())
                );
                w.press("secondary-c", cx);
                assert!(!cx.read_from_clipboard().unwrap().text().unwrap().is_empty());
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("usage-records-{width}-{mode:?}.png")),
                    )
                    .unwrap();
            }
            let mut next_request = first_request.clone();
            cx.update(|cx| {
                let page = v.read(cx).records.page.as_ref().unwrap();
                next_request.after = page.next.clone();
                next_request.boundary = page.rows.last().map(|r| r.key.clone());
            });
            let next_path = f::records_path(&s.options, &next_request);
            s.reply(&next_path, f::Reply::json(503, serde_json::json!({})));
            reveal(cx, h, "usage-records-next");
            cx.update_window(h, |_, w, cx| w.click("usage-records-next", cx))
                .unwrap();
            records_until(cx, h, &v);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("usage-records-error").is_some());
                assert_eq!(v.read(cx).records.page.as_ref().unwrap().rows.len(), 25);
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                reveal(cx, h, "usage-records-error");
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("usage-record-error-{width}-{mode:?}.png")),
                    )
                    .unwrap();
            }
            s.reply(
                &next_path,
                f::Reply::json(200, f::records(range, 25, 1, false)),
            );
            reveal(cx, h, "usage-records-next");
            cx.update_window(h, |_, w, cx| w.click("usage-records-next", cx))
                .unwrap();
            records_until(cx, h, &v);
            cx.update(|cx| {
                let page = v.read(cx).records.page.as_ref().unwrap();
                assert_eq!(page.rows.len(), 1);
                assert!(page.next.is_none());
                assert!(page.rows[0].counts().contains("Unknown"));
            });
            let unknown_id = cx.update(|cx| {
                format!(
                    "usage-record-details-{}",
                    v.read(cx).records.page.as_ref().unwrap().rows[0].id()
                )
            });
            cx.update_window(h, |_, w, cx| w.click(unknown_id, cx))
                .unwrap();
            settle(cx, h);
            keyboard(cx, h, "usage-record-copy");
            cx.update(|cx| {
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .contains("request-0025")
                )
            });
            // Cursor refusal may mean erased history; clear everything rather
            // than retain a pre-erasure summary, then require explicit refresh.
            s.reply(&first_path, f::Reply::json(400, serde_json::json!({})));
            reveal(cx, h, "usage-records-first");
            cx.update_window(h, |_, w, cx| w.click("usage-records-first", cx))
                .unwrap();
            records_until(cx, h, &v);
            cx.update(|cx| {
                assert!(v.read(cx).state.snapshot.is_none());
                assert!(v.read(cx).records.page.is_none());
            });
            cx.update_window(h, |_, w, _| assert!(w.try_find("usage-error").is_some()))
                .unwrap();
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.request(range, w, cx)))
                .unwrap();
            until(cx, h, &v);
            // The real Kit selector, keyboard navigation, cancelled Unicode
            // search and focus restoration. No query changes before Confirm.
            let project = Filter::Project(f::PROJECT.into());
            for filter in [&project, &Filter::Unattributed] {
                f::install_filter(&s, range, filter);
            }
            let mut empty_project = f::report(range, false);
            empty_project["total"]["records"] = 0.into();
            empty_project["total"]["unpriced"] = 0.into();
            empty_project["total"]["metrics"] = serde_json::json!({});
            s.reply(
                &f::scoped_path(&s.options, range, &project, View::Buckets),
                f::Reply::json(200, empty_project.clone()),
            );
            s.reply(
                &f::scoped_path(&s.options, range, &project, View::Summary),
                f::Reply::json(200, empty_project),
            );
            let mut pending = f::Reply::json(200, f::report(range, false));
            pending.delay_ms = 500;
            s.reply(&f::path(&s.options, range, false), pending);
            let mut limited = f::projects(range);
            limited["truncated"] = true.into();
            limited["next"] = "bounded-next-page-not-followed".into();
            let project_path = f::scoped_path(&s.options, range, &Filter::All, View::Projects);
            s.reply(&project_path, f::Reply::json(200, limited.clone()));
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.request(range, w, cx)))
                .unwrap();
            let serial = cx.update(|cx| v.read(cx).state.serial);
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.focus(w, cx));
            })
            .unwrap();
            // Traverse the actual native focus order, rather than assuming
            // one Tab stop per composite control or a fixed allocation order.
            let mut reached = false;
            for _ in 0..16 {
                cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
                settle(cx, h);
                reached = cx
                    .update_window(h, |_, w, cx| v.read(cx).probe_filter_focused(w, cx))
                    .unwrap();
                if reached {
                    break;
                }
            }
            assert!(reached, "project selector is keyboard reachable");
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("研究 👩‍💻 é".into()));
                w.press("secondary-v", cx);
                let query = v.read(cx).probe_query(cx);
                query.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            until(cx, h, &v);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("usage-project-limited").is_some());
                let query = v.read(cx).probe_query(cx);
                assert_eq!(query.read(cx).value().as_ref(), "研究 👩‍💻 éに");
                query.update(cx, |q, cx| {
                    assert!(
                        q.marked_text_range(w, cx).is_some(),
                        "async catalogue preserves native preedit"
                    );
                    q.unmark_text(w, cx);
                });
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| v.read(cx).state.serial),
                serial,
                "cancelled search does not read"
            );
            s.reply(
                &f::path(&s.options, range, false),
                f::Reply::json(200, f::report(range, false)),
            );
            // Escape restored trigger focus above. A delayed record page must
            // not survive an actual keyboard project selection.
            let mut pending_records = f::Reply::json(200, f::records(range, 0, 1, false));
            pending_records.delay_ms = 600;
            s.reply(&first_path, pending_records);
            reveal(cx, h, "usage-records-toggle");
            cx.update_window(h, |_, w, cx| w.click("usage-records-toggle", cx))
                .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| v.read(cx).records.busy));
            reveal(cx, h, "usage-title");
            cx.update_window(h, |_, w, cx| w.click("usage-project-filter", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            until(cx, h, &v);
            cx.update(|cx| {
                assert_eq!(v.read(cx).state.filter, project);
                assert_eq!(v.read(cx).state.snapshot.as_ref().unwrap().range, range);
                assert!(!v.read(cx).records.open);
                assert!(v.read(cx).records.page.is_none());
            });
            cx.update_window(h, |_, w, _| assert!(w.try_find("usage-empty").is_some()))
                .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_USAGE_DIR") {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(
                        std::path::PathBuf::from(dir)
                            .join(format!("usage-project-{width}-{mode:?}.png")),
                    )
                    .unwrap();
            }
            // A failed filtered refresh retains exactly that project's empty report.
            s.reply(
                &f::scoped_path(&s.options, range, &project, View::Summary),
                f::Reply::json(503, serde_json::json!({})),
            );
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.request(range, w, cx)))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-error").is_some());
                assert!(w.try_find("usage-empty").is_some());
            })
            .unwrap();
            // Choose authoritative missing attribution, then All again, with
            // the restored native trigger, not direct state mutation.
            for (key, count, expected) in
                [("down", 1, Filter::Unattributed), ("up", 2, Filter::All)]
            {
                if expected == Filter::Unattributed {
                    s.reply(&project_path, f::Reply::json(503, serde_json::json!({})));
                } else {
                    s.reply(&project_path, f::Reply::json(200, limited.clone()));
                }
                cx.update_window(h, |_, w, cx| w.click("usage-project-filter", cx))
                    .unwrap();
                settle(cx, h);
                for _ in 0..count {
                    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
                    settle(cx, h);
                }
                cx.update_window(h, |_, w, cx| w.press("enter", cx))
                    .unwrap();
                settle(cx, h);
                until(cx, h, &v);
                assert_eq!(cx.update(|cx| v.read(cx).state.filter.clone()), expected);
                if expected == Filter::Unattributed {
                    cx.update_window(h, |_, w, _| {
                        assert!(w.try_find("usage-project-error").is_some())
                    })
                    .unwrap();
                    assert!(cx.update(|cx| v.read(cx).state.catalogue.is_some()));
                }
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
            let current = cx.update(|cx| v.read(cx).state.range.unwrap());
            let pending_records = f::records_request(current);
            let mut pending_page = f::Reply::json(200, f::records(current, 0, 1, false));
            pending_page.delay_ms = 600;
            s.reply(&f::records_path(&s.options, &pending_records), pending_page);
            reveal(cx, h, "usage-records-toggle");
            cx.update_window(h, |_, w, cx| w.click("usage-records-toggle", cx))
                .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| v.read(cx).records.busy));
            reveal(cx, h, "usage-title");
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
                assert!(v.read(cx).records.page.is_none());
                assert!(!v.read(cx).records.open);
            });
            // Explicit retry installs a known faux response. Empty is not unknown=0.
            let empty = Range::preset(30, range.to - 1).unwrap();
            let mut report = f::report(empty, false);
            report["total"]["records"] = 0.into();
            report["total"]["unpriced"] = 0.into();
            report["total"]["metrics"] = serde_json::json!({});
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
            let records_request = f::records_request(empty);
            s.reply(
                &f::records_path(&s.options, &records_request),
                f::Reply::json(200, f::records(empty, 0, 0, false)),
            );
            reveal(cx, h, "usage-records-toggle");
            cx.update_window(h, |_, w, cx| w.click("usage-records-toggle", cx))
                .unwrap();
            records_until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("usage-records-empty").is_some())
            })
            .unwrap();
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
