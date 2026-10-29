//! Restart qualification using only the existing temporary store and faux daemon.
use super::*;

#[tokio::test]
async fn update_checkpoint_retains_unknown_across_cold_start_without_any_network() {
    for behavior in [
        Behavior::LostAccepted,
        Behavior::LostBeforeAdmission,
        Behavior::AnswerLost,
    ] {
        for key in ["chat:a", "new:checkpoint"] {
            if behavior == Behavior::AnswerLost && key.starts_with("new:") {
                continue;
            }
            let daemon = Daemon::start(behavior).await;
            let temp = Temp::new();
            let (client, updates) = ready(&daemon, &temp).await;
            if behavior == Behavior::AnswerLost {
                question_answer_command(&client, question_answer_fixture(), 1);
            } else {
                submit(&client, key, 1, "Original 日本語 👩‍💻", 1, false);
            }
            let state = until(&updates, |s| s.handled.get(key) == Some(&1)).await;
            let original = state
                .book
                .as_ref()
                .unwrap()
                .pending
                .values()
                .next()
                .unwrap()
                .clone();
            assert_eq!(original.state, "unknown");
            let mut newer = state.book.as_ref().unwrap().drafts[key].clone();
            newer.revision += 1;
            newer.text = "Newer unsent e\u{301} 🦀".into();
            assert!(client.edit(key.into(), newer));
            assert!(client.command(WriteCommand::Checkpoint(91)));
            let saved = until(&updates, |s| s.checkpoint == Some(91)).await;
            assert!(saved.error.is_none());
            let book = saved.book.unwrap();
            assert!(book.pending[&original.id] == original);
            assert!(
                book.gui_restart_safe(),
                "durable Unknown should survive a GUI restart"
            );
            assert!(
                !book.restart_settled(),
                "daemon upgrade keeps its stricter gate"
            );
            let bytes = fs::read(temp.0.join("state-v1.json")).unwrap();
            let before = daemon.seen.lock().unwrap().requests.clone();
            assert!(client.command(WriteCommand::Close));
            until(&updates, |s| s.flushed).await;
            drop(client);
            while updates.recv().await.is_ok() {}
            let (client, updates) = ready(&daemon, &temp).await;
            assert!(client.command(WriteCommand::Checkpoint(92)));
            let restored = until(&updates, |s| s.checkpoint == Some(92)).await;
            assert!(restored.book.as_ref().unwrap().as_ref() == book.as_ref());
            assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), bytes);
            assert_eq!(
                daemon.seen.lock().unwrap().requests,
                before,
                "no lookup or replay on restart/checkpoint"
            );
            assert!(client.command(WriteCommand::Close));
            until(&updates, |s| s.flushed).await;
            drop(client);
            while updates.recv().await.is_ok() {}
        }
    }
}

#[tokio::test]
async fn update_checkpoint_never_acknowledges_unknown_with_failed_newer_save() {
    let options = LocalOptions::synthetic(1);
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
    store
        .prepare("chat:a", &draft(1, "Durable original"), false, false)
        .unwrap();
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    store.fail_write = true;
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (close, close_receiver) = async_channel::bounded(1);
    let (updates, output) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(2, "Unsaved newer 日本語"),
    )])));
    let task = tokio::spawn(run(
        options,
        Ok(store),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits: edits.clone(),
            updates,
            replace: output.clone(),
            close: close_receiver,
        },
    ));
    until(&output, |s| s.book.is_some()).await;
    commands.send(WriteCommand::Checkpoint(93)).await.unwrap();
    let failed = until(&output, |s| s.error.is_some()).await;
    assert_eq!(failed.checkpoint, None);
    assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), before);
    assert_eq!(edits.lock().unwrap()["chat:a"].text, "Unsaved newer 日本語");
    drop((commands, wake, close));
    task.await.unwrap();
}

#[tokio::test]
async fn update_checkpoint_retains_interrupted_execute_diagnostic_byte_exact() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let intent = store
        .prepare(
            "chat:a",
            &draft(43, "Synthetic interrupted send"),
            false,
            false,
        )
        .unwrap();
    let mut delivery = crate::delivery_store::Delivery::from_intent(&intent);
    delivery.diagnostic = Some(Diagnostic {
        stage: Stage::Execute,
        category: Category::Interrupted,
        status: None,
        acknowledgment: Acknowledgment::Unknown,
    });
    store.record_diagnostic("chat:a", &delivery).unwrap();
    let bytes = fs::read(temp.0.join("state-v1.json")).unwrap();
    let original = store.book.clone();
    drop(store);
    for generation in [94, 95] {
        let (client, updates) = ready(&daemon, &temp).await;
        assert!(client.command(WriteCommand::Checkpoint(generation)));
        let state = until(&updates, |s| s.checkpoint == Some(generation)).await;
        assert!(state.book.as_ref().unwrap().as_ref() == &original);
        assert!(state.book.as_ref().unwrap().gui_restart_safe());
        assert!(state.error.is_none());
        assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), bytes);
        assert!(daemon.seen.lock().unwrap().requests.is_empty());
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        drop(client);
        while updates.recv().await.is_ok() {}
    }
}

#[tokio::test]
async fn restart_retains_newer_drafts_and_exact_pending_operations_without_network() {
    for behavior in [
        Behavior::Pending,
        Behavior::LostAccepted,
        Behavior::LostBeforeAdmission,
    ] {
        for key in ["new:retention", "chat:a"] {
            for disconnect in [false, true] {
                let daemon = Daemon::start(behavior).await;
                let temp = Temp::new();
                let (client, updates) = ready(&daemon, &temp).await;
                submit(&client, key, 1, "Original 日本語 👩‍💻 e\u{301}", 1, false);
                let state = until(&updates, |s| s.handled.get(key) == Some(&1)).await;
                let original = state
                    .book
                    .as_ref()
                    .unwrap()
                    .pending
                    .values()
                    .next()
                    .unwrap()
                    .clone();
                let envelope = serde_json::to_value(original.operation.as_ref().unwrap()).unwrap();
                assert_eq!(
                    original.state,
                    if behavior == Behavior::Pending {
                        "pending"
                    } else {
                        "unknown"
                    }
                );

                // Same-owner newer input, another owner, then a delayed stale edit.
                assert!(client.edit(key.into(), draft(3, "Newer 未送信 🦀")));
                assert!(client.edit("chat:other".into(), draft(4, "Other draft e\u{301}")));
                assert!(client.edit(key.into(), draft(2, "Stale navigation capture")));
                if disconnect {
                    drop(client);
                } else {
                    assert!(client.command(WriteCommand::Close));
                    until(&updates, |s| s.flushed).await;
                    drop(client);
                }
                // Channel EOF joins the ordinary worker exit and releases store ownership.
                tokio::time::timeout(Duration::from_secs(5), async {
                    while updates.recv().await.is_ok() {}
                })
                .await
                .unwrap();
                let before = daemon.seen.lock().unwrap().requests.clone();
                let (client, updates) = ready(&daemon, &temp).await;
                // A processed command, not a startup scheduling delay, proves no auto work.
                assert!(client.command(WriteCommand::Checkpoint(17)));
                let restored = until(&updates, |s| s.checkpoint == Some(17)).await;
                let book = restored.book.unwrap();
                assert!(book.pending[&original.id] == original);
                assert_eq!(book.drafts[key].text, "Newer 未送信 🦀");
                assert_eq!(book.drafts[key].revision, 3);
                assert_eq!(book.drafts["chat:other"].text, "Other draft e\u{301}");
                assert_eq!(daemon.seen.lock().unwrap().requests, before);

                // Existing explicit Check/Retry is the only way forward after restart.
                assert!(client.command(WriteCommand::Check {
                    id: original.id.clone(),
                    retry: true
                }));
                let checked = until(&updates, |s| {
                    s.book.as_ref().is_some_and(|b| {
                        if behavior == Behavior::Pending {
                            b.pending
                                .get(&original.id)
                                .is_some_and(|i| i.state == "pending")
                        } else {
                            b.pending.is_empty()
                        }
                    })
                })
                .await;
                let book = checked.book.unwrap();
                assert_eq!(book.drafts[key].text, "Newer 未送信 🦀");
                assert_eq!(book.drafts["chat:other"].revision, 4);
                if behavior != Behavior::Pending {
                    assert_eq!(book.drafts[key].last.as_ref().unwrap().id, original.id);
                    assert_eq!(book.drafts[key].last.as_ref().unwrap().state, "accepted");
                }
                {
                    let seen = daemon.seen.lock().unwrap();
                    assert_eq!(
                        seen.envelopes.len(),
                        if behavior == Behavior::LostBeforeAdmission {
                            2
                        } else {
                            1
                        }
                    );
                    assert!(seen.envelopes.iter().all(|actual| actual == &envelope));
                    assert_eq!(seen.executions, 1);
                }
                assert!(client.command(WriteCommand::Close));
                until(&updates, |s| s.flushed).await;
                while updates.recv().await.is_ok() {}
            }
        }
    }
}

#[test]
fn failed_newer_autosave_retains_unsaved_mailbox_and_original_operation_on_restart() {
    let temp = Temp::new();
    let options = LocalOptions::synthetic(1);
    let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "Captured original"), false, false)
        .unwrap();
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    let edits = Mutex::new(BTreeMap::from([
        ("chat:a".into(), draft(3, "Unsaved newer 日本語")),
        ("chat:b".into(), draft(2, "Unsaved other owner")),
    ]));
    store.fail_write = true;
    assert!(flush(&mut store, &edits).is_err());
    assert!(store.is_faulted());
    assert_eq!(edits.lock().unwrap()["chat:a"].text, "Unsaved newer 日本語");
    assert_eq!(edits.lock().unwrap()["chat:b"].revision, 2);
    assert!(store.finish(&intent.id, "accepted", None).is_err());
    assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), before);
    drop(store);
    let restored = Store::open(temp.0.clone(), options.host()).unwrap();
    assert!(restored.book.pending[&intent.id] == intent);
    assert_eq!(restored.book.drafts["chat:a"].text, "Captured original");
    assert!(!restored.book.drafts.contains_key("chat:b"));
    // Failed edits remain available to copy in memory, not falsely restored from disk.
    assert_eq!(edits.lock().unwrap().len(), 2);
}

#[test]
fn failed_late_acceptance_does_not_claim_settlement_or_lose_durable_newer_text() {
    let temp = Temp::new();
    let options = LocalOptions::synthetic(1);
    let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
    let intent = store
        .prepare("new:retention", &draft(1, "Original"), false, false)
        .unwrap();
    store
        .save_edits(BTreeMap::from([(
            "new:retention".into(),
            draft(2, "Durable newer"),
        )]))
        .unwrap();
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    store.fail_write = true;
    assert!(store.finish(&intent.id, "accepted", None).is_err());
    assert!(store.is_faulted());
    assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), before);
    drop(store);
    let mut restored = Store::open(temp.0.clone(), options.host()).unwrap();
    assert!(restored.book.pending[&intent.id] == intent);
    assert_eq!(restored.book.drafts["new:retention"].text, "Durable newer");
    assert!(restored.book.drafts["new:retention"].created.is_none());
    restored.finish(&intent.id, "accepted", None).unwrap();
    assert_eq!(restored.book.drafts["new:retention"].text, "Durable newer");
    assert_eq!(
        restored.book.drafts["new:retention"].created.as_ref(),
        Some(&intent.target)
    );
}
