//! Real LocalViewer hidden mount; only synthetic snapshots and recorded final effects.
use crate::{LocalViewer, PreviewState, updates_view::Updates};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, EntityInputHandler, HeadlessAppContext,
    InputEvent, MouseButton, MouseDownEvent, MouseUpEvent, WindowBounds, WindowOptions,
    component::ActiveTheme,
    px, size,
    test::{TestQueryExt, TestWindowExt},
};
use serde_json::{Value, json};
use std::time::Duration;

const CARD: &str = "chat-update:proposal-native";
const ACCEPT: &str = "chat-update-accept:proposal-native";
const DISMISS: &str = "chat-update-dismiss:proposal-native";
const DRAFT: &str = "Retained draft café 日本語 👩🏽‍💻";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}

fn snapshot(phase: &str) -> Value {
    json!({"id":"proposal-native", "phase":phase, "sessionId":"synthetic",
        "source":"native-fixture", "build":"101.1", "summary":"Keep the current conversation and drafts while updating Pilot."})
}

fn inject(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    updates: &Entity<Updates>,
    value: Option<Value>,
    busy: bool,
) {
    cx.update(|cx| {
        updates.update(cx, |u, cx| {
            u.probe_coordinated_snapshot(value, busy);
            cx.notify();
        })
    });
    settle(cx, h);
}

fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}

fn actions(cx: &mut HeadlessAppContext, updates: &Entity<Updates>) -> Vec<Value> {
    cx.update(|cx| updates.read(cx).probe_coordinated_actions().to_vec())
}

// Keep the old rendered listener alive while model identity changes.
fn stale_click(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    updates: &Entity<Updates>,
    replacement: Value,
) {
    cx.update_window(h, |_, w, cx| {
        let position = w.find(ACCEPT).bounds().center();
        w.dispatch_event(
            MouseDownEvent {
                button: MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }
            .to_platform_input(),
            cx,
        );
        updates.update(cx, |u, _| {
            u.probe_coordinated_snapshot(Some(replacement), false)
        });
        w.dispatch_event(
            MouseUpEvent {
                button: MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
            }
            .to_platform_input(),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
}

pub fn run_chat_update_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_CHAT_UPDATE_DIR").map(std::path::PathBuf::from);
    if let Some(path) = &captures {
        std::fs::create_dir_all(path).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            w.set_rem_size(px(14.));
                            cx.new(|cx| {
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.chat_update_probe_mount(w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            // Opening the native root observes system appearance. Pin the fixture afterwards.
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
            settle(cx, h);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), dark));
            let (updates, input) = cx.update(|cx| {
                (
                    view.read(cx).chat_update_probe_updates(cx),
                    view.read(cx).inline_probe_input(cx),
                )
            });
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, DRAFT, w, cx);
                })
            })
            .unwrap();
            inject(cx, h, &updates, None, false);
            cx.update_window(h, |_, w, _| assert!(w.try_find(CARD).is_none()))
                .unwrap();
            let mut unrelated = snapshot("proposed");
            unrelated["sessionId"] = json!("synthetic-two");
            inject(cx, h, &updates, Some(unrelated), false);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find(CARD).is_none(), "no card in another chat")
            })
            .unwrap();
            inject(cx, h, &updates, Some(snapshot("proposed")), false);
            if let Some(path) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(path.join(format!("proposal-initial-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(CARD).visible());
                assert_eq!(
                    view.read(cx).chat_update_probe_selected().as_deref(),
                    Some("synthetic")
                );
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
                let pane = w.find("conversation").bounds();
                let card = w.find(CARD).bounds();
                let composer = w.find("composer-tray").bounds();
                assert_eq!(
                    card.left(),
                    composer.left(),
                    "card aligns with composer left edge"
                );
                assert_eq!(
                    card.right(),
                    composer.right(),
                    "card aligns with composer right edge"
                );
                assert!(card.left() >= pane.left() && card.right() <= pane.right());
                assert!(card.bottom() <= w.find("conversation-editor").bounds().top());
                for id in [ACCEPT, DISMISS] {
                    let b = w.find(id).bounds();
                    assert!(b.left() >= card.left() && b.right() <= card.right());
                    assert!(
                        b.size.height >= px(24.),
                        "{id} target height {:?}, card {:?}",
                        b.size.height,
                        card
                    );
                }
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let preedit = cx
                .update_window(h, |_, w, cx| {
                    (
                        input.read(cx).value().to_string(),
                        input
                            .update(cx, |i, cx| i.marked_text_range(w, cx))
                            .expect("actual native preedit"),
                    )
                })
                .unwrap();
            click(cx, h, ACCEPT);
            click(cx, h, DISMISS);
            assert!(
                actions(cx, &updates).is_empty(),
                "IME cannot approve or dismiss"
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(input.read(cx).value().as_ref(), preedit.0);
                assert_eq!(
                    input.update(cx, |i, cx| i.marked_text_range(w, cx)),
                    Some(preedit.1.clone())
                );
                input.update(cx, |i, cx| {
                    i.replace_text_in_range(Some(preedit.1), "", w, cx)
                });
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
            })
            .unwrap();
            settle(cx, h);
            if let Some(path) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(path.join(format!("proposal-{width}-{dark}.png")))
                    .unwrap();
            }
            click(cx, h, ACCEPT);
            assert_eq!(
                actions(cx, &updates),
                [json!({"action":"accept","id":"proposal-native","phase":"proposed"})]
            );
            click(cx, h, ACCEPT);
            click(cx, h, DISMISS);
            assert_eq!(
                actions(cx, &updates).len(),
                1,
                "busy blocks duplicate effects"
            );
            cx.update_window(h, |_, w, cx| {
                assert!(w.find_by_label("Working…").visible());
                assert_eq!(
                    view.read(cx).chat_update_probe_selected().as_deref(),
                    Some("synthetic")
                );
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
            })
            .unwrap();
            inject(cx, h, &updates, Some(snapshot("proposed")), false);
            click(cx, h, DISMISS);
            assert_eq!(
                actions(cx, &updates)[1],
                json!({"action":"cancel","id":"proposal-native","phase":"proposed"})
            );
            let recorded = actions(cx, &updates);
            for field in ["id", "phase", "sessionId"] {
                inject(cx, h, &updates, Some(snapshot("proposed")), false);
                let mut replacement = snapshot("proposed");
                replacement[field] = json!(match field {
                    "id" => "replacement-proposal",
                    "phase" => "gui-installing",
                    _ => "synthetic-two",
                });
                stale_click(cx, h, &updates, replacement);
                assert_eq!(
                    actions(cx, &updates),
                    recorded,
                    "stale {field} callback is inert"
                );
            }
            // Composer Tab intentionally indents. Begin at the window's navigation owner,
            // then traverse real Tab stops without changing editor key handling.
            inject(cx, h, &updates, Some(snapshot("proposed")), false);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |view, cx| view.chat_update_probe_focus_root(w, cx))
            })
            .unwrap();
            settle(cx, h);
            let before_keyboard = actions(cx, &updates).len();
            for _ in 0..24 {
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                settle(cx, h);
                if cx
                    .update_window(h, |_, w, _| w.find(DISMISS).focused() == Some(true))
                    .unwrap()
                {
                    break;
                }
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find(DISMISS).focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                actions(cx, &updates).len(),
                before_keyboard + 1,
                "Return activates exactly once"
            );
            assert_eq!(
                actions(cx, &updates).last().unwrap(),
                &json!({"action":"cancel","id":"proposal-native","phase":"proposed"})
            );
            for phase in ["draining", "gui-installing", "daemon-installing"] {
                inject(cx, h, &updates, Some(snapshot(phase)), false);
                cx.update_window(h, |_, w, _| {
                    assert!(w.find(CARD).visible());
                    assert!(
                        w.find_by_label(match phase {
                            "draining" => "Preparing update",
                            "gui-installing" => "Restarting app",
                            _ => "Restarting daemon",
                        })
                        .visible()
                    );
                    assert!(w.try_find(ACCEPT).is_none());
                    assert!(w.try_find(DISMISS).is_none());
                })
                .unwrap();
            }
            inject(cx, h, &updates, Some(snapshot("draining")), false);
            cx.update(|cx| {
                updates.update(cx, |u, cx| {
                    u.probe_coordinated_blocked();
                    cx.notify();
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("chat-update-error:proposal-native").visible());
                assert!(w.find("chat-update-continue:proposal-native").visible());
            })
            .unwrap();
            let mut long = snapshot("proposed");
            long["summary"] = json!("Résumé 日本語 👩🏽‍💻 e\u{301}\n".repeat(2000));
            long["build"] = json!("版👩🏽‍💻".repeat(1000));
            inject(cx, h, &updates, Some(long), false);
            cx.update_window(h, |_, w, _| {
                let b = w.find(CARD).bounds();
                assert!(b.size.height < px(360.), "long proposal remains bounded");
                assert!(w.find(ACCEPT).visible() && w.find(DISMISS).visible());
            })
            .unwrap();
            if let Some(path) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(path.join(format!("proposal-long-{width}-{dark}.png")))
                    .unwrap();
            }
            let before_switch = actions(cx, &updates);
            // Retain A's painted button, navigate through the actual sidebar,
            // then release over A before allowing another frame.
            let old_accept = cx
                .update_window(h, |_, w, cx| {
                    let old_accept = w.find(ACCEPT).bounds().center();
                    let other_chat = w.find("chat-row-synthetic-two").bounds().center();
                    for position in [old_accept, other_chat] {
                        w.dispatch_event(
                            MouseDownEvent {
                                button: MouseButton::Left,
                                position,
                                modifiers: Default::default(),
                                click_count: 1,
                                first_mouse: false,
                            }
                            .to_platform_input(),
                            cx,
                        );
                    }
                    w.dispatch_event(
                        MouseUpEvent {
                            button: MouseButton::Left,
                            position: other_chat,
                            modifiers: Default::default(),
                            click_count: 1,
                        }
                        .to_platform_input(),
                        cx,
                    );
                    // Sidebar events may publish at the end of this update.
                    old_accept
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    view.read(cx).chat_update_probe_selected().as_deref(),
                    Some("synthetic-two")
                );
                w.dispatch_event(
                    MouseUpEvent {
                        button: MouseButton::Left,
                        position: old_accept,
                        modifiers: Default::default(),
                        click_count: 1,
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                actions(cx, &updates),
                before_switch,
                "old mouse-up cannot act after navigation"
            );
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find(CARD).is_none());
                assert_eq!(
                    view.read(cx).chat_update_probe_selected().as_deref(),
                    Some("synthetic-two")
                );
            })
            .unwrap();
            inject(cx, h, &updates, Some(snapshot("proposed")), false);
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find(CARD).is_none(),
                    "late proposing-chat update never follows selection"
                )
            })
            .unwrap();
            assert_eq!(actions(cx, &updates), before_switch);
            click(cx, h, "chat-row-synthetic");
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(CARD).visible());
                assert_eq!(input.read(cx).value().as_ref(), DRAFT);
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            println!(
                "chat_update mounted {width} dark={dark}: scope, draft/IME, pointer, Tab/Return, exact effects, busy, progress/error and Unicode bounds"
            );
        }
    }
}
