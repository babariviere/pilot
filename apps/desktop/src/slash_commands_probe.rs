//! Offscreen production LocalViewer/ChatEditor slash menu; only synthetic loopback reads.
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
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    what: &str,
    ready: impl Fn(&mut Window, &mut gpui_kit::App) -> bool,
) {
    let end = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        settle(cx, h);
        if cx.update_window(h, |_, w, cx| ready(w, cx)).unwrap() {
            return;
        }
        assert!(std::time::Instant::now() < end, "{what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn run_slash_commands_probe(cx: &mut HeadlessAppContext) {
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
            server.reply("/api/hello",Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})));
            server.reply("/api/sessions/source/commands",Reply::json(200,json!({"commands":[
                {"name":"review","source":"prompt","description":"Review the current diff and list risks before merging","argumentHint":"<pull request>"},
                {"name":"help","source":"prompt","description":"Project help prompt"},
                {"name":"jobs","source":"prompt","description":"Cannot shadow a built-in"},
                {"name":"skill:commit","source":"skill","description":"Create a conventional commit"}
            ]})));
            let (writer, writes) = Interaction::recording();
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
                let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);
                v.usage_options=Some(server.options.clone());v.generation=7;v.state.generation=7;v.state.loaded=true;v.state.page_busy=false;v.refreshing=false;v.selected=Some("source".into());
                v.state.chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"source","cwd":"/synthetic/project","title":"Slash commands","state":"idle","mode":"build","runningJobs":[{"id":"job-1","name":"pnpm test","startedAt":1}]})).unwrap()]);
                v.editor.update(cx,|e,cx|{e.shell_probe_setup(writer,w,cx);e.select("chat:source".into(),true,false,w,cx);e.focus(w,cx);});v
            }))).unwrap();
            settle(cx, h);
            let input = cx
                .update_window(h, |_, _, cx| view.read(cx).editor.read(cx).shell_probe().0)
                .unwrap();
            let names = |cx: &mut HeadlessAppContext| {
                cx.update_window(h, |_, _, cx| {
                    view.read(cx).editor.read(cx).slash_probe().map(|(n, _)| n)
                })
                .unwrap()
            };
            let set = |cx: &mut HeadlessAppContext, text: &str| {
                cx.update_window(h, |_, w, cx| {
                    input.update(cx, |i, cx| {
                        let all = 0..i.value().encode_utf16().count();
                        i.replace_text_in_range(Some(all), text, w, cx);
                    });
                })
                .unwrap();
                settle(cx, h);
            };
            let value = |cx: &mut HeadlessAppContext| {
                cx.update_window(h, |_, _, cx| input.read(cx).value().to_string())
                    .unwrap()
            };
            let press = |cx: &mut HeadlessAppContext, key: &str| {
                cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
                settle(cx, h);
            };
            assert!(
                server.state.lock().unwrap().seen.is_empty(),
                "nothing is read before a command is typed"
            );
            // A leading slash shows native commands at once, then this chat's list.
            set(cx, "/");
            until(cx, h, "chat commands did not arrive", |_, cx| {
                view.read(cx).editor.read(cx).slash_probe_loaded()
            });
            assert_eq!(
                names(cx).unwrap(),
                [
                    "jobs",
                    "compact",
                    "artifacts",
                    "review",
                    "help",
                    "skill:commit"
                ],
                "built-ins reserved; the chat's /help wins the app name"
            );
            cx.update_window(h, |_, w, cx| {
                let popup = w.find("slash-commands").bounds();
                let composer = w.find("composer-input").bounds();
                assert!(popup.origin.x >= px(0.) && popup.right() <= px(width));
                assert!(popup.bottom() <= composer.origin.y);
                assert!(popup.size.height > px(80.));
                assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
                assert_eq!(composer.size.height, px(34.));
                assert!(input.read(cx).focus_handle(cx).is_focused(w));
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_SLASH_DIR") {
                let p = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&p).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("slash-{width}-{dark}.png")))
                    .unwrap();
            }
            // Keyboard: Enter completes a prompt with arguments; nothing is sent.
            set(cx, "/re");
            assert_eq!(names(cx).unwrap(), ["review"]);
            press(cx, "enter");
            assert_eq!(value(cx), "/review ");
            assert!(names(cx).is_none());
            // Escape dismisses and keeps the draft.
            set(cx, "/");
            assert!(names(cx).is_some());
            press(cx, "escape");
            cx.update_window(h, |_, w, _| assert!(w.try_find("slash-commands").is_none()))
                .unwrap();
            assert_eq!(value(cx), "/");
            // Pointer: a native command opens its control and keeps the rest of the draft.
            set(cx, "/jo keep 👩‍💻 e\u{301}");
            cx.update_window(h, |_, _, cx| {
                input.update(cx, |i, cx| i.set_selected_range(3..3, cx))
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(names(cx).unwrap(), ["jobs"]);
            cx.update_window(h, |_, w, cx| w.click("slash-command-jobs", cx))
                .unwrap();
            until(cx, h, "jobs did not open from the pointer", |w, _| {
                w.try_find("session-jobs-list").is_some()
            });
            assert_eq!(value(cx), "keep 👩‍💻 e\u{301}");
            cx.update_window(h, |_, w, cx| w.click("session-jobs-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-jobs-list").is_none());
                view.update(cx, |v, cx| v.editor.update(cx, |e, cx| e.focus(w, cx)));
            })
            .unwrap();
            settle(cx, h);
            // A whole-draft built-in typed and sent opens its strip; it is not a message.
            set(cx, "/jobs");
            press(cx, "escape");
            press(cx, "enter");
            until(cx, h, "jobs did not open", |w, _| {
                w.try_find("session-jobs-list").is_some()
            });
            assert_eq!(value(cx), "");
            // An unavailable control explains itself and keeps the text.
            set(cx, "/artifacts");
            press(cx, "enter");
            until(cx, h, "no artifacts note", |w, _| {
                w.try_find("slash-command-note").is_some()
            });
            assert_eq!(value(cx), "/artifacts");
            // Marked composition never shows the menu.
            set(cx, "");
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "/", Some(1..1), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| assert!(w.try_find("slash-commands").is_none()))
                .unwrap();
            // The platform commits composition by replacing the marked text.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| i.replace_text_in_range(None, "/", w, cx))
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(value(cx), "/");
            assert!(names(cx).is_some(), "committed slash opens the menu");
            assert!(server.all_gets());
            // Manual compaction uses the existing action owner, not message delivery.
            let raw = json!({"id":"source","title":"Slash commands","cwd":"/synthetic/project","state":"idle","mode":"build"});
            server.reply("/api/sessions/source", Reply::json(200, raw.clone()));
            let mut ack = Reply::json(202, json!({"ok":true}));
            ack.delay_ms = 160;
            server.reply("/api/sessions/source/compact", ack);
            cx.update_window(h, |_, _, cx| {
                view.update(cx, |v, cx| {
                    v.chat_actions
                        .update(cx, |a, cx| a.connect(server.options.clone(), cx));
                    v.state.status = "Synthetic Local fixture".into();
                    v.state.list_loaded = true;
                    v.state.chats = Arc::new(vec![crate::local_model::chat(&raw).unwrap()]);
                })
            })
            .unwrap();
            // A pending message delivery blocks the native action, not just Send.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.editor.update(cx, |e, _| e.model_probe_pending(true));
                    assert!(
                        v.run_slash_action(
                            crate::slash_commands::Action::Compact,
                            "chat:source",
                            w,
                            cx
                        )
                        .is_err()
                    );
                    v.editor.update(cx, |e, _| e.model_probe_pending(false));
                })
            })
            .unwrap();
            assert!(server.writes().is_empty());
            // A late eligibility read from an earlier connection must not POST.
            let mut delayed = Reply::json(200, raw.clone());
            delayed.delay_ms = 100;
            server.reply("/api/sessions/source", delayed);
            set(cx, "/compact");
            press(cx, "enter");
            cx.update_window(h, |_, _, cx| view.update(cx, |v, _| v.generation += 1))
                .unwrap();
            until(cx, h, "stale compact read did not settle", |_, cx| {
                view.read(cx).chat_actions.read(cx).compact_check.is_none()
            });
            assert!(server.writes().is_empty());
            server.reply("/api/sessions/source", Reply::json(200, raw.clone()));
            cx.update_window(h, |_, _, cx| {
                view.update(cx, |v, _| v.state.generation = v.generation)
            })
            .unwrap();
            set(cx, "/co keep 👩‍💻 e\u{301}");
            cx.update_window(h, |_, _, cx| {
                input.update(cx, |i, cx| i.set_selected_range(3..3, cx))
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("slash-command-compact", cx))
                .unwrap();
            until(cx, h, "compact POST not dispatched", |_, _| {
                !server.state.lock().unwrap().writes.is_empty()
            });
            assert_eq!(value(cx), "keep 👩‍💻 e\u{301}");
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    assert!(
                        v.run_slash_action(
                            crate::slash_commands::Action::Compact,
                            "chat:source",
                            w,
                            cx
                        )
                        .is_err()
                    );
                })
            })
            .unwrap();
            until(cx, h, "compact ACK not retained", |_, cx| {
                view.read(cx).chat_actions.read(cx).outcome("source")
                    == Some(&crate::chat_actions::Outcome::Acknowledged)
            });
            let posts = server.state.lock().unwrap().writes.clone();
            assert_eq!(posts.len(), 1);
            assert_eq!(posts[0].1, "/api/sessions/source/compact");
            assert_eq!(posts[0].3, json!({}));
            cx.update_window(h, |_, w, cx| {
                assert!(input.read(cx).focus_handle(cx).is_focused(w))
            })
            .unwrap();
            // A malformed ACK remains Unknown even after a successful GET inspection.
            server.reply(
                "/api/sessions/source/compact",
                Reply::json(202, json!({"ok":false})),
            );
            set(cx, "/compact");
            press(cx, "enter");
            until(cx, h, "compact Unknown not retained", |_, cx| {
                view.read(cx).chat_actions.read(cx).outcome("source")
                    == Some(&crate::chat_actions::Outcome::Unknown)
            });
            set(cx, "/compact");
            press(cx, "enter");
            assert_eq!(value(cx), "/compact");
            assert_eq!(
                server.state.lock().unwrap().writes.len(),
                2,
                "Unknown never replays"
            );
            assert!(
                writes.try_recv().is_err(),
                "slash commands never send, queue, create or stop"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "slash commands: four mounted theme/width picker, keyboard/pointer, dismissal, native-control, IME and no-send flows passed"
    );
}
