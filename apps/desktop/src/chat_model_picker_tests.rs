use super::*;
use crate::chat_models_fixture::{Mode, Server};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AnyWindowHandle, TestAppContext};

#[test]
fn thinking_titles_do_not_change_catalog_values() {
    for (value, title) in [
        ("off", "Off"),
        ("minimal", "Minimal"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Xhigh"),
        ("", ""),
    ] {
        assert_eq!(thinking_title(value), title);
    }
}
#[test]
fn selectors_lead_with_resolved_values_and_never_guess() {
    let c: Catalog = serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap();
    let choice = |model: &str, thinking: Option<&str>| ModelChoice {
        model: model.into(),
        thinking: thinking.map(Into::into),
    };
    let text = |s: Shown| (s.model, s.model_help, s.thinking, s.thinking_help);
    let fresh = |choice: Option<&ModelChoice>, project: Option<&str>| {
        text(shown(Some(&c), false, choice, Some(project), Start::Fresh))
    };
    // A fresh Build draft: pilotd's resolved pick and its startup level.
    assert_eq!(
        fresh(None, None),
        (
            "Atlas 日本語".into(),
            Some("Pi default · p/a".into()),
            "Low".into(),
            Some("Pi default".into())
        )
    );
    // The Pilot project model overrides pi's pick; a non-thinking model's level is known.
    assert_eq!(
        fresh(None, Some("q/c")),
        (
            "Boreal 日本語".into(),
            Some("Project default · q/c".into()),
            "Off".into(),
            Some("The model's only level".into())
        )
    );
    // Explicit model, inherited thinking: each operation's own reported level.
    let b = choice("p/b", None);
    assert_eq!(fresh(Some(&b), None).2, "High");
    assert_eq!(
        text(shown(Some(&c), false, Some(&b), None, Start::Switch)),
        (
            "p/b".into(),
            None,
            "Low".into(),
            Some("Scope default".into())
        )
    );
    assert_eq!(
        text(shown(
            Some(&c),
            false,
            Some(&choice("p/a", None)),
            None,
            Start::Switch
        ))
        .3,
        Some("Keeps the chat's current level".into())
    );
    // Explicit thinking is shown as chosen, without provenance.
    assert_eq!(
        fresh(Some(&choice("p/a", Some("high"))), None),
        ("p/a".into(), None, "High".into(), None)
    );
    assert_eq!(
        fresh(Some(&choice("p/a", Some("max"))), None).2,
        "Max (not in catalog)"
    );
    assert_eq!(
        fresh(Some(&choice("q/d", None)), None).2,
        "Thinking not reported"
    );
    // An unlisted or missing default stays unresolved, never the first model or a level.
    let outside = fresh(None, Some("z/gone"));
    assert_eq!(outside.0, "Default model");
    assert!(outside.1.unwrap().contains("z/gone"));
    assert_eq!(outside.2, "Default");
    let mut bare = c.clone();
    (bare.default_model, bare.resolved_default_model) = (None, None);
    assert_eq!(
        text(shown(Some(&bare), false, None, Some(None), Start::Fresh))
            .1
            .as_deref(),
        Some("Chosen when the chat starts")
    );
    // Resolution doesn't describe other chats (Ask drafts, restored chats).
    let other = text(shown(Some(&c), false, None, None, Start::Other));
    assert_eq!(
        (other.0.as_str(), other.1.as_deref(), other.2.as_str()),
        (
            "Default model",
            Some("Chosen when the chat starts"),
            "Default"
        )
    );
    // An older daemon: the configured default in scope, but no reported level.
    let mut old = c.clone();
    old.resolved_default_model = None;
    for m in &mut old.models {
        (m.fresh_thinking, m.switch_thinking) = (None, None);
    }
    assert_eq!(
        text(shown(Some(&old), false, None, Some(None), Start::Fresh)),
        (
            "Atlas 日本語".into(),
            Some("Pi default · p/a".into()),
            "Default".into(),
            Some("Pi's setting for this model".into())
        )
    );
    // Loading and unavailable are said as such, not resolved.
    assert_eq!(
        text(shown(None, true, None, Some(Some("p/a")), Start::Fresh)).0,
        "Loading models…"
    );
    assert_eq!(
        text(shown(None, false, None, Some(None), Start::Fresh)).0,
        "Models unavailable"
    );
    let retained = text(shown(
        None,
        false,
        Some(&choice("p/a", Some("high"))),
        None,
        Start::Other,
    ));
    assert_eq!((retained.0.as_str(), retained.2.as_str()), ("p/a", "High"));
}
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
fn slash_model_opens_the_model_menu_without_sending(cx: &mut TestAppContext) {
    let (_server, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| e.focus(w, cx));
        let input = e.read(cx).text.clone();
        input.update(cx, |i, cx| i.replace_text_in_range(None, "/mo", w, cx));
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        assert_eq!(e.read(cx).slash_probe().unwrap().0, ["model"]);
        w.render_frame(cx);
        w.press("enter", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        assert!(
            w.try_find("model-option-p/a").is_some(),
            "model menu is open"
        );
        assert_eq!(e.read(cx).text.read(cx).value().as_ref(), "");
    })
    .unwrap();
    while let Ok(command) = commands.try_recv() {
        assert!(
            !matches!(
                command,
                WriteCommand::Submit { .. } | WriteCommand::Model { .. }
            ),
            "opening the menu sends nothing"
        );
    }
}

#[gpui_kit::test]
fn scope_change_revalidates_retained_reader_and_preserves_draft(cx: &mut TestAppContext) {
    let (_, h, e, _) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text
                .update(cx, |t, cx| t.set_value("retained draft", w, cx));
            let request = e.models.as_ref().unwrap().request;
            e.invalidate_models(w, cx);
            let m = e.models.as_ref().unwrap();
            assert!(m.request > request);
            assert!(m.picker.as_ref().unwrap().loading);
            let pending = m.reader.as_ref().unwrap().pending().unwrap();
            assert_eq!(pending.catalog_generation, 1);
            assert_eq!(pending.id, m.request);
            assert_eq!(e.text.read(cx).value(), "retained draft");
        });
    })
    .unwrap();
}
fn shown_values(cx: &mut TestAppContext, h: AnyWindowHandle) -> (String, String) {
    cx.run_until_parked();
    cx.update_window(h, |_, w, _| {
        let model = w.find("chat-model").value().unwrap_or_default().to_owned();
        let thinking = w
            .find("chat-thinking")
            .value()
            .unwrap_or_default()
            .to_owned();
        (model, thinking)
    })
    .unwrap()
}
#[gpui_kit::test]
fn new_draft_shows_resolved_default_and_follows_project_model_without_saving(
    cx: &mut TestAppContext,
) {
    let (_s, h, e, commands) = setup(cx);
    let project = |model: Option<&str>| {
        Arc::new(vec![crate::local_model::Project {
            id: "project-a".into(),
            name: "A".into(),
            path: "/synthetic/project".into(),
            model: model.map(Into::into),
            ..Default::default()
        }])
    };
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.projects(project(Some("q/c")), true, None, w, cx);
            e.cache.insert(
                "new:resolved".into(),
                Draft {
                    project_id: Some("project-a".into()),
                    cwd: "/synthetic/project".into(),
                    text: "Keep 日本語".into(),
                    mode: "build".into(),
                    ..Default::default()
                },
            );
            e.select("new:resolved".into(), true, false, w, cx);
            // Loading is said as such until this scope's catalog arrives.
            assert!(e.models.as_ref().unwrap().picker.as_ref().unwrap().loading);
        })
    })
    .unwrap();
    assert_eq!(shown_values(cx, h).0, "Loading models…");
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            let (scope, _) = source(e);
            let c: Catalog = serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap();
            e.accept_models(
                Update {
                    id: e.models.as_ref().unwrap().request,
                    scope,
                    result: Ok((c, None)),
                },
                w,
                cx,
            );
        })
    })
    .unwrap();
    // The project's non-thinking model, and its only level, lead.
    assert_eq!(shown_values(cx, h), ("Boreal 日本語".into(), "Off".into()));
    // A project model change follows without a write; pi's default then applies.
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| e.projects(project(None), true, None, w, cx))
    })
    .unwrap();
    // pilotd's resolved pick and its reported startup level.
    assert_eq!(shown_values(cx, h), ("Atlas 日本語".into(), "Low".into()));
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            assert!(
                e.draft().unwrap().model_choice.is_none(),
                "inheritance kept"
            );
            // An explicit model, then the default again: the choice returns to null.
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            assert_eq!(e.model_choice().unwrap().model, "p/b");
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "", None, w, cx);
            assert!(e.draft().unwrap().model_choice.is_none());
            assert_eq!(e.text.read(cx).value().as_ref(), "Keep 日本語");
        })
    })
    .unwrap();
    assert_eq!(shown_values(cx, h).0, "Atlas 日本語");
    assert!(commands.is_empty(), "displaying a default never writes");
}
#[gpui_kit::test]
fn unstarted_chat_is_not_resolved_and_shows_its_reported_model_after(cx: &mut TestAppContext) {
    let (server, h, e, commands) = setup(cx);
    let reported = SessionModel::read(&server.seen.lock().unwrap().session());
    let unstarted = SessionModel {
        model: None,
        thinking: None,
        ..reported.clone()
    };
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.model_context("source", "/synthetic/project", unstarted, w, cx)
        })
    })
    .unwrap();
    // Resolution describes fresh Build drafts, not existing chats.
    assert_eq!(
        shown_values(cx, h),
        ("Default model".into(), "Default".into())
    );
    // The chat's reported model and effective level replace the default.
    let started = SessionModel {
        model: Some("p/b".into()),
        thinking: Some("high".into()),
        updated_at: reported.updated_at + 1,
        ..reported
    };
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.model_context("source", "/synthetic/project", started, w, cx)
        })
    })
    .unwrap();
    assert_eq!(shown_values(cx, h), ("Boreal 日本語".into(), "High".into()));
    assert!(commands.is_empty());
}

#[gpui_kit::test]
fn reconnect_during_composer_preedit_starts_replacement_read_and_fences_old_result(
    cx: &mut TestAppContext,
) {
    let (_, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text.update(cx, |t, cx| {
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
            });
            let text = e.text.read(cx).value();
            let choice = e.model_choice();
            let (scope, _) = source(e);
            let request = e.models.as_ref().unwrap().request;
            e.invalidate_models(w, cx);
            let m = e.models.as_ref().unwrap();
            let p = m.picker.as_ref().unwrap();
            assert!(
                m.request > request,
                "reconnect must not lose its read during IME"
            );
            assert!(p.loading && p.catalog.is_some());
            e.accept_models(
                Update {
                    id: request,
                    scope,
                    result: Err("obsolete read"),
                },
                w,
                cx,
            );
            assert!(
                e.models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .error
                    .is_none()
            );
            assert_eq!(e.model_choice(), choice);
            assert_eq!(e.text.read(cx).value(), text);
            assert!(e.marked(w, cx));
            assert!(commands.is_empty());
        });
    })
    .unwrap();
}

#[gpui_kit::test]
fn live_model_metadata_during_loading_keeps_one_read_and_last_success(cx: &mut TestAppContext) {
    let (_, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.load_models(false, w, cx);
            let m = e.models.as_ref().unwrap();
            let request = m.request;
            assert_eq!(m.reader.as_ref().unwrap().pending().unwrap().id, request);
            let mut current = m.current.as_ref().unwrap().2.clone();
            current.model = Some("p/b".into());
            current.thinking = Some("low".into());
            current.updated_at += 1;
            e.model_context("source", "/synthetic/project", current, w, cx);
            let m = e.models.as_ref().unwrap();
            let p = m.picker.as_ref().unwrap();
            assert_eq!(
                m.request, request,
                "metadata must not cancel/reissue an active read"
            );
            assert!(p.catalog.is_some() && p.loading);
            assert!(m.reader.as_ref().unwrap().pending().is_none());
            assert_eq!(e.model_choice().unwrap().thinking.as_deref(), Some("low"));
            // A catalog result may complete after fresher per-chat metadata.
            let old = SessionModel {
                model: Some("p/a".into()),
                thinking: Some("high".into()),
                updated_at: 1,
                ..Default::default()
            };
            e.accept_models(
                Update {
                    id: request,
                    scope: p.scope.clone(),
                    result: Ok((
                        serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap(),
                        Some(old),
                    )),
                },
                w,
                cx,
            );
            assert_eq!(e.model_choice().unwrap().model, "p/b");
            assert_eq!(e.model_choice().unwrap().thinking.as_deref(), Some("low"));
            assert!(commands.is_empty());
        });
    })
    .unwrap();
}

#[gpui_kit::test]
fn failed_refresh_retains_matching_catalog_but_not_authority_and_chat_switch_recovers(
    cx: &mut TestAppContext,
) {
    let (_, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text
                .update(cx, |t, cx| t.set_value("A draft 日本語", w, cx));
            let a_current = e
                .models
                .as_ref()
                .unwrap()
                .current
                .as_ref()
                .unwrap()
                .2
                .clone();
            let catalog = e
                .models
                .as_ref()
                .unwrap()
                .picker
                .as_ref()
                .unwrap()
                .catalog
                .clone()
                .unwrap();
            let (a_scope, a_epoch) = source(e);
            e.load_models(true, w, cx);
            let a_request = e.models.as_ref().unwrap().request;
            e.accept_models(
                Update {
                    id: a_request,
                    scope: a_scope.clone(),
                    result: Err("Scoped models unavailable for this Local directory."),
                },
                w,
                cx,
            );
            assert_eq!(
                e.models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .catalog
                    .as_deref(),
                Some(catalog.as_ref())
            );
            assert!(!e.can_choose_model());
            e.choose_model(&a_scope, &a_epoch, "p/b", None, w, cx);
            assert!(commands.is_empty());

            e.select("chat:b".into(), true, false, w, cx);
            let mut b_current = a_current.clone();
            b_current.model = Some("p/b".into());
            b_current.thinking = Some("low".into());
            e.model_context("b", "/synthetic/other", b_current.clone(), w, cx);
            let (b_scope, b_epoch) = source(e);
            let b_request = e.models.as_ref().unwrap().request;
            e.accept_models(
                Update {
                    id: b_request,
                    scope: b_scope.clone(),
                    result: Ok((catalog.as_ref().clone(), Some(b_current))),
                },
                w,
                cx,
            );
            e.text.update(cx, |t, cx| t.set_value("B draft 👩‍💻", w, cx));
            assert_eq!(e.model_choice().unwrap().thinking.as_deref(), Some("low"));

            e.select("chat:source".into(), true, false, w, cx);
            e.model_context("source", "/synthetic/project", a_current.clone(), w, cx);
            let a_request = e.models.as_ref().unwrap().request;
            assert!(e.models.as_ref().unwrap().picker.as_ref().unwrap().loading);
            e.accept_models(
                Update {
                    id: a_request,
                    scope: a_scope.clone(),
                    result: Ok((catalog.as_ref().clone(), Some(a_current))),
                },
                w,
                cx,
            );
            assert!(e.can_choose_model());
            assert_eq!(e.text.read(cx).value().as_ref(), "A draft 日本語");
            assert_eq!(e.cache["chat:b"].text, "B draft 👩‍💻");
            assert_eq!(e.model_choice().unwrap().model, "p/a");
            assert_eq!(e.model_choice().unwrap().thinking.as_deref(), Some("high"));
            e.accept_models(
                Update {
                    id: b_request,
                    scope: b_scope.clone(),
                    result: Err("stale B error"),
                },
                w,
                cx,
            );
            e.choose_model(&b_scope, &b_epoch, "q/c", None, w, cx);
            e.choose_model(&a_scope, &a_epoch, "q/c", None, w, cx);
            assert!(
                e.models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .error
                    .is_none()
            );
            while let Ok(command) = commands.try_recv() {
                assert!(!matches!(command, WriteCommand::Model { .. }));
            }
        });
    })
    .unwrap();
}

#[gpui_kit::test]
fn stale_catalog_success_and_error_do_not_replace_current_picker(cx: &mut TestAppContext) {
    let (_, h, e, _) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            e.text
                .update(cx, |t, cx| t.set_value("unsent draft", w, cx));
            let m = e.models.as_ref().unwrap();
            let id = m.request;
            let p = m.picker.as_ref().unwrap();
            let scope = p.scope.clone();
            let catalog = p.catalog.clone();
            assert!(id > 0);
            for result in [
                Err("stale error"),
                Ok((
                    serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap(),
                    None,
                )),
            ] {
                e.accept_models(
                    Update {
                        id: id - 1,
                        scope: scope.clone(),
                        result,
                    },
                    w,
                    cx,
                );
            }
            e.sync_models(w, cx);
            let m = e.models.as_ref().unwrap();
            let p = m.picker.as_ref().unwrap();
            assert_eq!(
                m.request, id,
                "same-chat synchronization must not request again"
            );
            assert_eq!(p.catalog, catalog);
            assert!(p.error.is_none());
            assert_eq!(e.text.read(cx).value(), "unsent draft");
        });
    })
    .unwrap();
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
                    // Working is routine: explained in context, never as a persistent notice.
                    assert_eq!(e.has_model_notice(), state != "working", "{state}");
                    assert_eq!(e.model_waits_for_work(), state == "working", "{state}");
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
fn busy_chat_explains_model_lock_in_context_without_notice_or_post(cx: &mut TestAppContext) {
    let (_server, h, e, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        e.update(cx, |e, cx| {
            // Editor busy (work or queued messages) with a healthy idle summary.
            e.permission(true, true, cx);
            e.sync_model_inputs(w, cx);
            assert_eq!(e.model_restriction(), Some(chat_models::BUSY));
            assert!(!e.can_choose_model());
            assert!(e.visible_model_restriction().is_none());
            assert!(!e.has_model_notice());
            // Both menus were rebuilt with the disabled explanation row first.
            let p = e.models.as_ref().unwrap().picker.as_ref().unwrap();
            assert!(p.synced.as_ref().unwrap().5);
            let (scope, epoch) = source(e);
            e.choose_model(&scope, &epoch, "p/b", None, w, cx);
            e.choose_model(&scope, &epoch, "p/a", Some(&"high".into()), w, cx);
            e.choose_model(&scope, &epoch, BUSY_ITEM, None, w, cx);
            assert!(commands.is_empty());
            assert_eq!(e.model_choice().unwrap().model, "p/a");
            // Idle again: the hint row goes away and one explicit switch is admitted.
            e.permission(true, false, cx);
            e.sync_model_inputs(w, cx);
            assert!(e.can_choose_model() && !e.model_waits_for_work());
            let p = e.models.as_ref().unwrap().picker.as_ref().unwrap();
            assert!(!p.synced.as_ref().unwrap().5);
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
                            resolved_default_model: None,
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
            assert!(
                e.model_restriction()
                    .unwrap()
                    .contains("Wait for the pending")
            );
            assert!(e.visible_model_restriction().is_none());
            assert!(
                !e.has_model_notice(),
                "Sending has no redundant composer helper"
            );
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
                    ..Default::default()
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
