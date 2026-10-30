//! Hidden production LocalViewer with an owned GET-only retained fixture.
use crate::{
    LocalViewer,
    mission_browser_fixture::{self as f, Reply, Server},
    native_review_fixture as r,
    native_review_view::Pane,
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds,
    WindowOptions, px, size, test::TestWindowExt,
};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| p(cx)) {
        assert!(
            Instant::now() < end,
            "Review timeout at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn choose(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str, down: usize) {
    click(cx, h, id);
    for _ in 0..down {
        cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        settle(cx, h);
    }
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
}
fn idle(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Pane>) {
    until(cx, h, |cx| !p.read(cx).probe(cx).0);
}
pub fn run_native_review_probe(cx: &mut HeadlessAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    // Real managed jj -> durable lifecycle outbox -> capture -> admitted list/patch/source.
    // Only the final transport is the owned faux HTTP server below, never production data.
    let output = std::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/daemon/src/testing/retained-review.ts"),
        )
        .output()
        .expect("real retained capture fixture must run");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let retained: serde_json::Value = serde_json::from_str(
        stdout
            .lines()
            .find(|line| line.starts_with("{\"first\":"))
            .expect("real retained capture response, separate from Node test-runner diagnostics"),
    )
    .unwrap();
    let dir = std::env::var_os("PILOT_NEXT_REVIEW_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let s = Server::start();
            r::install(&s);
            let (h, view) = cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                );
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
                    |w, cx| cx.new(|cx| LocalViewer::synthetic(w, cx)),
                )
                .unwrap()
            });
            let browser = cx
                .update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| v.brief_fixture_setup(s.options.clone(), w, cx))
                })
                .unwrap();
            until(cx, h, |cx| {
                browser.read(cx).catalog.is_some() && !browser.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| {
                w.click(format!("mission-row-{}", f::key("mission-A").tag()), cx)
            })
            .unwrap();
            until(cx, h, |cx| {
                browser.read(cx).detail.is_some() && !browser.read(cx).busy
            });
            click(cx, h, "mission-tab-review");
            let pane = cx.update(|cx| browser.read(cx).review.clone().unwrap());
            idle(cx, h, &pane);
            choose(cx, h, "review-worker", 1);
            idle(cx, h, &pane);
            choose(cx, h, "review-comparison", 1);
            idle(cx, h, &pane);
            cx.update(|cx| {
                let p = pane.read(cx).probe(cx);
                assert_eq!(p.1, Some(format!("{:064x}", 1)));
                assert_eq!(p.3, 1);
                assert_eq!(p.4, None);
            });
            cx.update_window(h, |_, w, cx| {
                let b = w.find("review-diff").bounds();
                assert!(b.size.height > px(160.));
                assert!(
                    w.find("review-details").bounds().bottom()
                        <= w.find("review-summary").bounds().bottom() + px(1.),
                    "Details must be visible without scrolling"
                );
                assert!(
                    w.try_find("review-records").is_none(),
                    "evidence stays inside Details"
                );
                assert!(
                    w.try_find("review-after").is_none(),
                    "source inspection stays inside Details"
                );
                assert!(b.right() <= w.find("native-review").bounds().right() + px(1.));
                w.click("review-diff", cx);
                w.press("down", cx);
                w.press("alt-down", cx);
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "review-split");
            click(cx, h, "review-unified");
            choose(cx, h, "review-comparison", 1);
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 2))));
            // A new retained revision never changes the exact chosen layer/stack.
            let mut partial = r::comparison(3, "layer");
            partial["status"] = json!("partial");
            let mut manifest = r::snapshot(&partial);
            manifest["omissions"] = json!(["before: one blob omitted (limit)"]);
            s.reply(&format!("{}/chat-B?after=0",r::ROOT),Reply::json(200,json!({"comparisons":[r::comparison(1,"layer"),r::comparison(2,"stack"),partial],"next":null})));
            s.reply(
                &format!("{}/chat-B/{:064x}", r::ROOT, 3),
                Reply::json(200, manifest),
            );
            s.reply(
                &format!("{}/chat-B/{:064x}/patch", r::ROOT, 3),
                Reply::json(
                    200,
                    json!({"snapshotId":format!("{:064x}",3),"patch":r::PATCH}),
                ),
            );
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 2))));
            choose(cx, h, "review-comparison", 1);
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 3))));
            // Select the previous retained comparison again, not live HEAD.
            click(cx, h, "review-comparison");
            cx.update_window(h, |_, w, cx| {
                w.press("up", cx);
                w.press("enter", cx);
            })
            .unwrap();
            idle(cx, h, &pane);
            click(cx, h, "review-details");
            click(cx, h, "review-after");
            idle(cx, h, &pane);
            cx.update(|cx| {
                assert!(
                    pane.read(cx)
                        .probe(cx)
                        .2
                        .unwrap()
                        .contains("retained lower")
                )
            });
            cx.update_window(h, |_, w, cx| {
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert!(pane.read(cx).probe(cx).2.is_none()));
            click(cx, h, "review-details");
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(if width == 680. { 1100. } else { 680. }), px(700.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("review-diff").bounds().size.height > px(100.))
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "review-{}-{}.png",
                        width as u32,
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            cx.update(|cx| pane.update(cx, |p, cx| p.probe_stale(cx)));
            // A refused target clears all prior authorized source/diff, not just its badge.
            s.reply(
                &format!("{}/chat-B/{:064x}", r::ROOT, 2),
                Reply::json(403, json!({"error":"denied"})),
            );
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| {
                let p = pane.read(cx).probe(cx);
                assert_eq!(p.3, 0);
                assert!(p.4.is_some());
            });
            r::install(&s);
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).3, 1));
            // Consume actual retained bytes, not the hand-authored demo manifest above.
            for (path, response) in retained["routes"].as_object().unwrap() {
                s.reply(path, Reply::json(200, response.clone()));
            }
            s.reply(
                &format!("{}/chat-B?after=0", r::ROOT),
                Reply::json(200, retained["first"].clone()),
            );
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            // Clear the earlier pinned fixture by returning through a different worker scope.
            let moved=crate::local_model::chat(&json!({"id":"chat-B","title":"Moved worker","projectId":"other","missionId":"other","state":"idle"})).unwrap();
            cx.update(|cx| pane.update(cx, |p, cx| p.observe_scope(&[moved], cx)));
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            choose(cx, h, "review-worker", 1);
            idle(cx, h, &pane);
            choose(cx, h, "review-comparison", 1);
            idle(cx, h, &pane);
            let real_id = retained["first"]["comparisons"][0]["snapshotId"]
                .as_str()
                .unwrap();
            cx.update(|cx| {
                assert_eq!(pane.read(cx).probe(cx).1.as_deref(), Some(real_id));
                assert_eq!(pane.read(cx).probe(cx).3, 1);
            });
            s.reply(
                &format!("{}/chat-B?after=0", r::ROOT),
                Reply::json(200, retained["latest"].clone()),
            );
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1.as_deref(), Some(real_id)));
            // Details may already be open from the preceding journey.
            cx.update_window(h, |_, w, cx| {
                if w.try_find("review-after").is_none() {
                    w.click("review-details", cx);
                }
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "review-after");
            idle(cx, h, &pane);
            cx.update(|cx| {
                assert!(
                    pane.read(cx)
                        .probe(cx)
                        .2
                        .as_deref()
                        .unwrap()
                        .contains("retained lower")
                )
            });
            click(cx, h, "review-back");
            // Failed capture is distinct from an empty inventory; selector is absent when unusable.
            let moved=crate::local_model::chat(&json!({"id":"chat-B","title":"Moved worker","projectId":"other","missionId":"other","state":"idle"})).unwrap();
            cx.update(|cx| pane.update(cx, |p, cx| p.observe_scope(&[moved], cx)));
            s.reply(
                &format!("{}/chat-B?after=0", r::ROOT),
                Reply::json(
                    200,
                    json!({"comparisons":[],"next":null,"capture":{"pending":0,"failed":1}}),
                ),
            );
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            choose(cx, h, "review-worker", 1);
            idle(cx, h, &pane);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("review-comparison").is_none())
            })
            .unwrap();
            cx.update(|cx| assert_eq!(pane.read(cx).probe_capture_notice(),Some("Saving some committed revisions couldn't be confirmed. They remain queued for exact recovery at the next worker checkpoint; existing saved revisions are unchanged.")));
            cx.update_window(h, |_, w, _| {
                assert!(w.find("review-capture-notice").bounds().size.height > px(0.))
            })
            .unwrap();
            s.reply(&format!("{}/chat-B?after=0",r::ROOT),Reply::json(200,json!({"comparisons":[],"next":null,"capture":{"pending":0,"failed":1,"unsupported":["conflicted"]}})));
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| {
                assert!(
                    pane.read(cx)
                        .probe_capture_notice()
                        .unwrap()
                        .contains("Conflicted")
                )
            });
            s.reply(&format!("{}/chat-B?after=0",r::ROOT),Reply::json(200,json!({"comparisons":[],"next":null,"capture":{"pending":0,"failed":0,"unsupported":["divergent","multiple-parents","root-base","missing","unknown-custody","unknown-discovery"]}})));
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update_window(h, |_, w, cx| {
                if w.try_find("review-capture-limitations").is_none() {
                    w.click("review-details", cx);
                }
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("review-comparison").is_none());
                assert!(w.find("review-capture-limitations").bounds().size.height > px(0.));
            })
            .unwrap();
            s.reply(
                &format!("{}/chat-B?after=0", r::ROOT),
                Reply::json(
                    200,
                    json!({"comparisons":[],"next":null,"unavailable":"missing custody"}),
                ),
            );
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| {
                assert!(
                    pane.read(cx)
                        .probe(cx)
                        .4
                        .unwrap()
                        .contains("ownership binding")
                )
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("review-comparison").is_none())
            })
            .unwrap();
            let moved=crate::local_model::chat(&json!({"id":"chat-B","title":"Moved worker","projectId":"other","missionId":"other","state":"idle"})).unwrap();
            cx.update(|cx| pane.update(cx, |p, cx| p.observe_scope(&[moved], cx)));
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).3, 0));
            s.reply(r::ROOT,Reply::json(200,json!({"missionId":"mission-A","projectId":"project-A","workers":[],"more":false})));
            click(cx, h, "review-refresh");
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).3, 0));
            cx.update_window(h, |_, w, cx| {
                pane.update(cx, |p, cx| p.focus(w, cx));
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    browser.read(cx).tab,
                    crate::mission_browser_view::Tab::Overview
                )
            });
            assert!(s.all_gets());
            assert!(
                s.state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(_, p)| !p.contains("/changes") && !p.contains("/workspace"))
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            drop(pane);
            drop(browser);
            drop(view);
            cx.run_until_parked();
        }
    }
    println!(
        "native Review: four hidden production-root mission entry, exact layer/stack, newer pin, partial, source/back, resize, empty/refusal and keyboard journeys; GET-only synthetic data, not OS IME/AX/performance acceptance"
    );
}
