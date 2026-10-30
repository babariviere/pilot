//! Model selection on the production writer, real private bytes, held faux HTTP.
use super::send_waits::{disconnected, disk};
use super::*;
use crate::model_wait_fixture::{Behavior as ModelBehavior, Server, attempt};

pub(super) fn seed(server: &Server, temp: &Temp) -> Draft {
    let mut captured = draft(2, "Unsent ordinary 日本語 👩‍💻");
    captured.model_choice = Some(crate::chat_models::DraftChoice {
        project_id: "project-a".into(),
        cwd: "/tmp".into(),
        choice: attempt(false).choice,
    });
    captured.answer = Some(
        crate::question::AnswerDraft::capture(
            &blocking_answer_fixture(),
            2,
            std::collections::BTreeSet::from([1]),
            "existing answer".into(),
        )
        .unwrap(),
    );
    Store::open(temp.0.clone(), server.options.host())
        .unwrap()
        .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
        .unwrap();
    captured
}
pub(super) async fn start(
    server: &Server,
    temp: &Temp,
) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    (client, updates)
}
fn submit_model(client: &Interaction, failed: bool, request: u64) {
    assert!(client.command(WriteCommand::Model {
        session: "a".into(),
        request,
        action: crate::chat_models::Action::Submit(attempt(failed))
    }));
}
pub(super) async fn reached(server: &Server) {
    tokio::time::timeout(Duration::from_secs(5), server.entered.recv())
        .await
        .unwrap()
        .unwrap();
}
pub(super) fn settled(state: &WriteState, request: u64) -> bool {
    state.model.as_ref().is_some_and(|r| {
        r.request == request && !matches!(r.outcome, crate::chat_models::Outcome::Pending)
    })
}
pub(super) async fn close(
    client: Interaction,
    updates: async_channel::Receiver<WriteState>,
    server: &Server,
    temp: &Temp,
) {
    assert!(client.command(WriteCommand::Close));
    let closed = until(&updates, |s| s.flushed).await;
    disconnected(client, updates).await;
    assert!(
        Store::open(temp.0.clone(), server.options.host())
            .unwrap()
            .book
            == *closed.book.unwrap()
    );
}
pub(super) fn posts(server: &Server) -> usize {
    server
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, _)| method == "POST")
        .count()
}
#[tokio::test]
async fn model_autosaves_before_held_response_release() {
    for failed in [false, true] {
        let route = if failed {
            "/api/sessions/a/failed-model"
        } else {
            "/api/sessions/a/model"
        };
        for (path, behavior) in [
            (route, ModelBehavior::Accept),
            ("/api/hello", ModelBehavior::Accept),
            ("/api/sessions/a", ModelBehavior::Accept),
            (
                "/api/models?cwd=%2Fsynthetic%2Fproject",
                ModelBehavior::Accept,
            ),
            (route, ModelBehavior::Lost),
            (route, ModelBehavior::Reject),
            (route, ModelBehavior::Wrong),
            (route, ModelBehavior::Malformed),
        ] {
            let server = Server::start(failed, behavior, path);
            let temp = Temp::new();
            let captured = seed(&server, &temp);
            // Another target's immutable Pending must survive every autosave/settlement.
            let (sealed, intent) = {
                let mut store = Store::open(temp.0.clone(), server.options.host()).unwrap();
                let intent = store
                    .prepare("chat:sealed", &captured, false, false)
                    .unwrap();
                (store.book.drafts["chat:sealed"].clone(), intent)
            };
            let (client, updates) = start(&server, &temp).await;
            submit_model(&client, failed, 17);
            reached(&server).await;
            let original = disk(&temp).model_changes.get("a").cloned();
            assert_eq!(original.is_some(), path == route);
            let newer =
                super::recovery_waits::edit_while_held(&client, &updates, &temp, &captured, false)
                    .await;
            let mut edited = sealed.clone();
            edited.revision = 10;
            edited.text = "Sealed newer text".into();
            edited.answer = newer.answer.clone();
            edited.model_choice = None;
            edited.cwd = "/changed".into();
            edited.project_id = None;
            assert!(client.edit("chat:sealed".into(), edited));
            assert!(client.command(WriteCommand::Checkpoint(29)));
            let saved = until(&updates, |s| {
                s.book
                    .as_ref()
                    .is_some_and(|b| b.drafts["chat:sealed"].revision == 10)
            })
            .await;
            assert!(matches!(
                saved.model.as_ref().unwrap().outcome,
                crate::chat_models::Outcome::Pending
            ));
            assert_eq!(saved.checkpoint, None, "checkpoint stays FIFO behind HTTP");
            let before = disk(&temp);
            assert_eq!(before.model_changes.get("a"), original.as_ref());
            assert!(before.pending[&intent.id] == intent);
            assert_eq!(before.drafts["chat:sealed"].text, "Sealed newer text");
            assert!(before.drafts["chat:sealed"].answer == sealed.answer);
            assert_eq!(
                before.drafts["chat:sealed"].model_choice,
                sealed.model_choice
            );
            assert_eq!(before.drafts["chat:sealed"].cwd, sealed.cwd);
            assert_eq!(before.drafts["chat:sealed"].project_id, sealed.project_id);
            server.release.send(()).await.unwrap();
            let finished = until(&updates, |s| s.checkpoint == Some(29)).await;
            assert!(settled(&finished, 17));
            let book = finished.book.as_ref().unwrap();
            assert_eq!(book.drafts["chat:a"].text, newer.text);
            assert!(book.drafts["chat:a"].answer == newer.answer);
            assert_eq!(book.drafts["chat:a"].model_choice, newer.model_choice);
            assert!(book.pending[&intent.id] == intent);
            if behavior == ModelBehavior::Accept {
                assert!(book.model_changes.is_empty());
                let crate::chat_models::Outcome::Acknowledged(current) =
                    &finished.model.unwrap().outcome
                else {
                    panic!("exact ACK required");
                };
                assert_eq!(current.model.as_deref(), Some("p/b"));
                assert_eq!(current.thinking.as_deref(), Some("low"));
                assert_eq!(current.failed_source.is_some(), failed);
            } else {
                assert_eq!(book.model_changes["a"], original.unwrap());
                assert!(matches!(
                    finished.model.unwrap().outcome,
                    crate::chat_models::Outcome::Unknown(_)
                ));
                assert!(client.command(WriteCommand::Model {
                    session: "a".into(),
                    request: 18,
                    action: crate::chat_models::Action::Inspect(attempt(failed).target)
                }));
                let observed = until(&updates, |s| settled(s, 18)).await;
                assert!(matches!(
                    observed.model.unwrap().outcome,
                    crate::chat_models::Outcome::Observed(_)
                ));
                assert!(
                    observed.book.unwrap().model_changes.contains_key("a"),
                    "GET never settles Unknown"
                );
            }
            assert_eq!(posts(&server), 1, "one immutable request, no replay");
            let mut expected = serde_json::to_value(&attempt(failed).choice).unwrap();
            if failed {
                expected["operationId"] = json!("model-one");
                expected["daemonId"] = json!("test-daemon");
                expected["lineageId"] = json!("test-lineage");
                expected["source"] =
                    serde_json::to_value(attempt(true).target.failed_source.unwrap()).unwrap();
            }
            assert_eq!(
                server
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(m, _, _)| m == "POST")
                    .unwrap(),
                &("POST".into(), route.into(), expected)
            );
            close(client, updates, &server, &temp).await;
        }
    }
}

#[tokio::test]
async fn model_close_flushes_and_late_response_cannot_settle_reopened_store() {
    for failed in [false, true] {
        let route = if failed {
            "/api/sessions/a/failed-model"
        } else {
            "/api/sessions/a/model"
        };
        let server = Server::start(failed, ModelBehavior::Accept, route);
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        submit_model(&client, failed, 17);
        reached(&server).await;
        let original = disk(&temp).model_changes["a"].clone();
        super::recovery_waits::edit_while_held(&client, &updates, &temp, &captured, false).await;
        let mut latest = captured.clone();
        latest.revision = 10;
        latest.text = "Latest on Close 日本語".into();
        assert!(client.edit("chat:a".into(), latest.clone()));
        close(client, updates, &server, &temp).await;
        let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
        assert_eq!(reopened.book.drafts["chat:a"].text, latest.text);
        assert_eq!(reopened.book.model_changes["a"], original);
        server.release.send(()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server.completed.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(disk(&temp) == reopened.book);
        assert_eq!(posts(&server), 1);
    }
}

#[tokio::test]
async fn model_refuses_original_pending_or_unknown_send_and_answer_without_replacement() {
    for answer in [false, true] {
        for state in ["pending", "unknown"] {
            let server = Server::start(false, ModelBehavior::Accept, "/never");
            let temp = Temp::new();
            let captured = seed(&server, &temp);
            let original = {
                let mut store = Store::open(temp.0.clone(), server.options.host()).unwrap();
                let intent = if answer {
                    store
                        .prepare_answer(
                            "chat:a",
                            &captured,
                            &blocking_answer_fixture(),
                            captured.answer.as_ref().unwrap(),
                        )
                        .unwrap()
                } else {
                    store.prepare("chat:a", &captured, false, false).unwrap()
                };
                if state == "pending" {
                    store.pending(&intent.id).unwrap();
                }
                store.book.pending[&intent.id].clone()
            };
            let (client, updates) = start(&server, &temp).await;
            submit_model(&client, false, 17);
            let refused = until(&updates, |s| settled(s, 17)).await;
            assert!(matches!(
                refused.model.unwrap().outcome,
                crate::chat_models::Outcome::Refused(_)
            ));
            assert!(refused.book.unwrap().model_changes.is_empty());
            super::recovery_waits::edit_while_held(&client, &updates, &temp, &captured, true).await;
            assert!(disk(&temp).pending[&original.id] == original);
            assert_eq!(posts(&server), 0);
            close(client, updates, &server, &temp).await;
        }
    }
}

#[tokio::test]
async fn model_inspect_and_local_ack_autosave_without_replay_or_early_settlement() {
    for acknowledge in [false, true] {
        let server = Server::start(false, ModelBehavior::Accept, "/api/sessions/a");
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        Store::open(temp.0.clone(), server.options.host())
            .unwrap()
            .prepare_model_change(attempt(false))
            .unwrap();
        let (client, updates) = start(&server, &temp).await;
        let action = if acknowledge {
            crate::chat_models::Action::Acknowledge {
                session: "a".into(),
                id: "model-one".into(),
            }
        } else {
            crate::chat_models::Action::Inspect(attempt(false).target)
        };
        assert!(client.command(WriteCommand::Model {
            session: "a".into(),
            request: 17,
            action
        }));
        reached(&server).await;
        super::recovery_waits::edit_while_held(&client, &updates, &temp, &captured, false).await;
        assert_eq!(disk(&temp).model_changes["a"], attempt(false));
        server.release.send(()).await.unwrap();
        let finished = until(&updates, |s| settled(s, 17)).await;
        assert_eq!(finished.book.unwrap().model_changes.is_empty(), acknowledge);
        assert_eq!(posts(&server), 0);
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn model_wait_keeps_other_model_actions_fifo() {
    let server = Server::start(false, ModelBehavior::Accept, "/api/sessions/a/model");
    let temp = Temp::new();
    let captured = seed(&server, &temp);
    let (client, updates) = start(&server, &temp).await;
    submit_model(&client, false, 17);
    reached(&server).await;
    let mut target = attempt(false).target;
    target.session = "b".into();
    assert!(client.command(WriteCommand::Model {
        session: "b".into(),
        request: 18,
        action: crate::chat_models::Action::Inspect(target)
    }));
    assert!(client.command(WriteCommand::Checkpoint(29)));
    super::recovery_waits::edit_while_held(&client, &updates, &temp, &captured, false).await;
    assert!(
        !server
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|(_, p, _)| p == "/api/sessions/b")
    );
    assert_eq!(client.commands.len(), 2);
    server.release.send(()).await.unwrap();
    let done = until(&updates, |s| s.checkpoint == Some(29)).await;
    assert_eq!(done.model.as_ref().unwrap().session, "b");
    assert_eq!(done.model.as_ref().unwrap().request, 18);
    assert!(matches!(
        done.model.unwrap().outcome,
        crate::chat_models::Outcome::Observed(_)
    ));
    assert_eq!(posts(&server), 1);
    close(client, updates, &server, &temp).await;
}

#[tokio::test]
async fn model_ack_survives_autosave_fault_without_durable_settlement_or_replay() {
    let server = Server::start(false, ModelBehavior::Accept, "/api/sessions/a/model");
    let temp = Temp::new();
    let captured = seed(&server, &temp);
    let (client, updates) = start(&server, &temp).await;
    submit_model(&client, false, 17);
    reached(&server).await;
    let original = disk(&temp).model_changes["a"].clone();
    let snapshot = temp.0.join("state-v1.json");
    let backup = temp.0.join("before-fault.json");
    fs::rename(&snapshot, &backup).unwrap();
    fs::create_dir(&snapshot).unwrap();
    let mut newer = captured.clone();
    newer.revision = 3;
    newer.text = "Unsaved on disk fault".into();
    assert!(client.edit("chat:a".into(), newer.clone()));
    until(&updates, |s| s.error.is_some()).await;
    assert_eq!(client.edits.lock().unwrap()["chat:a"].text, newer.text);
    server.release.send(()).await.unwrap();
    let ack = until(&updates, |s| settled(s, 17)).await;
    assert!(matches!(
        ack.model.unwrap().outcome,
        crate::chat_models::Outcome::Acknowledged(_)
    ));
    assert!(ack.error.is_some());
    assert_eq!(ack.book.unwrap().model_changes["a"], original);
    assert_eq!(posts(&server), 1);
    disconnected(client, updates).await;
    fs::remove_dir(&snapshot).unwrap();
    fs::rename(&backup, &snapshot).unwrap();
    assert_eq!(disk(&temp).drafts["chat:a"].text, captured.text);
    assert_eq!(disk(&temp).model_changes["a"], original);
}
