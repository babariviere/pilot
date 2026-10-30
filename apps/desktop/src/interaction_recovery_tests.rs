//! Real single-writer courier, gated faux HTTP and temporary private disk only.
use super::send_waits::{arrived, disconnected, disk, stalled};
use super::*;

fn reserve(daemon: &Daemon, temp: &Temp, answer: bool) -> (Intent, Draft) {
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let mut captured = draft(2, "Original ordinary 日本語 👩‍💻");
    let question = blocking_answer_fixture();
    captured.answer = Some(
        crate::question::AnswerDraft::capture(
            &question,
            2,
            std::collections::BTreeSet::from([1]),
            "original answer".into(),
        )
        .unwrap(),
    );
    let intent = if answer {
        store
            .prepare_answer(
                "chat:a",
                &captured,
                &question,
                captured.answer.as_ref().unwrap(),
            )
            .unwrap()
    } else {
        store.prepare("chat:a", &captured, false, false).unwrap()
    };
    (intent, captured)
}

fn receipt(intent: &Intent, state: &str) -> Value {
    let op = intent.operation.as_ref().unwrap();
    json!({"state":state,"operationId":op.operation_id,"payloadHash":op.payload_hash,
        "destination":op.destination,"targetId":op.target_id,"result":{"sessionId":op.target_id}})
}

async fn edit_while_held(
    client: &Interaction,
    updates: &async_channel::Receiver<WriteState>,
    temp: &Temp,
    captured: &Draft,
    pending: bool,
) -> Draft {
    let mut newer = captured.clone();
    newer.revision = 9;
    newer.text = "Newer ordinary 未送信 e\u{301} 🦀".into();
    // Pending freezes answer and config, but never ordinary text.
    newer.cwd = "/changed".into();
    newer.project_id = Some("project-other".into());
    newer.answer = Some(
        crate::question::AnswerDraft::capture(
            &question_answer_fixture(),
            9,
            std::collections::BTreeSet::from([0]),
            "different reply".into(),
        )
        .unwrap(),
    );
    assert!(client.edit("chat:a".into(), newer.clone()));
    let other = draft(7, "Other exact 日本語 👩‍💻");
    assert!(client.edit("chat:other".into(), other.clone()));
    let saved = until(updates, |s| {
        s.error.is_some()
            || s.book.as_ref().is_some_and(|b| {
                b.drafts.get("chat:a").is_some_and(|d| d.revision == 9)
                    && b.drafts.get("chat:other").is_some_and(|d| d.revision == 7)
            })
    })
    .await;
    assert!(saved.error.is_none(), "{:?}", saved.error);
    assert_eq!(
        saved.checkpoint, None,
        "only autosave, never a forced checkpoint"
    );
    let before = disk(temp);
    assert!(saved.book.as_ref().unwrap().as_ref() == &before);
    assert_eq!(before.drafts["chat:a"].text, newer.text);
    assert_eq!(before.drafts["chat:other"].text, other.text);
    assert_eq!(before.drafts["chat:other"].revision, other.revision);
    if pending {
        assert!(before.drafts["chat:a"].answer == captured.answer);
        assert_eq!(before.drafts["chat:a"].cwd, captured.cwd);
        assert_eq!(before.drafts["chat:a"].project_id, captured.project_id);
    } else {
        assert!(before.drafts["chat:a"].answer == newer.answer);
    }
    before.drafts["chat:a"].clone()
}

#[tokio::test]
async fn recovery_check_autosaves_without_executing_unknown() {
    let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations/receipt").await;
    let temp = Temp::new();
    let (intent, captured) = reserve(&daemon, &temp, false);
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.command(WriteCommand::Check {
        id: intent.id.clone(),
        retry: false
    }));
    assert_eq!(
        arrived(&reached).await,
        serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap()
    );
    edit_while_held(&client, &updates, &temp, &captured, true).await;
    assert!(disk(&temp).pending[&intent.id] == intent);
    assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
    release.send(()).await.unwrap();
    let done = until(&updates, |s| {
        s.delivery_reports
            .get(&intent.id)
            .is_some_and(|r| r.delivery.diagnostic.unwrap().category == Category::Unknown)
    })
    .await;
    assert!(done.book.as_ref().unwrap().pending.contains_key(&intent.id));
    assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    disconnected(client, updates).await;
}

#[tokio::test]
async fn recovery_retry_and_check_receipts_keep_exact_owners_while_autosaving() {
    for (retry, state, behavior) in [
        (false, "accepted", Behavior::Accept),
        (false, "pending", Behavior::Accept),
        (false, "rejected", Behavior::Accept),
        (false, "mismatch", Behavior::Accept),
        (true, "unknown", Behavior::Accept),
        (true, "pending", Behavior::Accept),
        (true, "accepted", Behavior::Accept),
        (true, "rejected", Behavior::Accept),
        (true, "mismatch", Behavior::Accept),
        (true, "unknown", Behavior::Reject),
        (true, "unknown", Behavior::Pending),
        (true, "unknown", Behavior::LostAccepted),
        (true, "unknown", Behavior::LostBeforeAdmission),
        (true, "unknown", Behavior::WrongReceipt),
        (true, "unknown", Behavior::Readonly),
    ] {
        let (daemon, reached, release) = stalled(behavior, "/api/operations/receipt").await;
        let temp = Temp::new();
        let (intent, captured) = reserve(&daemon, &temp, false);
        if state != "unknown" {
            let mut value = receipt(
                &intent,
                if state == "mismatch" {
                    "accepted"
                } else {
                    state
                },
            );
            if state == "mismatch" {
                value["destination"]["lineageId"] = json!("wrong-lineage");
            }
            daemon
                .seen
                .lock()
                .unwrap()
                .operations
                .insert(intent.id.clone(), value);
        }
        let (client, updates) = ready(&daemon, &temp).await;
        assert!(client.command(WriteCommand::Check {
            id: intent.id.clone(),
            retry
        }));
        arrived(&reached).await;
        let newer = edit_while_held(&client, &updates, &temp, &captured, true).await;
        assert!(disk(&temp).pending[&intent.id] == intent);
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.delivery_reports.contains_key(&intent.id)).await;
        let book = done.book.as_ref().unwrap();
        assert_eq!(
            book.drafts["chat:a"].text, newer.text,
            "{retry} {state} {behavior:?}"
        );
        assert!(book.drafts["chat:a"].answer == captured.answer);
        assert_eq!(book.drafts["chat:a"].cwd, captured.cwd);
        let posted = retry && state == "unknown" && behavior != Behavior::Readonly;
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(
            seen.envelopes.len(),
            usize::from(posted),
            "{retry} {state} {behavior:?}"
        );
        if posted {
            assert_eq!(
                seen.envelopes[0],
                serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap()
            );
        }
        let settled = matches!(state, "accepted" | "rejected")
            || posted && matches!(behavior, Behavior::Accept | Behavior::Reject);
        assert_eq!(
            book.pending.is_empty(),
            settled,
            "{retry} {state} {behavior:?}"
        );
        drop(seen);
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn recovery_answer_submit_autosaves_during_preflight_lookup_and_execute() {
    for path in [
        "/api/hello",
        "/api/sessions/a",
        "/api/operations/receipt",
        "/api/operations",
    ] {
        let (daemon, reached, release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        let question = blocking_answer_fixture();
        question_answer_command(&client, question.clone(), 1);
        arrived(&reached).await;
        let before = disk(&temp);
        let captured = before.drafts["chat:a"].clone();
        let pending = path.starts_with("/api/operations");
        assert_eq!(!before.pending.is_empty(), pending);
        let newer = edit_while_held(&client, &updates, &temp, &captured, pending).await;
        assert!(disk(&temp).pending == before.pending);
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        let saved = &done.book.as_ref().unwrap().drafts["chat:a"];
        assert_eq!(saved.text, newer.text);
        assert!(saved.answer == newer.answer);
        assert_eq!(
            daemon.seen.lock().unwrap().envelopes.len(),
            usize::from(pending)
        );
        if pending {
            let accepted = saved.last.as_ref().unwrap();
            assert_eq!(accepted.state, "accepted");
            assert!(accepted.answer == captured.answer.as_ref().map(|a| a.identity.clone()));
            // The old accepted reply cannot consume a newer ordinary edit.
            assert!(client.command(WriteCommand::RetireAnswer {
                key: "chat:a".into(),
                revision: captured.revision,
                identity: accepted.answer.clone().unwrap(),
                recover: false
            }));
            assert!(client.command(WriteCommand::Checkpoint(200)));
            let refused = until(&updates, |s| s.checkpoint == Some(200)).await;
            assert!(refused.book.as_ref().unwrap().drafts["chat:a"].answer == saved.answer);
            assert!(client.command(WriteCommand::RetireAnswer {
                key: "chat:a".into(),
                revision: saved.revision,
                identity: accepted.answer.clone().unwrap(),
                recover: false
            }));
            assert!(client.command(WriteCommand::Checkpoint(201)));
            let retired = until(&updates, |s| s.checkpoint == Some(201)).await;
            assert!(
                retired.book.as_ref().unwrap().drafts["chat:a"]
                    .answer
                    .is_none()
            );
            assert_eq!(
                retired.book.as_ref().unwrap().drafts["chat:a"].text,
                newer.text
            );
        } else {
            assert!(
                saved.last.is_none(),
                "preflight question drift refuses stale capture"
            );
        }
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn recovery_retry_answer_autosaves_during_identity_target_lookup_and_execute() {
    for path in [
        "/api/hello",
        "/api/sessions/a",
        "/api/operations/receipt",
        "/api/operations",
    ] {
        let (daemon, reached, release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (intent, captured) = reserve(&daemon, &temp, true);
        let (client, updates) = ready(&daemon, &temp).await;
        assert!(client.command(WriteCommand::RetryAnswer {
            id: intent.id.clone(),
            question: blocking_answer_fixture()
        }));
        arrived(&reached).await;
        let newer = edit_while_held(&client, &updates, &temp, &captured, true).await;
        assert!(disk(&temp).pending[&intent.id] == intent);
        release.send(()).await.unwrap();
        let done = until(&updates, |s| {
            s.book.as_ref().is_some_and(|b| b.pending.is_empty())
        })
        .await;
        let saved = &done.book.as_ref().unwrap().drafts["chat:a"];
        assert_eq!(saved.text, newer.text);
        assert!(saved.answer == captured.answer);
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(
            seen.envelopes.as_slice(),
            &[serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap()]
        );
        drop(seen);
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

async fn begin(
    daemon: &Daemon,
    temp: &Temp,
    lane: &str,
) -> (Interaction, async_channel::Receiver<WriteState>) {
    let intent = (lane != "answer").then(|| reserve(daemon, temp, lane == "retry-answer").0);
    let (client, updates) = ready(daemon, temp).await;
    match lane {
        "answer" => question_answer_command(&client, blocking_answer_fixture(), 1),
        "retry-answer" => assert!(client.command(WriteCommand::RetryAnswer {
            id: intent.unwrap().id,
            question: blocking_answer_fixture()
        })),
        _ => assert!(client.command(WriteCommand::Check {
            id: intent.unwrap().id,
            retry: lane == "retry"
        })),
    }
    (client, updates)
}

#[tokio::test]
async fn recovery_close_flushes_latest_edits_even_with_a_saturated_fifo() {
    for (lane, path) in [
        ("check", "/api/operations/receipt"),
        ("retry", "/api/operations"),
        ("retry-answer", "/api/sessions/a"),
        ("retry-answer", "/api/operations"),
        ("answer", "/api/hello"),
        ("answer", "/api/operations/receipt"),
        ("answer", "/api/operations"),
    ] {
        let (daemon, reached, _release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (client, updates) = begin(&daemon, &temp, lane).await;
        arrived(&reached).await;
        let captured = disk(&temp).drafts["chat:a"].clone();
        for request in 20..28 {
            assert!(client.command(WriteCommand::Submit {
                key: "chat:a".into(),
                draft: Box::new(draft(request, "queued Stop")),
                follow_up: false,
                stop: true,
                request
            }));
        }
        assert!(!client.command(WriteCommand::Checkpoint(88)));
        assert!(client.edit(
            "chat:a".into(),
            Draft {
                revision: 30,
                text: "Newest on Close 日本語".into(),
                ..captured
            }
        ));
        assert!(client.edit("chat:other".into(), draft(31, "Other on Close")));
        assert!(client.command(WriteCommand::Close));
        let done = until(&updates, |s| s.flushed).await;
        assert_eq!(done.checkpoint, None);
        assert_eq!(
            done.book.as_ref().unwrap().drafts["chat:a"].text,
            "Newest on Close 日本語"
        );
        assert_eq!(disk(&temp).drafts["chat:other"].text, "Other on Close");
        assert!(
            done.book
                .as_ref()
                .unwrap()
                .pending
                .values()
                .all(|i| i.state == "unknown")
        );
        assert_eq!(daemon.seen.lock().unwrap().stops, 0);
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn recovery_second_mutation_and_checkpoint_stay_fifo_while_edits_save() {
    for lane in ["retry", "answer", "retry-answer"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations").await;
        let temp = Temp::new();
        let (client, updates) = begin(&daemon, &temp, lane).await;
        arrived(&reached).await;
        let captured = disk(&temp).drafts["chat:a"].clone();
        submit(&client, "chat:b", 1, "second mutation", 2, false);
        assert!(client.command(WriteCommand::Checkpoint(91)));
        edit_while_held(&client, &updates, &temp, &captured, true).await;
        assert_eq!(client.commands.len(), 2);
        assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.checkpoint == Some(91)).await;
        assert_eq!(done.handled.get("chat:b"), Some(&2));
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(seen.envelopes.len(), 2);
        assert_eq!(seen.envelopes[0]["sequence"], 1);
        assert_eq!(seen.envelopes[1]["sequence"], 2);
        assert_eq!(seen.envelopes[1]["targetId"], "b");
        drop(seen);
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn recovery_save_fault_fences_unissued_posts_but_keeps_exact_accepted_ack() {
    for (lane, path) in [
        ("retry", "/api/operations/receipt"),
        ("retry", "/api/operations"),
        ("answer", "/api/hello"),
        ("answer", "/api/operations/receipt"),
        ("answer", "/api/operations"),
        ("retry-answer", "/api/operations/receipt"),
        ("retry-answer", "/api/operations"),
    ] {
        let (daemon, reached, release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (client, updates) = begin(&daemon, &temp, lane).await;
        arrived(&reached).await;
        let before = disk(&temp);
        let snapshot = temp.0.join("state-v1.json");
        let backup = temp.0.join("before-fault.json");
        let bytes = fs::read(&snapshot).unwrap();
        fs::rename(&snapshot, &backup).unwrap();
        fs::create_dir(&snapshot).unwrap();
        let mut newer = before.drafts["chat:a"].clone();
        newer.revision += 1;
        newer.text = "Newer unsaved input 日本語".into();
        assert!(client.edit("chat:a".into(), newer));
        assert!(client.edit("chat:other".into(), draft(1, "Other unsaved")));
        let failed = until(&updates, |s| s.error.is_some()).await;
        assert!(failed.handled.is_empty());
        assert_eq!(
            client.edits.lock().unwrap()["chat:a"].text,
            "Newer unsaved input 日本語"
        );
        release.send(()).await.unwrap();
        // Barrier runs only after the first mutation settled. A fault refuses
        // the barrier without certifying a checkpoint or executing more HTTP.
        assert!(client.command(WriteCommand::DiscardNew {
            key: "new:barrier".into(),
            revision: 1,
            request: 99
        }));
        let done = until(&updates, |s| {
            s.discard.as_ref().is_some_and(|(_, _, r, _)| *r == 99)
        })
        .await;
        assert!(!done.flushed);
        assert_eq!(done.checkpoint, None);
        assert!(done.error.is_some());
        let dispatched = path == "/api/operations";
        assert_eq!(
            daemon.seen.lock().unwrap().envelopes.len(),
            usize::from(dispatched)
        );
        if dispatched {
            let intent = before.pending.values().next().unwrap();
            let report = &done.delivery_reports[&intent.id];
            assert_eq!(
                report.delivery.diagnostic.unwrap().acknowledgment,
                Acknowledgment::Accepted
            );
            assert_eq!(
                report.delivery.diagnostic.unwrap().category,
                Category::PrivateWrite
            );
            assert!(!report.saved);
            assert!(done.book.as_ref().unwrap().pending[&intent.id] == *intent);
        }
        disconnected(client, updates).await;
        assert_eq!(fs::read(&backup).unwrap(), bytes);
        fs::remove_dir(&snapshot).unwrap();
        fs::rename(&backup, &snapshot).unwrap();
        assert!(
            Store::open(temp.0.clone(), daemon.options.host())
                .unwrap()
                .book
                == before
        );
    }
}

#[tokio::test]
async fn recovery_capacity_refusal_never_authorizes_a_retry_post() {
    for lane in ["retry", "answer", "retry-answer"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations/receipt").await;
        let temp = Temp::new();
        {
            let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
            store
                .save_edits(BTreeMap::from([(
                    "chat:existing".into(),
                    draft(1, "retained"),
                )]))
                .unwrap();
        }
        let (client, updates) = begin(&daemon, &temp, lane).await;
        arrived(&reached).await;
        let before = disk(&temp);
        let mut newer = before.drafts["chat:a"].clone();
        newer.revision += 1;
        newer.text = "Capacity unsaved newer".into();
        assert!(client.edit("chat:a".into(), newer));
        for i in 0..crate::delivery_store::DRAFT_CAP - 1 {
            assert!(client.edit(format!("chat:capacity-{i}"), draft(1, "unsaved other")));
        }
        until(&updates, |s| s.error.is_some()).await;
        assert_eq!(
            client.edits.lock().unwrap().len(),
            crate::delivery_store::DRAFT_CAP
        );
        release.send(()).await.unwrap();
        let intent = before.pending.values().next().unwrap();
        let done = until(&updates, |s| s.delivery_reports.contains_key(&intent.id)).await;
        assert!(done.book.as_ref().unwrap().pending[&intent.id].operation == intent.operation);
        assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
        assert_eq!(
            client.edits.lock().unwrap()["chat:a"].text,
            "Capacity unsaved newer"
        );
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn recovery_answer_execute_outcomes_never_replay_or_consume_newer_input() {
    for lane in ["answer", "retry-answer"] {
        for behavior in [
            Behavior::Pending,
            Behavior::Reject,
            Behavior::LostAccepted,
            Behavior::LostBeforeAdmission,
            Behavior::WrongReceipt,
        ] {
            let (daemon, reached, release) = stalled(behavior, "/api/operations").await;
            let temp = Temp::new();
            let (client, updates) = begin(&daemon, &temp, lane).await;
            let envelope = arrived(&reached).await;
            let before = disk(&temp);
            let intent = before.pending.values().next().unwrap();
            let captured = &before.drafts["chat:a"];
            let newer = edit_while_held(&client, &updates, &temp, captured, true).await;
            assert!(disk(&temp).pending[&intent.id] == *intent);
            release.send(()).await.unwrap();
            let done = until(&updates, |s| s.delivery_reports.contains_key(&intent.id)).await;
            let saved = &done.book.as_ref().unwrap().drafts["chat:a"];
            assert_eq!(saved.text, newer.text);
            assert!(saved.answer == captured.answer);
            let expected = if behavior == Behavior::Pending {
                "pending"
            } else {
                "unknown"
            };
            if behavior == Behavior::Reject {
                assert_eq!(saved.last.as_ref().unwrap().state, "rejected");
                assert!(done.book.as_ref().unwrap().pending.is_empty());
            } else {
                assert_eq!(
                    done.book.as_ref().unwrap().pending[&intent.id].state,
                    expected
                );
            }
            assert_eq!(
                daemon.seen.lock().unwrap().envelopes.as_slice(),
                &[envelope]
            );
            assert!(client.command(WriteCommand::Close));
            until(&updates, |s| s.flushed).await;
            disconnected(client, updates).await;
        }
    }
}

#[tokio::test]
async fn recovery_answer_preflight_keeps_capture_when_only_other_key_changes() {
    for path in ["/api/hello", "/api/sessions/a"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (client, updates) = begin(&daemon, &temp, "answer").await;
        arrived(&reached).await;
        let before = disk(&temp).drafts["chat:a"].clone();
        assert!(client.edit("chat:other".into(), draft(3, "Other 日本語")));
        until(&updates, |s| {
            s.book
                .as_ref()
                .is_some_and(|b| b.drafts.contains_key("chat:other"))
        })
        .await;
        assert_eq!(disk(&temp).drafts["chat:other"].text, "Other 日本語");
        assert!(disk(&temp).drafts["chat:a"] == before);
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        assert_eq!(
            done.book.as_ref().unwrap().drafts["chat:a"]
                .last
                .as_ref()
                .unwrap()
                .state,
            "accepted"
        );
        assert!(done.book.as_ref().unwrap().drafts["chat:a"].answer == before.answer);
        assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn recovery_retry_answer_refuses_drifted_identity_or_answer_labels() {
    for drift in ["identity", "selection"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations/receipt").await;
        let temp = Temp::new();
        let (intent, captured) = reserve(&daemon, &temp, true);
        let (client, updates) = ready(&daemon, &temp).await;
        let mut changed = blocking_answer_fixture().as_ref().clone();
        if drift == "identity" {
            changed.identity.entry += 1;
        } else {
            changed.content.options[1].label = "Changed selection".into();
        }
        assert!(client.command(WriteCommand::RetryAnswer {
            id: intent.id.clone(),
            question: Arc::new(changed)
        }));
        arrived(&reached).await;
        edit_while_held(&client, &updates, &temp, &captured, true).await;
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.delivery_reports.contains_key(&intent.id)).await;
        assert_eq!(
            done.delivery_reports[&intent.id]
                .delivery
                .diagnostic
                .unwrap()
                .category,
            Category::Refused
        );
        assert!(done.book.as_ref().unwrap().pending[&intent.id].operation == intent.operation);
        assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

/// Supplemental direct courier check: a faulted worker correctly fences further
/// commands before HTTP, but an exact prior observation must survive lookup failure.
#[tokio::test]
async fn recovery_exact_volatile_acceptance_survives_failed_receipt_lookup() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (intent, _) = reserve(&daemon, &temp, true);
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    store.fail_write = true;
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .build()
        .unwrap();
    let mut report = None;
    assert!(
        reconcile(
            &client,
            &daemon.options,
            &mut store,
            &intent.id,
            true,
            Some(&blocking_answer_fixture()),
            &mut report
        )
        .await
        .is_err()
    );
    assert!(store.is_faulted());
    assert_eq!(
        report
            .as_ref()
            .unwrap()
            .delivery
            .diagnostic
            .unwrap()
            .acknowledgment,
        Acknowledgment::Accepted
    );
    let refused = Daemon::start(Behavior::LookupRefused).await;
    assert!(
        reconcile(
            &client,
            &refused.options,
            &mut store,
            &intent.id,
            false,
            None,
            &mut report
        )
        .await
        .is_err()
    );
    let diagnostic = report.unwrap().delivery.diagnostic.unwrap();
    assert_eq!(diagnostic.acknowledgment, Acknowledgment::Accepted);
    assert_eq!(diagnostic.category, Category::Refused);
    assert_eq!(diagnostic.stage, Stage::Lookup);
    assert!(store.book.pending[&intent.id] == intent);
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
    assert!(refused.seen.lock().unwrap().envelopes.is_empty());
}

#[tokio::test]
async fn recovery_mismatched_receipt_tuple_cannot_adopt_or_authorize_retry() {
    for field in [
        "operationId",
        "payloadHash",
        "targetId",
        "destination",
        "lineage",
        "result",
    ] {
        let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations/receipt").await;
        let temp = Temp::new();
        let (intent, captured) = reserve(&daemon, &temp, true);
        let mut wrong = receipt(&intent, "accepted");
        match field {
            "destination" => wrong["destination"]["daemonId"] = json!("other-daemon"),
            "lineage" => wrong["destination"]["lineageId"] = json!("other-lineage"),
            "result" => wrong["result"]["sessionId"] = json!("other-target"),
            _ => wrong[field] = json!("mismatched"),
        }
        daemon
            .seen
            .lock()
            .unwrap()
            .operations
            .insert(intent.id.clone(), wrong);
        let (client, updates) = ready(&daemon, &temp).await;
        assert!(client.command(WriteCommand::RetryAnswer {
            id: intent.id.clone(),
            question: blocking_answer_fixture()
        }));
        arrived(&reached).await;
        edit_while_held(&client, &updates, &temp, &captured, true).await;
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.delivery_reports.contains_key(&intent.id)).await;
        assert_eq!(
            done.delivery_reports[&intent.id]
                .delivery
                .diagnostic
                .unwrap()
                .category,
            Category::ReceiptMismatch,
            "{field}"
        );
        assert!(done.book.as_ref().unwrap().pending[&intent.id].operation == intent.operation);
        assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}
