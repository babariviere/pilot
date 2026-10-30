//! Mounted ordinary drafts during captured registration, owned held HTTP only.
use super::model_wait_probe::{Private, Root, disk, pump, until};
use super::*;
use crate::{
    delivery_store::Store,
    project_registration::Outcome,
    project_registration_fixture::{Behavior, Server},
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
            for (method, path, nth, lost) in [
                ("GET", "/api/projects", 1, false),
                ("POST", "/api/projects", 1, false),
                ("GET", "/api/projects", 2, false),
                ("POST", "/api/projects", 1, true),
            ] {
                let server = Server::held(
                    if lost {
                        Behavior::Lost
                    } else {
                        Behavior::Accept
                    },
                    method,
                    path,
                    nth,
                );
                let private = Private(
                    std::env::temp_dir()
                        .join(format!("native-registration-wait-{}", uuid::Uuid::new_v4())),
                );
                let answer = fixture::captured();
                let mut captured = answer.clone();
                captured.answer = None;
                captured.text = "Original source 日本語 👩‍💻".into();
                let key = "chat:source".to_string();
                let next_key = "chat:other".to_string();
                captured.project_id = Some("project".into());
                captured.model_choice.as_mut().unwrap().project_id = "project".into();
                let path_captured = "/synthetic/日本語 e\u{301} 👩‍💻";
                let sealed = {
                    let mut store = Store::open(private.0.clone(), server.options.host()).unwrap();
                    store
                        .prepare_project("prior-attempt", "/synthetic/prior")
                        .unwrap();
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
                assert!(writer.command(WriteCommand::Project {
                    id: "captured-attempt".into(),
                    path: Some(path_captured.into())
                }));
                let deadline = Instant::now() + Duration::from_secs(5);
                while server.entered.try_recv().is_err() {
                    assert!(Instant::now() < deadline);
                    pump(cx, h, &editor, &updates);
                    std::thread::yield_now();
                }
                let original = disk(&private).project_registrations;
                if let Some(attempt) = original.get("captured-attempt") {
                    assert_eq!(attempt.path, path_captured);
                    assert_eq!(attempt.created.is_some(), nth == 2);
                }
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
                assert!(before.project_registrations == original);
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
                        .project
                        .as_ref()
                        .is_some_and(|r| !matches!(r.result, Ok(Outcome::Pending)))
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
                    let reply = e.state.project.as_ref().unwrap();
                    assert_eq!(reply.id, "captured-attempt");
                    assert_eq!(matches!(reply.result, Ok(Outcome::Created(_))), !lost);
                    assert_eq!(e.state.project_receipt.is_some(), !lost);
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
                // All five owned request handlers finish before fixture teardown.
                for _ in 0..5 {
                    while server.completed.try_recv().is_err() {
                        assert!(Instant::now() < deadline);
                        cx.run_until_parked();
                        std::thread::yield_now();
                    }
                }
                let reopened = Store::open(private.0.clone(), server.options.host()).unwrap();
                assert_eq!(
                    reopened.book.drafts[&next_key].text,
                    "Other chat unsent 日本語とうきょう"
                );
                assert!(reopened.book.drafts[&key].text.starts_with(text));
                assert!(reopened.book.pending[&sealed.id] == sealed);
                let seen = server.seen.lock().unwrap();
                assert_eq!(
                    seen.bodies,
                    [serde_json::to_vec(&serde_json::json!({"path":path_captured})).unwrap()]
                );
                println!(
                    "{}",
                    serde_json::json!({"probe":"registration-wait","method":method,"nth":nth,"width":width,"mode":mode.name(),"lost":lost,"durable_before_release":true,"edit_to_saved_ms":elapsed.as_secs_f64()*1000.})
                );
            }
        }
    }
}
