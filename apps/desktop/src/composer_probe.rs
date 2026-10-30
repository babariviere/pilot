//! Production composer, synthetic private Book and command recorder only.
use super::*;
use crate::delivery_store::{Host, Store};
use gpui_kit::InputEvent as _;
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use std::{sync::Arc, time::Duration};

struct Fixture(Entity<ChatEditor>);
impl Render for Fixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .bg(cx.theme().background)
            .child(
                div()
                    .flex_1()
                    .p_4()
                    .child("Synthetic conversation · composer controls"),
            )
            .child(self.0.clone())
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn key(w: &mut Window, key: &'static str, cx: &mut gpui_kit::App) {
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
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_COMPOSER_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_composer_probe(cx: &mut HeadlessAppContext) {
    super::stop_wait_probe::run(cx);
    super::model_wait_probe::run(cx);
    super::subscription_wait_probe::run(cx);
    super::subagent_wait_probe::run(cx);
    super::mission_wait_probe::run(cx);
    crate::local_view::composer_motion_probe::run(cx);
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let root =
                std::env::temp_dir().join(format!("native-composer-{}", uuid::Uuid::new_v4()));
            let mut store = Store::open(
                root.clone(),
                Host {
                    host_id: "local".into(),
                    daemon_id: "synthetic".into(),
                    lineage_id: "synthetic".into(),
                },
            )
            .unwrap();
            let initial = Draft {
                revision: 1,
                text: "Keep 日本語 👩‍💻 e\u{301}".into(),
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
                            let mut e = ChatEditor::new(Some(writer), w, cx);
                            e.accept(state.clone(), w, cx);
                            e.select("chat:a".into(), true, false, w, cx);
                            e
                        });
                        editor = Some(e.clone());
                        cx.new(|_| Fixture(e))
                    },
                )
                .unwrap();
                (h, editor.unwrap())
            });
            frame(cx, h);
            let (tray, input, send) = cx
                .update_window(h, |_, w, cx| {
                    assert_eq!(cx.theme().mode, mode);
                    assert!(w.try_find("follow-up").is_none());
                    assert!(w.try_find("local-stop").is_none());
                    assert!(
                        w.try_find("composer-recovery").is_none(),
                        "Ordinary drafts have no recovery chrome"
                    );
                    assert!(w.try_find("composer-recovery-region").is_none());
                    let tray = w.find("composer-tray").bounds();
                    let input = w.find("composer-input").bounds();
                    let send = w.find("local-send").bounds();
                    assert_eq!(tray.size.height, px(76.));
                    assert_eq!(input.size.height, px(34.));
                    assert!(send.right() <= tray.right() && send.bottom() <= tray.bottom());
                    (tray, input, send)
                })
                .unwrap();
            capture(cx, h, format!("{}-{}-idle.png", width as u32, mode.name()));
            // Real Return and Option-Return in both turn states. No toggle or Stop.
            for busy in [false, true] {
                for follow_up in [false, true] {
                    cx.update_window(h, |_, w, cx| {
                        editor.update(cx, |e, cx| {
                            e.pending.clear();
                            e.permission(true, busy, cx);
                            e.focus(w, cx);
                        });
                        w.render_frame(cx);
                        assert_eq!(w.find("composer-tray").bounds(), tray);
                        assert_eq!(w.find("composer-input").bounds(), input);
                        assert_eq!(w.find("local-send").bounds(), send);
                        assert_eq!(w.try_find("local-stop").is_some(), busy);
                        if busy {
                            assert_eq!(w.find("local-stop").role(), Some(gpui_kit::Role::Button));
                            assert_eq!(w.find("local-stop").checked(), None);
                            assert_eq!(w.find("local-stop").label(), Some("Stop current work"));
                        }
                        key(w, if follow_up { "alt-enter" } else { "enter" }, cx);
                    })
                    .unwrap();
                    frame(cx, h);
                    match commands.try_recv().unwrap() {
                        WriteCommand::Submit {
                            key,
                            draft,
                            follow_up: actual,
                            stop,
                            ..
                        } => {
                            assert_eq!(key, "chat:a");
                            assert_eq!(draft.text, initial.text);
                            assert_eq!(actual, follow_up);
                            assert!(!stop);
                        }
                        _ => panic!("Only ordinary submit"),
                    }
                    assert!(commands.try_recv().is_err());
                    // An admitted send starts the paint-only takeoff, which then lands.
                    assert!(cx.update(|cx| editor.read(cx).takeoff.running()));
                    let frames = std::env::var_os("PILOT_NEXT_TAKEOFF_DIR")
                        .filter(|_| width > 800. && !busy && !follow_up)
                        .map(std::path::PathBuf::from);
                    for index in 0..30 {
                        if let Some(dir) = &frames {
                            std::fs::create_dir_all(dir).unwrap();
                            cx.capture_screenshot(h)
                                .unwrap()
                                .save(dir.join(format!("{}-{index:02}.png", mode.name())))
                                .unwrap();
                        }
                        frame(cx, h);
                    }
                    assert!(!cx.update(|cx| editor.read(cx).takeoff.running()));
                    cx.update_window(h, |_, w, cx| {
                        assert_eq!(w.find("local-send").disabled(), Some(true));
                        if busy {
                            assert_eq!(w.find("local-stop").disabled(), Some(true));
                        }
                        w.click("local-send", cx);
                        if busy {
                            w.click("local-stop", cx);
                        }
                    })
                    .unwrap();
                    frame(cx, h);
                    assert!(
                        commands.try_recv().is_err(),
                        "Pending cannot duplicate send or Stop"
                    );
                }
            }
            // Busy composer with a draft: two distinct actions, never implicit cancellation.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.pending.clear();
                    cx.notify();
                });
                w.render_frame(cx);
                w.click("local-send", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(matches!(
                commands.try_recv().unwrap(),
                WriteCommand::Submit {
                    follow_up: false,
                    stop: false,
                    ..
                }
            ));
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.pending.clear();
                    cx.notify();
                });
                w.render_frame(cx);
            })
            .unwrap();
            capture(
                cx,
                h,
                format!("{}-{}-working.png", width as u32, mode.name()),
            );
            // Preedit refuses both actions without capturing or losing composition.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
                let handler = ElementInputHandler::new(
                    w.find_by_label("Message to Pilot").bounds(),
                    editor.read(cx).text.clone(),
                );
                TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                key(w, "alt-enter", cx);
                w.click("local-stop", cx);
                assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                editor.update(cx, |e, cx| {
                    e.text.update(cx, |s, cx| s.unmark_text(w, cx));
                    e.text
                        .update(cx, |s, cx| s.set_value(initial.text.clone(), w, cx));
                    e.changed(cx);
                });
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err(), "Preedit never sends/stops");
            // Native Tab traversal and Space activate the explicitly named Stop.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
                let mut reached = false;
                for _ in 0..12 {
                    if w.find("local-stop").focused() == Some(true) {
                        reached = true;
                        break;
                    }
                    key(w, "tab", cx);
                    w.render_frame(cx);
                }
                assert!(reached, "Stop is a named native keyboard action");
                key(w, "space", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(matches!(
                commands.try_recv().unwrap(),
                WriteCommand::Submit { stop: true, .. }
            ));
            assert!(commands.try_recv().is_err());
            capture(
                cx,
                h,
                format!("{}-{}-pending.png", width as u32, mode.name()),
            );
            // Error and readonly fence both entrypoints, retaining selected draft.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.pending.clear();
                    e.error = Some("Local action failed. Draft kept.");
                    cx.notify();
                });
                w.render_frame(cx);
                w.click("local-stop", cx);
                w.click("local-send", cx);
                assert_eq!(w.find("local-stop").disabled(), Some(true));
                assert!(
                    w.find("composer-recovery-region").bounds().bottom()
                        < w.find("composer-tray").bounds().top()
                );
                assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
                assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
            })
            .unwrap();
            frame(cx, h);
            capture(cx, h, format!("{}-{}-error.png", width as u32, mode.name()));
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.error = None;
                    e.permission(false, true, cx);
                });
                w.render_frame(cx);
                w.click("local-stop", cx);
                w.click("local-send", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err());
            // Empty input does not disable an explicit working Stop. Switching
            // away and back retains the ordinary Unicode draft and selection scope.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.permission(true, true, cx);
                    e.select("chat:b".into(), true, true, w, cx);
                    e.focus(w, cx);
                });
                w.render_frame(cx);
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert_ne!(w.find("local-stop").disabled(), Some(true));
                assert_eq!(w.find("composer-tray").bounds(), tray);
                key(w, "enter", cx);
            })
            .unwrap();
            // InputEvent subscriptions settle between real user interactions.
            // Do not programmatically retarget inside the same native dispatch.
            frame(cx, h);
            assert!(commands.try_recv().is_err(), "Empty Return never submits");
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.select("chat:a".into(), true, true, w, cx));
                assert_eq!(editor.read(cx).text.read(cx).value().as_ref(), initial.text);
            })
            .unwrap();
            frame(cx, h);
            while let Ok(command) = commands.try_recv() {
                assert!(
                    matches!(command, WriteCommand::RetireEmpty { .. }),
                    "Navigation may retire an empty private draft, never submit or Stop"
                );
            }
            // Unknown retains its exact immutable envelope. No Send/Stop replay.
            let intent = store.prepare("chat:a", &initial, true, false).unwrap();
            let original = serde_json::to_vec(&intent.operation).unwrap();
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.permission(true, true, cx);
                    e.accept(
                        WriteState {
                            book: Some(Arc::new(store.book.clone())),
                            ..Default::default()
                        },
                        w,
                        cx,
                    );
                });
                w.render_frame(cx);
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert_eq!(w.find("local-stop").disabled(), Some(true));
                w.click("local-send", cx);
                w.click("local-stop", cx);
                assert_eq!(
                    serde_json::to_vec(
                        &editor.read(cx).state.book.as_ref().unwrap().pending[&intent.id].operation
                    )
                    .unwrap(),
                    original
                );
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err());
            capture(
                cx,
                h,
                format!("{}-{}-unknown.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                let recovery = w.find("composer-recovery-region").bounds();
                let tray = w.find("composer-tray").bounds();
                let trigger = w.find("composer-recovery").bounds();
                assert!(recovery.bottom() < tray.top());
                assert!(trigger.bottom() <= recovery.bottom());
                assert!(
                    recovery.top() >= px(0.)
                        && recovery.left() >= tray.left()
                        && recovery.right() <= tray.right()
                );
                assert_eq!(tray.size.height, px(76.));
                assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
                assert!(w.try_find("discard-draft").is_none());
                assert!(w.try_find("check-delivery").is_none());
                assert!(w.try_find("dismiss-stop").is_none());
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
                let mut reached = false;
                for _ in 0..16 {
                    if w.find("composer-recovery").focused() == Some(true) {
                        reached = true;
                        break;
                    }
                    key(w, "tab", cx);
                    w.render_frame(cx);
                }
                assert!(reached, "Contextual recovery is keyboard reachable");
                key(w, "space", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Opening Recovery cannot execute anything"
            );
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("check-delivery").visible());
                assert!(w.find("retry-delivery").visible());
                assert!(w.find("discard-draft").visible());
                assert!(
                    w.try_find("dismiss-stop").is_none(),
                    "Irrelevant Stop acknowledgment never mounts"
                );
                for id in ["check-delivery", "retry-delivery", "discard-draft"] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= px(0.)
                            && b.right() <= w.viewport_size().width
                            && b.top() >= px(0.)
                            && b.bottom() <= w.viewport_size().height
                    );
                }
                key(w, "escape", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("check-delivery").is_none());
                assert_eq!(
                    w.find("composer-recovery").focused(),
                    Some(true),
                    "Escape restores the mounted native trigger"
                );
            })
            .unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            cases += 1;
            println!(
                "composer_controls {} {} passed: routing/pointer/keyboard/preedit/pending/error/Unknown/stable bounds",
                width as u32,
                mode.name()
            );
        }
    }
    assert_eq!(cases, 4);
    super::attachments_probe::run(cx);
}
