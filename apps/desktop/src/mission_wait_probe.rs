//! Mounted ordinary drafts during captured conversion, owned held HTTP only.
use super::model_wait_probe::{Private, Root, disk, pump, until};
use super::*;
use crate::{
    delivery_store::Store,
    local_view::mission_probe::Server,
    mission_conversion::{Action, Inspection, Request, Target},
    mission_fixture::Behavior,
    subagent_wait_fixture as fixture,
};
use gpui_kit::{
    Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use std::time::{Duration, Instant};

pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for lost in [false, true] {
                let server = Server::held(
                    if lost {
                        Behavior::LostAfter
                    } else {
                        Behavior::Accept
                    },
                    false,
                    "/api/missions",
                );
                let private = Private(
                    std::env::temp_dir()
                        .join(format!("native-mission-wait-{}", uuid::Uuid::new_v4())),
                );
                let answer = fixture::captured();
                let mut captured = answer.clone();
                captured.answer = None;
                captured.text = "Original source 日本語 👩‍💻".into();
                let key = "chat:source".to_string();
                let next_key = "chat:other".to_string();
                captured.project_id = Some("project".into());
                captured.model_choice.as_mut().unwrap().project_id = "project".into();
                let target = Target {
                    source: "source".into(),
                    project: "project".into(),
                    generation: 12,
                };
                let request = Request {
                    project_id: target.project.clone(),
                    from_session_id: target.source.clone(),
                    title: "Captured 日本語 e\u{301}".into(),
                    goal: "Exact goal 🦀".into(),
                    coordinator: true,
                    draft: false,
                };
                let sealed = {
                    let mut store = Store::open(private.0.clone(), server.options.host()).unwrap();
                    store
                        .save_edits(BTreeMap::from([(key.clone(), captured.clone())]))
                        .unwrap();
                    let question=crate::question::Question::parse(7,&serde_json::json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true})).unwrap();
                    let intent = store
                        .prepare_answer(
                            "chat:sealed",
                            &answer,
                            &question,
                            answer.answer.as_ref().unwrap(),
                        )
                        .unwrap();
                    store.pending(&intent.id).unwrap();
                    store.book.pending[&intent.id].clone()
                };
                let (writer, updates) =
                    Interaction::start(server.options.clone(), Ok(private.0.clone()));
                let (h, editor) = cx.update(|cx| {
                    let mut editor = None;
                    let (h, _) = gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(520.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            w.set_rem_size(px(14.));
                            let e = cx.new(|cx| ChatEditor::new(Some(writer.clone()), w, cx));
                            editor = Some(e.clone());
                            cx.new(|_| Root(e))
                        },
                    )
                    .unwrap();
                    gpui_kit::component::Theme::change(mode, None, cx);
                    (h, editor.unwrap())
                });
                until(cx, h, &editor, &updates, |e| e.ready());
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(cx.theme().mode, mode);
                    editor.update(cx, |e, cx| {
                        e.select(key.clone(), true, false, w, cx);
                        e.focus(w, cx);
                    });
                })
                .unwrap();
                pump(cx, h, &editor, &updates);
                assert!(writer.command(WriteCommand::Mission {
                    target: target.clone(),
                    request: 17,
                    action: Action::Submit {
                        id: "captured-attempt".into(),
                        request: request.clone()
                    }
                }));
                let deadline = Instant::now() + Duration::from_secs(5);
                while server.entered.try_recv().is_err() {
                    assert!(Instant::now() < deadline);
                    pump(cx, h, &editor, &updates);
                    std::thread::yield_now();
                }
                let original = disk(&private).missions["source"].clone();
                assert_eq!(original.id, "captured-attempt");
                assert!(original.request == request);
                let text = "Newer unsent e\u{301} 日本語 🦀";
                let started = Instant::now();
                cx.update_window(h, |_, w, cx| {
                    w.click("composer-input", cx);
                    w.press("secondary-a", cx);
                    w.input(text, cx);
                })
                .unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state
                        .book
                        .as_ref()
                        .is_some_and(|b| b.drafts[&key].text == text)
                });
                let elapsed = started.elapsed();
                let before = disk(&private);
                assert_eq!(before.drafts[&key].text, text);
                assert!(before.missions["source"] == original);
                assert!(before.pending[&sealed.id] == sealed);
                assert!(before.drafts[&key].answer == captured.answer);
                assert_eq!(before.drafts[&key].model_choice, captured.model_choice);
                assert_eq!(before.drafts[&key].project_id, captured.project_id);
                assert_eq!(before.drafts[&key].cwd, captured.cwd);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    let e = editor.read(cx);
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text(&key, &e.cache[&key])
                    );
                    let bounds = w.find("composer-input").bounds();
                    assert!(bounds.size.width > px(100.));
                    assert!(bounds.right() <= w.bounds().size.width);
                    let handler = ElementInputHandler::new(
                        w.find_by_label("Message to Pilot").bounds(),
                        e.text.clone(),
                    );
                    TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                    editor.update(cx, |e, cx| {
                        e.accept(e.state.clone(), w, cx);
                        assert!(e.marked(w, cx));
                        e.text.update(cx, |t, cx| t.unmark_text(w, cx));
                        e.changed(cx);
                        e.select(next_key.clone(), true, false, w, cx);
                        e.focus(w, cx);
                    });
                    w.input("Other chat unsent 日本語", cx);
                })
                .unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state.book.as_ref().is_some_and(|b| {
                        b.drafts
                            .get(&next_key)
                            .is_some_and(|d| d.text == "Other chat unsent 日本語")
                    })
                });
                cx.update_window(h, |_, w, cx| {
                    let handler = ElementInputHandler::new(
                        w.find_by_label("Message to Pilot").bounds(),
                        editor.read(cx).text.clone(),
                    );
                    TestInput::new(handler, w).compose_text(None, "とうきょう", Some(5..5), cx);
                })
                .unwrap();
                server.release.send_blocking(()).unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state
                        .mission
                        .as_ref()
                        .is_some_and(|r| !matches!(r.result, Ok(Inspection::Pending)))
                });
                cx.update_window(h, |_, w, cx| {
                    assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                    let e = editor.read(cx);
                    assert_eq!(e.selected.as_deref(), Some(next_key.as_str()));
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text(&next_key, &e.cache[&next_key])
                    );
                    assert_eq!(
                        e.cache[&next_key].text,
                        "Other chat unsent 日本語とうきょう"
                    );
                    let reply = e.state.mission.as_ref().unwrap();
                    assert!(reply.target == target);
                    assert_eq!(reply.request, 17);
                    assert_eq!(
                        matches!(reply.result, Ok(Inspection::Created { .. })),
                        !lost
                    );
                    assert_eq!(e.state.mission_receipts.contains_key("source"), !lost);
                    editor.update(cx, |e, cx| {
                        e.text.update(cx, |t, cx| t.unmark_text(w, cx));
                        e.changed(cx);
                    });
                })
                .unwrap();
                assert!(writer.command(WriteCommand::Close));
                until(cx, h, &editor, &updates, |e| e.state.flushed);
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                writer.disconnect_fixture();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !updates.is_closed() {
                    assert!(Instant::now() < deadline);
                    cx.run_until_parked();
                    std::thread::yield_now();
                }
                let reopened = Store::open(private.0.clone(), server.options.host()).unwrap();
                assert_eq!(
                    reopened.book.drafts[&next_key].text,
                    "Other chat unsent 日本語とうきょう"
                );
                assert!(reopened.book.drafts[&key].text.starts_with(text));
                assert!(reopened.book.pending[&sealed.id] == sealed);
                let seen = server.seen.lock().unwrap();
                assert_eq!(seen.posts, [serde_json::to_value(&request).unwrap()]);
                assert_eq!(seen.bodies, [serde_json::to_vec(&request).unwrap()]);
                println!(
                    "{}",
                    serde_json::json!({"probe":"mission-wait","width":width,"mode":mode.name(),"lost":lost,"durable_before_release":true,"edit_to_saved_ms":elapsed.as_secs_f64()*1000.})
                );
            }
        }
    }
}
