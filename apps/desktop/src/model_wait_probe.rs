//! Mounted model/thinking wait, real composer/courier and temporary durable state.
use super::*;
use crate::delivery_store::Store;
use crate::model_wait_fixture::{Behavior, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub(super) struct Private(pub(super) PathBuf);
impl Drop for Private {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}
pub(super) struct Root(pub(super) Entity<ChatEditor>);
impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .v_flex()
            .bg(cx.theme().background)
            .child(div().flex_1())
            .child(self.0.clone())
    }
}
pub(super) fn pump(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    editor: &Entity<ChatEditor>,
    updates: &async_channel::Receiver<WriteState>,
) {
    while let Ok(state) = updates.try_recv() {
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| e.accept(state, w, cx))
        })
        .unwrap();
    }
    cx.run_until_parked();
    cx.advance_clock(Duration::from_millis(16));
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
pub(super) fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    editor: &Entity<ChatEditor>,
    updates: &async_channel::Receiver<WriteState>,
    condition: impl Fn(&ChatEditor) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while !cx.update(|cx| condition(editor.read(cx))) {
        assert!(Instant::now() < deadline, "bounded held model publication");
        pump(cx, h, editor, updates);
        std::thread::yield_now();
    }
    pump(cx, h, editor, updates);
}
pub(super) fn disk(private: &Private) -> crate::delivery_store::Book {
    serde_json::from_slice(&std::fs::read(private.0.join("state-v1.json")).unwrap()).unwrap()
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for (failed, thinking, lost) in [
                (false, false, false),
                (true, false, false),
                (false, true, false),
                (true, true, true),
            ] {
                let route = if failed {
                    "/api/sessions/a/failed-model"
                } else {
                    "/api/sessions/a/model"
                };
                let server = Server::start(
                    failed,
                    if lost {
                        Behavior::Lost
                    } else {
                        Behavior::Accept
                    },
                    route,
                );
                let private = Private(
                    std::env::temp_dir()
                        .join(format!("native-model-wait-{}", uuid::Uuid::new_v4())),
                );
                let question = crate::question::Question::parse(7,&json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true})).unwrap();
                let captured = Draft {
                    revision: 2,
                    text: "Unsent ordinary 日本語 👩‍💻".into(),
                    cwd: "/synthetic/project".into(),
                    project_id: Some("project-a".into()),
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
                Store::open(private.0.clone(), server.options.host())
                    .unwrap()
                    .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
                    .unwrap();
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
                            let e = cx.new(|cx| {
                                let mut editor = ChatEditor::new(Some(writer.clone()), w, cx);
                                editor.enable_models(server.options.clone(), w, cx);
                                editor
                            });
                            editor = Some(e.clone());
                            cx.new(|_| Root(e))
                        },
                    )
                    .unwrap();
                    // Window-open system appearance synchronization runs first.
                    gpui_kit::component::Theme::change(mode, None, cx);
                    (h, editor.unwrap())
                });
                until(cx, h, &editor, &updates, |e| e.ready());
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(cx.theme().mode, mode);
                    editor.update(cx, |e, cx| {
                        e.select("chat:a".into(), true, false, w, cx);
                        e.model_context(
                            "a",
                            "/synthetic/project",
                            crate::chat_models::SessionModel::read(
                                &crate::model_wait_fixture::session(failed, None),
                            ),
                            w,
                            cx,
                        );
                    });
                    w.render_frame(cx);
                })
                .unwrap();
                until(cx, h, &editor, &updates, |e| e.model_probe_state().0);
                cx.update_window(h, |_, w, cx| {
                    w.click(
                        if thinking {
                            "chat-thinking"
                        } else {
                            "chat-model"
                        },
                        cx,
                    )
                })
                .unwrap();
                pump(cx, h, &editor, &updates);
                cx.update_window(h, |_, w, cx| {
                    w.click(
                        if thinking {
                            "model-option-low"
                        } else {
                            "model-option-p/b"
                        },
                        cx,
                    )
                })
                .unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while server.entered.try_recv().is_err() {
                    assert!(Instant::now() < deadline);
                    pump(cx, h, &editor, &updates);
                    std::thread::yield_now();
                }
                let original = disk(&private).model_changes["a"].clone();
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
                let before = disk(&private);
                assert_eq!(before.drafts["chat:a"].text, text);
                assert!(before.model_changes["a"] == original);
                assert!(before.drafts["chat:a"].answer == captured.answer);
                assert_eq!(before.drafts["chat:a"].cwd, captured.cwd);
                assert_eq!(before.drafts["chat:a"].project_id, captured.project_id);
                assert!(cx.update(|cx| editor.read(cx).model_probe_state().1));
                cx.update_window(h, |_, w, cx| {
                    let e = editor.read(cx);
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text("chat:a", &e.cache["chat:a"])
                    );
                    let bounds = w.find("composer-input").bounds();
                    assert!(bounds.size.width > px(100.));
                    assert!(bounds.right() <= w.bounds().size.width);
                })
                .unwrap();
                let elapsed = started.elapsed();
                // Preserve preedit/selection/focus through an autosave snapshot.
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    let handler = ElementInputHandler::new(
                        w.find_by_label("Message to Pilot").bounds(),
                        editor.read(cx).text.clone(),
                    );
                    TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                    editor.update(cx, |e, cx| {
                        let state = e.state.clone();
                        e.accept(state, w, cx);
                        assert!(e.marked(w, cx));
                    });
                })
                .unwrap();
                // Change visible target while A is waiting. Its ACK must not retarget B.
                cx.update_window(h, |_, w, cx| {
                    editor.update(cx, |e, cx| {
                        e.text.update(cx, |input, cx| input.unmark_text(w, cx));
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
                    })
                })
                .unwrap();
                pump(cx, h, &editor, &updates);
                cx.update_window(h, |_, w, cx| w.input("Other target unsent 日本語", cx))
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
                    (lost || !server.completed.is_empty())
                        && e.state.model.as_ref().is_some_and(|r| {
                            !matches!(r.outcome, crate::chat_models::Outcome::Pending)
                        })
                });
                cx.update_window(h, |_, w, cx| {
                    assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                    let e = editor.read(cx);
                    assert_eq!(e.selected.as_deref(), Some("chat:b"));
                    let choice = e.model_probe_state().2.unwrap();
                    assert_eq!(choice.model, "q/c", "A response cannot set B model");
                    assert_eq!(choice.thinking.as_deref(), Some("off"));
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text("chat:b", &e.cache["chat:b"])
                    );
                    assert_eq!(
                        e.cache["chat:b"].text,
                        "Other target unsent 日本語とうきょう"
                    );
                    assert!(e.cache["chat:a"].answer == captured.answer);
                    if lost {
                        assert!(e.state.book.as_ref().unwrap().model_changes["a"] == original);
                    } else {
                        assert!(e.state.book.as_ref().unwrap().model_changes.is_empty());
                    }
                })
                .unwrap();
                cx.update_window(h, |_, w, cx| {
                    editor.update(cx, |e, cx| {
                        e.text.update(cx, |input, cx| input.unmark_text(w, cx));
                        e.changed(cx);
                    })
                })
                .unwrap();
                assert!(writer.command(WriteCommand::Close));
                until(cx, h, &editor, &updates, |e| e.state.flushed);
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                writer.disconnect_fixture();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !updates.is_closed() {
                    assert!(
                        Instant::now() < deadline,
                        "writer disconnect releases Store"
                    );
                    cx.run_until_parked();
                    std::thread::yield_now();
                }
                let reopened = Store::open(private.0.clone(), server.options.host()).unwrap();
                assert_eq!(
                    reopened.book.drafts["chat:b"].text,
                    "Other target unsent 日本語とうきょう"
                );
                assert!(reopened.book.drafts["chat:a"].text.starts_with(text));
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
                    json!({"probe":"model-wait","failed_next_model":failed,"thinking_only":thinking,"width":width,"mode":mode.name(),"lost_ack":lost,"durable_before_release":true,"edit_to_saved_ms":elapsed.as_secs_f64()*1000.})
                );
            }
        }
    }
}
