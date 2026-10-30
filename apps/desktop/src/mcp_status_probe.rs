//! Real hidden Settings navigation and MCP surface against an owned faux daemon only.
use crate::{
    mcp_status_tests as f,
    mcp_status_view::Connections,
    mission_browser_fixture::{Reply, Server},
    settings_view::{SettingsPreferences, SettingsView},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    component::{Theme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use std::time::{Duration, Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<Connections>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).state.busy) {
        assert!(Instant::now() < end, "bounded faux status read");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_MCP_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{name}.png")))
            .unwrap();
    }
}
pub fn run_mcp_status_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let s = Server::start();
            f::install(&s);
            let mut r = Reply::json(200, f::roster());
            r.delay_ms = 180;
            s.reply("/api/mcp", r);
            let (h, (v, settings)) = cx.update(|cx| {
                Theme::change(mode, None, cx);
                let mcp = cx.new(|_| Connections::new(s.options.clone()));
                let owner = cx.new(|_| {
                    let mut p = SettingsPreferences::new(None);
                    p.mcp = Some(mcp.clone());
                    p
                });
                owner.update(cx, |p, cx| p.load(cx));
                let (h, settings) = gpui_kit::open_window(
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
                    |w, cx| cx.new(|cx| SettingsView::new(owner, w, cx)),
                )
                .unwrap();
                (h, (mcp, settings))
            });
            settle(cx, h);
            assert!(
                s.state.lock().unwrap().seen.is_empty(),
                "no MCP read before category intent"
            );
            cx.update_window(h, |_, w, cx| {
                w.activate_window();
                w.click("settings-mcp", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mcp-loading").is_some());
                assert!(w.try_find("mcp-empty").is_none());
            })
            .unwrap();
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.error.is_none()));
            let details = format!("mcp-details-{}", f::NAME);
            cx.update_window(h, |_, w, cx| {
                for id in ["mcp-title", "mcp-refresh", "mcp-page"] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.left() >= px(0.) && b.right() <= px(width),
                        "{id} at {width}"
                    );
                }
                w.click("mcp-refresh", cx);
            })
            .unwrap();
            until(cx, h, &v);
            // Real Kit button focus and keyboard disclosure, not direct state mutation.
            for _ in 0..16 {
                if cx
                    .update_window(h, |_, w, _| w.find(details.clone()).focused() == Some(true))
                    .unwrap()
                {
                    break;
                }
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                settle(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find(details.clone()).focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("mcp-detail-text").is_some());
                let b = w.find(format!("mcp-text-{}", f::NAME)).bounds();
                assert!(b.right() <= px(width));
                let a = point(b.left() + px(1.), b.top() + px(7.));
                w.drag(a, a + point(px(200.), px(0.)), cx);
                let text = TextSelection::selected_text(w, cx);
                assert!(!text.trim().is_empty());
                assert!(
                    f::NAME.contains(text.trim()),
                    "literal Unicode selection: {text:?}"
                );
                w.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), text);
            })
            .unwrap();
            capture(cx, h, format!("mcp-{width}-{mode:?}-details"));
            cx.update_window(h, |_, w, cx| w.click(details.clone(), cx))
                .unwrap();
            settle(cx, h);
            capture(cx, h, format!("mcp-{width}-{mode:?}-roster"));
            let read_at = cx.update(|cx| v.read(cx).state.read_at);
            s.reply("/api/mcp", Reply::json(503, serde_json::json!({})));
            cx.update_window(h, |_, w, cx| w.click("mcp-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            assert_eq!(cx.update(|cx| v.read(cx).state.read_at), read_at);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mcp-error").is_some());
                assert!(w.try_find("mcp-stale").is_some());
                assert!(w.try_find(format!("mcp-text-{}", f::NAME)).is_some());
            })
            .unwrap();
            capture(cx, h, format!("mcp-{width}-{mode:?}-stale"));
            s.reply(
                "/api/mcp",
                Reply::json(200, serde_json::json!({"checking":true,"servers":[]})),
            );
            cx.update_window(h, |_, w, cx| w.click("mcp-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| assert!(w.try_find("mcp-checking").is_some()))
                .unwrap();
            // Navigation cancels active obsolete reads without altering the reported roster.
            let mut r = Reply::json(200, f::roster());
            r.delay_ms = 180;
            s.reply("/api/mcp", r);
            cx.update_window(h, |_, w, cx| {
                w.click("mcp-refresh", cx);
                w.click("settings-appearance", cx);
            })
            .unwrap();
            assert!(!cx.update(|cx| v.read(cx).state.busy));
            assert!(cx.update(|cx| {
                v.read(cx)
                    .state
                    .snapshot
                    .as_ref()
                    .unwrap()
                    .servers
                    .is_empty()
            }));
            assert!(s.all_gets());
            assert!(
                s.state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .all(|(_, p)| p == "/api/hello" || p == "/api/mcp")
            );
            // Explicit close through the real Settings owner also drops the reader.
            cx.update_window(h, |_, w, cx| {
                assert!(settings.update(cx, |s, cx| s.request_close(w, cx)));
                w.remove_window();
            })
            .unwrap();
        }
    }
}
