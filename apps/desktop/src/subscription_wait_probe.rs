//! Mounted subscription actions, existing confirmation and held owned HTTP only.
use super::model_wait_probe::{Private, Root, disk, pump, until};
use super::*;
use crate::chat_models::{self, Choice as ModelChoice};
use crate::delivery_store::Store;
use crate::model_wait_fixture::{Behavior, Server};
use gpui_kit::{
    Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use serde_json::json;
use std::time::{Duration, Instant};

pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for scenario in ["force", "continue", "cross", "lost-continue"] {
                let continuation = scenario != "force";
                let lost = scenario == "lost-continue";
                let cross = scenario == "cross";
                let route = if continuation {
                    "/api/sessions/a/continue-model"
                } else {
                    "/api/sessions/a/subscription-force"
                };
                let server = Server::subscription(
                    false,
                    if lost {
                        Behavior::Lost
                    } else {
                        Behavior::Accept
                    },
                    route,
                );
                let private = Private(
                    std::env::temp_dir()
                        .join(format!("native-subscription-wait-{}", uuid::Uuid::new_v4())),
                );
                let question = crate::question::Question::parse(7, &json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true})).unwrap();
                let captured = Draft {
                    revision: 2,
                    text: "Unsent ordinary 日本語 👩‍💻".into(),
                    cwd: "/synthetic/project".into(),
                    project_id: Some("project-a".into()),
                    model_choice: Some(crate::chat_models::DraftChoice {
                        project_id: "project-a".into(),
                        cwd: "/synthetic/project".into(),
                        choice: ModelChoice {
                            model: "p/a".into(),
                            thinking: Some("high".into()),
                        },
                    }),
                    answer: Some(
                        crate::question::AnswerDraft::capture(
                            &question,
                            2,
                            BTreeSet::from([0]),
                            "Existing answer".into(),
                        )
                        .unwrap(),
                    ),
                    ..Default::default()
                };
                let sealed = {
                    let mut store = Store::open(private.0.clone(), server.options.host()).unwrap();
                    store
                        .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
                        .unwrap();
                    store
                        .prepare("chat:sealed", &captured, false, false)
                        .unwrap()
                };
                let (writer, updates) =
                    Interaction::start(server.options.clone(), Ok(private.0.clone()));
                let (h, editor) = cx.update(|cx| {
                    let mut editor = None;
                    let (h, _) = gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(650.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            w.set_rem_size(px(14.));
                            let e = cx.new(|cx| {
                                let mut e = ChatEditor::new(Some(writer.clone()), w, cx);
                                e.enable_models(server.options.clone(), w, cx);
                                e
                            });
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
                        e.select("chat:a".into(), true, false, w, cx);
                        let mut raw = crate::model_wait_fixture::session(false, None);
                        raw["subscriptionPause"] = json!({"forced":false,"windows":[]});
                        e.model_context(
                            "a",
                            "/synthetic/project",
                            crate::chat_models::SessionModel::read(&raw),
                            w,
                            cx,
                        );
                    });
                })
                .unwrap();
                until(cx, h, &editor, &updates, |e| e.model_probe_state().0);
                if continuation {
                    // Actual model-chip choice opens the existing confirmation, no POST.
                    cx.update_window(h, |_, w, cx| w.click("chat-model", cx))
                        .unwrap();
                    pump(cx, h, &editor, &updates);
                    cx.update_window(h, |_, w, cx| {
                        w.click(
                            if cross {
                                "model-option-q/c"
                            } else {
                                "model-option-p/b"
                            },
                            cx,
                        )
                    })
                    .unwrap();
                    pump(cx, h, &editor, &updates);
                    assert!(
                        server
                            .seen
                            .lock()
                            .unwrap()
                            .iter()
                            .all(|(m, _, _)| m != "POST")
                    );
                    cx.update_window(h, |_, w, _| {
                        assert_eq!(
                            w.find("subscription-continue-confirm").label(),
                            Some(if cross {
                                "Start new chat"
                            } else {
                                "Switch model"
                            })
                        );
                    })
                    .unwrap();
                }
                let button = if continuation {
                    "subscription-continue-confirm"
                } else {
                    "subscription-force"
                };
                // Existing consent/preedit guard must still refuse before dispatch.
                cx.update_window(h, |_, w, cx| {
                    w.click("composer-input", cx);
                    let handler = ElementInputHandler::new(
                        w.find_by_label("Message to Pilot").bounds(),
                        editor.read(cx).text.clone(),
                    );
                    TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                    w.click(button, cx);
                    assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                    let text = editor.read(cx).text.clone();
                    text.update(cx, |t, cx| {
                        t.replace_text_in_range(None, "", w, cx);
                        t.unmark_text(w, cx);
                    });
                })
                .unwrap();
                pump(cx, h, &editor, &updates);
                assert!(
                    server
                        .seen
                        .lock()
                        .unwrap()
                        .iter()
                        .all(|(m, _, _)| m != "POST")
                );
                cx.update_window(h, |_, w, cx| w.click(button, cx)).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while server.entered.try_recv().is_err() {
                    assert!(Instant::now() < deadline);
                    pump(cx, h, &editor, &updates);
                    std::thread::yield_now();
                }
                let original = disk(&private).model_changes.get("a").cloned();
                assert_eq!(original.is_some(), continuation);
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
                        .is_some_and(|b| b.drafts["chat:a"].text == text)
                });
                let elapsed = started.elapsed();
                let before = disk(&private);
                assert_eq!(before.drafts["chat:a"].text, text);
                assert_eq!(before.model_changes.get("a"), original.as_ref());
                assert!(before.pending[&sealed.id] == sealed);
                assert!(before.drafts["chat:a"].answer == captured.answer);
                assert_eq!(before.drafts["chat:a"].model_choice, captured.model_choice);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    let e = editor.read(cx);
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text("chat:a", &e.cache["chat:a"])
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
                    });
                    editor.update(cx, |e, cx| {
                        e.text.update(cx, |t, cx| t.unmark_text(w, cx));
                        e.changed(cx);
                        e.select("chat:b".into(), true, false, w, cx);
                        let mut raw = crate::model_wait_fixture::session(false, None);
                        raw["id"] = json!("b");
                        raw["model"] = json!("q/c");
                        raw["thinking"] = json!("off");
                        e.model_context(
                            "b",
                            "/synthetic/project",
                            crate::chat_models::SessionModel::read(&raw),
                            w,
                            cx,
                        );
                        e.focus(w, cx);
                    });
                    w.input("Other target unsent 日本語", cx);
                })
                .unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state.book.as_ref().is_some_and(|b| {
                        b.drafts
                            .get("chat:b")
                            .is_some_and(|d| d.text == "Other target unsent 日本語")
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
                        .model
                        .as_ref()
                        .is_some_and(|r| !matches!(r.outcome, chat_models::Outcome::Pending))
                });
                cx.update_window(h, |_, w, cx| {
                    assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                    let e = editor.read(cx);
                    assert_eq!(e.selected.as_deref(), Some("chat:b"));
                    assert_eq!(e.model_probe_state().2.unwrap().model, "q/c");
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text("chat:b", &e.cache["chat:b"])
                    );
                    assert_eq!(
                        e.cache["chat:b"].text,
                        "Other target unsent 日本語とうきょう"
                    );
                    assert_eq!(
                        e.state
                            .book
                            .as_ref()
                            .unwrap()
                            .model_changes
                            .contains_key("a"),
                        lost
                    );
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
                    reopened.book.drafts["chat:b"].text,
                    "Other target unsent 日本語とうきょう"
                );
                assert!(reopened.book.drafts["chat:a"].text.starts_with(text));
                assert!(reopened.book.pending[&sealed.id] == sealed);
                assert_eq!(
                    server
                        .seen
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(m, _, _)| m == "POST")
                        .count(),
                    1
                );
                println!(
                    "{}",
                    json!({"probe":"subscription-wait","scenario":scenario,"width":width,"mode":mode.name(),"durable_before_release":true,"edit_to_saved_ms":elapsed.as_secs_f64()*1000.})
                );
            }
        }
    }
}
