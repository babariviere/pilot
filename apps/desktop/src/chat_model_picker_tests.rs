use super::*;
use crate::chat_models_fixture::{Mode, Server};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AnyWindowHandle, TestAppContext};
fn setup(
    cx: &mut TestAppContext,
) -> (
    Server,
    AnyWindowHandle,
    Entity<ChatEditor>,
    async_channel::Receiver<WriteCommand>,
) {
    let server = Server::start(Mode::Accept);
    let (h, e, commands) = crate::chat_editor::tests::setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.browse_empty(w, cx);
            e.enable_models(server.options.clone(), w, cx);
            e.models.as_mut().unwrap().reader = Some(Reader::recording());
            e.select("chat:source".into(), true, false, w, cx);
            e.model_context(
                "source",
                "/synthetic/project",
                SessionModel::read(&server.seen.lock().unwrap().session()),
                w,
                cx,
            );
            let m = e.models.as_ref().unwrap();
            let p = m.picker.as_ref().unwrap();
            let update = Update {
                id: m.request,
                scope: p.scope.clone(),
                result: Ok((
                    serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap(),
                    Some(SessionModel::read(&server.seen.lock().unwrap().session())),
                )),
            };
            e.accept_models(update, w, cx);
        })
    })
    .unwrap();
    cx.run_until_parked();
    cx.update(|cx| assert!(e.read(cx).can_choose_model()));
    (server, h, e, commands)
}
fn source(e: &ChatEditor) -> (Scope, String) {
    let p = e.models.as_ref().unwrap().picker.as_ref().unwrap();
    (p.scope.clone(), p.epoch.clone())
}

#[gpui_kit::test]
fn failed_picker_captures_exact_preference_source_without_touching_message(
    cx: &mut TestAppContext,
) {
    let (server, h, e, commands) = setup(cx);
    server.seen.lock().unwrap().mode = Mode::FailedPassive;
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text.update(cx, |t, cx| {
                t.set_value("Keep failed draft 日本語 👩‍💻", w, cx);
                t.focus(w, cx);
            });
            let before = e.text.read(cx).value();
            let selection = e.text.read(cx).selected_range();
            let summary = server.seen.lock().unwrap().session();
            let expected = SessionModel::read(&summary).failed_source.unwrap();
            e.model_context(
                "source",
                "/synthetic/project",
                SessionModel::read(&summary),
                w,
                cx,
            );
            assert!(e.can_choose_model());
            assert!(e.has_model_notice());
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            let WriteCommand::Model {
                action: chat_models::Action::Submit(attempt),
                ..
            } = commands.try_recv().unwrap()
            else {
                panic!("one explicit preference");
            };
            assert_eq!(attempt.target.failed_source, Some(expected));
            assert_eq!(
                attempt.choice,
                ModelChoice {
                    model: "p/b".into(),
                    thinking: None
                }
            );
            assert_eq!(attempt.target.model.as_deref(), Some("p/a"));
            assert_eq!(e.text.read(cx).value(), before);
            assert_eq!(e.text.read(cx).selected_range(), selection);
            assert!(commands.is_empty());
        });
    })
    .unwrap();
}
#[gpui_kit::test]
fn parked_and_failure_transitions_rebuild_readonly_catalog_without_touching_draft(
    cx: &mut TestAppContext,
) {
    let (server, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text.update(cx, |t, cx| {
                t.set_value("Keep main draft 日本語 👩‍💻", w, cx);
                t.focus(w, cx);
            });
            e.changed(cx);
        });
        w.press("secondary-a", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            let selection = e.text.read(cx).selected_range();
            let draft = e.draft().unwrap().clone();
            let mut summary = server.seen.lock().unwrap().session();
            for (state, can_change, reason) in [
                ("parked", true, ""),
                ("failed", false, "failure"),
                ("parked", true, ""),
                ("idle", true, ""),
                ("working", false, "work and queued"),
                ("unknown", false, "not known"),
            ] {
                summary["state"] = serde_json::json!(state);
                e.model_context(
                    "source",
                    "/synthetic/project",
                    SessionModel::read(&summary),
                    w,
                    cx,
                );
                assert_eq!(e.can_choose_model(), can_change, "{state}");
                if !can_change {
                    assert!(e.model_restriction().unwrap().contains(reason));
                    assert!(e.has_model_notice());
                    let p = e.models.as_ref().unwrap().picker.as_ref().unwrap();
                    assert!(!p.synced.as_ref().unwrap().2);
                    let (scope, epoch) = source(e);
                    e.choose_model(&scope, &epoch, "p/b", None, w, cx);
                }
                assert_eq!(e.text.read(cx).selected_range(), selection);
                assert_eq!(
                    e.text.read(cx).value().as_ref(),
                    "Keep main draft 日本語 👩‍💻"
                );
                assert!(e.draft().unwrap() == &draft);
                assert_eq!(e.model_choice().unwrap().model, "p/a");
                assert!(commands.is_empty());
            }
            summary["state"] = serde_json::json!("parked");
            e.model_context(
                "source",
                "/synthetic/project",
                SessionModel::read(&summary),
                w,
                cx,
            );
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            assert!(matches!(
                commands.try_recv().unwrap(),
                WriteCommand::Model {
                    action: chat_models::Action::Submit(_),
                    ..
                }
            ));
            assert!(commands.is_empty());
        })
    })
    .unwrap();
}
#[gpui_kit::test]
fn empty_scoped_catalog_is_visible_without_substitution_or_actions(cx: &mut TestAppContext) {
    let (_server, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            let before = e.model_choice();
            let (scope, _) = source(e);
            e.accept_models(
                Update {
                    id: e.models.as_ref().unwrap().request,
                    scope,
                    result: Ok((
                        Catalog {
                            models: vec![],
                            default_model: None,
                        },
                        None,
                    )),
                },
                w,
                cx,
            );
            assert!(e.model_catalog_empty() && e.has_model_notice());
            assert_eq!(e.model_choice(), before);
            assert!(commands.is_empty());
        })
    })
    .unwrap();
}
#[gpui_kit::test]
fn checked_model_is_noop_new_model_omits_old_thinking_and_old_widget_cannot_change_new_model(
    cx: &mut TestAppContext,
) {
    let (_s, h, e, commands) = setup(cx);
    let old = cx
        .update_window(h, |_, w, cx| {
            e.update(cx, |e, cx| {
                let (scope, epoch) = source(e);
                let old = e
                    .models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .thinking
                    .clone();
                e.choose_model(&scope, &epoch, "p/a", None, w, cx);
                assert!(commands.is_empty());
                e.choose_model(&scope, &epoch, "p/b", None, w, cx);
                let WriteCommand::Model {
                    action: chat_models::Action::Submit(a),
                    request,
                    ..
                } = commands.try_recv().unwrap()
                else {
                    panic!("one explicit model command")
                };
                assert!(a.choice.thinking.is_none());
                assert_eq!(a.choice.model, "p/b");
                assert_eq!(a.target.model.as_deref(), Some("p/a"));
                e.state.model = Some(chat_models::Reply {
                    session: "source".into(),
                    request,
                    outcome: chat_models::Outcome::Acknowledged(SessionModel {
                        failed_source: None,
                        model: Some("p/b".into()),
                        thinking: Some("low".into()),
                        updated_at: 2,
                        allowed: true,
                        blocked: None,
                        ..Default::default()
                    }),
                });
                e.accept_model_action(w, cx);
                assert_ne!(
                    e.models.as_ref().unwrap().picker.as_ref().unwrap().epoch,
                    epoch
                );
                old
            })
        })
        .unwrap();
    cx.run_until_parked();
    old.update(cx, |_, cx| {
        cx.emit(SelectEvent::Confirm(Some("high".into())))
    });
    cx.run_until_parked();
    assert!(commands.is_empty());
    cx.update(|cx| {
        assert_eq!(
            e.read(cx).model_choice().unwrap().thinking.as_deref(),
            Some("low")
        )
    });
}
#[gpui_kit::test]
fn busy_readonly_queued_failed_paused_private_pending_and_preedit_refuse_model_commands(
    cx: &mut TestAppContext,
) {
    let (_s, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            let (scope, epoch) = source(e);
            e.busy = true;
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            e.busy = false;
            e.writable = false;
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            e.writable = true;
            e.pending.insert(scope.key.clone(), 1);
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            e.pending.clear();
            e.models
                .as_mut()
                .unwrap()
                .current
                .as_mut()
                .unwrap()
                .2
                .allowed = false;
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            e.models
                .as_mut()
                .unwrap()
                .current
                .as_mut()
                .unwrap()
                .2
                .allowed = true;
            e.text.update(cx, |t, cx| {
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
            });
            let revision = e.draft().unwrap().revision;
            let text = e.text.read(cx).value();
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            e.refresh_models(w, cx);
            assert_eq!(e.draft().unwrap().revision, revision);
            assert_eq!(e.text.read(cx).value(), text);
            assert!(e.marked(w, cx));
            assert!(commands.is_empty());
        })
    })
    .unwrap();
}
#[gpui_kit::test]
fn same_id_different_draft_and_delayed_catalog_cannot_retarget_choices_or_native_query(
    cx: &mut TestAppContext,
) {
    let (_s, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            let (scope, epoch) = source(e);
            let request = e.models.as_ref().unwrap().request;
            e.browse_empty(w, cx);
            e.accept_models(
                Update {
                    id: request,
                    scope: scope.clone(),
                    result: Ok((
                        serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap(),
                        None,
                    )),
                },
                w,
                cx,
            );
            assert!(e.models.as_ref().unwrap().picker.is_none());
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            assert!(commands.is_empty());
        })
    })
    .unwrap();
}
#[gpui_kit::test]
fn model_query_preedit_defers_catalog_then_explicit_dismiss_adopts_without_resetting_message(
    cx: &mut TestAppContext,
) {
    let (_s, h, e, _) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text
                .update(cx, |t, cx| t.set_value("Unsent 日本語 👩‍💻", w, cx));
            let p = e.models.as_ref().unwrap().picker.as_ref().unwrap();
            let scope = p.scope.clone();
            let q = p.models.read(cx).query_input(cx);
            let old = p.catalog.clone().unwrap();
            q.update(cx, |q, cx| {
                q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
            });
            let value = q.read(cx).value();
            e.accept_models(
                Update {
                    id: e.models.as_ref().unwrap().request,
                    scope,
                    result: Ok((
                        serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap(),
                        None,
                    )),
                },
                w,
                cx,
            );
            assert!(Arc::ptr_eq(
                &e.models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .catalog
                    .clone()
                    .unwrap(),
                &old
            ));
            assert_eq!(q.read(cx).value(), value);
            assert!(
                e.models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .deferred
                    .is_some()
            );
            q.update(cx, |q, cx| {
                q.unmark_text(w, cx);
                q.set_value("", w, cx);
            });
            e.finish_model_query(w, cx);
            assert!(
                e.models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .deferred
                    .is_none()
            );
            assert_eq!(e.text.read(cx).value().as_ref(), "Unsent 日本語 👩‍💻");
        })
    })
    .unwrap();
}
#[gpui_kit::test]
fn new_draft_model_is_bound_to_project_preserves_text_and_pending_cannot_retarget(
    cx: &mut TestAppContext,
) {
    let (_s, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.projects(
                Arc::new(vec![crate::local_model::Project {
                    id: "project-a".into(),
                    name: "A".into(),
                    path: "/synthetic/project".into(),
                }]),
                true,
                None,
                w,
                cx,
            );
            e.cache.insert(
                "new:choice".into(),
                Draft {
                    project_id: Some("project-a".into()),
                    cwd: "/synthetic/project".into(),
                    text: "Retain this draft 日本語".into(),
                    ..Default::default()
                },
            );
            e.select("new:choice".into(), true, false, w, cx);
            let c: Catalog = serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap();
            let (scope, _) = source(e);
            e.accept_models(
                Update {
                    id: e.models.as_ref().unwrap().request,
                    scope,
                    result: Ok((c, None)),
                },
                w,
                cx,
            );
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "p/b", Some(&"high".into()), w, cx);
            assert_eq!(
                e.draft()
                    .unwrap()
                    .model_choice
                    .as_ref()
                    .unwrap()
                    .choice
                    .thinking
                    .as_deref(),
                Some("high")
            );
            assert_eq!(e.text.read(cx).value().as_ref(), "Retain this draft 日本語");
            e.cache.get_mut("new:choice").unwrap().pending = Some("old-intent".into());
            let saved = e.draft().unwrap().clone();
            e.choose_model(&scope, &epoch, "q/c", None, w, cx);
            assert!(e.draft().unwrap() == &saved);
            assert!(
                commands.try_recv().is_err(),
                "local choices do not queue a chat/model operation"
            );
        })
    })
    .unwrap();
}
