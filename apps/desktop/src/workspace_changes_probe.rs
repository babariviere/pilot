//! Actual mounted header/inspector with an owned faux Local server. No live data.
use super::*;
use crate::mission_browser_fixture::{Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, size, test::TestWindowExt,
};
use serde_json::json;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn wait(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<LocalViewer>) {
    let end = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        settle(cx, h);
        if cx.update(|cx| {
            v.read(cx)
                .workspace_changes
                .as_ref()
                .is_some_and(|p| !p.read(cx).state.busy)
        }) {
            return;
        }
        assert!(std::time::Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn report() -> serde_json::Value {
    json!({"base":"b9e33fb3 · canonical base","branch":"feature/日本語","files":[{"path":"src/日本語.rs","status":"modified","additions":1,"deletions":1},{"path":format!("assets/{}binary.dat","長い名前".repeat(50)),"status":"added","additions":0,"deletions":0}],"diff":"diff --git a/src/日本語.rs b/src/日本語.rs\n--- a/src/日本語.rs\n+++ b/src/日本語.rs\n@@ -1 +1 @@\n-old\n+new\n","truncated":false})
}
pub fn run_workspace_changes_probe(cx: &mut HeadlessAppContext) {
    let captures =
        std::env::var_os("PILOT_NEXT_WORKSPACE_CHANGES_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let server = Server::start();
            let path = "/api/sessions/synthetic/changes";
            let mut slow = Reply::json(200, report());
            slow.delay_ms = 250;
            server.reply(path, slow);
            let (writer, writes) = Interaction::recording();
            let (h, view) = cx
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
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.usage_options = Some(server.options.clone());
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Retained 日本語 draft", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("workspace-changes-pane").is_none());
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            let before = cx.update(|cx| transcript.read(cx).reading_mark(cx));
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-d", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("workspace-changes-loading").visible());
                let region = w.find("workspace-changes-region").bounds();
                assert!(region.size.width >= px(300.) && region.size.height >= px(290.));
            })
            .unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("workspace-changes-provenance").visible());
                w.click(("workspace-change-file", 0usize), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find(("workspace-change-diff", 0usize)).visible())
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "changes-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            assert_eq!(cx.update(|cx| input.read(cx).value().to_string()), draft);
            let after = cx.update(|cx| transcript.read(cx).reading_mark(cx));
            assert_eq!(
                after.as_ref().map(|m| &m.message),
                before.as_ref().map(|m| &m.message)
            );
            assert_eq!(
                after.as_ref().map(|m| m.following),
                before.as_ref().map(|m| m.following)
            );
            // A received streaming/history publication does not fetch or replace Changes.
            let serial = cx.update(|cx| {
                view.read(cx)
                    .workspace_changes
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .state
                    .serial
            });
            let requests = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut next = v.state.clone();
                    next.rows = transcript.read(cx).link_snapshot_rows();
                    next.rows.push(Message::live(
                        500,
                        "Assistant".into(),
                        "Synthetic streaming continuation".into(),
                    ));
                    v.accept(next, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| view
                    .read(cx)
                    .workspace_changes
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .state
                    .serial),
                serial
            );
            assert_eq!(server.state.lock().unwrap().seen.len(), requests);
            // Explicit Refresh keeps the last good snapshot on refusal.
            server.reply(path, Reply::json(409, json!({})));
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-refresh", cx))
                .unwrap();
            wait(cx, h, &view);
            cx.update(|cx| {
                let p = view.read(cx).workspace_changes.as_ref().unwrap().read(cx);
                assert!(p.state.error.is_some());
                assert!(p.state.snapshot.is_some());
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.find("workspace-changes-error").visible())
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "error-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            let mut partial = report();
            partial["truncated"] = json!(true);
            server.reply(path, Reply::json(200, partial));
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-refresh", cx))
                .unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("workspace-changes-limited").visible())
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "partial-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            // Adjacent inspector replaces, rather than stacking or deleting, Changes.
            cx.update_window(h, |_, w, cx| w.click("conversation-links-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("workspace-changes-pane").is_none());
                assert!(w.find("conversation-links-pane").visible());
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-toggle", cx))
                .unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("conversation-links-pane").is_none());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("workspace-changes-pane").is_none())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| assert!(input.focus_handle(cx).is_focused(w)))
                .unwrap();
            // Keyboard reaches the details disclosure and the actual file owner.
            server.reply(path, Reply::json(200, report()));
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-toggle", cx))
                .unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| {
                for _ in 0..4 {
                    w.press("tab", cx);
                }
                assert_eq!(
                    w.find(("workspace-change-file", 0usize)).focused(),
                    Some(true)
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find(("workspace-change-diff", 0usize)).visible())
            })
            .unwrap();
            let count = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(
                server.state.lock().unwrap().seen.len(),
                count,
                "No hidden refresh on render or idle"
            );
            // Empty and unavailable are distinct, then a slow refresh is canceled on navigation.
            server.reply(
                path,
                Reply::json(
                    200,
                    json!({"base":"HEAD","files":[],"diff":"","truncated":false}),
                ),
            );
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-refresh", cx))
                .unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("workspace-changes-empty").visible())
            })
            .unwrap();
            let mut slow = Reply::json(200, report());
            slow.delay_ms = 400;
            server.reply(path, slow);
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-refresh", cx))
                .unwrap();
            settle(cx, h);
            let pane = cx.update(|cx| view.read(cx).workspace_changes.clone().unwrap());
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.show_home(w, cx)))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(view.read(cx).workspace_changes.is_none());
                assert!(!pane.read(cx).state.busy);
                assert_eq!(input.read(cx).value().to_string(), draft);
            });
            assert!(writes.try_recv().is_err());
            assert!(server.all_gets());
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "workspace_changes: mounted light/dark narrow/wide, actual faux read, loading, error retention, truncation, navigation, Links, IME and draft guards passed"
    );
}
