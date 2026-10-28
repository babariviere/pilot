//! Cmd-K reaches the Jump palette from ordinary focus states, including none.
use super::*;
use gpui_kit::{
    AnyWindowHandle, EntityInputHandler, Focusable, TestAppContext, WindowOptions,
    test::TestWindowExt,
};

/// Synthetic owner with a writable composer: recording writer, probe book, no daemon.
fn setup(
    cx: &mut TestAppContext,
) -> (
    AnyWindowHandle,
    Entity<LocalViewer>,
    async_channel::Receiver<crate::interaction::WriteCommand>,
) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
        LocalViewer::bind_keys(cx);
    });
    let (writer, commands) = Interaction::recording();
    let (h, v) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let v = LocalViewer::build(None, Some(writer), w, cx);
                    v.editor.update(cx, |e, cx| {
                        e.accept(
                            crate::interaction::WriteState {
                                book: Some(Arc::new(crate::delivery_store::Book::shell_probe())),
                                ..Default::default()
                            },
                            w,
                            cx,
                        );
                        e.select("chat:source".into(), true, false, w, cx);
                    });
                    v
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
    (h, v, commands)
}

/// One real keystroke through the window keymap, then deferred events settle.
fn press(cx: &mut TestAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    cx.run_until_parked();
}

fn open(cx: &mut TestAppContext, v: &Entity<LocalViewer>) -> bool {
    v.read_with(cx, |v, _| v.jump.is_some())
}

#[gpui_kit::test]
fn cmd_k_toggles_jump_when_nothing_is_focused(cx: &mut TestAppContext) {
    let (h, v, _commands) = setup(cx);
    cx.update_window(h, |_, w, cx| w.blur(cx)).unwrap();
    press(cx, h, "secondary-k");
    assert!(open(cx, &v), "Cmd-K opens Jump without a focused element");
    press(cx, h, "secondary-k");
    assert!(!open(cx, &v), "Cmd-K closes the open palette");
    press(cx, h, "secondary-k");
    assert!(open(cx, &v));
    press(cx, h, "escape");
    assert!(!open(cx, &v));
    press(cx, h, "secondary-k");
    assert!(open(cx, &v), "Cmd-K works again after Escape");
}

#[gpui_kit::test]
fn cmd_k_opens_from_home_and_restores_sidebar_search_focus(cx: &mut TestAppContext) {
    let (h, v, _commands) = setup(cx);
    // Home hides the focused composer, as at launch or after page navigation.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| v.editor.update(cx, |e, cx| e.focus(w, cx)));
        v.update(cx, |v, cx| v.show_home(w, cx));
    })
    .unwrap();
    cx.run_until_parked();
    press(cx, h, "secondary-k");
    assert!(open(cx, &v), "Cmd-K opens Jump from Home");
    press(cx, h, "escape");
    assert!(!open(cx, &v));
    press(cx, h, "secondary-f");
    let search = v.read_with(cx, |v, cx| v.chats.read(cx).query_input());
    let focused = |cx: &mut TestAppContext| {
        cx.update_window(h, |_, w, cx| search.focus_handle(cx).is_focused(w))
            .unwrap()
    };
    assert!(focused(cx));
    press(cx, h, "secondary-k");
    assert!(open(cx, &v), "Cmd-K opens Jump from sidebar search");
    press(cx, h, "escape");
    assert!(!open(cx, &v));
    assert!(focused(cx), "focus returns to search");
}

#[gpui_kit::test]
fn cmd_k_waits_for_composer_composition(cx: &mut TestAppContext) {
    let (h, v, _commands) = setup(cx);
    let text = v.read_with(cx, |v, cx| v.editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        text.update(cx, |t, cx| {
            t.focus(w, cx);
            t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
        });
    })
    .unwrap();
    press(cx, h, "secondary-k");
    assert!(!open(cx, &v), "marked composition keeps Cmd-K");
    cx.update_window(h, |_, w, cx| {
        assert!(text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
        text.update(cx, |t, cx| t.unmark_text(w, cx));
    })
    .unwrap();
    press(cx, h, "secondary-k");
    assert!(open(cx, &v), "Cmd-K opens after composition ends");
    press(cx, h, "escape");
    assert!(!open(cx, &v));
    let focused = cx
        .update_window(h, |_, w, cx| text.focus_handle(cx).is_focused(w))
        .unwrap();
    assert!(focused, "focus returns to the composer");
}

/// Plain auxiliary window (like Settings) with its own focused input.
struct Aux(Entity<gpui_kit::component::input::InputState>);
impl Render for Aux {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(gpui_kit::component::input::Input::new(&self.0))
    }
}

#[gpui_kit::test]
fn fallback_never_takes_focus_from_targets_modals_or_other_windows(cx: &mut TestAppContext) {
    let (h, v, _commands) = setup(cx);
    let text = v.read_with(cx, |v, cx| v.editor.read(cx).shell_probe().0);
    let composer = |cx: &mut TestAppContext| {
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            text.focus_handle(cx).is_focused(w)
        })
        .unwrap()
    };
    // A focused composer keeps focus across later frames.
    cx.update_window(h, |_, w, cx| text.update(cx, |t, cx| t.focus(w, cx)))
        .unwrap();
    assert!(composer(cx));
    cx.run_until_parked();
    assert!(
        composer(cx),
        "a rendered focused composer is never replaced"
    );
    // The palette's deliberate modal focus survives later frames.
    press(cx, h, "secondary-k");
    let query = v.read_with(cx, |v, cx| {
        v.jump
            .as_ref()
            .unwrap()
            .read(cx)
            .list
            .read(cx)
            .query_input()
    });
    for _ in 0..3 {
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        cx.run_until_parked();
    }
    let modal = cx
        .update_window(h, |_, w, cx| query.focus_handle(cx).is_focused(w))
        .unwrap();
    assert!(modal, "palette search keeps focus");
    press(cx, h, "escape");
    assert!(composer(cx), "closing restores the composer");
    // Another window keeps activation and its own focus while this one falls back.
    let input = cx.update(|cx| {
        let (aux, input) = gpui_kit::open_window(
            WindowOptions {
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                let input = cx.new(|cx| gpui_kit::component::input::InputState::new(w, cx));
                cx.new(|_| Aux(input))
            },
        )
        .map(|(aux, view)| (aux, view.read(cx).0.clone()))
        .unwrap();
        (aux, input)
    });
    let (aux, input) = input;
    cx.run_until_parked();
    cx.update_window(aux, |_, w, cx| {
        w.activate_window();
        input.update(cx, |i, cx| i.focus(w, cx));
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        w.blur(cx);
        w.render_frame(cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert_eq!(cx.update(|cx| cx.active_window()), Some(aux));
    let kept = cx
        .update_window(aux, |_, w, cx| {
            w.render_frame(cx);
            input.focus_handle(cx).is_focused(w)
        })
        .unwrap();
    assert!(kept, "the other window's input keeps focus");
    let main_focus = cx
        .update_window(h, |_, w, cx| w.focused(cx).is_some())
        .unwrap();
    assert!(main_focus, "only the unfocused window falls back");
}
