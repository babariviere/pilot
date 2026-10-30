use super::*;

#[gpui_kit::test]
fn update_checkpoint_empty_composer_retains_unknown_without_replaying(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    let root = std::env::temp_dir().join(format!("empty-update-{}", uuid::Uuid::new_v4()));
    let mut store = Store::open(root.clone(), book().host.clone()).unwrap();
    store
        .prepare(
            "chat:earlier",
            &Draft {
                revision: 1,
                text: "earlier synthetic send".into(),
                ..Default::default()
            },
            false,
            false,
        )
        .unwrap();
    store.book.drafts.clear();
    let retained = serde_json::to_vec(&store.book.pending).unwrap();
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.accept(
                WriteState {
                    book: Some(std::sync::Arc::new(store.book.clone())),
                    ..Default::default()
                },
                w,
                cx,
            );
            assert!(e.text.read(cx).value().is_empty());
            assert!(e.state.book.as_ref().unwrap().drafts.is_empty());
            assert!(
                !e.state.book.as_ref().unwrap().restart_settled(),
                "old daemon checkpoint falsely refused a zero-draft app"
            );
            assert!(e.begin_gui_update_checkpoint(42, w, cx));
            assert_eq!(e.update_receipt(w, cx), None);
            let mut flushed = (**e.state.book.as_ref().unwrap()).clone();
            flushed.drafts = e.cache.clone();
            e.state.book = Some(std::sync::Arc::new(flushed));
            e.state.checkpoint = Some(42);
            assert_eq!(e.update_receipt(w, cx), Some(42));
            assert_eq!(
                serde_json::to_vec(&e.state.book.as_ref().unwrap().pending).unwrap(),
                retained
            );
            e.end_update_checkpoint(cx);
        })
    })
    .unwrap();
    while let Ok(command) = commands.try_recv() {
        assert!(
            matches!(command, WriteCommand::Checkpoint(42)),
            "checkpoint never checks or executes a retained delivery"
        );
    }
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[gpui_kit::test]
fn update_checkpoint_keeps_draft_and_requires_exact_fresh_ack(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, cx| {
            editor.text.update(cx, |input, cx| {
                input.set_value("Retain 👩‍💻 e\u{301}", window, cx)
            });
            assert!(editor.begin_update_checkpoint(7, window, cx));
            assert_eq!(editor.update_receipt(window, cx), None);
            let mut book = (**editor.state.book.as_ref().unwrap()).clone();
            book.drafts = editor.cache.clone();
            editor.state.book = Some(std::sync::Arc::new(book));
            editor.state.checkpoint = Some(6);
            assert_eq!(editor.update_receipt(window, cx), None);
            editor.state.checkpoint = Some(7);
            assert_eq!(editor.update_receipt(window, cx), Some(7));
            editor.text.update(cx, |input, cx| {
                input.set_value("Newer native text", window, cx)
            });
            assert_eq!(editor.update_receipt(window, cx), None);
            editor.end_update_checkpoint(cx);
            assert_eq!(editor.text.read(cx).value().as_ref(), "Newer native text");
            assert_eq!(editor.cache["chat:a"].text, "Retain 👩‍💻 e\u{301}");
        });
    })
    .unwrap();
    let mut checkpoint = false;
    while let Ok(command) = commands.try_recv() {
        checkpoint |= matches!(command, WriteCommand::Checkpoint(7));
    }
    assert!(checkpoint);
}

#[gpui_kit::test]
fn update_checkpoint_refuses_unknown_delivery_and_native_preedit(cx: &mut TestAppContext) {
    use gpui_kit::{ElementInputHandler, test::TestInput};
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, cx| {
            for state in ["pending", "unknown"] {
                let mut book = (**editor.state.book.as_ref().unwrap()).clone();
                book.drafts.insert(
                    "chat:other".into(),
                    Draft {
                        last: Some(crate::delivery_store::Delivery {
                            id: "unconfirmed".into(),
                            state: state.into(),
                            target: "a".into(),
                            kind: "message".into(),
                            revision: 1,
                            diagnostic: None,
                            answer: None,
                        }),
                        ..Default::default()
                    },
                );
                editor.state.book = Some(std::sync::Arc::new(book));
                assert!(!editor.begin_update_checkpoint(8, window, cx));
                assert!(
                    !editor.begin_gui_update_checkpoint(8, window, cx),
                    "orphan summaries are not retained immutable intents"
                );
            }
            editor.state.book = Some(book());
        });
        window.render_frame(cx);
        let handler = ElementInputHandler::new(
            window.find_by_label("Message to Pilot").bounds(),
            view.read(cx).text.clone(),
        );
        TestInput::new(handler, window).compose_text(None, "にほん", Some(3..3), cx);
        view.update(cx, |editor, cx| {
            assert!(editor.marked(window, cx));
            let before = editor.text.read(cx).value().to_string();
            assert!(!editor.begin_update_checkpoint(9, window, cx));
            assert!(!editor.begin_gui_update_checkpoint(9, window, cx));
            assert!(editor.marked(window, cx));
            assert_eq!(editor.text.read(cx).value().as_ref(), before);
        });
    })
    .unwrap();
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn update_checkpoint_retains_only_saved_unknown_and_still_needs_fresh_ack(cx: &mut TestAppContext) {
    use crate::delivery_store::{
        Delivery,
        diagnostic::{Acknowledgment, Category, Diagnostic, Stage},
    };
    let (handle, view, commands) = setup(cx);
    let root = std::env::temp_dir().join(format!("editor-checkpoint-{}", uuid::Uuid::new_v4()));
    let mut store = Store::open(root.clone(), book().host.clone()).unwrap();
    let intent = store
        .prepare(
            "chat:a",
            &Draft {
                revision: 1,
                text: "Retain 日本語 👩‍💻".into(),
                ..Default::default()
            },
            false,
            false,
        )
        .unwrap();
    let saved = std::sync::Arc::new(store.book.clone());
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.accept(
                WriteState {
                    book: Some(saved.clone()),
                    ..Default::default()
                },
                w,
                cx,
            );
            assert!(
                !e.begin_update_checkpoint(11, w, cx),
                "daemon upgrade remains strict"
            );
            e.pending.insert("chat:a".into(), 1);
            assert!(
                !e.begin_gui_update_checkpoint(11, w, cx),
                "in-flight request"
            );
            e.pending.clear();
            e.unsaved_local.insert("chat:a".into());
            assert!(!e.begin_gui_update_checkpoint(11, w, cx), "unsaved text");
            e.unsaved_local.clear();
            e.state.error = Some("Private state durability is unconfirmed.");
            assert!(!e.begin_gui_update_checkpoint(11, w, cx));
            e.state.error = None;
            let mut report = crate::interaction::DeliveryReport {
                key: "chat:a".into(),
                delivery: Delivery::from_intent(&intent),
                saved: false,
                save_error: Some(Category::PrivateCapacity),
            };
            report.delivery.diagnostic = Some(Diagnostic {
                stage: Stage::Adoption,
                category: Category::PrivateCapacity,
                status: Some(200),
                acknowledgment: Acknowledgment::Accepted,
            });
            e.state
                .delivery_reports
                .insert(intent.id.clone(), report.clone());
            assert!(
                !e.begin_gui_update_checkpoint(11, w, cx),
                "a volatile ACK must not be lost even without a store fault"
            );
            e.state.delivery_reports.clear();
            let mut pending = (*saved).clone();
            pending.pending.get_mut(&intent.id).unwrap().state = "pending".into();
            e.state.book = Some(std::sync::Arc::new(pending));
            assert!(
                !e.begin_gui_update_checkpoint(11, w, cx),
                "daemon-pending delivery"
            );
            e.state.book = Some(saved.clone());
            assert!(e.begin_gui_update_checkpoint(11, w, cx));
            assert_eq!(e.update_receipt(w, cx), None);
            let mut flushed = (*saved).clone();
            flushed.drafts = e.cache.clone();
            assert!(flushed.pending[&intent.id] == intent);
            e.state.book = Some(std::sync::Arc::new(flushed));
            e.state.checkpoint = Some(10);
            assert_eq!(e.update_receipt(w, cx), None);
            e.state.checkpoint = Some(11);
            assert_eq!(e.update_receipt(w, cx), Some(11));
            e.state.delivery_reports.insert(intent.id.clone(), report);
            assert_eq!(
                e.update_receipt(w, cx),
                None,
                "late volatile ACK invalidates readiness"
            );
            e.state.delivery_reports.clear();
            assert_eq!(e.update_receipt(w, cx), Some(11));
            e.text
                .update(cx, |i, cx| i.set_value("Newer unsaved text", w, cx));
            assert_eq!(e.update_receipt(w, cx), None);
            e.end_update_checkpoint(cx);
            assert!(e.state.book.as_ref().unwrap().pending[&intent.id] == intent);
        })
    })
    .unwrap();
    let recorded: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok()).collect();
    assert_eq!(recorded.len(), 1);
    assert!(
        matches!(recorded[0], WriteCommand::Checkpoint(11)),
        "no lookup, execute, retirement or replay"
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[gpui_kit::test]
fn question_discard_guard_refuses_live_or_saved_reply_without_capture(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    let q = question_composer_fixture(4);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.text
                .update(cx, |s, cx| s.set_value("ordinary retained", w, cx));
            e.changed(cx);
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(q.clone()),
                true,
                w,
                cx,
            );
            e.questions.input.update(cx, |s, cx| {
                s.set_value("last native reply character 日本語", w, cx)
            });
            let revision = e.cache["chat:a"].revision;
            assert!(
                e.cache["chat:a"].answer.is_none(),
                "Programmatic set_value emits no Change"
            );
            e.discard_draft(w, cx);
            assert_eq!(e.selected.as_deref(), Some("chat:a"));
            assert_eq!(e.cache["chat:a"].revision, revision);
            assert!(
                e.cache["chat:a"].answer.is_none(),
                "Ordinary discard cannot capture/rekey question input"
            );
            assert_eq!(
                e.questions.input.read(cx).value().as_ref(),
                "last native reply character 日本語"
            );
            assert_eq!(e.cache["chat:a"].text, "ordinary retained");
            e.changed(cx);
            let answer = e.cache["chat:a"].answer.clone();
            e.questions.input.update(cx, |s, cx| s.set_value("", w, cx));
            e.discard_draft(w, cx);
            assert_eq!(e.selected.as_deref(), Some("chat:a"));
            assert!(e.cache["chat:a"].answer == answer);
        });
    })
    .unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
}
#[gpui_kit::test]
fn question_discard_guard_preserves_preedit_and_stale_adoption_scope(cx: &mut TestAppContext) {
    use gpui_kit::{ElementInputHandler, test::TestInput};
    let (handle, view, commands) = setup(cx);
    let q = question_composer_fixture(4);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(q.clone()),
                true,
                w,
                cx,
            );
            e.focus(w, cx);
        });
        w.render_frame(cx);
        let handler = ElementInputHandler::new(
            w.find_by_label("Your question reply").bounds(),
            view.read(cx).questions.input.clone(),
        );
        TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
        view.update(cx, |e, cx| {
            let revision = e.cache["chat:a"].revision;
            e.discard_draft(w, cx);
            assert!(e.question_marked(w, cx));
            assert_eq!(e.selected.as_deref(), Some("chat:a"));
            assert_eq!(e.cache["chat:a"].revision, revision);
            assert!(e.cache["chat:a"].answer.is_none());
            e.question_context(
                Some("b"),
                crate::question::Projection::Pending(question_composer_fixture(8)),
                true,
                w,
                cx,
            );
            e.discard_draft(w, cx);
            assert_eq!(e.selected.as_deref(), Some("chat:a"));
            assert_eq!(e.questions.current.as_ref().unwrap().identity, q.identity);
            assert!(!e.cache.contains_key("chat:b"));
            assert!(e.question_marked(w, cx));
        });
    })
    .unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn question_composer_single_group_arrows_and_enter_select_without_sending(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    let q=std::sync::Arc::new(crate::question::Question::parse(4,&serde_json::json!({"question":"Choose one","options":[{"label":"One"},{"label":"Two"}]})).unwrap());
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(q.clone()),
                true,
                w,
                cx,
            );
            e.focus(w, cx);
        });
        w.render_frame(cx);
        w.press("shift-tab", cx);
        w.render_frame(cx);
        assert_eq!(
            w.find(format!("question-choices-4-{}", q.identity.fingerprint))
                .focused(),
            Some(true)
        );
        w.press("down", cx);
        w.render_frame(cx);
        w.press("down", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        let draft = &view.read(cx).cache["chat:a"];
        assert_eq!(draft.answer.as_ref().unwrap().selected, BTreeSet::from([1]));
        let revision = draft.revision;
        w.render_frame(cx);
        w.press("enter", cx);
        assert_eq!(
            view.read(cx).cache["chat:a"].revision,
            revision,
            "Activation of the selected radio is not a new edit"
        );
        view.update(cx, |e, cx| e.permission(false, false, cx));
        w.press("up", cx);
        assert_eq!(
            view.read(cx).cache["chat:a"]
                .answer
                .as_ref()
                .unwrap()
                .selected,
            BTreeSet::from([1])
        );
    })
    .unwrap();
    cx.run_until_parked();
    assert!(
        commands.try_recv().is_err(),
        "Arrows and group Enter never confirm delivery"
    );
}

fn question_composer_fixture(id: u64) -> std::sync::Arc<crate::question::Question> {
    std::sync::Arc::new(crate::question::Question::parse(id,&serde_json::json!({"question":"Which checks should run?","context":"Choose explicitly. Your existing message stays separate.","options":[{"label":"Typecheck","detail":"Check shared types","suggested":true},{"label":"Tests"}],"multiSelect":true})).unwrap())
}
#[gpui_kit::test]
fn question_retry_carries_only_the_exact_fresh_awaited_question(cx: &mut TestAppContext) {
    use crate::question::{AnswerDraft, Projection, Question};
    let (handle, view, commands) = setup(cx);
    let awaited = |entry| {
        std::sync::Arc::new(Question::parse(entry, &serde_json::json!({"question":"Which checks should run?","options":[{"label":"Tests"}],"blocking":true})).unwrap())
    };
    let (first, second) = (awaited(4), awaited(8));
    let identity = AnswerDraft::capture(&first, 1, BTreeSet::from([0]), String::new())
        .unwrap()
        .identity;
    let retry_answers = |command: WriteCommand| match command {
        WriteCommand::RetryAnswer { id, question } => {
            assert_eq!(id, "lost");
            Some(question.identity.clone())
        }
        WriteCommand::Check { id, retry: true } => {
            assert_eq!(id, "lost");
            None
        }
        _ => panic!("Send again is only an explicit retry of the same intent"),
    };
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            let mut book = (**e.state.book.as_ref().unwrap()).clone();
            book.pending.insert(
                "lost".into(),
                crate::delivery_store::Intent {
                    id: "lost".into(),
                    key: "chat:a".into(),
                    revision: 1,
                    target: "a".into(),
                    operation: None,
                    state: "unknown".into(),
                    diagnostic: None,
                    answer: Some(identity.clone()),
                },
            );
            e.state.book = Some(std::sync::Arc::new(book));
            e.question_context(Some("a"), Projection::Pending(first.clone()), true, w, cx);
            assert_eq!(
                retry_answers(e.retry_command("lost")),
                Some(first.identity.clone()),
                "The same awaited ask still projects"
            );
            // A lost first answer cannot become the reply to a newer ask.
            e.question_context(Some("a"), Projection::Pending(second.clone()), true, w, cx);
            assert_eq!(retry_answers(e.retry_command("lost")), None);
            e.question_context(Some("a"), Projection::Pending(first.clone()), false, w, cx);
            assert_eq!(retry_answers(e.retry_command("lost")), None, "Stale source");
            e.question_context(Some("a"), Projection::Unavailable, true, w, cx);
            assert_eq!(retry_answers(e.retry_command("lost")), None);
        });
    })
    .unwrap();
    cx.run_until_parked();
    while let Ok(command) = commands.try_recv() {
        assert!(
            !matches!(
                command,
                WriteCommand::Answer { .. }
                    | WriteCommand::Check { .. }
                    | WriteCommand::RetryAnswer { .. }
            ),
            "Projection changes never send or retry"
        );
    }
}
#[gpui_kit::test]
fn question_hint_focus_is_exact_and_never_submits(cx: &mut TestAppContext) {
    use crate::question::Projection;
    use gpui_kit::Focusable;
    let (handle, view, commands) = setup(cx);
    let first = question_composer_fixture(4);
    let second = question_composer_fixture(8);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.question_context(Some("a"), Projection::Pending(first.clone()), true, w, cx);
            let original = e.cache["chat:a"].text.clone();
            e.view_question(&first.identity, w, cx);
            assert!(e.questions.input.read(cx).focus_handle(cx).is_focused(w));
            assert_eq!(e.cache["chat:a"].text, original);
            e.text.update(cx, |s, cx| s.focus(w, cx));
            e.question_context(Some("a"), Projection::Pending(second.clone()), true, w, cx);
            e.text.update(cx, |s, cx| s.focus(w, cx));
            e.view_question(&first.identity, w, cx);
            assert!(
                e.text.read(cx).focus_handle(cx).is_focused(w),
                "Old action cannot focus a newer question"
            );
            e.question_context(Some("a"), Projection::Pending(second.clone()), false, w, cx);
            e.view_question(&second.identity, w, cx);
            assert!(!e.question_needs_you(), "Reconnect hides current reason");
            e.question_context(Some("b"), Projection::Pending(first.clone()), true, w, cx);
            e.view_question(&first.identity, w, cx);
            assert!(!e.question_needs_you(), "Other chat cannot supply a hint");
            e.question_context(Some("a"), Projection::None, true, w, cx);
            assert!(!e.question_needs_you(), "Resolved hint disappears");
        });
    })
    .unwrap();
    cx.run_until_parked();
    while let Ok(command) = commands.try_recv() {
        assert!(
            !matches!(
                command,
                WriteCommand::Answer { .. }
                    | WriteCommand::Check { .. }
                    | WriteCommand::RetryAnswer { .. }
            ),
            "Viewing a question is navigation only"
        );
    }
}
#[gpui_kit::test]
fn question_composer_choice_then_explicit_reply_preserves_ordinary(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup_width(cx, 680.);
    let q = question_composer_fixture(4);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.text
                .update(cx, |s, cx| s.set_value("ordinary draft 👩‍💻", w, cx));
            e.changed(cx);
            e.permission(true, false, cx);
            let draft = e.cache.get_mut("chat:a").unwrap();
            draft.settled_revision = Some(draft.revision);
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(q.clone()),
                true,
                w,
                cx,
            );
        });
        w.render_frame(cx);
        w.click(format!("question-4-{}-0", q.identity.fingerprint), cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(
        commands.try_recv().is_err(),
        "Choosing an option is not confirmation"
    );
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| e.focus(w, cx));
        w.input("own words 日本語", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        assert_eq!(view.read(cx).cache["chat:a"].text, "ordinary draft 👩‍💻");
        assert_eq!(
            view.read(cx).cache["chat:a"]
                .answer
                .as_ref()
                .unwrap()
                .labels,
            &["Typecheck"]
        );
        w.render_frame(cx);
        let draft = &view.read(cx).cache["chat:a"];
        assert!(
            draft
                .settled_revision
                .is_some_and(|revision| revision >= draft.revision),
            "Question edits cannot unlock settled ordinary input"
        );
        w.click("answer-question", cx);
    })
    .unwrap();
    cx.run_until_parked();
    match commands.try_recv().unwrap() {
        WriteCommand::Answer {
            key,
            draft,
            question,
            ..
        } => {
            assert_eq!(key, "chat:a");
            assert_eq!(question.identity, q.identity);
            assert_eq!(draft.text, "ordinary draft 👩‍💻");
            assert_eq!(
                draft
                    .answer
                    .as_ref()
                    .unwrap()
                    .reply(&question)
                    .unwrap()
                    .as_deref(),
                Some("Typecheck\n\nown words 日本語")
            );
        }
        _ => panic!("Expected typed question reply command"),
    }
    assert!(commands.try_recv().is_err());
}
#[gpui_kit::test]
fn question_composer_preedit_defers_new_identity_without_erasing_either_draft(
    cx: &mut TestAppContext,
) {
    use gpui_kit::{ElementInputHandler, test::TestInput};
    let (handle, view, commands) = setup_width(cx, 680.);
    let q = question_composer_fixture(4);
    let next = question_composer_fixture(8);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.text.update(cx, |s, cx| s.set_value("ordinary", w, cx));
            e.changed(cx);
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(q.clone()),
                true,
                w,
                cx,
            );
        });
        w.render_frame(cx);
        let handler = ElementInputHandler::new(
            w.find_by_label("Your question reply").bounds(),
            view.read(cx).questions.input.clone(),
        );
        TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
        view.update(cx, |e, cx| {
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(next.clone()),
                true,
                w,
                cx,
            );
            assert_eq!(e.questions.current.as_ref().unwrap().identity, q.identity);
            assert!(!e.capture_navigation(w, cx));
            e.answer_question(None, w, cx);
        });
        w.press("enter", cx);
        w.render_frame(cx);
        w.click("answer-question", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.questions.input.update(cx, |s, cx| s.unmark_text(w, cx))
        });
        w.render_frame(cx);
        w.click("show-current-question", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        let e = view.read(cx);
        assert_eq!(
            e.questions.current.as_ref().unwrap().identity,
            next.identity
        );
        assert_eq!(e.cache["chat:a"].text, "ordinary");
        assert_eq!(
            e.cache["chat:a"].answer.as_ref().unwrap().identity.question,
            q.identity
        );
        assert_eq!(e.cache["chat:a"].answer.as_ref().unwrap().text, "にほん");
        w.render_frame(cx);
        w.click("keep-question-reply", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(
        matches!(
            commands.try_recv().unwrap(),
            WriteCommand::RetireAnswer { recover: true, .. }
        ),
        "Only a private recovery request, never an answer"
    );
}
#[gpui_kit::test]
fn question_composer_readonly_stale_source_and_access_never_answer(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    let q = question_composer_fixture(4);
    cx.update_window(handle,|_,w,cx| {
        view.update(cx,|e,cx| {
            e.question_context(Some("a"),crate::question::Projection::Pending(q.clone()),true,w,cx);
            e.questions.input.update(cx,|s,cx|s.set_value("reply",w,cx));e.changed(cx);
            e.permission(false,false,cx);e.answer_question(None,w,cx);
            e.permission(true,false,cx);e.question_context(Some("a"),crate::question::Projection::Pending(q.clone()),false,w,cx);e.answer_question(None,w,cx);
            e.question_context(Some("b"),crate::question::Projection::Pending(q.clone()),true,w,cx);e.answer_question(None,w,cx);
            let access=std::sync::Arc::new(crate::question::Question::parse(12,&serde_json::json!({"question":"Allow database access?","databaseAccess":{"requestId":"grant-1"}})).unwrap());
            e.question_context(Some("a"),crate::question::Projection::Pending(access),true,w,cx);e.answer_question(None,w,cx);
        });
        w.render_frame(cx);assert!(w.try_find("answer-question").is_none());
        assert!(w.try_find("view-pending-question").is_none(), "Unsupported access has no fabricated target");
    }).unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn delivery_diagnostic_stays_with_exact_owner_after_autosave_navigation_and_legacy_restore(
    cx: &mut TestAppContext,
) {
    use crate::delivery_store::{
        Delivery,
        diagnostic::{Acknowledgment, Category, Diagnostic, Stage},
    };
    let (handle, view, commands) = setup_width(cx, 680.);
    let path =
        std::env::temp_dir().join(format!("delivery-detail-editor-{}", uuid::Uuid::new_v4()));
    let mut store = Store::open(path.clone(), book().host.clone()).unwrap();
    let intent = store
        .prepare(
            "chat:a",
            &Draft {
                revision: 1,
                text: "retained native text 👩‍💻".into(),
                ..Default::default()
            },
            false,
            false,
        )
        .unwrap();
    let mut delivery = Delivery::from_intent(&intent);
    delivery.diagnostic = Some(Diagnostic {
        stage: Stage::Lookup,
        category: Category::Refused,
        status: Some(503),
        acknowledgment: Acknowledgment::Unknown,
    });
    store.record_diagnostic("chat:a", &delivery).unwrap();
    let mut state = WriteState {
        book: Some(std::sync::Arc::new(store.book.clone())),
        notice: "Draft saved.",
        ..Default::default()
    };
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.accept(state.clone(), w, cx);
            let detail = e.delivery_detail("chat:a", &e.cache["chat:a"]).unwrap();
            assert!(detail.1.contains("Receipt check · HTTP 503"));
            e.select("chat:b".into(), true, false, w, cx);
            assert!(e.delivery_detail("chat:b", &Draft::default()).is_none());
            e.select("chat:a".into(), true, false, w, cx);
            assert!(
                e.delivery_detail("chat:a", &e.cache["chat:a"])
                    .unwrap()
                    .1
                    .contains("HTTP 503")
            );
            let mut wrong = delivery.clone();
            wrong.target = "other".into();
            state.delivery_reports.insert(
                intent.id.clone(),
                crate::interaction::DeliveryReport {
                    key: "chat:a".into(),
                    delivery: wrong,
                    saved: false,
                    save_error: Some(Category::PrivateWrite),
                },
            );
            e.accept(state.clone(), w, cx);
            assert!(
                !e.delivery_detail("chat:a", &e.cache["chat:a"])
                    .unwrap()
                    .1
                    .contains("not saved")
            );
        })
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("delivery-diagnostic").is_none());
        assert_eq!(
            w.find("delivery-recovery-status").label(),
            Some("Couldn't confirm this message was sent."),
            "A refused lookup knows nothing about Local's answer"
        );
        w.click("composer-recovery", cx);
        w.render_frame(cx);
        assert!(w.try_find("delivery-diagnostic").is_some());
    })
    .unwrap();
    // A known Local answer with a failed private save is not an unconfirmed send.
    for (acknowledgment, label) in [
        (
            Acknowledgment::Accepted,
            "Sent. Pilot couldn't save the receipt.",
        ),
        (
            Acknowledgment::Pending,
            "Sending. Pilot couldn't save the receipt.",
        ),
        (
            Acknowledgment::Rejected,
            "Not sent. Pilot couldn't save the receipt.",
        ),
    ] {
        let mut known = delivery.clone();
        known.diagnostic = Some(Diagnostic {
            stage: Stage::Adoption,
            category: Category::PrivateWrite,
            status: Some(200),
            acknowledgment,
        });
        state.delivery_reports.insert(
            intent.id.clone(),
            crate::interaction::DeliveryReport {
                key: "chat:a".into(),
                delivery: known,
                saved: false,
                save_error: Some(Category::PrivateWrite),
            },
        );
        cx.update_window(handle, |_, w, cx| {
            w.press("escape", cx);
            view.update(cx, |e, cx| e.accept(state.clone(), w, cx));
            w.render_frame(cx);
            assert_eq!(w.find("delivery-recovery-status").label(), Some(label));
            assert_eq!(
                view.read(cx).state.book.as_ref().unwrap().pending[&intent.id].state,
                "unknown"
            );
        })
        .unwrap();
    }
    assert!(
        commands.try_recv().is_err(),
        "Rendering/navigation must not Check/execute/retry"
    );
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

use crate::{
    delivery_store::{Host, Store},
    interaction::WriteState,
};
use gpui_kit::{
    Bounds, TestAppContext, WindowBounds, WindowOptions, px, size,
    test::{TestQueryExt, TestWindowExt},
};

fn book() -> std::sync::Arc<crate::delivery_store::Book> {
    let root = std::env::temp_dir().join(format!("editor-test-{}", uuid::Uuid::new_v4()));
    let store = Store::open(
        root.clone(),
        Host {
            host_id: "local".into(),
            daemon_id: "test-daemon".into(),
            lineage_id: "test-lineage".into(),
        },
    )
    .unwrap();
    let book = std::sync::Arc::new(store.book.clone());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    book
}
pub(super) fn setup(
    cx: &mut TestAppContext,
) -> (
    gpui_kit::AnyWindowHandle,
    Entity<ChatEditor>,
    async_channel::Receiver<WriteCommand>,
) {
    setup_width(cx, 960.)
}
fn setup_width(
    cx: &mut TestAppContext,
    width: f32,
) -> (
    gpui_kit::AnyWindowHandle,
    Entity<ChatEditor>,
    async_channel::Receiver<WriteCommand>,
) {
    let (client, commands) = Interaction::recording();
    let book = book();
    cx.update(gpui_kit::init);
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(500.)),
                ))),
                show: false,
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    let mut editor = ChatEditor::new(Some(client), window, cx);
                    editor.accept(
                        WriteState {
                            book: Some(book),
                            ..Default::default()
                        },
                        window,
                        cx,
                    );
                    editor.select("chat:a".into(), true, true, window, cx);
                    editor.focus(window, cx);
                    editor
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    (handle, view, commands)
}

#[gpui_kit::test]
fn discarding_a_draft_copies_its_text_queues_the_discard_and_clears_the_row(
    cx: &mut TestAppContext,
) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, cx| {
            editor.cache.insert(
                "new:slot".into(),
                Draft {
                    revision: 3,
                    text: "undelivered message".into(),
                    cwd: "/synthetic".into(),
                    pending: Some("intent-a".into()),
                    ..Default::default()
                },
            );
            editor.select("new:slot".into(), true, false, window, cx);
        });
        window.render_frame(cx);
        assert!(window.try_find("discard-draft").is_none());
        window.click("composer-recovery", cx);
        window.render_frame(cx);
        assert_eq!(
            window.find_all("discard-draft").len(),
            1,
            "an undelivered new-chat draft can be discarded"
        );
        window.click("discard-draft", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Discard { key, revision } if key == "new:slot" && revision == 3
    ));
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, _| {
            assert!(!editor.cache.contains_key("new:slot"));
            assert!(editor.selected.is_none());
            assert!(editor.error.is_none());
        });
        window.render_frame(cx);
    })
    .unwrap();
}

#[gpui_kit::test]
fn creation_adoption_requires_current_empty_revision_after_live_capture(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, cx| {
            editor.cache.insert(
                "new:slot".into(),
                Draft {
                    revision: 7,
                    cwd: "/synthetic".into(),
                    created: Some("created".into()),
                    ..Default::default()
                },
            );
            editor.select("new:slot".into(), true, false, window, cx);
            assert!(editor.can_adopt_creation("new:slot", 7, "created", window, cx));
            assert!(!editor.can_adopt_creation("new:other", 7, "created", window, cx));
            assert!(!editor.can_adopt_creation("new:slot", 6, "created", window, cx));
            assert!(!editor.can_adopt_creation("new:slot", 7, "different", window, cx));
            editor.text.update(cx, |input, cx| {
                input.set_value("Newer native draft 👩‍💻", window, cx)
            });
            assert!(!editor.can_adopt_creation("new:slot", 7, "created", window, cx));
            assert_eq!(editor.cache["new:slot"].text, "Newer native draft 👩‍💻");
            assert_eq!(editor.cache["new:slot"].revision, 8);
            editor.select("chat:a".into(), true, false, window, cx);
            assert!(!editor.can_adopt_creation("new:slot", 8, "created", window, cx));
        })
    })
    .unwrap();
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn compact_composer_keeps_controls_inside_and_text_live(cx: &mut TestAppContext) {
    for width in [320., 472., 760.] {
        let (handle, view, commands) = setup_width(cx, width);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let tray = window.find("composer-tray").bounds();
            let input = window.find("composer-input").bounds();
            let controls = window.find("composer-controls").bounds();
            let stop = window.find("local-stop").bounds();
            let send = window.find("local-send").bounds();
            assert!(
                tray.size.height <= px(88.),
                "compact single-line tray: {tray:?}"
            );
            assert!(
                input.size.height <= px(44.),
                "no doubled text padding: {input:?}"
            );
            assert_eq!(
                input.bottom(),
                controls.top(),
                "no extra gap between field and controls"
            );
            assert!(window.find("activity-indicator").bounds().bottom() < tray.top());
            for rect in [input, controls, stop, send] {
                assert!(
                    rect.left() >= tray.left() && rect.right() <= tray.right(),
                    "width {width}: {rect:?} outside {tray:?}"
                );
                assert!(rect.top() >= tray.top() && rect.bottom() <= tray.bottom());
            }
            assert_eq!(stop.center().y, send.center().y, "one compact control row");
            window.input("Draft 👩‍💻 e\u{301} stays live", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.changed(cx);
                assert_eq!(
                    view.text.read(cx).value().as_ref(),
                    "Draft 👩‍💻 e\u{301} stays live"
                );
                assert_eq!(view.cache["chat:a"].text, "Draft 👩‍💻 e\u{301} stays live");
                assert!(view.cache["chat:a"].revision > 0);
            });
            view.update(cx, |view, cx| {
                view.text.update(cx, |text, cx| {
                    text.set_value("A long draft 👩‍💻 e\u{301}\n".repeat(40), window, cx)
                });
            });
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let tray = window.find("composer-tray").bounds();
            let input = window.find("composer-input").bounds();
            let controls = window.find("composer-controls").bounds();
            assert!(
                input.size.height > px(80.) && input.size.height <= px(160.),
                "existing six-line growth cap: {input:?}"
            );
            assert!(tray.size.height <= px(210.));
            assert_eq!(input.bottom(), controls.top());
            assert!(controls.bottom() <= tray.bottom());
            view.update(cx, |view, cx| {
                view.changed(cx);
                assert_eq!(
                    view.cache["chat:a"].text,
                    "A long draft 👩‍💻 e\u{301}\n".repeat(40)
                );
            });
            window.remove_window();
        })
        .unwrap();
        while let Ok(command) = commands.try_recv() {
            assert!(
                !matches!(command, WriteCommand::Submit { .. }),
                "layout/typing must never submit"
            );
        }
        cx.run_until_parked();
    }
}

#[gpui_kit::test]
fn compaction_reuses_transient_status_preserves_stop_and_question(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, cx| {
            editor.permission(true, false, cx);
            editor.activity(true, cx);
            editor.set_compacting(true, cx);
        });
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), Some("Preparing context…"));
        assert_eq!(window.find_all("activity-indicator").len(), 1);
        assert!(
            window.find_all("local-stop").is_empty(),
            "idle manual compaction does not invent run admission"
        );
        view.update(cx, |editor, cx| editor.permission(true, true, cx));
        window.render_frame(cx);
        window.click("local-stop", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Submit { stop: true, .. }
    ));
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |editor, cx| {
            editor.question_context(
                Some("a"),
                crate::question::Projection::Pending(question_composer_fixture(4)),
                true,
                window,
                cx,
            );
            assert_eq!(editor.activity_label(), Some("Needs you"));
            editor.question_context(
                Some("a"),
                crate::question::Projection::None,
                true,
                window,
                cx,
            );
            editor.set_compacting(false, cx);
            editor.permission(true, false, cx);
            editor.activity(false, cx);
            assert_eq!(editor.activity_label(), None);
            editor.set_compacting(true, cx);
            editor.select("chat:b".into(), true, false, window, cx);
            assert_eq!(
                editor.activity_label(),
                None,
                "navigation clears compaction"
            );
        });
    })
    .unwrap();
}

#[gpui_kit::test]
fn thinking_reuses_one_indicator_and_stop_fences_late_presentations(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.activity(true, cx));
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), Some("Thinking..."));
        assert_eq!(window.find_all("activity-indicator").len(), 1);
        window.click("local-stop", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Submit { stop: true, .. }
    ));
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.activity(true, cx));
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), Some("Working..."));
        assert_eq!(window.find_all("activity-indicator").len(), 1);
        view.update(cx, |view, cx| {
            view.activity(false, cx);
            view.permission(true, false, cx);
        });
        window.render_frame(cx);
        assert_eq!(view.read(cx).activity_label(), None);
        assert!(window.find_all("activity-indicator").is_empty());
        view.update(cx, |view, cx| {
            view.activity(true, cx);
            view.select("chat:b".into(), true, false, window, cx);
        });
        assert_eq!(
            view.read(cx).activity_label(),
            None,
            "navigation clears activity"
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn double_enter_and_pointer_send_capture_latest_value_once(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("last character 日本語", cx);
        window.press("enter", cx);
        window.press("enter", cx);
        window.click("local-send", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let command = commands.try_recv().unwrap();
    match command {
        WriteCommand::Submit {
            key, draft, stop, ..
        } => {
            assert_eq!(key, "chat:a");
            assert_eq!(draft.text, "last character 日本語");
            assert!(!stop);
        }
        _ => panic!("expected one submit"),
    }
    assert!(commands.try_recv().is_err());
    cx.update(|cx| assert_eq!(view.read(cx).cache["chat:a"].text, "last character 日本語"));
}

#[gpui_kit::test]
fn fast_navigation_captures_pending_changes_and_never_retargets_a_send(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("draft A", cx);
        view.update(cx, |view, cx| {
            view.select("chat:b".into(), true, true, window, cx)
        });
        window.input("draft B", cx);
        view.update(cx, |view, cx| view.submit(false, window, cx));
        view.update(cx, |view, cx| {
            view.select("chat:a".into(), true, true, window, cx)
        });
        assert_eq!(view.read(cx).text.read(cx).value().as_ref(), "draft A");
        assert_eq!(view.read(cx).cache["chat:b"].text, "draft B");
    })
    .unwrap();
    cx.run_until_parked();
    match commands.try_recv().unwrap() {
        WriteCommand::Submit { key, draft, .. } => {
            assert_eq!(key, "chat:b");
            assert_eq!(draft.text, "draft B");
        }
        _ => panic!("expected submit"),
    }
}

#[gpui_kit::test]
fn readonly_and_marked_text_cannot_send_from_keyboard_or_pointer(cx: &mut TestAppContext) {
    use gpui_kit::{ElementInputHandler, test::TestInput};
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("prefix ", cx);
        let handler = ElementInputHandler::new(
            window.find_by_label("Message to Pilot").bounds(),
            view.read(cx).text.clone(),
        );
        let mut input = TestInput::new(handler, window);
        input.compose_text(None, "にほん", Some(3..3), cx);
        window.press("enter", cx);
        window.press("shift-enter", cx);
        window.click("local-send", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.select("chat:retained".into(), false, true, window, cx)
        });
        view.update(cx, |view, cx| {
            view.text
                .update(cx, |text, cx| text.set_value("cannot send", window, cx));
            view.submit(false, window, cx);
        });
    })
    .unwrap();
    assert!(commands.try_recv().is_err());
}

#[gpui_kit::test]
fn accepted_ack_cannot_clear_native_text_before_its_change_callback(cx: &mut TestAppContext) {
    let (handle, view, _) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.input("new text before ack", cx);
        let mut saved = (*book()).clone();
        saved.drafts.insert(
            "chat:a".into(),
            Draft {
                revision: 0,
                text: String::new(),
                ..Default::default()
            },
        );
        view.update(cx, |view, cx| {
            view.accept(
                WriteState {
                    book: Some(std::sync::Arc::new(saved)),
                    ..Default::default()
                },
                window,
                cx,
            )
        });
        assert_eq!(
            view.read(cx).text.read(cx).value().as_ref(),
            "new text before ack"
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn first_new_draft_keeps_its_revision_before_the_first_autosave_ack(cx: &mut TestAppContext) {
    let (handle, view, _) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.new_draft("/tmp".into(), window, cx));
        let key = view.read(cx).selected.clone().unwrap();
        assert_eq!(view.read(cx).cache[&key].revision, 1);
        assert_eq!(view.read(cx).cache[&key].cwd, "/tmp");
        view.update(cx, |view, cx| {
            view.text
                .update(cx, |text, cx| text.set_value("first edit", window, cx))
        });
        view.update(cx, |view, cx| view.changed(cx));
        assert_eq!(view.read(cx).cache[&key].revision, 2);
        view.update(cx, |view, cx| {
            view.select("chat:a".into(), true, false, window, cx)
        });
        assert_eq!(view.read(cx).cache[&key].text, "first edit");
    })
    .unwrap();
}

#[gpui_kit::test]
fn browsing_empty_chats_and_repeated_blank_new_chat_do_not_exhaust_drafts(cx: &mut TestAppContext) {
    let (handle, view, _) = setup(cx);
    cx.update_window(handle, |_, window, cx| {
        for n in 0..512 {
            view.update(cx, |view, cx| {
                view.select(format!("chat:synthetic-{n}"), true, false, window, cx)
            });
        }
        assert!(view.read(cx).cache.len() < 3);
        for _ in 0..256 {
            view.update(cx, |view, cx| view.new_draft(String::new(), window, cx));
        }
        assert!(view.read(cx).cache.len() < 3);
    })
    .unwrap();
}

/// Drives the exact reply admission against a real private store and returns
/// the store after the given receipt outcome, with the captured reply identity.
fn question_reply_outcome(
    cx: &mut TestAppContext,
    handle: gpui_kit::AnyWindowHandle,
    view: &Entity<ChatEditor>,
    commands: &async_channel::Receiver<WriteCommand>,
    state: &str,
) -> (Store, std::path::PathBuf, crate::question::ReplyIdentity) {
    let q = question_composer_fixture(4);
    let root = std::env::temp_dir().join(format!("answer-recovery-{}", uuid::Uuid::new_v4()));
    let mut store = Store::open(root.clone(), book().host.clone()).unwrap();
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.text.update(cx, |s, cx| {
                s.set_value("unrelated ordinary draft 👩‍💻", w, cx)
            });
            e.changed(cx);
            e.permission(true, false, cx);
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(q.clone()),
                true,
                w,
                cx,
            );
            e.questions
                .input
                .update(cx, |s, cx| s.set_value("my exact reply 日本語", w, cx));
            e.changed(cx);
        });
        w.render_frame(cx);
        w.click("answer-question", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let (draft, request) = match commands.try_recv().unwrap() {
        WriteCommand::Answer { draft, request, .. } => (draft, request),
        _ => panic!("Expected the explicit reply"),
    };
    let identity = draft.answer.as_ref().unwrap().identity.clone();
    let intent = store
        .prepare_answer("chat:a", &draft, &q, draft.answer.as_ref().unwrap())
        .unwrap();
    // Unknown: the receipt never arrived, so the intent stays pending.
    if state != "unknown" {
        store.finish(&intent.id, state, None).unwrap();
    }
    let book = std::sync::Arc::new(store.book.clone());
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.accept(
                WriteState {
                    book: Some(book),
                    handled: BTreeMap::from([("chat:a".into(), request)]),
                    ..Default::default()
                },
                w,
                cx,
            )
        });
        w.render_frame(cx);
    })
    .unwrap();
    cx.run_until_parked();
    (store, root, identity)
}

#[gpui_kit::test]
fn accepted_question_reply_retires_without_recovery_and_keeps_ordinary_draft(
    cx: &mut TestAppContext,
) {
    let (handle, view, commands) = setup_width(cx, 680.);
    let (mut store, root, identity) =
        question_reply_outcome(cx, handle, &view, &commands, "accepted");
    assert!(
        commands.try_recv().is_err(),
        "The same question is still shown; nothing retires yet"
    );
    // The agent run starts: the projection is unavailable, then empty, never fresh.
    for (projection, fresh) in [
        (crate::question::Projection::Unavailable, false),
        (crate::question::Projection::None, false),
    ] {
        cx.update_window(handle, |_, w, cx| {
            view.update(cx, |e, cx| {
                e.question_context(Some("a"), projection, fresh, w, cx)
            });
            w.render_frame(cx);
            assert!(
                w.try_find("keep-question-reply").is_none(),
                "An accepted reply is not offered as recovery"
            );
        })
        .unwrap();
    }
    cx.run_until_parked();
    let (revision, recover) = match commands.try_recv().unwrap() {
        WriteCommand::RetireAnswer {
            key,
            revision,
            identity: retired,
            recover,
        } => {
            assert_eq!(key, "chat:a");
            assert_eq!(retired, identity, "Exact acknowledged identity");
            (revision, recover)
        }
        _ => panic!("Expected private settlement of the accepted reply"),
    };
    assert!(!recover, "An accepted reply never enters recovery");
    assert!(commands.try_recv().is_err(), "Retired once, nothing sent");
    store
        .retire_answer("chat:a", revision, &identity, recover)
        .unwrap();
    let saved = &store.book.drafts["chat:a"];
    assert!(saved.recovered.is_empty());
    assert!(saved.answer.is_none());
    assert_eq!(saved.text, "unrelated ordinary draft 👩‍💻");
    let book = std::sync::Arc::new(store.book.clone());
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.accept(
                WriteState {
                    book: Some(book),
                    ..Default::default()
                },
                w,
                cx,
            )
        });
        w.render_frame(cx);
        assert!(w.try_find("composer-recovery").is_none());
        assert!(w.try_find("keep-question-reply").is_none());
        let e = view.read(cx);
        assert_eq!(
            e.text.read(cx).value().as_ref(),
            "unrelated ordinary draft 👩‍💻"
        );
        assert!(e.cache["chat:a"].recovered.is_empty());
    })
    .unwrap();
    cx.run_until_parked();
    assert!(commands.try_recv().is_err());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[gpui_kit::test]
fn accepted_question_reply_never_blocks_the_next_question(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup_width(cx, 680.);
    let (store, root, identity) = question_reply_outcome(cx, handle, &view, &commands, "accepted");
    let next = question_composer_fixture(8);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| {
            e.question_context(
                Some("a"),
                crate::question::Projection::Pending(next.clone()),
                true,
                w,
                cx,
            )
        });
        w.render_frame(cx);
        assert!(w.try_find("keep-question-reply").is_none());
        assert_eq!(view.read(cx).questions.input.read(cx).value().as_ref(), "");
        view.update(cx, |e, cx| {
            e.questions
                .input
                .update(cx, |s, cx| s.set_value("next words", w, cx));
            e.changed(cx);
        });
        let answer = view.read(cx).cache["chat:a"].answer.clone().unwrap();
        assert_eq!(
            answer.identity.question, next.identity,
            "The next question is answerable"
        );
        assert_eq!(answer.text, "next words");
        assert!(view.read(cx).cache["chat:a"].recovered.is_empty());
    })
    .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::RetireAnswer { recover: false, identity: retired, .. } if retired == identity
    ));
    assert!(commands.try_recv().is_err(), "Nothing is sent");
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[gpui_kit::test]
fn rejected_or_unknown_question_reply_keeps_its_evidence(cx: &mut TestAppContext) {
    for state in ["rejected", "unknown"] {
        let (handle, view, commands) = setup_width(cx, 680.);
        let (store, root, _) = question_reply_outcome(cx, handle, &view, &commands, state);
        let next = question_composer_fixture(8);
        cx.update_window(handle, |_, w, cx| {
            view.update(cx, |e, cx| {
                e.question_context(Some("a"), crate::question::Projection::None, true, w, cx);
                e.question_context(
                    Some("a"),
                    crate::question::Projection::Pending(next.clone()),
                    true,
                    w,
                    cx,
                )
            });
            w.render_frame(cx);
            assert!(
                w.try_find("keep-question-reply").is_some(),
                "{state}: an unconfirmed reply stays explicitly recoverable"
            );
            let saved = &view.read(cx).cache["chat:a"];
            assert_eq!(saved.answer.as_ref().unwrap().text, "my exact reply 日本語");
            assert!(
                saved.recovered.is_empty(),
                "{state}: nothing moved automatically"
            );
        })
        .unwrap();
        cx.run_until_parked();
        assert!(
            commands.try_recv().is_err(),
            "{state}: never retired or resent automatically"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
