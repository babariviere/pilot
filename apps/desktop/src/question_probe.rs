//! Actual offscreen production composer, isolated private state and command recorder.
//! No LocalOptions, worker, HTTP, real question, send, stop or grant.
use super::*;
use crate::{
    delivery_store::{Host, Store},
    question::{Projection, Question},
    ui::{self, Text},
};
use gpui_kit::InputEvent as _;
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use std::{sync::Arc, time::Duration};
struct Fixture {
    editor: Entity<ChatEditor>,
}
impl Render for Fixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .p_4()
                    .child(ui::text(Text::Headline, "A question needs your answer"))
                    .child(ui::text(
                        Text::Body,
                        "Synthetic conversation. The ordinary message draft is kept independently.",
                    )),
            )
            .child(self.editor.clone())
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn control_key(w: &mut Window, key: &str, cx: &mut gpui_kit::App) {
    // Exercise actual native control keys, not the helper's simulated text IME.
    let keystroke = gpui_kit::Keystroke::parse(key).unwrap();
    w.dispatch_event(
        gpui_kit::KeyDownEvent {
            keystroke: keystroke.clone(),
            is_held: false,
            prefer_character_input: false,
        }
        .to_platform_input(),
        cx,
    );
    w.dispatch_event(gpui_kit::KeyUpEvent { keystroke }.to_platform_input(), cx);
}
/// Wide cases are awaited asks published by a live run; narrow ones are legacy.
fn question_data(multi: bool) -> serde_json::Value {
    let options=(0..if multi {9}else{3}).map(|ix|serde_json::json!({
  "label":format!("{}: {}",ix+1,if ix==0 {"Typecheck shared types 日本語 👩‍💻"} else {"Run the focused checks for this change"}),
  "detail":"Keep existing behavior, privacy and immutable delivery identity. This is an explicitly selected synthetic answer, not a live operation.",
  "suggested":ix==0,
 })).collect::<Vec<_>>();
    serde_json::json!({
     "question":"Which checks should run before continuing?",
     "context":"Choose one answer or several, then confirm explicitly. You can add your own words. Your existing message draft remains separate; choosing alone never sends.",
     "options":options,"multiSelect":multi,"blocking":!multi,
    })
}
fn question(multi: bool) -> Arc<Question> {
    Arc::new(Question::parse(4, &question_data(multi)).unwrap())
}
/// The production reducer's projection after held automatic input arrives
/// while the question waits (synthetic snapshot, no worker). An awaited ask
/// arrives while its run is live; a legacy ask never presents during a run.
fn held_arrival(model: &mut crate::local_model::LiveTranscript, multi: bool) -> Projection {
    let awaited = !multi;
    let mut legacy = question_data(multi);
    legacy["blocking"] = false.into();
    model.apply(&serde_json::json!({"type":"snapshot","entries":[
        {"id":4,"head":1,"kind":"pilot.question","data":legacy,"model":[]}
    ],"run":{"startedAt":1}}));
    assert!(
        matches!(model.question(), Projection::Unavailable),
        "A legacy ask stays hidden while a run is live"
    );
    model.apply(&serde_json::json!({"type":"snapshot","entries":[
        {"id":4,"head":1,"kind":"pilot.question","data":question_data(multi),"model":[]}
    ],"run":if awaited {serde_json::json!({"startedAt":1})} else {serde_json::Value::Null}}));
    model.apply(
        &serde_json::json!({"type":"queue_update","items":[],"automatic":[
            {"id":1,"origin":"mission","mode":"followUp","preview":"Mission update","held":true}
        ]}),
    );
    model.question()
}
pub fn run_question_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_QUESTIONS_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let root =
                std::env::temp_dir().join(format!("native-questions-{}", uuid::Uuid::new_v4()));
            let host = Host {
                host_id: "local".into(),
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            };
            let mut store = Store::open(root.clone(), host).unwrap();
            let multi = width == 680.;
            let q = question(multi);
            let initial = Draft {
                revision: 1,
                text: "Keep ordinary draft 👩‍💻 日本語 e\u{301}".into(),
                ..Default::default()
            };
            store
                .save_edits(BTreeMap::from([("chat:a".into(), initial.clone())]))
                .unwrap();
            let state = WriteState {
                book: Some(Arc::new(store.book.clone())),
                ..Default::default()
            };
            let (writer, commands) = Interaction::recording();
            cx.update(|cx| {
                cx.set_reduce_motion(mode == ThemeMode::Dark);
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (h, editor) = cx.update(|cx| {
                let mut editor = None;
                let (h, _) = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        let e = cx.new(|cx| {
                            let mut e = ChatEditor::new(Some(writer.clone()), w, cx);
                            e.accept(state.clone(), w, cx);
                            e.select("chat:a".into(), true, false, w, cx);
                            e.question_context(
                                Some("a"),
                                Projection::Pending(q.clone()),
                                true,
                                w,
                                cx,
                            );
                            e
                        });
                        editor = Some(e.clone());
                        cx.new(|_| Fixture { editor: e })
                    },
                )
                .unwrap();
                (h, editor.unwrap())
            });
            frame(cx, h);
            let mut model = crate::local_model::LiveTranscript::default();
            let held = held_arrival(&mut model, multi);
            assert!(
                matches!(&held, Projection::Pending(p) if p.identity == q.identity),
                "Held automatic input keeps the same question pending"
            );
            // Mirror LocalView: held input still counts as queued, and an
            // awaited ask's run is live, so the composer is busy.
            assert_eq!(model.queued, 1);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.permission(true, model.queued > 0 || !multi, cx);
                    e.question_context(Some("a"), held, true, w, cx)
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("question-composer").is_some(),
                    "Held queue arrival keeps the mounted question"
                );
                assert!(
                    w.try_find("question-stop").is_some(),
                    "Busy from held input is applied"
                );
                assert_eq!(editor.read(cx).cache["chat:a"].text, initial.text);
            })
            .unwrap();
            assert!(commands.try_recv().is_err(), "Held arrival sends nothing");
            if multi {
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "question-content",
                        gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-4000.))),
                        cx,
                    )
                })
                .unwrap();
                frame(cx, h);
                cx.update_window(h, |_, w, cx| {
                    let content = w.find("question-content").bounds();
                    let last = w.find(format!(
                        "question-4-{}-{}",
                        q.identity.fingerprint,
                        q.content.options.len() - 1
                    ));
                    assert!(last.visible(), "Last admitted choice is reachable by wheel");
                    let b = last.bounds();
                    assert!(
                        b.top() >= content.top() && b.bottom() <= content.bottom(),
                        "Last choice fits its bounded scroll owner"
                    );
                    w.scroll(
                        "question-content",
                        gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(4000.))),
                        cx,
                    );
                })
                .unwrap();
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                assert!((f32::from(w.viewport_size().width) - width).abs() < 1.);
                let tray = w.find("composer-tray").bounds();
                let question = w.find("question-composer").bounds();
                let content = w.find("question-content").bounds();
                let own = w.find_by_label("Your question reply").bounds();
                let actions = w.find("question-actions").bounds();
                let stop = w.find("question-stop").bounds();
                let reply = w.find("answer-question").bounds();
                let gap = w.rem_size() * 0.5;
                assert!((stop.center().y - reply.center().y).abs() < px(1.));
                assert!(stop.right() < reply.left());
                assert_eq!(w.find_all("question-stop").len(), 1);
                assert!(w.try_find("local-stop").is_none());
                assert!((actions.top() - own.bottom() - gap).abs() < px(1.));
                assert!((reply.right() - actions.right()).abs() < px(1.));
                assert!(
                    (question.size.height
                        - content.size.height
                        - own.size.height
                        - actions.size.height
                        - gap * 4.)
                        .abs()
                        < px(1.),
                    "Question height contains only content, input, actions and Kit spacing"
                );
                assert!(question.top() >= tray.top() && question.bottom() <= tray.bottom());
                assert!(content.size.height <= px(280.5));
                assert!(tray.bottom() <= w.viewport_size().height);
                assert!(question.left() >= tray.left() && question.right() <= tray.right());
                let option = if multi {
                    w.find(format!("question-4-{}-0", q.identity.fingerprint))
                } else {
                    w.find_by_label(q.content.options[0].label.as_str())
                };
                let bounds = option.bounds();
                let panel = w.find("question-composer").bounds();
                w.click_at(
                    "question-composer",
                    gpui_kit::point(
                        bounds.center().x - panel.left(),
                        bounds.center().y - panel.top(),
                    ),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Selection cannot send or dismiss"
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    editor.read(cx).cache["chat:a"]
                        .answer
                        .as_ref()
                        .unwrap()
                        .selected,
                    BTreeSet::from([0]),
                    "Pointer chooses exactly one answer without sending"
                );
                // Kit's styled Checkbox explicitly preserves focus on mouse
                // presses. Reach its native keyboard binding using real Tab.
                // This offscreen fixture starts without an active responder;
                // use the production composer-focus entry point first.
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
                assert_eq!(
                    w.find_by_label("Your question reply").focused(),
                    Some(true),
                    "Production composer focus establishes the keyboard responder"
                );
                let mut reached = false;
                for _ in 0..q.content.options.len() + 12 {
                    let option = if multi {
                        w.find(format!("question-4-{}-0", q.identity.fingerprint))
                    } else {
                        w.find(format!("question-choices-4-{}", q.identity.fingerprint))
                    };
                    if option.focused() == Some(true) {
                        reached = true;
                        break;
                    }
                    control_key(w, "tab", cx);
                    w.render_frame(cx);
                }
                assert!(
                    reached,
                    "Question choice must be reachable through native Tab traversal"
                );
                control_key(w, if multi { "space" } else { "down" }, cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                let selected = &editor.read(cx).cache["chat:a"]
                    .answer
                    .as_ref()
                    .unwrap()
                    .selected;
                if multi {
                    assert!(selected.is_empty(), "Space toggles the focused checkbox");
                } else {
                    assert_eq!(
                        selected,
                        &BTreeSet::from([1]),
                        "Arrow moves within the real RadioGroup"
                    );
                }
                if multi {
                    control_key(w, "space", cx);
                }
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.input("My own words 日本語 👩‍💻 e\u{301}", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(editor.read(cx).cache["chat:a"].text, initial.text);
                assert_eq!(w.find("answer-question").disabled(), None);
                let own = w.find_by_label("Your question reply").bounds();
                let tray = w.find("composer-tray").bounds();
                assert!(
                    own.left() >= tray.left()
                        && own.right() <= tray.right()
                        && own.bottom() <= tray.bottom()
                );
                assert_eq!(cx.theme().mode, mode);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-reply.png", width as u32, mode.name())))
                    .unwrap();
            }
            assert!(commands.try_recv().is_err());
            // A marked reply blocks both actions without losing native preedit.
            cx.update_window(h, |_, w, cx| {
                let handler = ElementInputHandler::new(
                    w.find_by_label("Your question reply").bounds(),
                    editor.read(cx).questions.input.clone(),
                );
                TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                w.click("question-stop", cx);
                w.click("answer-question", cx);
                editor.update(cx, |e, cx| {
                    assert!(e.question_marked(w, cx));
                    assert_eq!(e.cache["chat:a"].text, initial.text);
                    e.questions.input.update(cx, |s, cx| {
                        s.unmark_text(w, cx);
                        s.set_value("My own words 日本語 👩‍💻 e\u{301}", w, cx);
                    });
                });
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err(), "Preedit cannot send or Stop");
            // Pointer and native Tab/Space use the same existing Stop owner.
            for keyboard in [false, true] {
                cx.update_window(h, |_, w, cx| {
                    if keyboard {
                        editor.update(cx, |e, cx| e.focus(w, cx));
                        w.render_frame(cx);
                        for _ in 0..q.content.options.len() + 12 {
                            if w.find("question-stop").focused() == Some(true) {
                                break;
                            }
                            control_key(w, "tab", cx);
                            w.render_frame(cx);
                        }
                        assert_eq!(w.find("question-stop").focused(), Some(true));
                        control_key(w, "space", cx);
                    } else {
                        w.click("question-stop", cx);
                    }
                })
                .unwrap();
                frame(cx, h);
                match commands.try_recv().unwrap() {
                    WriteCommand::Submit {
                        stop: true, draft, ..
                    } => assert_eq!(draft.text, initial.text),
                    _ => panic!("Stop never becomes a reply"),
                }
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find("question-stop").disabled(), Some(true));
                    assert_eq!(w.find("answer-question").disabled(), Some(true));
                    w.click("question-stop", cx);
                    editor.update(cx, |e, cx| {
                        e.pending.clear();
                        cx.notify();
                    });
                })
                .unwrap();
                frame(cx, h);
                assert!(
                    commands.try_recv().is_err(),
                    "Pending Stop cannot duplicate"
                );
            }
            cx.update_window(h, |_, w, cx| editor.update(cx, |e, cx| e.focus(w, cx)))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h);
            let (captured, request) = match commands.try_recv().unwrap() {
                WriteCommand::Answer {
                    key,
                    draft,
                    question,
                    request,
                } => {
                    assert_eq!(key, "chat:a");
                    assert_eq!(question.identity, q.identity);
                    (draft, request)
                }
                _ => panic!("Only explicit confirmation may request a reply"),
            };
            assert!(commands.try_recv().is_err());
            assert_eq!(captured.text, initial.text);
            let intent = store
                .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
                .unwrap();
            let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
            let operation = intent.operation.as_ref().unwrap();
            assert_eq!(operation.kind, "chat-send");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&operation.payload).unwrap()["mode"],
                "steer",
                "A busy held queue never changes the answer's delivery mode"
            );
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.accept(
                        WriteState {
                            book: Some(Arc::new(store.book.clone())),
                            handled: BTreeMap::from([("chat:a".into(), request)]),
                            ..Default::default()
                        },
                        w,
                        cx,
                    )
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("discard-draft").is_none());
                w.click("composer-recovery", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("answer-question").disabled(), Some(true));
                assert_eq!(
                    w.find("discard-draft").disabled(),
                    Some(true),
                    "Ordinary Discard cannot abandon the separate question purpose"
                );
                let tray = gpui_kit::Bounds::new(Default::default(), w.viewport_size());
                for id in ["check-delivery", "retry-delivery"] {
                    let control = w.find(id);
                    assert!(control.visible());
                    let b = control.bounds();
                    assert!(
                        b.left() >= tray.left()
                            && b.right() <= tray.right()
                            && b.bottom() <= tray.bottom()
                    );
                }
                assert_eq!(editor.read(cx).cache["chat:a"].text, initial.text);
                assert_eq!(cx.theme().mode, mode);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-unknown.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("check-delivery", cx))
                .unwrap();
            frame(cx, h);
            assert!(matches!(
                commands.try_recv().unwrap(),
                WriteCommand::Check { retry: false, .. }
            ));
            assert!(commands.try_recv().is_err());
            assert_eq!(
                serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap())
                    .unwrap(),
                original
            );
            // Holds clear after the answer: the Unknown reply still cannot repeat.
            model.apply(&serde_json::json!({"type":"queue_update","items":[],"automatic":[]}));
            assert_eq!(model.queued, 0);
            let cleared = model.question();
            if !multi {
                assert!(
                    matches!(&cleared, Projection::Pending(p) if p.identity == q.identity),
                    "The live run still awaits the same ask"
                );
            }
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.permission(true, model.queued > 0 || !multi, cx);
                    e.question_context(Some("a"), cleared, true, w, cx)
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.try_find("question-stop").is_some(),
                    !multi,
                    "Stop stays beside an awaited ask while its run is live"
                );
                assert_eq!(w.find("answer-question").disabled(), Some(true));
                w.click("answer-question", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Cleared holds never repeat an Unknown reply"
            );
            // The reply's ordinary user entry closes the ask, even mid-run.
            model.apply(&serde_json::json!({"type":"entry_appended","entry":{"id":5,"kind":"pi.user","model":[{"role":"user","content":"Reply"}]}}));
            assert!(!matches!(model.question(), Projection::Pending(_)));
            // The exact receipt arrives later: the run hides the question and
            // the accepted reply settles silently, never as recovered text.
            store.finish(&intent.id, "accepted", None).unwrap();
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.accept(
                        WriteState {
                            book: Some(Arc::new(store.book.clone())),
                            ..Default::default()
                        },
                        w,
                        cx,
                    );
                    e.permission(true, true, cx);
                    e.question_context(Some("a"), Projection::Unavailable, false, w, cx)
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("keep-question-reply").is_none());
                assert!(w.try_find("composer-recovery").is_none());
            })
            .unwrap();
            match commands.try_recv().unwrap() {
                WriteCommand::RetireAnswer {
                    key,
                    revision,
                    identity,
                    recover,
                } => {
                    assert!(!recover, "An accepted reply never enters recovery");
                    assert_eq!(&identity, intent.answer.as_ref().unwrap());
                    store
                        .retire_answer(&key, revision, &identity, recover)
                        .unwrap();
                }
                _ => panic!("Only private settlement of the accepted reply"),
            }
            assert!(commands.try_recv().is_err(), "Nothing is resent");
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.accept(
                        WriteState {
                            book: Some(Arc::new(store.book.clone())),
                            ..Default::default()
                        },
                        w,
                        cx,
                    )
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("composer-recovery").is_none());
                let saved = &editor.read(cx).cache["chat:a"];
                assert!(saved.recovered.is_empty() && saved.answer.is_none());
                assert_eq!(saved.text, initial.text);
            })
            .unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            cases += 1;
            println!(
                "questions {} {} passed: canonical choice/keyboard/explicit reply/ordinary draft/Unknown retention",
                width as u32,
                mode.name()
            );
        }
    }
    cx.update(|cx| cx.set_reduce_motion(false));
    assert_eq!(cases, 4, "Nonzero exact native matrix");
    // The same composer inside the production Local root, as a run awaits it.
    crate::local_view::awaited_question_probe::run(cx);
}
