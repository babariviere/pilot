use super::*;
use crate::mission_conversion::Reply;
use gpui_kit::{
    Bounds, TestAppContext, WindowBounds, WindowOptions, size,
    test::{TestQueryExt, TestWindowExt},
};

fn target() -> Target {
    Target {
        source: "source-exact".into(),
        project: "project-exact".into(),
        generation: 9,
    }
}
fn setup(
    cx: &mut TestAppContext,
) -> (
    gpui_kit::AnyWindowHandle,
    Entity<MissionForm>,
    async_channel::Receiver<WriteCommand>,
) {
    let (writer, commands) = Interaction::recording();
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::local_view::LocalViewer::bind_keys(cx);
    });
    let (handle, form) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(680.), px(720.)),
                ))),
                show: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let mut form = MissionForm::new(Some(writer), w, cx);
                    form.accept(
                        &WriteState {
                            book: Some(Arc::new(Book::shell_probe())),
                            ..Default::default()
                        },
                        w,
                        cx,
                    );
                    form.open(target(), "Existing chat", w, cx);
                    form
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Mission {
            action: Command::Inspect,
            ..
        }
    ));
    ready(cx, handle, &form);
    (handle, form, commands)
}
fn ready(cx: &mut TestAppContext, handle: gpui_kit::AnyWindowHandle, form: &Entity<MissionForm>) {
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            let state = WriteState {
                book: form.book.clone(),
                mission: Some(Reply {
                    target: target(),
                    request: form.request,
                    result: Ok(Inspection::Ready {
                        title: "Canonical title".into(),
                    }),
                }),
                ..Default::default()
            };
            form.accept(&state, w, cx);
        })
    })
    .unwrap();
    cx.run_until_parked();
}

#[gpui_kit::test]
fn explicit_form_captures_native_text_choices_and_double_confirm_once(cx: &mut TestAppContext) {
    let (handle, form, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        w.click("mission-coordinator", cx);
        w.click("mission-draft", cx);
        let title = form.read(cx).title.clone();
        title.update(cx, |input, cx| input.focus(w, cx));
        w.press("secondary-a", cx);
        w.input("Edited 日本語", cx);
        let goal = form.read(cx).goal.clone();
        goal.update(cx, |input, cx| input.focus(w, cx));
        w.input("Goal 👩‍💻", cx);
        w.press("enter", cx);
        assert!(
            commands.try_recv().is_err(),
            "Goal Return is not confirmation"
        );
        w.press("secondary-enter", cx);
        w.press("secondary-enter", cx);
        w.click("mission-confirm", cx);
    })
    .unwrap();
    cx.run_until_parked();
    match commands.try_recv().unwrap() {
        WriteCommand::Mission {
            target: captured,
            action: Command::Submit { request, .. },
            ..
        } => {
            assert!(captured == target());
            assert_eq!(request.from_session_id, "source-exact");
            assert_eq!(request.project_id, "project-exact");
            assert_eq!(request.title, "Edited 日本語");
            assert!(request.goal.starts_with("Goal 👩‍💻"));
            assert!(!request.coordinator && !request.draft);
        }
        _ => panic!("Expected exactly one captured mission confirmation"),
    }
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn invalid_title_and_stale_source_replies_never_enable_confirmation(cx: &mut TestAppContext) {
    let (handle, form, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            form.title.update(cx, |t, cx| t.set_value("   ", w, cx));
            form.confirm(w, cx);
            assert!(commands.try_recv().is_err());
            form.ready = false;
            let mut stale = target();
            stale.generation += 1;
            form.accept(
                &WriteState {
                    book: form.book.clone(),
                    mission: Some(Reply {
                        target: stale,
                        request: form.request,
                        result: Ok(Inspection::Ready {
                            title: "Wrong source".into(),
                        }),
                    }),
                    ..Default::default()
                },
                w,
                cx,
            );
            assert!(!form.ready);
            form.confirm(w, cx);
            assert!(commands.try_recv().is_err());
            assert_eq!(form.title.read(cx).value().as_ref(), "   ");
        })
    })
    .unwrap();
}

#[gpui_kit::test]
fn repeated_ready_publication_cannot_refill_a_title_the_user_cleared(cx: &mut TestAppContext) {
    let (handle, form, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            form.title
                .update(cx, |title, cx| title.set_value("", w, cx));
            let state = WriteState {
                book: form.book.clone(),
                mission: Some(Reply {
                    target: target(),
                    request: form.request,
                    result: Ok(Inspection::Ready {
                        title: "Canonical title".into(),
                    }),
                }),
                ..Default::default()
            };
            form.accept(&state, w, cx);
            assert!(form.title.read(cx).value().is_empty());
            form.confirm(w, cx);
            assert!(commands.try_recv().is_err());
            form.accept(&state, w, cx);
            assert!(form.title.read(cx).value().is_empty());
        })
    })
    .unwrap();
}

#[gpui_kit::test]
fn mission_title_and_goal_preedit_guard_escape_keyboard_and_pointer(cx: &mut TestAppContext) {
    use gpui_kit::{ElementInputHandler, test::TestInput};
    for goal in [false, true] {
        let (handle, form, commands) = setup(cx);
        cx.update_window(handle, |_, w, cx| {
            w.render_frame(cx);
            if goal {
                let input = form.read(cx).goal.clone();
                input.update(cx, |t, cx| t.focus(w, cx));
                let handler =
                    ElementInputHandler::new(w.find_by_label("Mission goal").bounds(), input);
                TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
            } else {
                let input = form.read(cx).title.clone();
                input.update(cx, |t, cx| t.focus(w, cx));
                let handler =
                    ElementInputHandler::new(w.find_by_label("Mission title").bounds(), input);
                TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
            }
            w.press("secondary-enter", cx);
            w.press("escape", cx);
            w.click("mission-confirm", cx);
            w.click("mission-cancel", cx);
            form.update(cx, |form, cx| {
                assert!(form.open);
                assert!(form.marked(w, cx));
            });
            assert!(commands.try_recv().is_err());
        })
        .unwrap();
    }
}

#[gpui_kit::test]
fn unconfirmed_attempt_reopen_only_checks_membership_never_submits(cx: &mut TestAppContext) {
    let (handle, form, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            let request = form.captured(cx).unwrap();
            let mut book = (**form.book.as_ref().unwrap()).clone();
            book.missions.insert(
                target().source,
                crate::mission_conversion::Attempt {
                    id: "uncertain-attempt".into(),
                    request,
                    outcome: Outcome::Unknown,
                },
            );
            form.accept(
                &WriteState {
                    book: Some(Arc::new(book)),
                    ..Default::default()
                },
                w,
                cx,
            );
            form.close(w, cx);
            form.open(target(), "Retained source", w, cx);
            form.confirm(w, cx);
            assert!(!form.editable());
        })
    })
    .unwrap();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Mission {
            action: Command::Inspect,
            ..
        }
    ));
    assert!(commands.try_recv().is_err());
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            form.accept(
                &WriteState {
                    book: form.book.clone(),
                    mission: Some(Reply {
                        target: target(),
                        request: form.request,
                        result: Ok(Inspection::Membership {
                            mission_id: Some("current-membership".into()),
                        }),
                    }),
                    ..Default::default()
                },
                w,
                cx,
            );
            form.confirm(w, cx);
            form.check(cx);
            assert!(form.attempt().unwrap().outcome == Outcome::Unknown);
        })
    })
    .unwrap();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Mission {
            action: Command::Check,
            ..
        }
    ));
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn trimmed_unicode_boundaries_capture_exact_valid_payload_and_invalid_never_commands(
    cx: &mut TestAppContext,
) {
    let (handle, form, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            form.title.update(cx, |t, cx| {
                t.set_value(format!("  {}  ", "😀".repeat(101)), w, cx)
            });
            form.confirm(w, cx);
            assert!(commands.try_recv().is_err());
            form.title.update(cx, |t, cx| {
                t.set_value(format!("  {}  ", "😀".repeat(100)), w, cx)
            });
            form.goal.update(cx, |t, cx| {
                t.set_value(format!("  {}  ", "😀".repeat(2001)), w, cx)
            });
            form.confirm(w, cx);
            assert!(commands.try_recv().is_err());
            form.goal.update(cx, |t, cx| {
                t.set_value(format!("  {}  ", "😀".repeat(2000)), w, cx)
            });
            form.confirm(w, cx);
        });
    })
    .unwrap();
    let WriteCommand::Mission {
        action: Command::Submit { request, .. },
        ..
    } = commands.try_recv().unwrap()
    else {
        panic!("one trimmed boundary request")
    };
    assert_eq!(request.title, "😀".repeat(100));
    assert_eq!(request.goal, "😀".repeat(2000));
    assert!(request.validate().is_ok());
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn known_201_is_source_attempt_qualified_retained_closed_and_not_replaced_by_inspection(
    cx: &mut TestAppContext,
) {
    let (handle, form, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        form.update(cx, |form, cx| {
            let request = form.captured(cx).unwrap();
            let mut book = (**form.book.as_ref().unwrap()).clone();
            book.missions.insert(
                target().source,
                crate::mission_conversion::Attempt {
                    id: "known-attempt".into(),
                    request,
                    outcome: Outcome::Unknown,
                },
            );
            let mut receipts = std::collections::BTreeMap::new();
            receipts.insert(
                target().source,
                crate::mission_conversion::Receipt {
                    attempt_id: "wrong-attempt".into(),
                    project_id: target().project,
                    mission_id: "mission-known".into(),
                },
            );
            form.close(w, cx);
            let mut state = WriteState {
                book: Some(Arc::new(book)),
                mission_receipts: Arc::new(receipts),
                error: Some("Private receipt write failed"),
                ..Default::default()
            };
            form.accept(&state, w, cx);
            assert!(
                form.created_id().is_none(),
                "different attempt cannot lend its receipt"
            );
            Arc::make_mut(&mut state.mission_receipts)
                .get_mut(&target().source)
                .unwrap()
                .attempt_id = "known-attempt".into();
            form.accept(&state, w, cx); // Accepts 201 evidence even with sheet CLOSED.
            assert_eq!(form.created_id(), Some("mission-known"));
            form.open(target(), "Reopened", w, cx);
            assert_eq!(form.created_id(), Some("mission-known"));
            assert!(!form.editable());
            form.confirm(w, cx);
            assert!(
                commands.try_recv().is_err(),
                "faulted receipt access queues no operation"
            );
            form.result = Some(Ok(Inspection::Membership { mission_id: None }));
            assert_eq!(
                form.created_id(),
                Some("mission-known"),
                "GET is not the receipt"
            );
            let mut other = target();
            other.source = "another-source".into();
            form.open(other, "Other source", w, cx);
            assert!(form.created_id().is_none());
            form.open(target(), "Retained", w, cx);
            assert_eq!(form.created_id(), Some("mission-known"));
            assert!(commands.try_recv().is_err());
        });
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        w.click("mission-copy-id", cx);
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().as_deref(),
            Some("mission-known")
        );
    })
    .unwrap();
}
