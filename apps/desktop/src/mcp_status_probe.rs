//! Real hidden Settings navigation, MCP actions and sign-in journeys against an owned faux daemon only.
use crate::{
    mcp_status::{SignInStatus, Snapshot},
    mcp_status_tests::{self as f, Answer, Daemon},
    mcp_status_view::Connections,
    settings_view::{SettingsPreferences, SettingsView},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    component::{Theme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
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
/// Bounded wait for the page's read and action to finish.
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<Connections>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).state.busy || v.read(cx).pending.is_some()) {
        assert!(Instant::now() < end, "bounded faux MCP request");
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
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    cx.update_window(h, |_, w, cx| w.click(id.to_owned(), cx))
        .unwrap();
    settle(cx, h);
}
fn exists(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) -> bool {
    cx.update_window(h, |_, w, _| w.try_find(id.to_owned()).is_some())
        .unwrap()
}
/// Real Kit focus traversal, then Enter. No direct state mutation.
fn keyboard(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    for _ in 0..40 {
        if cx
            .update_window(h, |_, w, _| w.find(id.to_owned()).focused() == Some(true))
            .unwrap()
        {
            break;
        }
        cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
        settle(cx, h);
    }
    cx.update_window(h, |_, w, cx| {
        assert_eq!(
            w.find(id.to_owned()).focused(),
            Some(true),
            "{id} keyboard focus"
        );
        w.press("enter", cx);
    })
    .unwrap();
    settle(cx, h);
}
fn push(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<Connections>, value: Value) {
    let report = Arc::new(Snapshot::from_value(&value));
    cx.update(|cx| v.update(cx, |c, cx| c.pushed(report, cx)));
    settle(cx, h);
}
fn linear(cx: &mut HeadlessAppContext, v: &Entity<Connections>) -> crate::mcp_status::Server {
    cx.update(|cx| v.read(cx).state.snapshot.as_ref().unwrap().servers[1].clone())
}
fn with_linear(state: &str, sign_in: Value) -> Value {
    let mut v = f::roster();
    v["servers"][1]["state"] = json!(state);
    v["servers"][1]["signIn"] = sign_in;
    v
}
pub fn run_mcp_status_probe(cx: &mut HeadlessAppContext) {
    let linear_path = f::sign_in_path("Linear");
    let action = "mcp-action-Linear";
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let d = Daemon::start();
            let mut r = Answer::json(200, f::roster());
            r.delay_ms = 180;
            d.reply("GET", "/api/mcp", r);
            let (h, (v, settings)) = cx.update(|cx| {
                Theme::change(mode, None, cx);
                let mcp = cx.new(|_| Connections::new(d.options.clone()));
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
            // A report pushed before the page opens is never adopted later.
            push(cx, h, &v, with_linear("connected", json!(null)));
            assert!(
                d.seen.lock().unwrap().is_empty(),
                "no MCP request before category intent"
            );
            cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
            click(cx, h, "settings-mcp");
            assert!(exists(cx, h, "mcp-loading"));
            assert!(!exists(cx, h, "mcp-empty"));
            until(cx, h, &v);
            assert!(cx.update(|cx| v.read(cx).state.error.is_none()));
            assert!(d.actions().is_empty(), "opening never checks or signs in");
            assert_eq!(linear(cx, &v).state, crate::mcp_status::Status::NeedsSignIn);
            cx.update_window(h, |_, w, _| {
                for id in [
                    "mcp-title",
                    "mcp-refresh",
                    "mcp-check",
                    "mcp-page",
                    "mcp-needs",
                    "mcp-list",
                    "mcp-config-problem",
                    action,
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.left() >= px(0.) && b.right() <= px(width),
                        "{id} at {width}"
                    );
                }
                let name = w.find("mcp-text-Linear").bounds();
                let state = w.find("mcp-state-Linear").bounds();
                let button = w.find(action).bounds();
                assert!(
                    name.right() <= state.left() && state.right() <= button.left(),
                    "name, status and action share one line"
                );
                // Needs you comes first.
                assert!(w.find("mcp-needs").bounds().bottom() <= w.find("mcp-list").bounds().top());
            })
            .unwrap();
            capture(cx, h, format!("mcp-{width}-{mode:?}-roster"));

            // Required-auth row: keyboard Sign in starts exactly one daemon-owned browser sign-in.
            let mut ack = Answer::json(200, f::waiting(1_793_381_100_000));
            ack.delay_ms = 120;
            d.reply("POST", &linear_path, ack);
            keyboard(cx, h, action);
            assert!(
                cx.update(|cx| v.read(cx).pending.is_some()),
                "action in flight"
            );
            until(cx, h, &v);
            assert_eq!(
                d.actions(),
                vec![(
                    "POST".into(),
                    linear_path.clone(),
                    r#"{"again":false}"#.into()
                )]
            );
            assert!(linear(cx, &v).sign_in.unwrap().waiting());
            assert!(
                !exists(cx, h, "mcp-sign-in-Linear"),
                "the status word says waiting once"
            );
            capture(cx, h, format!("mcp-{width}-{mode:?}-waiting"));

            // Leaving Settings neither cancels nor restarts the daemon's sign-in.
            d.reply(
                "GET",
                "/api/mcp",
                Answer::json(
                    200,
                    with_linear("needs_sign_in", f::waiting(1_793_381_100_000)),
                ),
            );
            click(cx, h, "settings-appearance");
            click(cx, h, "settings-mcp");
            until(cx, h, &v);
            assert_eq!(d.actions().len(), 1);
            assert!(linear(cx, &v).sign_in.unwrap().waiting());

            // A newer start is reported first: cancel binds the exact observed start, and a
            // changed sign-in is refused, shown and re-read without a second attempt.
            push(
                cx,
                h,
                &v,
                with_linear("needs_sign_in", f::waiting(1_793_381_200_000)),
            );
            d.reply(
                "DELETE",
                &linear_path,
                Answer::json(409, json!({"error":"Sign-in changed"})),
            );
            click(cx, h, action);
            until(cx, h, &v);
            assert_eq!(
                d.actions()[1],
                (
                    "DELETE".into(),
                    linear_path.clone(),
                    r#"{"expectedStartedAt":1793381200000}"#.into()
                )
            );
            assert!(exists(cx, h, "mcp-note-Linear"));
            // That re-read reports the earlier start again; cancel now binds that one.
            assert_eq!(
                linear(cx, &v).sign_in.unwrap().started_at,
                1_793_381_100_000
            );
            d.reply("DELETE", &linear_path, Answer::json(200, json!({"state":"cancelled","startedAt":1_793_381_100_000u64,"expiresAt":1_793_381_400_000u64,"finishedAt":1_793_381_150_000u64})));
            click(cx, h, action);
            until(cx, h, &v);
            assert_eq!(d.actions()[2].2, r#"{"expectedStartedAt":1793381100000}"#);
            assert_eq!(
                linear(cx, &v).sign_in.unwrap().state,
                SignInStatus::Cancelled
            );
            assert!(!exists(cx, h, "mcp-note-Linear"));
            capture(cx, h, format!("mcp-{width}-{mode:?}-cancelled"));

            // Completion and failure come from the reported sign-in, never from the roster alone.
            push(cx, h, &v, with_linear("connected", json!(null)));
            assert!(!exists(cx, h, "mcp-sign-in-Linear") && !exists(cx, h, action));
            push(
                cx,
                h,
                &v,
                with_linear(
                    "connected",
                    json!({"state":"done","startedAt":1_793_381_300_000u64,"expiresAt":1_793_381_600_000u64,"finishedAt":1_793_381_310_000u64}),
                ),
            );
            assert!(exists(cx, h, "mcp-sign-in-Linear"));
            capture(cx, h, format!("mcp-{width}-{mode:?}-signed-in"));
            push(
                cx,
                h,
                &v,
                with_linear(
                    "needs_sign_in",
                    json!({"state":"failed","startedAt":1_793_381_300_000u64,"expiresAt":1_793_381_600_000u64,"finishedAt":1_793_381_310_000u64,"error":"Sign-in timed out. Try again."}),
                ),
            );
            assert!(exists(cx, h, "mcp-sign-in-Linear") && exists(cx, h, action));
            capture(cx, h, format!("mcp-{width}-{mode:?}-failed"));

            // Lost ACK: unconfirmed, re-read passively, never replayed.
            d.reply("POST", &linear_path, Answer::lost());
            let reads = d.reads();
            click(cx, h, action);
            until(cx, h, &v);
            assert_eq!(d.actions().len(), 4);
            assert!(d.reads() > reads, "passive re-read after a lost ACK");
            assert!(exists(cx, h, "mcp-note-Linear"));
            capture(cx, h, format!("mcp-{width}-{mode:?}-unconfirmed"));

            // A different daemon: refused before anything is sent.
            d.identity("different-daemon");
            click(cx, h, action);
            until(cx, h, &v);
            assert_eq!(d.actions().len(), 4);
            assert!(exists(cx, h, "mcp-note-Linear"));
            d.identity("test-daemon");

            // Sign in again is an explicit secondary choice inside Details.
            let details = format!("mcp-details-{}", f::NAME);
            let again = format!("mcp-sign-in-again-{}", f::NAME);
            assert!(!exists(cx, h, &again));
            d.reply(
                "POST",
                &f::sign_in_path(f::NAME),
                Answer::json(200, f::waiting(1_793_381_500_000)),
            );
            keyboard(cx, h, &details);
            assert!(exists(cx, h, "mcp-detail-text"));
            click(cx, h, &again);
            until(cx, h, &v);
            assert_eq!(
                d.actions()[4],
                (
                    "POST".into(),
                    f::sign_in_path(f::NAME),
                    r#"{"again":true}"#.into()
                )
            );
            assert!(
                exists(cx, h, &format!("mcp-action-{}", f::NAME)),
                "Cancel replaces Sign in again"
            );

            // Literal Unicode selection/copy survives the new layout.
            cx.update_window(h, |_, w, cx| {
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
            click(cx, h, &details);

            // Check now asks the daemon to connect again; Refresh only re-reads.
            let mut checking = f::roster();
            checking["checking"] = json!(true);
            d.reply("POST", "/api/mcp/check", Answer::json(200, checking));
            click(cx, h, "mcp-check");
            until(cx, h, &v);
            assert_eq!(
                d.actions()[5],
                ("POST".into(), "/api/mcp/check".into(), "{}".into())
            );
            assert!(exists(cx, h, "mcp-checking"));
            click(cx, h, "mcp-check");
            assert_eq!(
                d.actions().len(),
                6,
                "disabled while the daemon reports a check"
            );

            // Stale retained report on a failed re-read.
            let read_at = cx.update(|cx| v.read(cx).state.read_at);
            d.reply("GET", "/api/mcp", Answer::json(503, json!({})));
            click(cx, h, "mcp-refresh");
            until(cx, h, &v);
            assert_eq!(cx.update(|cx| v.read(cx).state.read_at), read_at);
            assert!(exists(cx, h, "mcp-error") && exists(cx, h, "mcp-stale"));
            assert!(exists(cx, h, &format!("mcp-text-{}", f::NAME)));
            capture(cx, h, format!("mcp-{width}-{mode:?}-stale"));
            d.reply(
                "GET",
                "/api/mcp",
                Answer::json(200, json!({"checking":false,"servers":[]})),
            );
            click(cx, h, "mcp-refresh");
            until(cx, h, &v);
            assert!(exists(cx, h, "mcp-empty"));
            capture(cx, h, format!("mcp-{width}-{mode:?}-empty"));

            // Navigation drops in-flight work: reads are cancelled, a sign-in started on the
            // daemon is neither cancelled nor repeated, and its late reply is ignored.
            d.reply("GET", "/api/mcp", Answer::json(200, f::roster()));
            click(cx, h, "mcp-refresh");
            until(cx, h, &v);
            let mut slow = Answer::json(200, f::waiting(1_793_381_700_000));
            slow.delay_ms = 300;
            d.reply("POST", &linear_path, slow);
            click(cx, h, action);
            let mut slow = Answer::json(200, f::roster());
            slow.delay_ms = 180;
            d.reply("GET", "/api/mcp", slow);
            click(cx, h, "mcp-refresh");
            click(cx, h, "settings-appearance");
            assert!(cx.update(|cx| !v.read(cx).state.busy && v.read(cx).pending.is_none()));
            std::thread::sleep(Duration::from_millis(400));
            settle(cx, h);
            assert!(
                linear(cx, &v).sign_in.is_none(),
                "late ACK after leaving is ignored"
            );
            assert_eq!(d.actions().len(), 7);
            let deletes = d.actions().iter().filter(|(m, _, _)| m == "DELETE").count();
            assert_eq!(deletes, 2, "only the two explicit cancellations");
            // Explicit close through the real Settings owner also drops the reader.
            cx.update_window(h, |_, w, cx| {
                assert!(settings.update(cx, |s, cx| s.request_close(w, cx)));
                w.remove_window();
            })
            .unwrap();
        }
    }
}
