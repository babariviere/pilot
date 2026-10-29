//! Offscreen production LocalViewer/ChatEditor; only synthetic loopback reads.
use super::*;
use crate::mission_browser_fixture::{Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, size, test::TestWindowExt,
};
use serde_json::json;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
    }
}
fn wait(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    let end = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        settle(cx, h);
        let ready = cx
            .update_window(h, |_, _, cx| {
                view.read(cx).editor.read(cx).path_probe().1 > 0
            })
            .unwrap();
        if ready {
            return;
        }
        assert!(std::time::Instant::now() < end, "completion did not arrive");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn wait_error(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    let end = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        settle(cx, h);
        if cx
            .update_window(h, |_, _, cx| {
                view.read(cx).editor.read(cx).path_probe_error().is_some()
            })
            .unwrap()
        {
            return;
        }
        assert!(std::time::Instant::now() < end, "refusal did not arrive");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn route(prefix: &str) -> String {
    let mut u =
        reqwest::Url::parse("http://127.0.0.1/api/sessions/source/path-candidates").unwrap();
    u.query_pairs_mut()
        .append_pair("cwd", "/synthetic/project")
        .append_pair("prefix", prefix)
        .append_pair("daemonId", "test-daemon")
        .append_pair("lineageId", "test-lineage");
    format!("{}?{}", u.path(), u.query().unwrap())
}
fn report(prefix: &str) -> serde_json::Value {
    json!({"sessionId":"source","cwd":"/synthetic/project","prefix":prefix,"daemonId":"test-daemon","lineageId":"test-lineage","entries":[{"path":"README 🦀.md","directory":false},{"path":"Reports","directory":true}],"truncated":false})
}
pub fn run_path_completion_probe(cx: &mut HeadlessAppContext) {
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
            server.reply("/api/hello",Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"sessionPathCandidates":1}})));
            server.reply(&route("R"), Reply::json(200, report("R")));
            server.reply(&route("RE"),Reply::json(200,json!({"sessionId":"source","cwd":"/synthetic/project","prefix":"RE","daemonId":"test-daemon","lineageId":"test-lineage","entries":[{"path":"README 🦀.md","directory":false}],"truncated":false})));
            let (writer, writes) = Interaction::recording();
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);
            v.usage_options=Some(server.options.clone());v.generation=7;v.state.generation=7;v.state.loaded=true;v.state.page_busy=false;v.refreshing=false;v.selected=Some("source".into());
            v.state.chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"source","cwd":"/synthetic/project","title":"Path completion","state":"idle","mode":"build"})).unwrap()]);
            v.editor.update(cx,|e,cx|{e.shell_probe_setup(writer,w,cx);e.select("chat:source".into(),true,false,w,cx);e.focus(w,cx);});v
        }))).unwrap();
            settle(cx, h);
            let input = cx
                .update_window(h, |_, _, cx| view.read(cx).editor.read(cx).shell_probe().0)
                .unwrap();
            let replace = |cx: &mut HeadlessAppContext, text: &str| {
                cx.update_window(h, |_, w, cx| {
                    input.update(cx, |i, cx| {
                        let all = 0..i.value().encode_utf16().count();
                        i.replace_text_in_range(Some(all), text, w, cx);
                    });
                })
                .unwrap();
                settle(cx, h);
            };
            replace(cx, "Read 🦀 R after");
            // Native byte caret before the unchanged suffix.
            cx.update_window(h, |_, _, cx| {
                input.update(cx, |i, cx| i.set_selected_range(11..11, cx))
            })
            .unwrap();
            settle(cx, h);
            assert!(
                server.state.lock().unwrap().seen.is_empty(),
                "no idle/background completion fetch"
            );
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait(cx, h, &view);
            let captured = cx
                .update_window(h, |_, w, cx| {
                    let popup = w.find("path-suggestions").bounds();
                    let composer = w.find("composer-input").bounds();
                    assert!(popup.origin.x >= px(0.) && popup.right() <= px(width));
                    assert!(popup.bottom() <= composer.origin.y);
                    assert!(popup.size.height > px(40.));
                    assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
                    assert_eq!(composer.size.height, px(34.));
                    assert!(input.read(cx).focus_handle(cx).is_focused(w));
                    view.read(cx).editor.read(cx).path_probe().0.unwrap()
                })
                .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_PATHS_DIR") {
                let p = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&p).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("paths-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("up", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    input.read(cx).value().as_ref(),
                    "Read 🦀 README\\ 🦀.md after"
                );
                assert!(w.try_find("path-suggestions").is_none());
                w.press("secondary-z", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(input.read(cx).value().as_ref(), "Read 🦀 R after")
            })
            .unwrap();
            // Stale callback after edit-away/back must not insert even if text/selection match.
            replace(cx, "Read 🦀 R after!");
            replace(cx, "Read 🦀 R after");
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| i.set_selected_range(11..11, cx));
                view.read(cx)
                    .editor
                    .clone()
                    .update(cx, |e, cx| e.path_probe_accept(captured, w, cx));
                assert_eq!(input.read(cx).value().as_ref(), "Read 🦀 R after");
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| w.click("path-candidate-Reports", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(input.read(cx).value().as_ref(), "Read 🦀 Reports/ after");
                assert!(input.read(cx).focus_handle(cx).is_focused(w));
            })
            .unwrap();
            // Typing refines a live chooser without a new activation; acceptance Tab is never send.
            replace(cx, "R");
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| i.replace_text_in_range(None, "E", w, cx))
            })
            .unwrap();
            settle(cx, h);
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(input.read(cx).value().as_ref(), "README\\ 🦀.md")
            })
            .unwrap();
            replace(cx, "R");
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(input.read(cx).value().as_ref(), "R");
                assert!(w.try_find("path-suggestions").is_none());
            })
            .unwrap();
            // Preedit prevents popup acceptance and sibling pointer blur. Input Escape is captured.
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                });
                w.click("path-candidate-Reports", cx);
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(input.read(cx).focus_handle(cx).is_focused(w));
                assert!(input.read(cx).value().contains('に'));
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                input.update(cx, |i, cx| i.unmark_text(w, cx));
            })
            .unwrap();
            settle(cx, h);
            // Actual Tab accepts the highlighted directory, not just the first file.
            replace(cx, "R");
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait(cx, h, &view);
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(input.read(cx).value().as_ref(), "Reports/")
            })
            .unwrap();

            for (status, reason) in [
                (
                    409,
                    "Path completion requires the matching active Build workspace",
                ),
                (
                    400,
                    "EACCES: permission denied, opendir '/synthetic/project/private'",
                ),
                (404, "Not found"),
            ] {
                replace(cx, "R");
                server.reply(&route("R"), Reply::json(status, json!({"error":reason})));
                let before = server.state.lock().unwrap().seen.len();
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                wait_error(cx, h, &view);
                cx.update_window(h, |_, w, cx| {
                    let error = view.read(cx).editor.read(cx).path_probe_error().unwrap();
                    assert!(error.contains(&format!("HTTP {status}")), "{error}");
                    assert!(
                        error.contains(if status == 404 {
                            "Settings → Updates"
                        } else {
                            reason
                        }),
                        "{error}"
                    );
                    assert_eq!(view.read(cx).editor.read(cx).path_probe().1, 0);
                    let shown = w.find("path-status").bounds();
                    let popup = w.find("path-suggestions").bounds();
                    assert!(shown.size.height > px(0.));
                    assert!(shown.origin.x >= popup.origin.x && shown.right() <= popup.right());
                    assert!(shown.origin.y >= px(0.));
                    assert!(popup.bottom() <= w.find("composer-input").bounds().origin.y);
                    assert_eq!(input.read(cx).value().as_ref(), "R");
                })
                .unwrap();
                if status == 409
                    && let Some(dir) = std::env::var_os("PILOT_NEXT_PATHS_DIR")
                {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(
                            std::path::PathBuf::from(dir)
                                .join(format!("paths-refused-{width}-{dark}.png")),
                        )
                        .unwrap();
                }
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(
                        input.read(cx).value().as_ref(),
                        "R",
                        "refused Tab never inserts or sends"
                    );
                    assert!(input.read(cx).focus_handle(cx).is_focused(w));
                    w.press("escape", cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, _| {
                    assert!(w.try_find("path-suggestions").is_none())
                })
                .unwrap();
                assert_eq!(
                    server.state.lock().unwrap().seen.len(),
                    before + 2,
                    "no refusal retry or fallback"
                );
            }
            server.reply("/api/hello", Reply::json(200, json!({"daemonId":"test-daemon","lineageId":"test-lineage","daemonVersion":"1.20.0","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})));
            let before = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            wait_error(cx, h, &view);
            cx.update_window(h, |_, w, cx| {
                let error = view.read(cx).editor.read(cx).path_probe_error().unwrap();
                assert!(
                    error.contains("1.20.0") && error.contains("Settings → Updates"),
                    "{error}"
                );
                assert_eq!(input.read(cx).value().as_ref(), "R");
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                server.state.lock().unwrap().seen.len(),
                before + 1,
                "missing capability never queries candidates"
            );
            server.reply("/api/hello",Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"sessionPathCandidates":1}})));

            // Source generation change cancels an in-flight response, no insertion or background restart.
            let large = format!("{} R", "x".repeat(crate::delivery_store::TEXT_CAP));
            replace(cx, "");
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(large.clone()));
                w.press("secondary-v", cx);
            })
            .unwrap();
            settle(cx, h);
            let reads_before_large_tab = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(input.read(cx).value().as_ref(), large);
                assert!(w.try_find("path-suggestions").is_none());
            })
            .unwrap();
            assert_eq!(
                server.state.lock().unwrap().seen.len(),
                reads_before_large_tab
            );
            for change_cwd in [false, true] {
                cx.update_window(h, |_, _, cx| {
                    view.update(cx, |v, cx| {
                        v.generation = 7;
                        Arc::make_mut(&mut v.state.chats)[0].cwd = "/synthetic/project".into();
                        cx.notify();
                    });
                })
                .unwrap();
                settle(cx, h);
                replace(cx, "R");
                let mut delayed = if change_cwd {
                    Reply::json(409, json!({"error":"Path completion workspace changed"}))
                } else {
                    Reply::json(200, report("R"))
                };
                delayed.delay_ms = 350;
                server.reply(&route("R"), delayed);
                let before = server.state.lock().unwrap().seen.len();
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(4);
                while server.state.lock().unwrap().seen.len() < before + 2 {
                    settle(cx, h);
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                cx.update_window(h, |_, _, cx| {
                    view.update(cx, |v, cx| {
                        if change_cwd {
                            Arc::make_mut(&mut v.state.chats)[0].cwd = "/synthetic/other".into();
                        } else {
                            v.generation += 1;
                        }
                        cx.notify();
                    })
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(w.try_find("path-suggestions").is_none());
                    assert_eq!(input.read(cx).value().as_ref(), "R");
                })
                .unwrap();
                let late = std::time::Instant::now() + Duration::from_millis(450);
                while std::time::Instant::now() < late {
                    settle(cx, h);
                    std::thread::sleep(Duration::from_millis(5));
                }
                cx.update_window(h, |_, w, cx| {
                    assert!(w.try_find("path-suggestions").is_none());
                    assert_eq!(input.read(cx).value().as_ref(), "R");
                })
                .unwrap();
                assert_eq!(
                    server.state.lock().unwrap().seen.len(),
                    before + 2,
                    "late source must not restart or finish the bracket"
                );
            }
            assert!(server.all_gets());
            assert!(
                writes.try_recv().is_err(),
                "completion must never send/create/queue/stop"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "path completion: four mounted theme/width Tab success/refusal/compatibility/IME/undo/stale-cwd/no-send flows passed"
    );
}
