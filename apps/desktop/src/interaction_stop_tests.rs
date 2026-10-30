//! Stop on the production FIFO writer, held faux HTTP and private durable bytes.
use super::recovery_waits::edit_while_held;
use super::send_waits::{arrived, disconnected, disk, stalled};
use super::*;

fn seed(daemon: &Daemon, temp: &Temp) -> Draft {
    let mut captured = draft(2, "Unsent ordinary 日本語 👩‍💻");
    captured.model_choice = Some(crate::chat_models::DraftChoice {
        project_id: "project-a".into(),
        cwd: "/tmp".into(),
        choice: crate::chat_models::Choice {
            model: "test/model".into(),
            thinking: Some("high".into()),
        },
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
    Store::open(temp.0.clone(), daemon.options.host())
        .unwrap()
        .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
        .unwrap();
    captured
}

fn stop(client: &Interaction, captured: &Draft, request: u64) {
    assert!(client.command(WriteCommand::Submit {
        key: "chat:a".into(),
        draft: Box::new(captured.clone()),
        follow_up: false,
        stop: true,
        request,
    }));
}

#[tokio::test]
async fn stop_autosaves_durable_text_before_held_preflight_or_response_is_released() {
    for (path, behavior) in [
        ("/api/sessions/a/stop", Behavior::Accept),
        ("/api/hello", Behavior::Accept),
        ("/api/sessions/a", Behavior::Accept),
        ("/api/sessions/a/stop", Behavior::LostStop),
        ("/api/sessions/a/stop", Behavior::Reject),
        ("/api/sessions/a/stop", Behavior::WrongReceipt),
    ] {
        let (daemon, reached, release) = stalled(behavior, path).await;
        let temp = Temp::new();
        let captured = seed(&daemon, &temp);
        let (client, updates) = ready(&daemon, &temp).await;
        stop(&client, &captured, 17);
        let body = arrived(&reached).await;
        let reserved = disk(&temp).pending.values().next().cloned();
        let pending = path.ends_with("/stop");
        assert_eq!(reserved.is_some(), pending);
        if pending {
            assert_eq!(body, json!({}));
        }
        let newer = edit_while_held(&client, &updates, &temp, &captured, pending).await;
        let before = disk(&temp);
        if let Some(intent) = &reserved {
            assert!(before.pending[&intent.id] == *intent);
            assert_eq!(intent.target, "a");
            assert_eq!(intent.revision, captured.revision);
            assert_eq!(intent.state, "unknown");
            assert!(
                intent.operation.is_none(),
                "no receipt/replay envelope for Stop"
            );
        }
        release.send(()).await.unwrap();
        let settled = until(&updates, |s| s.handled.get("chat:a") == Some(&17)).await;
        let book = settled.book.as_ref().unwrap();
        assert_eq!(book.drafts["chat:a"].text, newer.text);
        assert_eq!(book.drafts["chat:a"].revision, newer.revision);
        assert!(book.drafts["chat:a"].answer == newer.answer);
        assert_eq!(book.drafts["chat:a"].cwd, newer.cwd);
        assert_eq!(book.drafts["chat:a"].project_id, newer.project_id);
        assert_eq!(book.drafts["chat:a"].model_choice, newer.model_choice);
        if behavior == Behavior::Accept {
            assert!(book.pending.is_empty());
            assert_eq!(
                book.drafts["chat:a"].last.as_ref().unwrap().state,
                "accepted"
            );
            let mut recovered = before.drafts["chat:a"].recovered.as_ref().clone();
            recovered.push("synthetic queued input".into());
            assert_eq!(*book.drafts["chat:a"].recovered, recovered);
        } else {
            assert!(book.pending.values().next().unwrap() == reserved.as_ref().unwrap());
            assert!(settled.notice.starts_with("Stop outcome is unknown"));
            let id = reserved.as_ref().unwrap().id.clone();
            assert!(client.command(WriteCommand::Check { id, retry: true }));
            until(&updates, |s| s.notice.starts_with("Stop has no receipt")).await;
        }
        assert_eq!(daemon.seen.lock().unwrap().stops, 1);
        assert_eq!(daemon.seen.lock().unwrap().executions, 0);
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
        assert!(
            Store::open(temp.0.clone(), daemon.options.host())
                .unwrap()
                .book
                == *book.as_ref()
        );
    }
}

#[tokio::test]
async fn stop_preserves_fifo_generation_and_other_target_while_autosaving() {
    let (daemon, reached, release) = stalled(Behavior::Accept, "/api/sessions/a/stop").await;
    let temp = Temp::new();
    let captured = seed(&daemon, &temp);
    let (client, updates) = ready(&daemon, &temp).await;
    stop(&client, &captured, 17);
    arrived(&reached).await;
    stop(&client, &captured, 17); // Same UI generation cannot repeat Stop.
    submit(&client, "chat:b", 3, "Second target", 18, false);
    assert!(client.command(WriteCommand::Checkpoint(29)));
    edit_while_held(&client, &updates, &temp, &captured, true).await;
    assert_eq!(daemon.seen.lock().unwrap().executions, 0);
    release.send(()).await.unwrap();
    let final_state = until(&updates, |s| s.checkpoint == Some(29)).await;
    assert_eq!(final_state.handled["chat:a"], 17);
    assert_eq!(final_state.handled["chat:b"], 18);
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.stops, 1);
    assert_eq!(seen.envelopes[0]["targetId"], "b");
    assert_eq!(
        seen.requests
            .iter()
            .filter(|(_, p)| p.ends_with("/stop") || p == "/api/operations")
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>(),
        ["/api/sessions/a/stop", "/api/operations"]
    );
    drop(seen);
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    disconnected(client, updates).await;
}

#[tokio::test]
async fn stop_close_cancels_held_effect_flushes_latest_and_releases_store_before_disconnect() {
    let (daemon, reached, release) = stalled(Behavior::Accept, "/api/sessions/a/stop").await;
    let temp = Temp::new();
    let captured = seed(&daemon, &temp);
    let (client, updates) = ready(&daemon, &temp).await;
    stop(&client, &captured, 17);
    arrived(&reached).await;
    let original = disk(&temp).pending.values().next().unwrap().clone();
    edit_while_held(&client, &updates, &temp, &captured, true).await;
    assert!(client.edit("chat:a".into(), draft(10, "Latest before Close 日本語")));
    assert!(client.command(WriteCommand::Close));
    let closed = until(&updates, |s| s.flushed).await;
    disconnected(client, updates).await;
    let reopened = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert!(reopened.book == *closed.book.as_ref().unwrap().as_ref());
    assert!(reopened.book.pending[&original.id] == original);
    assert_eq!(
        reopened.book.drafts["chat:a"].text,
        "Latest before Close 日本語"
    );
    assert!(reopened.book.drafts["chat:a"].answer == captured.answer);
    // A late server ACK has no receiver and cannot settle the reopened store.
    release.send(()).await.unwrap();
    assert!(disk(&temp) == reopened.book);
    assert_eq!(daemon.seen.lock().unwrap().stops, 1);
}

#[tokio::test]
async fn stop_never_replaces_original_pending_or_unknown_send_or_answer() {
    for answer in [false, true] {
        for state in ["unknown", "pending"] {
            let daemon = Daemon::start(Behavior::Accept).await;
            let temp = Temp::new();
            let captured = seed(&daemon, &temp);
            let original = {
                let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
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
            let (client, updates) = ready(&daemon, &temp).await;
            stop(&client, &captured, 17);
            let refused = until(&updates, |s| s.handled.get("chat:a") == Some(&17)).await;
            assert!(refused.notice.starts_with("Delivery is already pending"));
            edit_while_held(&client, &updates, &temp, &captured, true).await;
            assert!(disk(&temp).pending[&original.id] == original);
            assert!(daemon.seen.lock().unwrap().requests.is_empty());
            assert!(client.command(WriteCommand::Close));
            until(&updates, |s| s.flushed).await;
            disconnected(client, updates).await;
        }
    }
}
