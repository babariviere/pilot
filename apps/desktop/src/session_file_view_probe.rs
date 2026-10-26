//! Real mounted Changes composition, private faux HTTP, offscreen native renderer.
use super::*;
use crate::mission_browser_fixture::{Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::json;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn pane(cx: &mut HeadlessAppContext, v: &Entity<LocalViewer>) -> Entity<Pane> {
    cx.update(|cx| v.read(cx).workspace_changes.clone().unwrap())
}
fn wait(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<LocalViewer>, file: bool) {
    let end = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        settle(cx, h);
        if cx.update(|cx| {
            v.read(cx).workspace_changes.as_ref().is_some_and(|p| {
                let p = p.read(cx);
                if file {
                    p.file.as_ref().is_some_and(|f| !f.read(cx).state.busy)
                } else {
                    !p.state.busy
                }
            })
        }) {
            return;
        }
        assert!(std::time::Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn response(text: &str, truncated: bool) -> serde_json::Value {
    json!({"path":"src/日本語.rs","text":text,"binary":false,"truncated":truncated})
}
pub fn run_session_file_view_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SESSION_FILE_DIR").map(std::path::PathBuf::from);
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
            let s = Server::start();
            s.reply("/api/sessions/synthetic/changes",Reply::json(200,json!({"base":"HEAD","files":[{"path":"src/日本語.rs","status":"modified","additions":1,"deletions":1},{"path":"gone.rs","status":"deleted","additions":0,"deletions":1}],"diff":"","truncated":false})));
            s.reply(
                "/api/sessions/synthetic",
                Reply::json(200, json!({"id":"synthetic","cwd":"/synthetic/workspace"})),
            );
            let file_path =
                "/api/sessions/synthetic/files?path=src%2F%E6%97%A5%E6%9C%AC%E8%AA%9E.rs";
            let exact = "First 日本語 👩‍💻 e\u{301}\r\n\tsecond line\nfinal";
            let mut slow = Reply::json(200, response(exact, false));
            slow.delay_ms = 250;
            s.reply(file_path, slow);
            let (writer, writes) = Interaction::recording();
            let (h, v) = cx
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
                                v.usage_options = Some(s.options.clone());
                                let chats = std::sync::Arc::make_mut(&mut v.state.chats);
                                chats.iter_mut().find(|c| c.id == "synthetic").unwrap().cwd =
                                    "/synthetic/workspace".into();
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let input = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Retained draft 日本語", w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("workspace-changes-toggle", cx))
                .unwrap();
            wait(cx, h, &v, false);
            cx.update_window(h, |_, w, cx| w.click(("workspace-change-file", 0usize), cx))
                .unwrap();
            settle(cx, h);
            let p = pane(cx, &v);
            let serial = cx.update(|cx| p.read(cx).state.serial);
            // Opening is guarded by composer preedit, including pointer down.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click(("workspace-open-file", 0usize), cx))
                .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| p.read(cx).file.is_none()));
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    let r = i.marked_text_range(w, cx).unwrap();
                    i.replace_text_in_range(Some(r), "", w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            let transcript = cx.update(|cx| v.read(cx).transcript.clone());
            let mark = cx.update(|cx| transcript.read(cx).reading_mark(cx));
            cx.update_window(h, |_, w, cx| {
                p.read(cx).focus.clone().focus(w, cx);
                for _ in 0..5 {
                    w.press("tab", cx);
                }
                assert_eq!(
                    w.find(("workspace-open-file", 0usize)).focused(),
                    Some(true)
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("session-file-loading").visible())
            })
            .unwrap();
            wait(cx, h, &v, true);
            cx.update_window(h, |_, w, cx| {
                w.press("tab", cx);
                assert_eq!(w.find("session-file-refresh").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            wait(cx, h, &v, true);
            cx.update_window(h, |_, w, cx| {
                let region = w.find("workspace-changes-region").bounds();
                let text = w.find("session-file-text").bounds();
                let refresh = w.find("session-file-refresh").bounds();
                let close = w.find("session-file-close").bounds();
                assert!(region.contains(&refresh.center()) && region.contains(&close.center()));
                assert!(refresh.right() <= close.left());
                assert!(text.size.width <= region.size.width);
                assert!(text.top() >= refresh.bottom());
                w.click("session-file-copy", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), exact);
            })
            .unwrap();
            settle(cx, h);
            // Native selection and Copy are separate from the explicit exact-copy action.
            cx.update_window(h, |_, w, cx| {
                let b = w.find("session-file-text").bounds();
                w.drag(
                    point(b.left() + px(2.), b.top() + px(8.)),
                    point(b.left() + px(105.), b.top() + px(8.)),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let selection = gpui_kit::base::TextSelection::selected_text(w, cx);
                assert!(!selection.is_empty());
                assert!(exact.contains(&selection));
                w.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), selection);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("file-{width}-{dark}.png")))
                    .unwrap();
            }
            let before = cx.update(|cx| p.read(cx).file.as_ref().unwrap().read(cx).state.serial);
            let requests = s.state.lock().unwrap().seen.len();
            // Streaming publication must not refresh, close or replace this snapshot.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut next = v.state.clone();
                    next.rows = transcript.read(cx).link_snapshot_rows();
                    next.rows.push(Message::live(
                        500,
                        "Assistant".into(),
                        "Synthetic stream".into(),
                    ));
                    v.accept(next, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| p.read(cx).file.as_ref().unwrap().read(cx).state.serial),
                before
            );
            assert_eq!(s.state.lock().unwrap().seen.len(), requests);
            s.reply(file_path, Reply::json(409, json!({})));
            cx.update_window(h, |_, w, cx| w.click("session-file-refresh", cx))
                .unwrap();
            wait(cx, h, &v, true);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("session-file-error").visible());
                w.click("session-file-copy", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), exact);
            })
            .unwrap();
            // Partial copy stays an exact prefix, never labelled/copying the whole file.
            let large = "Line 日本語 🦀\n".repeat(700);
            s.reply(file_path, Reply::json(200, response(&large, false)));
            cx.update_window(h, |_, w, cx| w.click("session-file-refresh", cx))
                .unwrap();
            wait(cx, h, &v, true);
            cx.update_window(h, |_, w, cx| {
                w.click("session-file-copy", cx);
                let shown = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(large.starts_with(&shown));
                assert!(shown.len() < large.len());
                assert_eq!(
                    w.find("session-file-copy").label(),
                    Some("Copy shown portion")
                );
            })
            .unwrap();
            // Binary and lossy text clear the text surface, not replacement gibberish.
            for binary in [true, false] {
                let mut r = response(if binary { "" } else { "bad \u{fffd}" }, false);
                r["binary"] = json!(binary);
                s.reply(file_path, Reply::json(200, r));
                cx.update_window(h, |_, w, cx| w.click("session-file-refresh", cx))
                    .unwrap();
                wait(cx, h, &v, true);
                cx.update_window(h, |_, w, _| {
                    assert!(w.try_find("session-file-text").is_none());
                    assert!(w.try_find("session-file-copy").is_none());
                })
                .unwrap();
            }
            // Escape closes only file detail and restores mounted composer focus.
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-file-pane").is_none());
                assert!(w.find("workspace-changes-pane").visible());
                assert!(input.focus_handle(cx).is_focused(w));
            })
            .unwrap();
            assert_eq!(cx.update(|cx| p.read(cx).state.serial), serial);
            assert_eq!(cx.update(|cx| input.read(cx).value().to_string()), draft);
            let after = cx.update(|cx| transcript.read(cx).reading_mark(cx));
            assert_eq!(
                mark.as_ref().map(|m| (&m.message, m.following)),
                after.as_ref().map(|m| (&m.message, m.following))
            );
            // In-flight source switch cancels and fences late content, even with a retained entity.
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "workspace-changes-region",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(-100000.))),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click(("workspace-change-file", 1usize), cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find(("workspace-open-file", 1usize)).disabled(),
                    Some(true)
                )
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "workspace-changes-region",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100000.))),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click(("workspace-change-file", 0usize), cx))
                .unwrap();
            settle(cx, h);
            let mut slow = Reply::json(200, response("late foreign source", false));
            slow.delay_ms = 400;
            s.reply(file_path, slow);
            cx.update_window(h, |_, w, cx| w.click(("workspace-open-file", 0usize), cx))
                .unwrap();
            settle(cx, h);
            let f = cx.update(|cx| p.read(cx).file.clone().unwrap());
            let other = Server::start();
            cx.update(|cx| {
                v.update(cx, |v, cx| {
                    v.usage_options = Some(other.options.clone());
                    cx.notify();
                })
            });
            settle(cx, h);
            cx.update(|cx| {
                assert!(!f.read(cx).state.busy);
                assert!(f.read(cx).state.content.is_none());
            });
            assert!(
                other.state.lock().unwrap().seen.is_empty(),
                "No source-switch fallback"
            );
            cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.show_home(w, cx)))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(!f.read(cx).state.busy);
                assert!(f.read(cx).state.content.is_none());
                assert!(v.read(cx).workspace_changes.is_none());
                assert_eq!(input.read(cx).value().to_string(), draft);
            });
            assert!(writes.try_recv().is_err());
            assert!(s.all_gets());
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "session_file_view: mounted narrow/wide light/dark, bounded exact Unicode copy/selection, IME, error retention, binary/truncation, streaming, close/focus and source cancellation passed"
    );
}
