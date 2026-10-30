//! Existing Force/Continue on the production FIFO writer and real private bytes.
use super::model_waits::{close, posts, reached, seed, settled, start};
use super::recovery_waits::edit_while_held;
use super::send_waits::{disconnected, disk};
use super::*;
use crate::chat_models::{Action, Outcome};
use crate::model_wait_fixture::{Behavior as ModelBehavior, Server, attempt};

fn action(continuation: bool) -> Action {
    if continuation {
        Action::Continue(attempt(false))
    } else {
        Action::Force {
            target: attempt(false).target,
            force: true,
        }
    }
}

#[tokio::test]
async fn subscription_continue_catalog_wait_and_cross_provider_ack_keep_captured_choice() {
    let server = Server::subscription(
        false,
        ModelBehavior::Accept,
        "/api/models?cwd=%2Fsynthetic%2Fproject",
    );
    let temp = Temp::new();
    let captured = seed(&server, &temp);
    let (client, updates) = start(&server, &temp).await;
    let mut captured_attempt = attempt(false);
    captured_attempt.choice.model = "q/c".into();
    captured_attempt.choice.thinking = None;
    assert!(client.command(WriteCommand::Model {
        session: "a".into(),
        request: 17,
        action: Action::Continue(captured_attempt.clone())
    }));
    reached(&server).await;
    edit_while_held(&client, &updates, &temp, &captured, false).await;
    assert!(
        disk(&temp).model_changes.is_empty(),
        "preflight has not admitted intent"
    );
    server.release.send(()).await.unwrap();
    let done = until(&updates, |s| settled(s, 17)).await;
    let Outcome::Continued(next) = done.model.unwrap().outcome else {
        panic!("replacement ACK")
    };
    assert_eq!(next.id, "next");
    assert!(done.book.unwrap().model_changes.is_empty());
    assert_eq!(posts(&server), 1);
    assert_eq!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .find(|(m, _, _)| m == "POST")
            .unwrap()
            .2,
        json!({"model":"q/c"})
    );
    close(client, updates, &server, &temp).await;
}

#[tokio::test]
async fn subscription_force_allows_existing_pending_but_continuation_refuses_without_replacement() {
    for continuation in [false, true] {
        for answer in [false, true] {
            for state in ["pending", "unknown"] {
                let server = Server::subscription(false, ModelBehavior::Accept, "/api/sessions/a");
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
                command(&client, continuation);
                reached(&server).await;
                edit_while_held(&client, &updates, &temp, &captured, true).await;
                assert!(disk(&temp).pending[&original.id] == original);
                server.release.send(()).await.unwrap();
                let done = until(&updates, |s| settled(s, 17)).await;
                assert_eq!(
                    matches!(done.model.unwrap().outcome, Outcome::Refused(_)),
                    continuation
                );
                assert!(done.book.unwrap().model_changes.is_empty());
                assert_eq!(posts(&server), usize::from(!continuation));
                assert!(disk(&temp).pending[&original.id] == original);
                close(client, updates, &server, &temp).await;
            }
        }
    }
}

#[tokio::test]
async fn subscription_pause_at_limit_and_unchanged_force_observation_do_not_infer_post_success() {
    for value in [false, true] {
        let server = Server::subscription(true, ModelBehavior::Accept, "/api/sessions/a");
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        assert!(client.command(WriteCommand::Model {
            session: "a".into(),
            request: 17,
            action: Action::Force {
                target: attempt(false).target,
                force: value
            }
        }));
        reached(&server).await;
        edit_while_held(&client, &updates, &temp, &captured, false).await;
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| settled(s, 17)).await;
        assert_eq!(
            matches!(done.model.unwrap().outcome, Outcome::Observed(_)),
            value
        );
        assert_eq!(posts(&server), usize::from(!value));
        if !value {
            assert_eq!(
                server
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(m, _, _)| m == "POST")
                    .unwrap()
                    .2,
                json!({"force":false})
            );
        }
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn subscription_unknown_inspect_and_local_ack_save_without_replay() {
    for acknowledge in [false, true] {
        let server = Server::subscription(false, ModelBehavior::Accept, "/api/sessions/a");
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        Store::open(temp.0.clone(), server.options.host())
            .unwrap()
            .prepare_model_change(attempt(false))
            .unwrap();
        let (client, updates) = start(&server, &temp).await;
        let action = if acknowledge {
            Action::Acknowledge {
                session: "a".into(),
                id: "model-one".into(),
            }
        } else {
            Action::Inspect(attempt(false).target)
        };
        assert!(client.command(WriteCommand::Model {
            session: "a".into(),
            request: 17,
            action
        }));
        reached(&server).await;
        edit_while_held(&client, &updates, &temp, &captured, false).await;
        assert_eq!(disk(&temp).model_changes["a"], attempt(false));
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| settled(s, 17)).await;
        assert_eq!(done.book.unwrap().model_changes.is_empty(), acknowledge);
        assert_eq!(posts(&server), 0);
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn subscription_close_releases_store_and_late_ack_cannot_settle_reopened_intent() {
    for continuation in [false, true] {
        let route = if continuation {
            "/api/sessions/a/continue-model"
        } else {
            "/api/sessions/a/subscription-force"
        };
        let server = Server::subscription(false, ModelBehavior::Accept, route);
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        command(&client, continuation);
        reached(&server).await;
        let original = disk(&temp).model_changes.get("a").cloned();
        edit_while_held(&client, &updates, &temp, &captured, false).await;
        let mut latest = captured.clone();
        latest.revision = 10;
        latest.text = "Latest on Close 日本語".into();
        assert!(client.edit("chat:a".into(), latest.clone()));
        close(client, updates, &server, &temp).await;
        let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
        assert_eq!(reopened.book.drafts["chat:a"].text, latest.text);
        assert_eq!(reopened.book.model_changes.get("a"), original.as_ref());
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
async fn subscription_ack_survives_autosave_disk_fault() {
    for continuation in [false, true] {
        let route = if continuation {
            "/api/sessions/a/continue-model"
        } else {
            "/api/sessions/a/subscription-force"
        };
        let server = Server::subscription(false, ModelBehavior::Accept, route);
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        command(&client, continuation);
        reached(&server).await;
        let original = disk(&temp);
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
            Outcome::Acknowledged(_)
        ));
        assert!(ack.error.is_some());
        assert!(ack.book.unwrap().as_ref() == &original);
        assert_eq!(posts(&server), 1);
        disconnected(client, updates).await;
        fs::remove_dir(&snapshot).unwrap();
        fs::rename(&backup, &snapshot).unwrap();
        assert!(disk(&temp) == original);
    }
}
fn command(client: &Interaction, continuation: bool) {
    assert!(client.command(WriteCommand::Model {
        session: "a".into(),
        request: 17,
        action: action(continuation)
    }));
}

#[tokio::test]
async fn subscription_autosaves_before_held_response_release() {
    for continuation in [false, true] {
        let route = if continuation {
            "/api/sessions/a/continue-model"
        } else {
            "/api/sessions/a/subscription-force"
        };
        for (path, behavior) in [
            (route, ModelBehavior::Accept),
            ("/api/hello", ModelBehavior::Accept),
            ("/api/sessions/a", ModelBehavior::Accept),
            (route, ModelBehavior::Lost),
            (route, ModelBehavior::Reject),
            (route, ModelBehavior::Wrong),
            (route, ModelBehavior::Malformed),
        ] {
            let server = Server::subscription(false, behavior, path);
            let temp = Temp::new();
            let captured = seed(&server, &temp);
            let (sealed, intent) = {
                let mut store = Store::open(temp.0.clone(), server.options.host()).unwrap();
                let intent = store
                    .prepare("chat:sealed", &captured, false, false)
                    .unwrap();
                (store.book.drafts["chat:sealed"].clone(), intent)
            };
            let (client, updates) = start(&server, &temp).await;
            command(&client, continuation);
            reached(&server).await;
            let original = disk(&temp).model_changes.get("a").cloned();
            assert_eq!(original.is_some(), continuation && path == route);
            let newer = edit_while_held(&client, &updates, &temp, &captured, false).await;
            let mut edited = sealed.clone();
            edited.revision = 10;
            edited.text = "Sealed newer text".into();
            edited.answer = newer.answer.clone();
            edited.model_choice = None;
            edited.cwd = "/changed".into();
            edited.project_id = None;
            assert!(client.edit("chat:sealed".into(), edited));
            assert!(client.command(WriteCommand::Checkpoint(28)));
            assert!(client.command(WriteCommand::Checkpoint(29)));
            let saved = until(&updates, |s| {
                s.book
                    .as_ref()
                    .is_some_and(|b| b.drafts["chat:sealed"].revision == 10)
            })
            .await;
            assert!(matches!(saved.model.unwrap().outcome, Outcome::Pending));
            assert_eq!(saved.checkpoint, None);
            assert_eq!(client.commands.len(), 2, "commands remain FIFO behind HTTP");
            assert!(
                !server
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(_, p, _)| p == "/api/sessions/b")
            );
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
            let result = until(&updates, |s| s.checkpoint == Some(29)).await;
            match behavior {
                ModelBehavior::Accept => assert!(matches!(
                    &result.model.as_ref().unwrap().outcome,
                    Outcome::Acknowledged(_)
                )),
                ModelBehavior::Reject => {
                    assert!(matches!(
                        &result.model.as_ref().unwrap().outcome,
                        Outcome::Refused(_)
                    ))
                }
                _ => assert!(matches!(
                    &result.model.as_ref().unwrap().outcome,
                    Outcome::Unknown(_)
                )),
            }
            let finished = result;
            assert!(settled(&finished, 17));
            let book = finished.book.unwrap();
            assert_eq!(book.drafts["chat:a"].text, newer.text);
            assert!(book.pending[&intent.id] == intent);
            assert_eq!(
                book.model_changes.contains_key("a"),
                continuation && !matches!(behavior, ModelBehavior::Accept | ModelBehavior::Reject)
            );
            assert_eq!(posts(&server), 1, "one request, no replay");
            let payload = if continuation {
                serde_json::to_value(attempt(false).choice).unwrap()
            } else {
                json!({"force":true})
            };
            assert_eq!(
                server
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(m, _, _)| m == "POST")
                    .unwrap(),
                &("POST".into(), route.into(), payload)
            );
            close(client, updates, &server, &temp).await;
        }
    }
}
