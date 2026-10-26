//! Closed-sheet completion must retain the original owner without latching busy.
use super::*;

#[gpui_kit::test]
fn chat_actions_closed_pending_completion_is_exact_and_does_not_steal_focus(
    cx: &mut TestAppContext,
) {
    let (h, form, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        form.update(cx, |f, cx| {
            f.confirm(w, cx);
            assert!(f.pending());
            f.close(w, cx);
            assert!(!f.open);
        })
    })
    .unwrap();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Mission {
            action: crate::mission_conversion::Action::Submit { .. },
            ..
        }
    ));
    cx.update_window(h, |_, w, cx| {
        form.update(cx, |f, cx| {
            let title = f.title.read(cx).value().to_string();
            let focus = w.focused(cx);
            let mut other = target();
            other.source = "another-chat".into();
            let mut state = WriteState {
                book: Some(Arc::new(Book::shell_probe())),
                mission: Some(Reply {
                    target: other,
                    request: f.request,
                    result: Ok(Inspection::Uncertain),
                }),
                ..Default::default()
            };
            f.accept(&state, w, cx);
            assert!(
                f.pending(),
                "foreign completion never releases original pending owner"
            );
            state.mission = Some(Reply {
                target: target(),
                request: f.request,
                result: Ok(Inspection::Uncertain),
            });
            f.accept(&state, w, cx);
            assert!(
                !f.pending(),
                "actual closed-sheet completion releases pending without retargeting"
            );
            assert_eq!(f.target.as_ref().unwrap().source, "source-exact");
            assert_eq!(f.title.read(cx).value().as_ref(), title);
            assert_eq!(w.focused(cx), focus);
        })
    })
    .unwrap();
}
