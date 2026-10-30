//! Mounted production composer/sidebar with actual synthetic child summaries.
//! Hidden native rendering only, no real daemon or subagent commands.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::{Value, json};

const NAME: &str = "Review/日本 %?#";
const DRAFT: &str = "Unsent 私 👩‍💻 draft";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    // Mount/retarget Kit's dialog Presence first, then finish its actual theme
    // transition. A closing surface still shields clicks until it leaves.
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
        .unwrap();
    let duration = cx.update(|cx| cx.theme().motion_tokens().duration_normal);
    cx.advance_clock(duration);
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, done: impl Fn(&mut Window) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        settle(cx, h);
        if cx.update_window(h, |_, w, _| done(w)).unwrap() {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "bounded synthetic snapshot"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn children() -> Value {
    json!([
        {"name":NAME,"state":"working","createdAt":1,"task":"Inspect actual source paths 私 👩‍💻. Keep exact identity.","model":"synthetic/model"},
        {"name":"Finished","state":"idle","createdAt":2,"lastAnswerId":"answer-A","task":"Completed child"},
        {"name":"Idle","state":"idle","createdAt":3,"task":"Not yet answered"},
        {"name":"Failed","state":"idle","createdAt":4,"error":"Synthetic child failure","task":"Failed child"}
    ])
}
fn publish(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    children: Value,
    fresh: bool,
) {
    cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| {
        let mut state = v.state.clone();
        state.status = if fresh { "Connected · Local" } else { "Local disconnected" }.into();
        state.list_loaded = true;
        let chats = Arc::make_mut(&mut state.chats);
        chats[0] = crate::local_model::chat(&json!({"id":"source","title":"Source 私 👩‍💻","cwd":"/synthetic/project","state":"idle","subagents":children})).unwrap();
        v.accept(state, w, cx);
    })).unwrap();
    settle(cx, h);
}

pub fn run_session_subagents_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SUBAGENTS_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let tag = format!("{width}-{}", if dark { "dark" } else { "light" });
            cx.update(|cx| {
                appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let server = crate::session_subagents_fixture::Server::start();
            let (writer, writes) = Interaction::recording();
            let (client, commands) = LocalClient::synthetic_commands();
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);
            v.client=Some(client);v.usage_options=Some(server.options.clone());v.title="Source 私 👩‍💻".into();
            v.state.chats=Arc::new(vec![
                crate::local_model::chat(&json!({"id":"source","title":"Source","cwd":"/synthetic/project","state":"idle"})).unwrap(),
                crate::local_model::chat(&json!({"id":"coordinator","title":"Coordinator","cwd":"/synthetic/project","state":"idle","missionId":"mission-A","missionCoordinator":true,"subagents":[{"name":"Coordinator child","state":"idle","createdAt":1}]})).unwrap(),
                crate::local_model::chat(&json!({"id":"member","title":"Member","cwd":"/synthetic/project","state":"working","missionId":"mission-A","subagents":[{"name":NAME,"state":"working","createdAt":1}]})).unwrap(),
            ]);
            v.state.mission_titles=Some(Arc::new([("mission-A".into(),"Mission".into())].into_iter().collect()));
            v.state.status="Connected · Local".into();v.state.list_loaded=true;v.selected=Some("source".into());
            v.editor.update(cx,|e,cx|{e.shell_probe_setup(writer,w,cx);e.select("chat:source".into(),true,false,w,cx);});v
        }))).unwrap();
            publish(cx, h, &view, json!([]), true);
            let editor = cx.update(|cx| view.read(cx).editor.clone());
            let input = cx.update(|cx| editor.read(cx).shell_probe().0);
            let editor_id = editor.entity_id();
            let input_id = input.entity_id();
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            cx.update_window(h, |_, _, cx| {
                view.update(cx, |v, cx| {
                    v.state.loaded = true;
                    v.state.rows = (1..=30)
                        .map(|id| {
                            Message::live(
                                id,
                                "assistant".into(),
                                format!("Reader {id}\n\n{}", "Retained conversation. ".repeat(30)),
                            )
                            .anchored(crate::model::ReaderKey::model(
                                id,
                                0,
                                Some(0),
                            ))
                        })
                        .collect();
                    v.transcript.update(cx, |t, cx| {
                        t.replace_readonly(v.state.rows.clone(), true, cx)
                    });
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-subagents-strip").is_none());
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input(DRAFT, cx);
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100000.))),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            let anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            assert!(!anchor.2, "fixture reads parent history");
            publish(cx, h, &view, children(), true);
            cx.update_window(h, |_, w, cx| {
                for parent in ["source", "coordinator", "member"] {
                    assert!(w.try_find(format!("sidebar-subagents:{parent}")).is_none());
                    assert!(
                        w.try_find(format!("sidebar-subagent:{parent}:{NAME}"))
                            .is_none()
                    );
                }
                assert!(
                    w.find("chat-row-member").visible(),
                    "mission member remains visible"
                );
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
                let now = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(now.0, anchor.0);
                assert!((now.1 - anchor.1).abs() < 1.);
                assert!(input.focus_handle(cx).is_focused(w));
                let tree = &view.read(cx).chats.read(cx).delegate().tree;
                assert_eq!(tree.threads.len(), 1);
                assert_eq!(tree.threads[0].members.len(), 1);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("session-subagents-toggle", cx))
                .unwrap();
            settle(cx, h);
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("subagents-{tag}.png")))
                    .unwrap();
            }
            // Both paths use the same preedit fence and preserve parent text.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click(format!("composer-subagent:source:{NAME}"), cx)
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("subagent-conversation").is_none());
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
                let end = input.read(cx).value().encode_utf16().count();
                input.update(cx, |i, cx| {
                    i.replace_text_in_range(Some(0..end), DRAFT, w, cx)
                });
                w.click(format!("composer-subagent:source:{NAME}"), cx);
            })
            .unwrap();
            until(cx, h, |w| {
                w.try_find("subagent-refresh")
                    .is_some_and(|e| e.disabled() != Some(true))
            });
            let key = cx.update(|cx| editor.read(cx).navigation_key().unwrap().to_owned());
            let target = crate::session_subagents::Target::from_key(&key).unwrap();
            assert_eq!(target.parent, "source");
            assert_eq!(target.name, NAME);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("subagent-conversation").visible());
                assert_eq!(view.read(cx).editor.entity_id(), editor_id);
                assert_eq!(editor.read(cx).shell_probe().0.entity_id(), input_id);
                assert!(
                    input.read(cx).value().is_empty(),
                    "child draft is not parent's draft"
                );
                assert!(
                    w.try_find("local-stop").is_none(),
                    "never route parent Stop to a child"
                );
                assert!(
                    w.try_find("session-subagents-strip").is_none(),
                    "no duplicated parent strips"
                );
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input("Message to child 私", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            let command = writes.try_recv().unwrap();
            let WriteCommand::Submit {
                key: sent_key,
                draft,
                follow_up,
                stop,
                request,
            } = command
            else {
                panic!("one explicit child Submit");
            };
            assert_eq!(sent_key, key);
            assert_eq!(draft.text, "Message to child 私");
            assert!(!follow_up && !stop);
            // A synthetic accepted ACK, through the ordinary composer projection.
            let mut saved = *draft;
            saved.text.clear();
            saved.settled_revision = Some(saved.revision);
            saved.last = Some(crate::delivery_store::Delivery {
                id: "accepted-child-message".into(),
                state: "accepted".into(),
                target: "source".into(),
                kind: "subagent-send".into(),
                revision: saved.revision,
                diagnostic: None,
                answer: None,
            });
            let mut book = crate::delivery_store::Book::shell_probe();
            book.drafts.insert(key.clone(), saved);
            let mut state = crate::interaction::WriteState {
                book: Some(Arc::new(book)),
                ..Default::default()
            };
            state.handled.insert(key.clone(), request);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.accept(state, w, cx))
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(input.read(cx).value().is_empty());
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input("Child unsent draft", cx);
            })
            .unwrap();
            settle(cx, h);
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("subagent-conversation-{tag}.png")))
                    .unwrap();
            }
            // An in-flight old child read must not change the parent's editor.
            let held = server.response.lock().unwrap();
            let before = server.requests.lock().unwrap().len();
            cx.update_window(h, |_, w, cx| w.click("subagent-refresh", cx))
                .unwrap();
            until(cx, h, |_| {
                server.requests.lock().unwrap().len() >= before + 2
            });
            cx.update_window(h, |_, w, cx| w.click("subagent-back", cx))
                .unwrap();
            settle(cx, h);
            drop(held);
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("subagent-conversation").is_none());
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
                assert_ne!(w.find("local-send").disabled(), Some(true));
                assert!(input.focus_handle(cx).is_focused(w));
                let now = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(now.0, anchor.0);
                assert!((now.1 - anchor.1).abs() < 1.);
                w.click(format!("composer-subagent:source:{NAME}"), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(input.read(cx).value().as_ref(), "Child unsent draft");
                w.click("subagent-back", cx);
            })
            .unwrap();
            settle(cx, h);
            // Same name under a mission member is a different conversation/draft.
            cx.update_window(h, |_, w, cx| w.click("chat-row-member", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(),Ok(Command::Open{id,..}) if id=="member"));
            cx.update_window(h, |_, w, cx| w.click("session-subagents-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click(format!("composer-subagent:member:{NAME}"), cx)
            })
            .unwrap();
            until(cx, h, |w| {
                w.try_find("subagent-refresh")
                    .is_some_and(|e| e.disabled() != Some(true))
            });
            cx.update_window(h, |_, w, cx| {
                assert!(input.read(cx).value().is_empty());
                assert_ne!(editor.read(cx).navigation_key(), Some(key.as_str()));
                w.click("subagent-back", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("chat-row-source", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(),Ok(Command::Open{id,..}) if id=="source"));
            cx.update_window(h, |_, w, cx| {
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
                w.click(format!("composer-subagent:source:{NAME}"), cx);
            })
            .unwrap();
            settle(cx, h);
            publish(cx, h, &view, children(), false);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert_eq!(w.find("subagent-refresh").disabled(), Some(true));
            })
            .unwrap();
            publish(cx, h, &view, children(), true);
            let mut replaced = children();
            replaced[0]["createdAt"] = json!(99);
            publish(cx, h, &view, replaced, true);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("local-send").disabled(), Some(true))
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("subagent-back", cx))
                .unwrap();
            settle(cx, h);
            // Mission fold/roll-up excludes subagents entirely.
            cx.update_window(h, |_, w, cx| w.click("mission-disclosure-mission-A", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find(format!("sidebar-subagent:member:{NAME}"))
                        .is_none()
                );
                assert_eq!(
                    view.read(cx).chats.read(cx).delegate().tree.threads[0]
                        .rollup
                        .working,
                    1
                );
                w.click("mission-disclosure-mission-A", cx);
            })
            .unwrap();
            settle(cx, h);
            while let Ok(command) = writes.try_recv() {
                assert!(
                    !matches!(command, WriteCommand::Submit { .. }),
                    "navigation never sends"
                );
            }
            assert!(
                server.messages.lock().unwrap().is_empty(),
                "native source uses recording writer only"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "session subagents {tag}: absent sidebar children, preserved mission member, exact main conversation/shared composer, separate drafts, explicit Send, state/identity, mission folds and IME/keyboard passed"
            );
        }
    }
}
