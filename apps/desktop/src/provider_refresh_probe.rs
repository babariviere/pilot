//! Mounted Home and Usage, fake daemon only, hidden native light/dark.
use crate::{
    app_shell::{Overview, OverviewInput},
    mission_browser_fixture::{Reply, Server},
    provider_refresh_reader,
    provider_refresh_view::Limits,
    usage_overview_view::Usage,
};
use gpui_kit::{
    AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

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
fn until(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, limits: &Entity<Limits>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| limits.read(cx).state.busy) {
        assert!(Instant::now() < end, "finite limits refresh");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn path(s: &Server, provider: &str) -> String {
    let u = provider_refresh_reader::url(&s.options, provider);
    format!("{}?{}", u.path(), u.query().unwrap())
}
pub(crate) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let s = Server::start();
            s.reply("/api/hello",Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"subscriptionRefresh":1}})));
            let at = crate::usage_overview::now();
            for provider in ["anthropic", "openai"] {
                let mut reply = Reply::json(
                    200,
                    json!({"provider":provider,"account":"not_reported","state":if provider=="anthropic"{"refreshed"}else{"cached"},"usage":{"provider":provider,"fetchedAt":at,"windows":[{"label":"5h","usedPercent":42,"resetsAt":"2099-01-01T12:00:00Z"},{"label":"Week","usedPercent":81}]}}),
                );
                reply.delay_ms = 100;
                s.reply(&path(&s, provider), reply);
            }
            let (h, (overview, limits)) = cx.update(|cx| {
                Theme::change(mode, None, cx);
                let (h, overview) = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1000.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| {
                        let limits = cx.new(|_| Limits::new(s.options.clone()));
                        cx.new(|cx| {
                            let mut v = Overview::new();
                            v.limits = Some(limits);
                            v.sync(
                                OverviewInput {
                                    projects: Arc::new(vec![]),
                                    chats: Arc::new(vec![]),
                                    project: None,
                                    projects_loaded: true,
                                    chats_loaded: true,
                                    error: None,
                                },
                                cx,
                            );
                            v
                        })
                    },
                )
                .unwrap();
                let limits = overview.read(cx).limits.clone().unwrap();
                (h, (overview, limits))
            });
            settle(cx, h);
            assert!(
                s.state.lock().unwrap().seen.is_empty(),
                "rendering never contacts provider or daemon"
            );
            cx.update_window(h, |_, w, cx| {
                w.activate_window();
                w.focus_next(cx);
                w.press("space", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(
                cx.update(|cx| limits.read(cx).state.busy),
                "keyboard invokes real Refresh limits"
            );
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find("subscription-refresh-status")
                        .label()
                        .unwrap()
                        .contains("Refreshing")
                );
                w.click("subscription-refresh", cx);
            })
            .unwrap();
            until(cx, h, &limits);
            assert_eq!(
                s.state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .filter(|(m, _)| m == "POST")
                    .count(),
                2,
                "disabled duplicate never queues another refresh"
            );
            cx.update_window(h, |_, w, cx| {
                let status = w
                    .find("subscription-refresh-status")
                    .label()
                    .unwrap()
                    .to_owned();
                assert!(status.contains("Claude: updated"));
                assert!(status.contains("Codex: recent cached report"));
                for id in [
                    "subscription-limits",
                    "subscription-refresh-status",
                    "home-subscriptions",
                ] {
                    let b = w.find(id).bounds();
                    assert!(b.left() >= px(0.) && b.right() <= px(width), "{id} fits");
                }
                w.click("home-subscription-Claude-details-toggle", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                let text = w
                    .find("home-subscription-Claude-details")
                    .label()
                    .unwrap()
                    .to_owned();
                assert!(text.contains("Account identity is not reported"));
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_PROVIDER_USAGE_CAPTURE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("limits-refresh-{width}-{mode:?}.png")))
                    .unwrap();
            }
            // The Usage window mounts the exact same owner, including pending/error state.
            let (uh, usage) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1000.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| {
                        cx.new(|cx| {
                            let mut v = Usage::new(None, cx);
                            v.limits = Some(limits.clone());
                            v
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, uh);
            for provider in ["anthropic", "openai"] {
                s.reply(
                    &path(&s, provider),
                    Reply::json(500, json!({"error":"private account"})),
                );
            }
            cx.update_window(uh, |_, w, cx| w.click("subscription-refresh", cx))
                .unwrap();
            until(cx, uh, &limits);
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| limits.read(cx).state.snapshots[0].fetched_at),
                Some(at)
            );
            for wh in [h, uh] {
                cx.update_window(wh, |_, w, _| {
                    assert!(
                        w.find("subscription-refresh-status")
                            .label()
                            .unwrap()
                            .contains("refresh failed")
                    );
                    assert!(w.try_find("home-subscriptions").is_some());
                })
                .unwrap();
            }
            let count = s.state.lock().unwrap().seen.len();
            cx.advance_clock(Duration::from_secs(180));
            settle(cx, h);
            assert_eq!(
                s.state.lock().unwrap().seen.len(),
                count,
                "no polling or retry"
            );
            cx.update_window(uh, |_, w, _| w.remove_window()).unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            drop((overview, usage));
        }
    }
}
