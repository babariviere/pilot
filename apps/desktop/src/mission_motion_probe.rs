//! Synthetic offscreen frames of the real mission browser. Geometry and CPU
//! draw/render cost are evidence here, never visible presentation smoothness.
use super::super::{Browser, Route, Tab};
use super::*;
use crate::{mission_browser as model, mission_browser_fixture as f};
use gpui_kit::{
    AnyWindowHandle, AppContext, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{sync::Arc, time::Instant};

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ms: u64) -> f64 {
    cx.advance_clock(Duration::from_millis(ms));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        // Deliver the production helper's requested frame, rather than hiding
        // missing invalidation with a forced notify of the whole browser.
        w.simulate_next_frame(cx);
        let start = Instant::now();
        w.draw(cx).clear(cx);
        start.elapsed().as_secs_f64() * 1000.
    })
    .unwrap()
}
fn y(cx: &mut HeadlessAppContext, h: AnyWindowHandle, section: &str) -> f32 {
    cx.update_window(h, |_, w, _| {
        f32::from(
            w.find(SharedString::from(format!("mission-{section}-task-E")))
                .bounds()
                .top(),
        )
    })
    .unwrap()
}
fn fraction(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> f32 {
    cx.update_window(h, |_, w, _| {
        f32::from(w.find("mission-progress-done").bounds().size.width)
            / f32::from(w.find("mission-progress-bar").bounds().size.width)
    })
    .unwrap()
}
fn set_detail(cx: &mut HeadlessAppContext, b: &Entity<Browser>, raw: &serde_json::Value) {
    let detail = Arc::new(model::detail(&f::key("mission-A"), raw).unwrap());
    cx.update(|cx| {
        b.update(cx, |b, cx| {
            b.detail = Some(detail);
            cx.notify();
        })
    });
}
fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}
fn capture(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    width: f32,
    mode: ThemeMode,
    step: &str,
) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_MISSION_MOTION_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{width}-{mode:?}-{step}.png")))
            .unwrap();
    }
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| {
                Theme::change(mode, None, cx);
                cx.set_reduce_motion(false);
            });
            let server = f::Server::start();
            let mut raw = f::detail("mission-A");
            raw["tasks"] = json!([
                {"id":"task-A","number":1,"title":"Finished","status":"done","order":1},
                {"id":"task-E","number":2,"title":"Moving 日本語 👩‍💻","status":"blocked","order":2},
                {"id":"task-F","number":3,"title":"Still needs you","status":"blocked","order":3},
                {"id":"task-C","number":4,"title":"Working","status":"in_progress","order":4}
            ]);
            let (h, browser) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                let mut b = Browser::new(cx);
                                b.options(server.options.clone());
                                b.online = true;
                                b.loaded = true;
                                b.generation = 1;
                                b.route = Some(Route::Detail(f::key("mission-A")));
                                b.catalog = Some(Arc::new(model::catalog(&f::catalog()).unwrap()));
                                b.catalog_current = true;
                                b.detail = Some(Arc::new(
                                    model::detail(&f::key("mission-A"), &raw).unwrap(),
                                ));
                                b.members = Ok(Arc::new(
                                    model::members(
                                        b.detail.as_ref().unwrap(),
                                        &f::members("mission-A"),
                                    )
                                    .unwrap(),
                                ));
                                b.sync_tasks(Some(f::key("mission-A")), w, cx);
                                b
                            })
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
            frame(cx, h, 240);
            let initial = y(cx, h, "needs-task");
            assert!((fraction(cx, h) - 0.25).abs() < 0.01);
            capture(cx, h, width, mode, "initial");
            let focus = cx.update(|cx| {
                browser
                    .read(cx)
                    .motion
                    .borrow_mut()
                    .focus("task-E", false, cx)
            });
            cx.update_window(h, |_, w, cx| focus.focus(w, cx)).unwrap();

            raw["tasks"][1]["status"] = json!("in_progress");
            raw["tasks"][3]["status"] = json!("done");
            set_detail(cx, &browser, &raw);
            frame(cx, h, 0);
            let start = y(cx, h, "working-task");
            assert!(
                (start - initial).abs() < 0.1,
                "move starts where shown: {initial} -> {start}"
            );
            cx.update_window(h, |_, w, _| {
                assert!(
                    focus.is_focused(w),
                    "focus follows canonical task across sections"
                );
                assert!(
                    w.try_find("mission-needs-task-task-E").is_none(),
                    "old action removed immediately"
                );
            })
            .unwrap();
            let mut draw = Vec::new();
            draw.push(frame(cx, h, 64));
            let middle = y(cx, h, "working-task");
            let bar_middle = fraction(cx, h);
            assert!(
                bar_middle > 0.25 && bar_middle < 0.5,
                "intermediate fill {bar_middle}"
            );
            capture(cx, h, width, mode, "moving");

            // Reverse before landing. The new row begins at the exact shown Y.
            raw["tasks"][1]["status"] = json!("blocked");
            raw["tasks"][3]["status"] = json!("in_progress");
            set_detail(cx, &browser, &raw);
            frame(cx, h, 0);
            let reverse = y(cx, h, "needs-task");
            assert!(
                (reverse - middle).abs() < 0.1,
                "reversal {middle} -> {reverse}"
            );
            assert!((fraction(cx, h) - bar_middle).abs() < 0.01);
            draw.push(frame(cx, h, 64));
            let reversing = y(cx, h, "needs-task");
            frame(cx, h, 240);
            let end = y(cx, h, "needs-task");
            assert!((end - initial).abs() < 0.1);
            assert!(
                (reversing - end).abs() < (middle - end).abs(),
                "reversal approaches end: {middle} -> {reversing} -> {end}"
            );
            assert!((fraction(cx, h) - 0.25).abs() < 0.01);

            // Finish the forward move; no old section/control survives it.
            raw["tasks"][1]["status"] = json!("in_progress");
            set_detail(cx, &browser, &raw);
            frame(cx, h, 0);
            draw.push(frame(cx, h, 64));
            let forward_middle = y(cx, h, "working-task");
            frame(cx, h, 240);
            let forward_end = y(cx, h, "working-task");
            capture(cx, h, width, mode, "landed");
            assert!(
                (forward_middle - initial).abs() > 0.1
                    && (forward_middle - forward_end).abs() > 0.1
            );
            assert!(
                forward_middle > initial.min(forward_end)
                    && forward_middle < initial.max(forward_end)
            );

            // Resize during a move cancels its old offset in the same prepaint.
            raw["tasks"][1]["status"] = json!("blocked");
            set_detail(cx, &browser, &raw);
            frame(cx, h, 0);
            frame(cx, h, 64);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width - 40.), px(600.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            cx.update(|cx| {
                let b = browser.read(cx);
                let motion = b.motion.borrow();
                let row = motion.rows["task-E"].borrow();
                assert_eq!(row.shown, row.target);
                assert!(!row.transition.running());
            });
            let before_scroll = y(cx, h, "needs-task");
            let offset_before = cx.update(|cx| browser.read(cx).detail_scroll.offset());
            cx.update(|cx| {
                browser.update(cx, |b, cx| {
                    b.detail_scroll
                        .set_offset(offset_before + point(px(0.), px(-20.)));
                    cx.notify();
                })
            });
            frame(cx, h, 0);
            let offset_after = cx.update(|cx| browser.read(cx).detail_scroll.offset());
            let scrolled = y(cx, h, "needs-task");
            assert!(
                offset_after.y < offset_before.y,
                "fixture must actually scroll"
            );
            assert!(
                (scrolled - before_scroll - f32::from(offset_after.y - offset_before.y)).abs()
                    < 0.1,
                "scroll must apply at once, without an animated rebound"
            );
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width), px(840.)));
                w.bounds_changed(cx);
                browser.update(cx, |b, cx| {
                    b.detail_scroll.set_offset(Default::default());
                    cx.notify();
                });
            })
            .unwrap();
            frame(cx, h, 0);

            // A task disappearing from the preview restores the browser focus.
            raw["tasks"][1]["status"] = json!("done");
            cx.update(|cx| cx.set_reduce_motion(true));
            set_detail(cx, &browser, &raw);
            frame(cx, h, 0);
            cx.update_window(h, |_, w, cx| {
                assert!(browser.read(cx).focus.is_focused(w));
                assert!(w.try_find("mission-working-task-task-E").is_none());
            })
            .unwrap();
            assert!((fraction(cx, h) - 0.5).abs() < 0.01);

            // Native brief open/close handlers, including full-size child bounds,
            // mid-close reversal and immediate removal of all brief controls.
            cx.update(|cx| cx.set_reduce_motion(false));
            cx.update_window(h, |_, w, cx| {
                browser.update(cx, |b, cx| b.open_brief(w, cx))
            })
            .unwrap();
            frame(cx, h, 0);
            let brief_shown = |cx: &mut HeadlessAppContext| {
                cx.update(|cx| browser.read(cx).motion.borrow().brief.borrow().shown)
            };
            assert_eq!(brief_shown(cx), 0.);
            draw.push(frame(cx, h, 64));
            let brief_middle = brief_shown(cx);
            let full = cx
                .update_window(h, |_, w, _| {
                    f32::from(w.find("mission-brief-workspace").bounds().size.height)
                })
                .unwrap();
            assert!(brief_middle > 0. && brief_middle < full);
            capture(cx, h, width, mode, "brief-opening");
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width - 40.), px(780.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            let resized_full = cx
                .update_window(h, |_, w, _| {
                    f32::from(w.find("mission-brief-workspace").bounds().size.height)
                })
                .unwrap();
            assert_eq!(resized_full, 780.);
            assert!(
                (brief_shown(cx) / resized_full - brief_middle / full).abs() < 0.001,
                "resize immediately scales the clip without restarting its clock"
            );
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width), px(840.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            frame(cx, h, 240);
            assert_eq!(brief_shown(cx), full);
            capture(cx, h, width, mode, "brief-open");
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h, 0);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mission-brief-workspace").is_none())
            })
            .unwrap();
            draw.push(frame(cx, h, 64));
            let closing = brief_shown(cx);
            assert!(closing > 0. && closing < full);
            cx.update_window(h, |_, w, cx| {
                browser.update(cx, |b, cx| b.open_brief(w, cx))
            })
            .unwrap();
            frame(cx, h, 0);
            assert_eq!(brief_shown(cx), closing);
            frame(cx, h, 240);
            assert_eq!(brief_shown(cx), full);
            cx.update(|cx| cx.set_reduce_motion(true));
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(brief_shown(cx), 0.);

            let mut idle = Vec::new();
            let mut render = Vec::new();
            for _ in 0..8 {
                idle.push(frame(cx, h, 16));
                render.push(
                    cx.update_window(h, |_, w, cx| {
                        let start = Instant::now();
                        w.render_frame(cx);
                        start.elapsed().as_secs_f64() * 1000.
                    })
                    .unwrap(),
                );
            }
            println!(
                "mission-motion {width} {mode:?}: row y {initial:.2} -> {middle:.2}, reverse {reverse:.2} -> {reversing:.2} -> {end:.2}; forward {forward_middle:.2} -> {forward_end:.2}; bar .25 -> {bar_middle:.4} -> .25; brief 0 -> {brief_middle:.2} -> {full:.2}, close {closing:.2} -> reopen {full:.2}; resize and scroll immediate; draw median {:.3}ms, idle draw {:.3}ms, headless render_frame {:.3}ms (not GPU/presentation cost)",
                median(&mut draw),
                median(&mut idle),
                median(&mut render)
            );
            // Return still activates the canonical row after it has moved. The
            // existing reveal selects and centres it among all received tasks.
            raw["tasks"][1]["status"] = json!("in_progress");
            raw["tasks"][1]["order"] = json!(80.5);
            raw["tasks"]
                .as_array_mut()
                .unwrap()
                .extend((0..120).map(|i| {
                    json!({
                        "id":format!("filler-{i}"), "number":i+10, "title":"Waiting task",
                        "status":"todo", "order":i+1
                    })
                }));
            server.reply("/api/missions/mission-A", f::Reply::json(200, raw.clone()));
            set_detail(cx, &browser, &raw);
            frame(cx, h, 0);
            let row_focus = cx.update(|cx| {
                browser
                    .read(cx)
                    .motion
                    .borrow_mut()
                    .focus("task-E", false, cx)
            });
            cx.update_window(h, |_, w, cx| {
                row_focus.focus(w, cx);
                w.press("enter", cx);
            })
            .unwrap();
            assert_eq!(cx.update(|cx| browser.read(cx).tab), Tab::Tasks);
            let deadline = Instant::now() + Duration::from_secs(6);
            while !cx.update(|cx| {
                browser
                    .read(cx)
                    .tasks_browser
                    .read(cx)
                    .state
                    .selected
                    .as_deref()
                    == Some("task-E")
            }) {
                assert!(Instant::now() < deadline, "bounded task reveal");
                frame(cx, h, 16);
                std::thread::yield_now();
            }
            // One later layout applies Kit's deferred Centre reveal.
            frame(cx, h, 16);
            cx.update_window(h, |_, w, _| {
                let row = w.find("mission-tasks-item-task-E").bounds();
                let list = w.find("mission-tasks-list").bounds();
                assert!(
                    row.top() >= list.top() && row.bottom() <= list.bottom(),
                    "selected task visible"
                );
                assert!(
                    (row.center().y - list.center().y).abs() < row.size.height,
                    "Centre reveal preserved: {row:?} in {list:?}"
                );
            })
            .unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
