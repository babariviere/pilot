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
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestQueryExt, TestWindowExt},
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
fn question(multi: bool) -> Arc<Question> {
    let options=(0..if multi {9}else{3}).map(|ix|serde_json::json!({
  "label":format!("{}: {}",ix+1,if ix==0 {"Typecheck shared types 日本語 👩‍💻"} else {"Run the focused checks for this change"}),
  "detail":"Keep existing behavior, privacy and immutable delivery identity. This is an explicitly selected synthetic answer, not a live operation.",
  "suggested":ix==0,
 })).collect::<Vec<_>>();
    Arc::new(Question::parse(4,&serde_json::json!({
  "question":"Which checks should run before continuing?",
  "context":"Choose one answer or several, then confirm explicitly. You can add your own words. Your existing message draft remains separate; choosing alone never sends.",
  "options":options,"multiSelect":multi,
 })).unwrap())
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
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h);
            let captured = match commands.try_recv().unwrap() {
                WriteCommand::Answer {
                    key,
                    draft,
                    question,
                    ..
                } => {
                    assert_eq!(key, "chat:a");
                    assert_eq!(question.identity, q.identity);
                    draft
                }
                _ => panic!("Only explicit confirmation may request a reply"),
            };
            assert!(commands.try_recv().is_err());
            assert_eq!(captured.text, initial.text);
            let intent = store
                .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
                .unwrap();
            let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.accept(
                        WriteState {
                            book: Some(Arc::new(store.book.clone())),
                            handled: BTreeMap::from([("chat:a".into(), 1)]),
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
    assert_eq!(cases, 4, "Nonzero exact native matrix");
}
