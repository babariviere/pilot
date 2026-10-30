//! Command-Left/Right walk navigation history only outside text editing (macOS).
use super::*;
use crate::navigation::{Location, Target};
use gpui_kit::{
    AnyWindowHandle, EntityInputHandler, Focusable, TestAppContext, WindowOptions,
    component::{
        WindowExt,
        input::{Input, InputState},
    },
    test::TestWindowExt,
};

const BACK: &str = "cmd-left";
const FORWARD: &str = "cmd-right";

fn hidden() -> WindowOptions {
    WindowOptions {
        show: false,
        focus: false,
        ..Default::default()
    }
}

/// Synthetic owner with a writable composer: recording writer, probe book, no daemon.
fn setup(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<LocalViewer>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
        LocalViewer::bind_keys(cx);
    });
    let (writer, _commands) = Interaction::recording();
    let (h, v) = cx.update(|cx| {
        gpui_kit::open_window(hidden(), cx, |w, cx| {
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
        })
        .unwrap()
    });
    cx.run_until_parked();
    cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
    (h, v)
}

/// One real keystroke through the window keymap, then deferred events settle.
fn press(cx: &mut TestAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    cx.run_until_parked();
}

/// Leave no focused element, as when the sidebar list or transcript has focus.
fn blur(cx: &mut TestAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.blur(cx)).unwrap();
    cx.run_until_parked();
}

fn location(cx: &mut TestAppContext, v: &Entity<LocalViewer>) -> Location {
    v.read_with(cx, |v, cx| v.location(cx))
}

fn value(cx: &mut TestAppContext, h: AnyWindowHandle, input: &Entity<InputState>) -> String {
    cx.update_window(h, |_, _, cx| input.read(cx).value().to_string())
        .unwrap()
}

/// Insert at the caret, to observe where Command-Left/Right moved it.
fn insert(cx: &mut TestAppContext, h: AnyWindowHandle, input: &Entity<InputState>, s: &str) {
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.replace_text_in_range(None, s, w, cx))
    })
    .unwrap();
}

/// Chats (empty composer) → Home → Missions, leaving Back available.
fn seed_history(cx: &mut TestAppContext, h: AnyWindowHandle, v: &Entity<LocalViewer>) {
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.show_home(w, cx);
            assert!(v.show_missions(w, cx));
        })
    })
    .unwrap();
    cx.run_until_parked();
}

/// Walk history with the given shortcuts from a window with no focused text field.
fn walk(cx: &mut TestAppContext, back: &str, forward: &str) -> Vec<Target> {
    let (h, v) = setup(cx);
    seed_history(cx, h, &v);
    let mut seen = vec![location(cx, &v).target];
    for key in [back, back, back, forward, forward, forward, back] {
        blur(cx, h);
        press(cx, h, key);
        seen.push(location(cx, &v).target);
    }
    seen
}

const WALK: [Target; 8] = [
    Target::Missions,
    Target::Home,
    Target::Empty,
    Target::Empty, // nothing earlier: no-op
    Target::Home,
    Target::Missions,
    Target::Missions, // nothing later: no-op
    Target::Home,
];

#[gpui_kit::test]
fn command_arrows_walk_the_existing_history(cx: &mut TestAppContext) {
    assert_eq!(walk(cx, BACK, FORWARD), WALK);
}

#[gpui_kit::test]
fn brackets_keep_their_existing_history_route(cx: &mut TestAppContext) {
    assert_eq!(walk(cx, "secondary-[", "secondary-]"), WALK);
}

#[gpui_kit::test]
fn back_restores_a_new_chat_draft_and_its_text(cx: &mut TestAppContext) {
    let (h, v) = setup(cx);
    press(cx, h, "secondary-n");
    let key = v.read_with(cx, |v, cx| {
        v.editor.read(cx).navigation_key().map(str::to_owned)
    });
    let key = key.expect("New Chat opens a draft");
    assert!(key.starts_with("new:"));
    let text = v.read_with(cx, |v, cx| v.editor.read(cx).shell_probe().0);
    let draft = "Draft 👩‍💻 e\u{301}";
    cx.update_window(h, |_, w, cx| {
        text.update(cx, |t, cx| {
            t.focus(w, cx);
            t.replace_text_in_range(None, draft, w, cx);
        })
    })
    .unwrap();
    cx.run_until_parked();
    press(cx, h, "secondary-1");
    assert_eq!(location(cx, &v).target, Target::Home);
    blur(cx, h);
    press(cx, h, BACK);
    assert_eq!(location(cx, &v).target, Target::Draft(key));
    let restored = cx
        .update_window(h, |_, _, cx| text.read(cx).value().to_string())
        .unwrap();
    assert_eq!(restored, draft);
    blur(cx, h);
    press(cx, h, FORWARD);
    assert_eq!(location(cx, &v).target, Target::Home);
}

#[gpui_kit::test]
fn composer_keeps_line_start_end_selection_and_composition(cx: &mut TestAppContext) {
    let (h, v) = setup(cx);
    seed_history(cx, h, &v);
    cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.show_chats(w, cx)))
        .unwrap();
    cx.run_until_parked();
    let at = location(cx, &v);
    let text = v.read_with(cx, |v, cx| v.editor.read(cx).shell_probe().0);
    let value = |cx: &mut TestAppContext| {
        cx.update_window(h, |_, _, cx| text.read(cx).value().to_string())
            .unwrap()
    };
    let type_text = |cx: &mut TestAppContext, s: &str| {
        cx.update_window(h, |_, w, cx| {
            text.update(cx, |t, cx| t.replace_text_in_range(None, s, w, cx))
        })
        .unwrap()
    };
    cx.update_window(h, |_, w, cx| {
        text.update(cx, |t, cx| t.focus(w, cx));
        w.draw(cx).clear(cx);
        assert!(w.is_action_available(&NavigateBack, cx), "history exists");
    })
    .unwrap();
    type_text(cx, "hello world");
    press(cx, h, BACK);
    type_text(cx, "<");
    press(cx, h, FORWARD);
    type_text(cx, ">");
    assert_eq!(value(cx), "<hello world>");
    assert_eq!(location(cx, &v), at, "the composer never navigates");
    press(cx, h, "shift-cmd-left");
    type_text(cx, "line");
    assert_eq!(value(cx), "line", "Shift-Command-Left still selects");
    // Marked composition stays with the composer.
    cx.update_window(h, |_, w, cx| {
        text.update(cx, |t, cx| {
            t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
        })
    })
    .unwrap();
    press(cx, h, BACK);
    press(cx, h, FORWARD);
    assert_eq!(location(cx, &v), at);
    assert!(value(cx).contains("にほん"));
    let focused = cx
        .update_window(h, |_, w, cx| text.focus_handle(cx).is_focused(w))
        .unwrap();
    assert!(focused, "focus stays in the composer");
}

#[gpui_kit::test]
fn search_palette_and_dialogs_keep_their_keys(cx: &mut TestAppContext) {
    let (h, v) = setup(cx);
    seed_history(cx, h, &v);
    let at = location(cx, &v);
    // Jump's mounted query owns its caret keys, not navigation history.
    press(cx, h, "secondary-k");
    let search = v.read_with(cx, |v, cx| {
        v.jump
            .as_ref()
            .unwrap()
            .read(cx)
            .list
            .read(cx)
            .query_input()
    });
    insert(cx, h, &search, "atlas");
    press(cx, h, BACK);
    insert(cx, h, &search, "<");
    press(cx, h, FORWARD);
    insert(cx, h, &search, ">");
    assert_eq!(value(cx, h, &search), "<atlas>");
    assert_eq!(location(cx, &v), at);
    // Jump palette: modal, its query owns the keys.
    assert!(v.read_with(cx, |v, _| v.jump.is_some()));
    press(cx, h, BACK);
    press(cx, h, FORWARD);
    assert!(
        v.read_with(cx, |v, _| v.jump.is_some()),
        "palette stays open"
    );
    assert_eq!(location(cx, &v), at);
    press(cx, h, "escape");
    assert!(v.read_with(cx, |v, _| v.jump.is_none()));
    // A dialog with a text field (like Rename), then the same dialog without focus.
    let field = cx
        .update_window(h, |_, w, cx| {
            let field = cx.new(|cx| InputState::new(w, cx));
            let child = field.clone();
            w.open_dialog(cx, move |dialog, _, cx| {
                crate::ui::dialog(dialog, cx).child(Input::new(&child))
            });
            field.update(cx, |f, cx| f.focus(w, cx));
            field
        })
        .unwrap();
    cx.run_until_parked();
    insert(cx, h, &field, "title");
    press(cx, h, BACK);
    insert(cx, h, &field, "<");
    assert_eq!(value(cx, h, &field), "<title");
    assert_eq!(location(cx, &v), at);
    blur(cx, h);
    press(cx, h, BACK);
    assert_eq!(location(cx, &v), at, "an open dialog blocks history");
    cx.update_window(h, |_, w, cx| w.close_dialog(cx)).unwrap();
    cx.run_until_parked();
    blur(cx, h);
    press(cx, h, BACK);
    assert_eq!(
        location(cx, &v).target,
        Target::Home,
        "closed: history works"
    );
}

/// Plain auxiliary window (like Settings) with its own focused input.
struct Aux(Entity<InputState>);
impl Render for Aux {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(Input::new(&self.0))
    }
}

#[gpui_kit::test]
fn settings_like_window_keeps_its_line_editing(cx: &mut TestAppContext) {
    let (_h, v) = setup(cx);
    seed_history(cx, _h, &v);
    let at = location(cx, &v);
    let (aux, input) = cx.update(|cx| {
        gpui_kit::open_window(hidden(), cx, |w, cx| {
            let input = cx.new(|cx| InputState::new(w, cx));
            cx.new(|_| Aux(input))
        })
        .map(|(aux, view)| (aux, view.read(cx).0.clone()))
        .unwrap()
    });
    cx.run_until_parked();
    cx.update_window(aux, |_, w, cx| {
        w.activate_window();
        input.update(cx, |i, cx| i.focus(w, cx));
    })
    .unwrap();
    insert(cx, aux, &input, "model");
    press(cx, aux, BACK);
    insert(cx, aux, &input, "<");
    assert_eq!(value(cx, aux, &input), "<model");
    assert_eq!(location(cx, &v), at);
}
