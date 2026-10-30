//! Isolated synthetic daemon writes only. Never targets a running Local daemon.
use super::*;

#[tokio::test]
async fn diagnostic_creation_and_reply_preserve_role_without_project_reads_or_replay() {
    for behavior in [Behavior::Diagnostic, Behavior::LostAccepted] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        let draft = Draft {
            revision: 1,
            diagnostics: true,
            mode: "ask".into(),
            text: "Investigate latency".into(),
            ..Default::default()
        };
        client.command(WriteCommand::Submit {
            key: "new:diag".into(),
            draft: Box::new(draft),
            follow_up: false,
            stop: false,
            request: 1,
        });
        let mut state = until(&updates, |s| s.handled.get("new:diag") == Some(&1)).await;
        if behavior == Behavior::LostAccepted {
            let id = state.book.as_ref().unwrap().drafts["new:diag"]
                .pending
                .clone()
                .unwrap();
            assert_eq!(daemon.seen.lock().unwrap().executions, 1);
            client.command(WriteCommand::Check { id, retry: false });
            state = until(&updates, |s| {
                s.book
                    .as_ref()
                    .is_some_and(|b| b.drafts["new:diag"].created.is_some())
            })
            .await;
        }
        let target = state.book.as_ref().unwrap().drafts["new:diag"]
            .created
            .clone()
            .unwrap();
        {
            let seen = daemon.seen.lock().unwrap();
            assert_eq!(seen.envelopes.len(), 1);
            assert_eq!(seen.envelopes[0]["kind"], "diagnostics-create");
            let payload: Value =
                serde_json::from_str(seen.envelopes[0]["payload"].as_str().unwrap()).unwrap();
            assert_eq!(payload["role"], "diagnostics");
            assert_eq!(payload["mode"], "ask");
            assert_eq!(
                payload["diagnosticHost"],
                serde_json::to_value(daemon.options.host()).unwrap()
            );
            assert!(!seen.requests.iter().any(|(_, p)| p == "/api/projects"));
        }
        if behavior == Behavior::Diagnostic {
            let key = format!("chat:{target}");
            submit(&client, &key, 1, "Read the log inventory", 2, false);
            let reply = until(&updates, |s| s.handled.get(&key) == Some(&2)).await;
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert!(reply.book.as_ref().unwrap().pending.is_empty());
            assert_eq!(daemon.seen.lock().unwrap().executions, 2);
        }
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[path = "interaction_catalog_tests.rs"]
mod catalog_waits;
#[path = "interaction_draft_discard_tests.rs"]
mod draft_discard;
#[path = "interaction_model_tests.rs"]
mod model_waits;
#[path = "interaction_recovery_tests.rs"]
mod recovery_waits;
#[path = "interaction_retention_tests.rs"]
mod retention;
#[path = "interaction_send_tests.rs"]
mod send_waits;
#[path = "interaction_stop_tests.rs"]
mod stop_waits;

#[tokio::test]
async fn update_checkpoint_acknowledges_exact_flushed_generation_without_closing_writer() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.edit("chat:a".into(), draft(7, "Retain 日本語 👩‍💻 before update")));
    assert!(client.command(WriteCommand::Checkpoint(41)));
    let state = until(&updates, |s| s.checkpoint == Some(41)).await;
    assert!(!state.flushed);
    assert!(state.error.is_none());
    assert_eq!(state.book.unwrap().drafts["chat:a"].revision, 7);
    // The checkpoint can overtake its edit's already-queued autosave wake.
    // That empty wake must not invalidate the exact receipt while preparing exit.
    let _ = client.wake.try_send(());
    tokio::time::sleep(AUTOSAVE_MAX + AUTOSAVE_IDLE).await;
    while let Ok(state) = updates.try_recv() {
        assert_eq!(
            state.checkpoint,
            Some(41),
            "empty autosave cleared checkpoint"
        );
    }
    assert!(client.edit(
        "chat:a".into(),
        draft(8, "Retained after cancelled preparation")
    ));
    let state = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts["chat:a"].revision == 8)
    })
    .await;
    assert_eq!(
        state.checkpoint, None,
        "real edits must invalidate the receipt"
    );
    assert!(client.command(WriteCommand::Checkpoint(42)));
    let state = until(&updates, |s| s.checkpoint == Some(42)).await;
    assert_eq!(state.book.unwrap().drafts["chat:a"].revision, 8);
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    while updates.recv().await.is_ok() {}
    drop(client);
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(
        store.book.drafts["chat:a"].text,
        "Retained after cancelled preparation"
    );
}

fn question_answer_fixture() -> Arc<crate::question::Question> {
    Arc::new(crate::question::Question::parse(4,&json!({"question":"Which checks?","options":[{"label":"Typecheck"},{"label":"Tests"}],"multiSelect":true})).unwrap())
}
/// The same ask published by a live run that awaits the explicit reply.
fn blocking_answer_fixture() -> Arc<crate::question::Question> {
    Arc::new(crate::question::Question::parse(4,&json!({"question":"Which checks?","options":[{"label":"Typecheck"},{"label":"Tests"}],"multiSelect":true,"blocking":true})).unwrap())
}
fn question_answer_command(
    client: &Interaction,
    question: Arc<crate::question::Question>,
    request: u64,
) {
    let mut captured = draft(2, "Keep ordinary 日本語 👩‍💻");
    captured.answer = Some(
        crate::question::AnswerDraft::capture(
            &question,
            2,
            std::collections::BTreeSet::from([0, 1]),
            " own words ".into(),
        )
        .unwrap(),
    );
    assert!(client.edit("chat:a".into(), captured.clone()));
    assert!(client.command(WriteCommand::Answer {
        key: "chat:a".into(),
        draft: Box::new(captured),
        question,
        request
    }));
}
#[tokio::test]
async fn question_answer_courier_uses_steer_once_and_keeps_ordinary_draft() {
    let daemon = Daemon::start(Behavior::AnswerIdle).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(
        daemon.seen.lock().unwrap().requests.is_empty(),
        "Never auto-answer"
    );
    let question = question_answer_fixture();
    question_answer_command(&client, question.clone(), 1);
    let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let draft = &state.book.as_ref().unwrap().drafts["chat:a"];
    assert_eq!(draft.text, "Keep ordinary 日本語 👩‍💻");
    assert!(draft.pending.is_none());
    assert_eq!(draft.last.as_ref().unwrap().state, "accepted");
    assert_eq!(
        draft
            .last
            .as_ref()
            .unwrap()
            .answer
            .as_ref()
            .unwrap()
            .question,
        question.identity
    );
    {
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(seen.executions, 1);
        assert_eq!(seen.envelopes.len(), 1);
        let op = &seen.envelopes[0];
        assert_eq!(op["kind"], "chat-send");
        assert_eq!(op["targetId"], "a");
        assert_eq!(
            serde_json::from_str::<Value>(op["payload"].as_str().unwrap()).unwrap(),
            json!({"message":"- Typecheck\n- Tests\n\nown words","mode":"steer"})
        );
    }
    question_answer_command(&client, question.clone(), 1);
    until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    question_answer_command(&client, question, 2);
    until(&updates, |s| s.handled.get("chat:a") == Some(&2)).await;
    assert_eq!(
        daemon.seen.lock().unwrap().executions,
        1,
        "Repeated confirmation cannot create another answer"
    );
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}
#[tokio::test]
async fn blocking_question_answer_sends_once_while_its_run_waits() {
    // The synthetic summary reports a working run, as while ask_user awaits.
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    let question = blocking_answer_fixture();
    question_answer_command(&client, question.clone(), 1);
    let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let draft = &state.book.as_ref().unwrap().drafts["chat:a"];
    assert_eq!(draft.text, "Keep ordinary 日本語 👩‍💻");
    assert!(draft.pending.is_none());
    let last = draft.last.as_ref().unwrap();
    assert_eq!(last.state, "accepted");
    assert_eq!(last.answer.as_ref().unwrap().question, question.identity);
    {
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(seen.executions, 1);
        assert_eq!(seen.envelopes.len(), 1);
        let op = &seen.envelopes[0];
        assert_eq!(op["kind"], "chat-send");
        assert_eq!(op["targetId"], "a");
        assert_eq!(
            serde_json::from_str::<Value>(op["payload"].as_str().unwrap()).unwrap(),
            json!({"message":"- Typecheck\n- Tests\n\nown words","mode":"steer"}),
            "The awaited reply keeps the ordinary steering payload"
        );
    }
    question_answer_command(&client, question, 2);
    until(&updates, |s| s.handled.get("chat:a") == Some(&2)).await;
    assert_eq!(
        daemon.seen.lock().unwrap().executions,
        1,
        "Repeated confirmation cannot create another awaited answer"
    );
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}
#[tokio::test]
async fn blocking_question_unknown_retry_needs_its_exact_awaited_question() {
    let daemon = Daemon::start(Behavior::AnswerWorkingLost).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    let question = blocking_answer_fixture();
    question_answer_command(&client, question.clone(), 1);
    let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let intent = state
        .book
        .as_ref()
        .unwrap()
        .pending
        .values()
        .next()
        .unwrap()
        .clone();
    assert_eq!(intent.state, "unknown");
    let original = serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap();
    let refused = |checkpoint: u64, command: WriteCommand| {
        assert!(client.command(command));
        assert!(client.command(WriteCommand::Checkpoint(checkpoint)));
        checkpoint
    };
    // A working turn without the exact awaited question never re-posts.
    for (n, command) in [
        WriteCommand::Check { id: intent.id.clone(), retry: true },
        WriteCommand::RetryAnswer { id: intent.id.clone(), question: question_answer_fixture() },
        WriteCommand::RetryAnswer {
            id: intent.id.clone(),
            question: Arc::new(crate::question::Question::parse(8,&json!({"question":"Which checks?","options":[{"label":"Typecheck"},{"label":"Tests"}],"multiSelect":true,"blocking":true})).unwrap()),
        },
    ]
    .into_iter()
    .enumerate()
    {
        let checkpoint = refused(50 + n as u64, command);
        let state = until(&updates, |s| s.checkpoint == Some(checkpoint)).await;
        let retained = &state.book.as_ref().unwrap().pending[&intent.id];
        assert!(retained.operation == intent.operation && retained.answer == intent.answer);
        assert_eq!(
            state.delivery_reports[&intent.id].delivery.diagnostic.unwrap().category,
            Category::Refused
        );
        assert_eq!(daemon.seen.lock().unwrap().envelopes.as_slice(), std::slice::from_ref(&original));
    }
    assert!(client.command(WriteCommand::RetryAnswer {
        id: intent.id.clone(),
        question,
    }));
    let done = until(&updates, |s| {
        s.book.as_ref().is_some_and(|b| b.pending.is_empty())
    })
    .await;
    assert_eq!(
        done.book.as_ref().unwrap().drafts["chat:a"]
            .last
            .as_ref()
            .unwrap()
            .state,
        "accepted"
    );
    {
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(
            seen.envelopes.as_slice(),
            &[original.clone(), original],
            "Exact envelope only"
        );
        assert_eq!(seen.executions, 1);
    }
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}
#[tokio::test]
async fn question_answer_courier_gates_identity_permissions_turn_and_source_capture() {
    for behavior in [
        Behavior::Readonly,
        Behavior::AnswerDelegated,
        Behavior::Accept,
        Behavior::BadIdentity,
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        question_answer_command(&client, question_answer_fixture(), 1);
        let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        assert!(state.book.as_ref().unwrap().pending.is_empty());
        assert_eq!(daemon.seen.lock().unwrap().executions, 0);
        assert_eq!(
            state.book.as_ref().unwrap().drafts["chat:a"].text,
            "Keep ordinary 日本語 👩‍💻"
        );
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
    }
    let daemon = Daemon::start(Behavior::AnswerIdle).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    let question = question_answer_fixture();
    let mut captured = draft(2, "ordinary");
    captured.answer = Some(
        crate::question::AnswerDraft::capture(
            &question,
            2,
            std::collections::BTreeSet::from([0]),
            "mine".into(),
        )
        .unwrap(),
    );
    let changed =
        Arc::new(crate::question::Question::parse(8, &json!({"question":"Different?"})).unwrap());
    assert!(client.edit("chat:a".into(), captured.clone()));
    assert!(client.command(WriteCommand::Answer {
        key: "chat:a".into(),
        draft: Box::new(captured),
        question: changed,
        request: 1
    }));
    until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    assert!(
        daemon.seen.lock().unwrap().requests.is_empty(),
        "Mismatched captured identity fails before network"
    );
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}
#[tokio::test]
async fn question_answer_courier_unknown_restart_never_replays_and_explicit_retry_is_exact() {
    let daemon = Daemon::start(Behavior::AnswerLost).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    question_answer_command(&client, question_answer_fixture(), 1);
    let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let intent = state
        .book
        .as_ref()
        .unwrap()
        .pending
        .values()
        .next()
        .unwrap()
        .clone();
    assert_eq!(intent.state, "unknown");
    assert!(intent.answer.is_some());
    let original = serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap();
    assert_eq!(
        daemon.seen.lock().unwrap().envelopes.as_slice(),
        std::slice::from_ref(&original)
    );
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    drop(client);
    drop(updates);
    let before = daemon.seen.lock().unwrap().requests.len();
    let (client, updates) = ready(&daemon, &temp).await;
    assert_eq!(
        daemon.seen.lock().unwrap().requests.len(),
        before,
        "Restart does not look up or execute"
    );
    assert!(client.command(WriteCommand::Check {
        id: intent.id.clone(),
        retry: false
    }));
    until(&updates, |s| {
        s.delivery_reports
            .get(&intent.id)
            .is_some_and(|r| r.delivery.diagnostic.unwrap().category == Category::Unknown)
    })
    .await;
    assert_eq!(
        daemon.seen.lock().unwrap().envelopes.len(),
        1,
        "Check cannot execute"
    );
    assert!(client.command(WriteCommand::Check {
        id: intent.id.clone(),
        retry: true
    }));
    let done = until(&updates, |s| {
        s.book.as_ref().is_some_and(|b| b.pending.is_empty())
    })
    .await;
    assert_eq!(
        done.book.as_ref().unwrap().drafts["chat:a"].text,
        "Keep ordinary 日本語 👩‍💻"
    );
    assert_eq!(
        daemon.seen.lock().unwrap().envelopes.as_slice(),
        &[original.clone(), original]
    );
    assert_eq!(daemon.seen.lock().unwrap().executions, 1);
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn delivery_diagnostic_memory_ack_survives_capacity_and_failed_check() {
    use crate::delivery_store::{RECOVER_CAP, STATE_CAP};
    let daemon = Daemon::start(Behavior::RejectThenLookupRefused).await;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let mut initial = draft(1, "original immutable input");
    initial.recovered = Arc::new(vec!["prior recovery".into(); 8]);
    store
        .save_edits(BTreeMap::from([("chat:a".into(), initial.clone())]))
        .unwrap();
    let intent = store.prepare("chat:a", &initial, false, false).unwrap();
    let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
    store
        .save_edits(BTreeMap::from([(
            "chat:a".into(),
            draft(2, "newer native input"),
        )]))
        .unwrap();
    let mut pad = Draft {
        recovered: Arc::new(vec![String::new(); 4]),
        ..Default::default()
    };
    let mut estimate = store.book.clone();
    estimate.drafts.insert("chat:pad".into(), pad.clone());
    let mut left = STATE_CAP - 16 - serde_json::to_vec(&estimate).unwrap().len();
    for text in Arc::make_mut(&mut pad.recovered) {
        let n = left.min(RECOVER_CAP);
        *text = "x".repeat(n);
        left -= n;
    }
    assert_eq!(left, 0);
    store
        .save_edits(BTreeMap::from([("chat:pad".into(), pad)]))
        .unwrap();
    assert!(!store.is_faulted());
    drop(store);
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(
        daemon.seen.lock().unwrap().requests.is_empty(),
        "Restart never checks delivery"
    );
    assert!(client.command(WriteCommand::Check {
        id: intent.id.clone(),
        retry: true
    }));
    let first = until(&updates, |s| s.delivery_reports.contains_key(&intent.id)).await;
    let report = &first.delivery_reports[&intent.id];
    assert_eq!(
        report.delivery.diagnostic.unwrap().acknowledgment,
        Acknowledgment::Rejected
    );
    assert_eq!(
        report.delivery.diagnostic.unwrap().category,
        Category::PrivateState
    );
    assert_eq!(report.save_error, Some(Category::PrivateCapacity));
    assert!(!report.saved);
    // Carry only the observation's acknowledgment, never another tuple's.
    for acknowledgment in [Acknowledgment::Accepted, Acknowledgment::Rejected] {
        let mut previous = report.clone();
        previous
            .delivery
            .diagnostic
            .as_mut()
            .unwrap()
            .acknowledgment = acknowledgment;
        assert_eq!(
            DeliveryReport::new(&intent, Some(&previous))
                .delivery
                .diagnostic
                .unwrap()
                .acknowledgment,
            acknowledgment
        );
        for field in 0..5 {
            let mut wrong = previous.clone();
            match field {
                0 => wrong.key = "chat:other".into(),
                1 => wrong.delivery.id = "other".into(),
                2 => wrong.delivery.target = "other".into(),
                3 => wrong.delivery.kind = "chat-create".into(),
                _ => wrong.delivery.revision += 1,
            }
            assert_eq!(
                DeliveryReport::new(&intent, Some(&wrong))
                    .delivery
                    .diagnostic
                    .unwrap()
                    .acknowledgment,
                Acknowledgment::Unknown
            );
        }
    }
    assert!(
        first.error.is_none(),
        "Non-I/O capacity must not fault the store"
    );
    assert!(
        first.book.as_ref().unwrap().pending[&intent.id]
            .diagnostic
            .is_none()
    );
    assert!(client.command(WriteCommand::Check {
        id: intent.id.clone(),
        retry: false
    }));
    let second = until(&updates, |s| {
        s.delivery_reports
            .get(&intent.id)
            .is_some_and(|r| r.delivery.diagnostic.unwrap().category == Category::Refused)
    })
    .await;
    let diagnostic = second.delivery_reports[&intent.id]
        .delivery
        .diagnostic
        .unwrap();
    assert_eq!(
        (diagnostic.stage, diagnostic.status),
        (Stage::Lookup, Some(503))
    );
    assert_eq!(
        diagnostic.acknowledgment,
        Acknowledgment::Rejected,
        "A failed Check must not erase the only memory-known acknowledgment"
    );
    assert!(second.error.is_none());
    assert!(!second.delivery_reports[&intent.id].saved);
    let kept = &second.book.as_ref().unwrap().pending[&intent.id];
    assert_eq!(kept.state, "unknown");
    assert!(kept.diagnostic.is_none());
    assert_eq!(
        serde_json::to_vec(kept.operation.as_ref().unwrap()).unwrap(),
        original
    );
    assert_eq!(
        second.book.as_ref().unwrap().drafts["chat:a"].text,
        "newer native input"
    );
    assert_eq!(
        daemon.seen.lock().unwrap().envelopes.len(),
        1,
        "Failed lookup must execute nothing"
    );
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn delivery_diagnostic_followup_malformed_state_and_identity_gate_never_execute() {
    for bad_gate in [false, true] {
        let daemon = Daemon::start(if bad_gate {
            Behavior::BadIdentity
        } else {
            Behavior::Accept
        })
        .await;
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        let intent = store
            .prepare("chat:a", &draft(1, "original"), false, false)
            .unwrap();
        let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
        if bad_gate {
            store.pending(&intent.id).unwrap();
        } else {
            let op = intent.operation.as_ref().unwrap();
            daemon.seen.lock().unwrap().operations.insert(intent.id.clone(),json!({
                "state":"not-a-receipt-state","operationId":op.operation_id,"payloadHash":op.payload_hash,
                "destination":op.destination,"targetId":op.target_id
            }));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut report = None;
        assert!(
            reconcile(
                &client,
                &daemon.options,
                &mut store,
                &intent.id,
                false,
                None,
                &mut report
            )
            .await
            .is_err()
        );
        let mut state = WriteState::default();
        retain_report(&mut state, &mut store, report);
        let d = state.delivery_reports[&intent.id]
            .delivery
            .diagnostic
            .unwrap();
        assert_eq!(
            d.category,
            if bad_gate {
                Category::Identity
            } else {
                Category::Malformed
            }
        );
        assert_eq!(
            d.stage,
            if bad_gate {
                Stage::Identity
            } else {
                Stage::Lookup
            }
        );
        assert_eq!(
            d.acknowledgment,
            if bad_gate {
                Acknowledgment::Pending
            } else {
                Acknowledgment::Unknown
            }
        );
        assert_eq!(
            serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
            original
        );
        assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
    }
}
#[tokio::test]
async fn delivery_diagnostic_hello_and_target_keep_transport_outcome_and_never_execute() {
    for (behavior, stopped, stage, category, status) in [
        (
            Behavior::Accept,
            true,
            Stage::Identity,
            Category::Interrupted,
            None,
        ),
        (
            Behavior::HelloRefused,
            false,
            Stage::Identity,
            Category::Refused,
            Some(503),
        ),
        (
            Behavior::BadIdentity,
            false,
            Stage::Identity,
            Category::Identity,
            Some(200),
        ),
        (
            Behavior::TargetMissing,
            false,
            Stage::Target,
            Category::Refused,
            Some(404),
        ),
        (
            Behavior::Readonly,
            false,
            Stage::Target,
            Category::Refused,
            Some(200),
        ),
    ] {
        let daemon = Daemon::start(behavior).await;
        if stopped {
            // Nothing listens: the daemon is down, not a different daemon.
            daemon.task.abort();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        let intent = store
            .prepare("chat:a", &draft(1, "original"), false, false)
            .unwrap();
        let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut report = None;
        // Explicit Send again, so the target check is reached after an unknown lookup.
        let result = reconcile(
            &client,
            &daemon.options,
            &mut store,
            &intent.id,
            true,
            None,
            &mut report,
        )
        .await;
        assert!(result.is_err(), "{behavior:?}");
        let mut state = WriteState::default();
        retain_report(&mut state, &mut store, report);
        let d = state.delivery_reports[&intent.id]
            .delivery
            .diagnostic
            .unwrap();
        assert_eq!(
            (d.stage, d.category, d.status),
            (stage, category, status),
            "{behavior:?}"
        );
        assert_eq!(d.acknowledgment, Acknowledgment::Unknown);
        drop(store);
        let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        let kept = &store.book.pending[&intent.id];
        assert_eq!((kept.state.as_str(), kept.diagnostic), ("unknown", Some(d)));
        assert_eq!(
            serde_json::to_vec(kept.operation.as_ref().unwrap()).unwrap(),
            original
        );
        assert!(
            daemon.seen.lock().unwrap().envelopes.is_empty(),
            "{behavior:?} executed"
        );
    }
}
#[tokio::test]
async fn delivery_diagnostic_followup_known_rejection_survives_non_io_adoption_failure_and_restart()
{
    let daemon = Daemon::start(Behavior::Reject).await;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let mut initial = draft(1, "original");
    initial.recovered = Arc::new(vec!["retained recovery".into(); 8]);
    store
        .save_edits(BTreeMap::from([("chat:a".into(), initial.clone())]))
        .unwrap();
    let intent = store.prepare("chat:a", &initial, false, false).unwrap();
    store
        .save_edits(BTreeMap::from([("chat:a".into(), draft(2, "newer draft"))]))
        .unwrap();
    let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(2))
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
            None,
            &mut report
        )
        .await
        .is_err()
    );
    let mut state = WriteState::default();
    retain_report(&mut state, &mut store, report);
    let d = state.delivery_reports[&intent.id]
        .delivery
        .diagnostic
        .unwrap();
    assert_eq!(
        (d.stage, d.category, d.acknowledgment),
        (
            Stage::Adoption,
            Category::PrivateState,
            Acknowledgment::Rejected
        )
    );
    assert!(!store.is_faulted());
    assert!(state.delivery_reports[&intent.id].saved);
    drop(store);
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(store.book.pending[&intent.id].diagnostic, Some(d));
    assert_eq!(store.book.pending[&intent.id].state, "unknown");
    assert_eq!(store.book.drafts["chat:a"].text, "newer draft");
    assert_eq!(store.book.drafts["chat:a"].recovered.len(), 8);
    assert_eq!(
        serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
        original
    );
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
}
#[tokio::test]
async fn delivery_diagnostic_followup_diagnostic_write_cannot_erase_a_durable_acceptance() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "original"), false, false)
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(2))
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
            None,
            &mut report
        )
        .await
        .is_ok()
    );
    assert!(store.book.pending.is_empty());
    store.fail_write = true;
    let mut state = WriteState::default();
    retain_report(&mut state, &mut store, report);
    assert_eq!(
        state.delivery_reports[&intent.id]
            .delivery
            .diagnostic
            .unwrap()
            .acknowledgment,
        Acknowledgment::Accepted
    );
    assert!(!state.delivery_reports[&intent.id].saved);
    assert!(state.error.is_some());
    drop(store);
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let last = store.book.drafts["chat:a"].last.as_ref().unwrap();
    assert_eq!(
        (last.id.as_str(), last.target.as_str(), last.state.as_str()),
        (intent.id.as_str(), intent.target.as_str(), "accepted")
    );
    assert!(
        last.diagnostic.is_none(),
        "Only the new diagnostic failed to persist, not acceptance"
    );
    assert!(store.book.pending.is_empty());
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
}

#[tokio::test]
async fn delivery_diagnostic_http_boundaries_are_typed_sanitized_and_exact() {
    for (behavior, stage, category, status) in [
        (
            Behavior::LookupRefused,
            Stage::Lookup,
            Category::Refused,
            503,
        ),
        (
            Behavior::ExecuteRefused,
            Stage::Execute,
            Category::Refused,
            503,
        ),
        (
            Behavior::LookupMalformed,
            Stage::Lookup,
            Category::Malformed,
            200,
        ),
        (
            Behavior::LookupOversize,
            Stage::Lookup,
            Category::TooLarge,
            200,
        ),
        (
            Behavior::LookupTruncated,
            Stage::Lookup,
            Category::ResponseInterrupted,
            200,
        ),
        (
            Behavior::WrongReceipt,
            Stage::Execute,
            Category::ReceiptMismatch,
            200,
        ),
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "retained original", 1, false);
        let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        let book = state.book.as_ref().unwrap();
        let intent = book.pending.values().next().unwrap();
        let detail = intent.diagnostic.unwrap();
        assert_eq!(
            (detail.stage, detail.category, detail.status),
            (stage, category, Some(status))
        );
        assert_eq!(detail.acknowledgment, Acknowledgment::Unknown);
        assert!(state.delivery_reports[&intent.id].saved);
        assert!(
            !serde_json::to_string(book)
                .unwrap()
                .contains("private provider")
        );
        assert!(!detail.caption().contains("/sensitive"));
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn delivery_diagnostic_loss_autosave_other_owner_restart_and_lookup_only_keep_original() {
    for behavior in [Behavior::LostBeforeAdmission, Behavior::LostAccepted] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "new:slot", 1, "retained original", 1, false);
        let state = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
        let intent = state
            .book
            .as_ref()
            .unwrap()
            .pending
            .values()
            .next()
            .unwrap()
            .clone();
        let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
        let diagnostic = intent.diagnostic.unwrap();
        assert_eq!(
            (diagnostic.stage, diagnostic.category),
            (Stage::Execute, Category::Interrupted)
        );
        assert!(client.edit("chat:other".into(), draft(1, "unrelated autosave")));
        assert!(client.edit("new:slot".into(), draft(2, "newer draft")));
        let autosaved = until(&updates, |s| s.notice == "Draft saved.").await;
        assert_eq!(
            autosaved.book.as_ref().unwrap().pending[&intent.id].diagnostic,
            Some(diagnostic)
        );
        assert_eq!(
            autosaved.delivery_reports[&intent.id].delivery.diagnostic,
            Some(diagnostic)
        );
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
        drop(client);
        assert!(updates.recv().await.is_err());
        let before = daemon.seen.lock().unwrap().requests.len();
        let (client, updates) = Interaction::start(daemon.options.clone(), Ok(temp.0.clone()));
        let restored = until(&updates, |s| s.book.is_some()).await;
        assert_eq!(daemon.seen.lock().unwrap().requests.len(), before);
        let kept = &restored.book.as_ref().unwrap().pending[&intent.id];
        assert_eq!(kept.diagnostic, Some(diagnostic));
        assert_eq!(
            serde_json::to_vec(kept.operation.as_ref().unwrap()).unwrap(),
            original
        );
        let envelopes = daemon.seen.lock().unwrap().envelopes.len();
        client.command(WriteCommand::Check {
            id: intent.id.clone(),
            retry: false,
        });
        let checked = until(&updates, |s| {
            s.delivery_reports
                .get(&intent.id)
                .is_some_and(|r| r.delivery.diagnostic.unwrap().stage == Stage::Lookup)
        })
        .await;
        assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), envelopes);
        if behavior == Behavior::LostBeforeAdmission {
            let kept = &checked.book.as_ref().unwrap().pending[&intent.id];
            assert_eq!(
                serde_json::to_vec(kept.operation.as_ref().unwrap()).unwrap(),
                original
            );
            assert_eq!(kept.diagnostic.unwrap().category, Category::Unknown);
        } else {
            assert_eq!(
                checked.book.as_ref().unwrap().drafts["new:slot"]
                    .last
                    .as_ref()
                    .unwrap()
                    .id,
                intent.id
            );
        }
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn delivery_diagnostic_valid_acknowledgments_never_retain_arbitrary_rejection_reason() {
    for (behavior, ack) in [
        (Behavior::Pending, Acknowledgment::Pending),
        (Behavior::Accept, Acknowledgment::Accepted),
        (Behavior::Reject, Acknowledgment::Rejected),
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "original draft", 1, false);
        let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        let report = state.delivery_reports.values().next().unwrap();
        assert_eq!(report.delivery.diagnostic.unwrap().acknowledgment, ack);
        assert!(report.saved);
        assert!(
            !serde_json::to_string(state.book.as_ref().unwrap())
                .unwrap()
                .contains("private provider")
        );
        let before = daemon.seen.lock().unwrap().envelopes.len();
        if behavior == Behavior::Pending {
            client.command(WriteCommand::Check {
                id: report.delivery.id.clone(),
                retry: false,
            });
            until(&updates, |s| s.notice.starts_with("Pending:")).await;
            assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), before);
        }
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn delivery_diagnostic_private_adoption_failure_retains_known_ack_in_existing_state() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "original"), false, false)
        .unwrap();
    let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
    store.fail_write = true;
    let mut report = None;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    assert!(
        reconcile(
            &client,
            &daemon.options,
            &mut store,
            &intent.id,
            true,
            None,
            &mut report
        )
        .await
        .is_err()
    );
    let mut state = WriteState::default();
    retain_report(&mut state, &mut store, report);
    let detail = &state.delivery_reports[&intent.id];
    assert_eq!(detail.delivery.diagnostic.unwrap().stage, Stage::Adoption);
    assert_eq!(
        detail.delivery.diagnostic.unwrap().category,
        Category::PrivateWrite
    );
    assert_eq!(
        detail.delivery.diagnostic.unwrap().acknowledgment,
        Acknowledgment::Accepted
    );
    assert!(!detail.saved);
    assert!(state.error.is_some());
    assert_eq!(store.book.pending[&intent.id].state, "unknown");
    assert_eq!(
        serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
        original
    );
    let diagnostic = detail.delivery.diagnostic;
    retain_report(&mut state, &mut store, None);
    assert_eq!(
        state.delivery_reports[&intent.id].delivery.diagnostic,
        diagnostic
    );
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
    drop(store);
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert!(store.book.pending[&intent.id].diagnostic.is_none());
    assert_eq!(
        serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
        original
    );
}

use serde_json::json;
use std::fs;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("desktop-courier-test-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
async fn image_attachment_send_requires_fresh_role_and_coordinator_readable_storage() {
    for (behavior, allowed, pasted) in [
        (Behavior::ImageBuild, true, false),
        (Behavior::Accept, false, true),
        (Behavior::ImageCoordinator, true, true),
        (Behavior::ImageCoordinator, false, false),
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let captured = Draft {
            revision: 1,
            attachments: vec![crate::image_attachments::Attachment {
                path: if pasted {
                    crate::image_attachments::pasted_directory()
                        .unwrap()
                        .join(format!("{id}.png"))
                } else {
                    temp.0.join("attachments").join(format!("{id}.png"))
                },
                id,
                hash: "a".repeat(64),
            }],
            ..Default::default()
        };
        store
            .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
            .unwrap();
        let result = super::submit(
            &reqwest::Client::new(),
            &daemon.options,
            &mut store,
            Submission {
                key: "chat:a",
                draft: &captured,
                follow_up: false,
                stop: false,
            },
            &mut None,
            |_| {},
        )
        .await;
        let seen = daemon.seen.lock().unwrap();
        if allowed {
            assert!(result.is_ok());
            assert_eq!(seen.envelopes.len(), 1);
            let payload: Value =
                serde_json::from_str(seen.envelopes[0]["payload"].as_str().unwrap()).unwrap();
            assert_eq!(
                payload["message"],
                crate::image_attachments::message("", &captured.attachments)
            );
        } else {
            assert!(result.unwrap_err().contains("not sent"));
            assert!(seen.envelopes.is_empty());
            assert!(store.book.pending.is_empty());
            assert_eq!(
                store.book.drafts["chat:a"].attachments,
                captured.attachments
            );
        }
    }
}
#[tokio::test]
async fn coordinator_images_keep_exact_delivery_and_drafts_on_refusal_or_unknown() {
    for text in ["", "Review this layout 👩‍💻"] {
        for behavior in [
            Behavior::Accept,
            Behavior::Reject,
            Behavior::LostBeforeAdmission,
            Behavior::Readonly,
            Behavior::BadIdentity,
        ] {
            let daemon = Daemon::start(behavior).await;
            daemon.seen.lock().unwrap().image_coordinator = true;
            let temp = Temp::new();
            let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let draft = Draft {
                revision: 1,
                text: text.into(),
                attachments: vec![crate::image_attachments::Attachment {
                    path: crate::image_attachments::pasted_directory()
                        .unwrap()
                        .join(format!("{id}.png")),
                    id,
                    hash: "a".repeat(64),
                }],
                ..Default::default()
            };
            store
                .save_edits(BTreeMap::from([("chat:a".into(), draft.clone())]))
                .unwrap();
            let result = super::submit(
                &reqwest::Client::new(),
                &daemon.options,
                &mut store,
                Submission {
                    key: "chat:a",
                    draft: &draft,
                    follow_up: false,
                    stop: false,
                },
                &mut None,
                |_| {},
            )
            .await;
            if behavior == Behavior::Accept {
                assert!(result.is_ok(), "{result:?}");
                assert!(store.book.drafts["chat:a"].attachments.is_empty());
            } else {
                assert_eq!(store.book.drafts["chat:a"].attachments, draft.attachments);
                assert_eq!(store.book.drafts["chat:a"].text, text);
            }
            if matches!(behavior, Behavior::Readonly | Behavior::BadIdentity) {
                assert!(result.is_err());
                assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
            } else {
                let seen = daemon.seen.lock().unwrap();
                assert_eq!(seen.envelopes.len(), 1);
                let payload: Value =
                    serde_json::from_str(seen.envelopes[0]["payload"].as_str().unwrap()).unwrap();
                assert_eq!(
                    payload["message"],
                    crate::image_attachments::message(text, &draft.attachments)
                );
            }
            if behavior == Behavior::LostBeforeAdmission {
                drop(store);
                let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
                assert_eq!(store.book.drafts["chat:a"].attachments, draft.attachments);
                assert_eq!(store.book.pending.values().next().unwrap().state, "unknown");
                assert_eq!(
                    daemon.seen.lock().unwrap().envelopes.len(),
                    1,
                    "No replay on reopen"
                );
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Behavior {
    Diagnostic,
    ImageBuild,
    ImageCoordinator,
    AnswerIdle,
    AnswerLost,
    AnswerDelegated,
    Accept,
    Pending,
    Reject,
    LostAccepted,
    LostBeforeAdmission,
    BadIdentity,
    Readonly,
    WrongReceipt,
    Slow,
    LostStop,
    ProjectsUnavailable,
    ProjectRemoved,
    ProjectPathChanged,
    LookupRefused,
    RejectThenLookupRefused,
    ExecuteRefused,
    LookupMalformed,
    LookupOversize,
    LookupTruncated,
    HelloRefused,
    TargetMissing,
    AnswerWorkingLost,
}
#[derive(Default)]
struct Seen {
    image_coordinator: bool,
    bad_identity: bool,
    requests: Vec<(String, String)>,
    operations: BTreeMap<String, Value>,
    envelopes: Vec<Value>,
    executions: usize,
    stops: usize,
    projects: BTreeMap<String, String>,
}
struct Daemon {
    options: LocalOptions,
    seen: Arc<Mutex<Seen>>,
    task: JoinHandle<()>,
}
struct HttpStall {
    path: &'static str,
    claimed: std::sync::atomic::AtomicBool,
    entered: async_channel::Sender<Value>,
    release: async_channel::Receiver<()>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Daemon {
    async fn start(behavior: Behavior) -> Self {
        Self::start_with_stall(behavior, None).await
    }
    async fn start_with_stall(behavior: Behavior, stall: Option<Arc<HttpStall>>) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Seen::default()));
        let record = seen.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((stream,_))=accepted else{break;};let record=record.clone();let stall=stall.clone();
                        tasks.spawn(async move {
                            let mut reader=BufReader::new(stream);let mut first=String::new();reader.read_line(&mut first).await.unwrap();
                            let words:Vec<_>=first.split_whitespace().collect();if words.len()<2{return;}
                            let (method,path)=(words[0].to_string(),words[1].to_string());
                            let mut length=0;
                            loop {let mut line=String::new();if reader.read_line(&mut line).await.unwrap()==0{return;}
                            if line=="\r\n"{break;}
                                assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                                if let Some(value)=line.to_ascii_lowercase().strip_prefix("content-length:"){length=value.trim().parse::<usize>().unwrap();}
                                assert!(length<128*1024);
                            }
                            let mut body=vec![0;length];reader.read_exact(&mut body).await.unwrap();
                            let payload=if body.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&body).unwrap()};
                            let mut stream=reader.into_inner();
                            let reject_then_refuse=behavior==Behavior::RejectThenLookupRefused && path=="/api/operations/receipt" && !record.lock().unwrap().envelopes.is_empty();
                            let fault=if (path=="/api/operations/receipt" && matches!(behavior,Behavior::LookupRefused|Behavior::LookupMalformed|Behavior::LookupOversize|Behavior::LookupTruncated)) || reject_then_refuse
                                || (path=="/api/hello" && behavior==Behavior::HelloRefused)
                                || (path.starts_with("/api/sessions/") && behavior==Behavior::TargetMissing)
                                || (path=="/api/operations" && behavior==Behavior::ExecuteRefused) {
                                Some(match behavior {
                                    Behavior::LookupRefused|Behavior::ExecuteRefused|Behavior::RejectThenLookupRefused|Behavior::HelloRefused=>"HTTP/1.1 503 Unavailable\r\nContent-Length: 31\r\nConnection: close\r\n\r\nprivate provider body /sensitive",
                                    Behavior::TargetMissing=>"HTTP/1.1 404 Not Found\r\nContent-Length: 31\r\nConnection: close\r\n\r\nprivate provider body /sensitive",
                                    Behavior::LookupOversize=>"HTTP/1.1 200 OK\r\nContent-Length: 4194305\r\nConnection: close\r\n\r\nx",
                                    Behavior::LookupTruncated=>"HTTP/1.1 200 OK\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{}",
                                    _=>"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad",
                                })
                            } else {None};
                            if let Some(response)=fault {
                                record.lock().unwrap().requests.push((method.clone(),path.clone()));
                                let _=tokio::time::timeout(Duration::from_secs(1),stream.write_all(response.as_bytes())).await;
                                return;
                            }
                            if behavior==Behavior::Slow&&path=="/api/operations"{tokio::time::sleep(Duration::from_secs(30)).await;return;}
                            let mut lose_response = false;
                            let response={
                                let mut seen=record.lock().unwrap();seen.requests.push((method.clone(),path.clone()));
                                if method=="GET"&&path=="/api/hello" {json!({"daemonId":if behavior==Behavior::BadIdentity||seen.bad_identity{"wrong"}else{"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})}
                                else if method=="GET"&&path=="/api/projects" {
                                    if behavior==Behavior::ProjectsUnavailable {json!({"error":"Synthetic unavailable"})}
                                    else if behavior==Behavior::ProjectRemoved {json!([{"id":"project-a","name":"Synthetic Atlas","path":"/tmp"}])}
                                    else {json!([{"id":"project-a","name":"Synthetic Atlas","path":"/tmp"},{"id":"project-ab","name":"Synthetic Boreal","path":if behavior==Behavior::ProjectPathChanged{"/changed"}else{"/tmp"}}])}
                                }
                                else if method=="GET"&&path.starts_with("/api/sessions/") {
                                    let id=path.rsplit('/').next().unwrap();
                                    json!({"id":id,"mode":if matches!(behavior,Behavior::ImageBuild|Behavior::ImageCoordinator){"build"}else{"ask"},"missionCoordinator":seen.image_coordinator||behavior==Behavior::ImageCoordinator,"control":behavior==Behavior::Readonly,"state":if matches!(behavior,Behavior::AnswerIdle|Behavior::AnswerLost|Behavior::AnswerDelegated){"idle"}else{"working"},"role":if behavior==Behavior::AnswerDelegated{Some("review")}else if behavior==Behavior::Diagnostic{Some("diagnostics")}else{None},"diagnosticScope":if behavior==Behavior::Diagnostic{Some("app")}else{None},"projectId":seen.projects.get(id)})
                                } else if method=="POST"&&path.ends_with("/stop") {
                                    seen.stops+=1;
                                    if behavior==Behavior::LostStop{lose_response=true;}
                                    if behavior==Behavior::WrongReceipt{json!({"ok":true,"draft":{}})}
                                    else {json!({"ok":behavior!=Behavior::Reject,"draft":"synthetic queued input"})}
                                } else if method=="POST"&&matches!(path.as_str(),"/api/operations"|"/api/operations/receipt") {
                                    let id=payload["operationId"].as_str().unwrap().to_string();
                                    assert_eq!(payload["payloadHash"],crate::delivery_store::hash(payload["payload"].as_str().unwrap()));
                                    if path.ends_with("/receipt") {seen.operations.get(&id).cloned().unwrap_or_else(||json!({"state":"unknown"}))}
                                    else {
                                        seen.envelopes.push(payload.clone());
                                        if matches!(behavior,Behavior::LostBeforeAdmission|Behavior::AnswerLost|Behavior::AnswerWorkingLost)&&seen.envelopes.len()==1 {
                                            lose_response = true;
                                            json!({"state":"unknown"})
                                        } else {
                                        let state=if behavior==Behavior::Pending{"pending"}else if matches!(behavior,Behavior::Reject|Behavior::RejectThenLookupRefused){"rejected"}else{"accepted"};
                                        let receipt=json!({"operationId":id,"payloadHash":payload["payloadHash"],"destination":payload["destination"],"targetId":payload["targetId"],"state":state,"result":{"sessionId":payload["targetId"]},"reason":"private provider body /sensitive"});
                                        if !seen.operations.contains_key(&id){
                                            if payload["kind"]=="chat-create"&&state=="accepted" {
                                                let request:Value=serde_json::from_str(payload["payload"].as_str().unwrap()).unwrap();
                                                if let Some(project)=request["projectId"].as_str() {seen.projects.insert(payload["targetId"].as_str().unwrap().into(),project.into());}
                                            }
                                            seen.executions+=1;seen.operations.insert(id.clone(),receipt);
                                        }
                                        if behavior==Behavior::LostAccepted&&seen.envelopes.len()==1 {lose_response = true;}
                                        let mut receipt=seen.operations[&id].clone();
                                        if behavior==Behavior::WrongReceipt {receipt["targetId"]=json!("another-target");}
                                        receipt
                                        }
                                    }
                                } else {panic!("unallowlisted synthetic write route: {method} {path}")}
                            };
                            // Gate the response after admission, not the request before it.
                            // Close can therefore leave a truly accepted send locally Unknown.
                            if let Some(stall) = &stall
                                && path == stall.path
                                && !stall.claimed.swap(true, std::sync::atomic::Ordering::SeqCst)
                            {
                                stall.entered.send(payload.clone()).await.unwrap();
                                if stall.release.recv().await.is_err() { return; }
                            }
                            if lose_response { return; }
                            // The real daemon answers Stop with 202 Accepted.
                            let status=if method=="POST"&&path.ends_with("/stop"){"202 Accepted"}else{"200 OK"};
                            let body=response.to_string();let headers=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                            let _=stream.write_all(headers.as_bytes()).await;
                        });
                    },
                    _=tasks.join_next(),if !tasks.is_empty()=>{}
                }
            }
        });
        Self {
            options,
            seen,
            task,
        }
    }
}
fn draft(revision: u64, text: &str) -> Draft {
    Draft {
        revision,
        text: text.into(),
        cwd: "/tmp".into(),
        project_id: Some("project-a".into()),
        ..Default::default()
    }
}
async fn until(
    rx: &async_channel::Receiver<WriteState>,
    predicate: impl Fn(&WriteState) -> bool,
) -> WriteState {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = rx.recv().await.unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("bounded synthetic courier update")
}
async fn ready(daemon: &Daemon, temp: &Temp) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(daemon.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    (client, updates)
}

#[tokio::test]
async fn composer_controls_send_routes_idle_running_and_explicit_follow_up_without_stop() {
    for behavior in [Behavior::AnswerIdle, Behavior::Accept] {
        for follow_up in [false, true] {
            let daemon = Daemon::start(behavior).await;
            let temp = Temp::new();
            let (client, updates) = ready(&daemon, &temp).await;
            assert!(client.command(WriteCommand::Submit {
                key: "chat:a".into(),
                draft: Box::new(draft(1, "日本語 👩‍💻 e\u{301}")),
                follow_up,
                stop: false,
                request: 1,
            }));
            let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
            assert!(state.error.is_none(), "{:?}", state.error);
            {
                let seen = daemon.seen.lock().unwrap();
                assert_eq!(seen.executions, 1);
                assert_eq!(seen.stops, 0, "Send never cancels current work");
                let envelope = &seen.envelopes[0];
                assert_eq!(envelope["kind"], "chat-send");
                assert_eq!(envelope["targetId"], "a");
                let payload: Value =
                    serde_json::from_str(envelope["payload"].as_str().unwrap()).unwrap();
                assert_eq!(
                    payload["mode"],
                    if follow_up { "followUp" } else { "steer" }
                );
                assert_eq!(payload["message"], "日本語 👩‍💻 e\u{301}");
            }
            assert!(client.command(WriteCommand::Close));
            until(&updates, |s| s.flushed).await;
        }
    }
}

#[tokio::test]
async fn composer_controls_explicit_stop_never_executes_a_send_and_keeps_withdrawn_text() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.command(WriteCommand::Submit {
        key: "chat:a".into(),
        draft: Box::new(draft(1, "newer ordinary draft")),
        follow_up: false,
        stop: true,
        request: 1,
    }));
    let state = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    assert!(state.error.is_none());
    assert_eq!(daemon.seen.lock().unwrap().stops, 1);
    assert_eq!(daemon.seen.lock().unwrap().executions, 0);
    let d = &state.book.as_ref().unwrap().drafts["chat:a"];
    assert_eq!(d.text, "newer ordinary draft");
    assert!(d.recovered.iter().any(|r| r == "synthetic queued input"));
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}
fn submit(client: &Interaction, key: &str, revision: u64, text: &str, request: u64, stop: bool) {
    let draft = draft(revision, text);
    assert!(client.edit(key.into(), draft.clone()));
    assert!(client.command(WriteCommand::Submit {
        key: key.into(),
        draft: Box::new(draft),
        follow_up: true,
        stop,
        request
    }));
}

#[tokio::test]
async fn discarding_a_draft_abandons_its_delivery_and_removes_the_row() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let intent_id = {
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        let captured = draft(1, "undelivered message");
        store
            .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
            .unwrap();
        let intent = store.prepare("chat:a", &captured, false, false).unwrap();
        assert!(store.book.pending.contains_key(&intent.id));
        intent.id
    };
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.command(WriteCommand::Discard {
        key: "chat:a".into(),
        revision: 1
    }));
    let state = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|book| !book.drafts.contains_key("chat:a"))
    })
    .await;
    let book = state.book.unwrap();
    assert!(book.pending.is_empty());
    assert_eq!(book.abandoned, vec![intent_id.clone()]);
    assert!(state.notice.contains("discarded"));
    // The abandoned delivery is never offered for a retry again.
    assert!(client.command(WriteCommand::Check {
        id: intent_id.clone(),
        retry: true
    }));
    let state = until(&updates, |s| s.notice.contains("settled")).await;
    assert!(state.error.is_none());
}

#[tokio::test]
async fn same_folder_projects_use_exact_supported_identity_and_canonical_readback() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    let mut captured = draft(1, "Synthetic project-bound create 日本語");
    captured.project_id = Some("project-ab".into());
    assert!(client.command(WriteCommand::Submit {
        key: "new:project".into(),
        draft: Box::new(captured),
        follow_up: true,
        stop: false,
        request: 1
    }));
    let state = until(&updates, |s| s.handled.get("new:project") == Some(&1)).await;
    let target = state.book.as_ref().unwrap().drafts["new:project"]
        .created
        .clone()
        .unwrap();
    {
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(seen.executions, 1);
        let payload: Value =
            serde_json::from_str(seen.envelopes[0]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload["projectId"], "project-ab");
        assert!(payload.get("cwd").is_none());
        assert_eq!(
            seen.projects.get(&target).map(String::as_str),
            Some("project-ab")
        );
    }
    let readback = read_json(reqwest::Client::new().get(format!(
        "{}/api/sessions/{target}",
        daemon.options.loopback()
    )))
    .await
    .unwrap();
    assert_eq!(readback["projectId"], "project-ab");
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn invalid_or_stale_project_catalog_never_reserves_or_posts_creation() {
    for behavior in [
        Behavior::ProjectsUnavailable,
        Behavior::ProjectRemoved,
        Behavior::ProjectPathChanged,
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        let mut captured = draft(1, "Keep draft when project changes");
        captured.project_id = Some("project-ab".into());
        assert!(client.edit("new:project".into(), captured.clone()));
        assert!(client.command(WriteCommand::Submit {
            key: "new:project".into(),
            draft: Box::new(captured),
            follow_up: true,
            stop: false,
            request: 1
        }));
        let state = until(&updates, |s| s.handled.get("new:project") == Some(&1)).await;
        let book = state.book.as_ref().unwrap();
        assert!(book.pending.is_empty());
        assert_eq!(
            book.drafts["new:project"].text,
            "Keep draft when project changes"
        );
        assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn create_send_and_stop_use_only_allowlisted_user_driven_routes() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(
        daemon.seen.lock().unwrap().requests.is_empty(),
        "load must not send anything"
    );
    submit(&client, "new:slot", 1, "synthetic create", 1, false);
    let accepted = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
    let target = accepted.book.as_ref().unwrap().drafts["new:slot"]
        .created
        .clone()
        .unwrap();
    let key = format!("chat:{target}");
    submit(&client, &key, 1, "synthetic follow-up", 2, false);
    until(&updates, |s| s.handled.get(&key) == Some(&2)).await;
    submit(&client, &key, 2, "unsent composer", 3, true);
    let stopped = until(&updates, |s| s.handled.get(&key) == Some(&3)).await;
    assert_eq!(
        stopped.book.as_ref().unwrap().drafts[&key].text,
        "unsent composer"
    );
    assert_eq!(
        *stopped.book.as_ref().unwrap().drafts[&key].recovered,
        vec!["synthetic queued input"]
    );
    assert!(
        stopped.book.as_ref().unwrap().pending.is_empty(),
        "an accepted Stop settles and never blocks an update"
    );
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 2);
    assert_eq!(seen.stops, 1);
    assert!(!seen.requests.iter().any(|(_, p)| p.ends_with("/messages")
        || p == "/api/sessions"
        || p.contains("archive")
        || p.contains("read-status")));
}

#[tokio::test]
async fn lost_response_is_reconciled_by_receipt_without_duplicate_admission() {
    let daemon = Daemon::start(Behavior::LostAccepted).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "new:slot", 1, "lost response fixture", 1, false);
    let unknown = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
    let id = unknown.book.as_ref().unwrap().drafts["new:slot"]
        .pending
        .clone()
        .unwrap();
    assert_eq!(
        unknown.book.as_ref().unwrap().drafts["new:slot"].text,
        "lost response fixture"
    );
    client.command(WriteCommand::Check {
        id: id.clone(),
        retry: true,
    });
    let accepted = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.pending.is_empty() && b.drafts["new:slot"].created.is_some())
    })
    .await;
    assert!(
        accepted.book.as_ref().unwrap().drafts["new:slot"]
            .text
            .is_empty()
    );
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 1);
    assert_eq!(seen.envelopes.len(), 1);
}

#[tokio::test]
async fn explicit_retry_reuses_original_envelope_when_no_receipt_exists() {
    let daemon = Daemon::start(Behavior::LostBeforeAdmission).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "new:slot", 1, "retry same intent", 1, false);
    let unknown = until(&updates, |s| s.handled.get("new:slot") == Some(&1)).await;
    let id = unknown.book.as_ref().unwrap().drafts["new:slot"]
        .pending
        .clone()
        .unwrap();
    client.command(WriteCommand::Check { id, retry: true });
    until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.pending.is_empty() && b.drafts["new:slot"].created.is_some())
    })
    .await;
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 1);
    assert_eq!(seen.envelopes.len(), 2);
    assert_eq!(seen.envelopes[0], seen.envelopes[1]);
}

#[tokio::test]
async fn pending_never_reposts_and_restart_never_automatically_executes() {
    let daemon = Daemon::start(Behavior::Pending).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "pending fixture", 1, false);
    let pending = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let id = pending.book.as_ref().unwrap().drafts["chat:a"]
        .pending
        .clone()
        .unwrap();
    client.command(WriteCommand::Check {
        id: id.clone(),
        retry: true,
    });
    until(&updates, |s| s.notice.starts_with("Pending:")).await;
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(10)).await;
    let before = daemon.seen.lock().unwrap().requests.len();
    let (client, updates) = ready(&daemon, &temp).await;
    assert_eq!(daemon.seen.lock().unwrap().requests.len(), before);
    client.command(WriteCommand::Check { id, retry: false });
    until(&updates, |s| s.notice.starts_with("Pending:")).await;
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
}

#[tokio::test]
async fn identity_readonly_and_bad_receipt_refuse_without_draft_loss() {
    for behavior in [
        Behavior::BadIdentity,
        Behavior::Readonly,
        Behavior::WrongReceipt,
        Behavior::Reject,
    ] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "retained synthetic draft", 1, false);
        let result = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        assert_eq!(
            result.book.as_ref().unwrap().drafts["chat:a"].text,
            "retained synthetic draft"
        );
        if matches!(behavior, Behavior::BadIdentity | Behavior::Readonly) {
            assert_eq!(daemon.seen.lock().unwrap().executions, 0);
        }
        if behavior == Behavior::WrongReceipt {
            assert!(!result.book.as_ref().unwrap().pending.is_empty());
        }
    }
}

#[tokio::test]
async fn close_flushes_drafts_and_cancels_inflight_request_without_retry() {
    let daemon = Daemon::start(Behavior::Slow).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "close in flight", 1, false);
    until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts.contains_key("chat:a"))
    })
    .await;
    client.edit("chat:b".into(), draft(2, "other latest draft"));
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(10)).await;
    let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(restored.book.drafts["chat:b"].text, "other latest draft");
    assert_eq!(restored.book.drafts["chat:a"].text, "close in flight");
    assert!(daemon.seen.lock().unwrap().executions == 0);
}

#[tokio::test]
async fn uncertain_stop_is_not_replayed_by_check_retry_or_local_acknowledgement() {
    let daemon = Daemon::start(Behavior::LostStop).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "keep composer", 1, true);
    let unknown = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    let id = unknown.book.as_ref().unwrap().drafts["chat:a"]
        .pending
        .clone()
        .unwrap();
    client.command(WriteCommand::Check {
        id: id.clone(),
        retry: true,
    });
    until(&updates, |s| s.notice.starts_with("Stop has no receipt")).await;
    assert_eq!(daemon.seen.lock().unwrap().stops, 1);
    client.command(WriteCommand::DismissStop { id });
    let dismissed = until(&updates, |s| {
        s.book.as_ref().is_some_and(|b| b.pending.is_empty())
    })
    .await;
    assert_eq!(
        dismissed.book.as_ref().unwrap().drafts["chat:a"].text,
        "keep composer"
    );
    assert!(
        dismissed.book.as_ref().unwrap().restart_settled(),
        "a dismissed Stop must not block update install"
    );
    assert_eq!(daemon.seen.lock().unwrap().stops, 1);
}

#[test]
fn autosave_keeps_short_bursts_fast_and_sustained_edits_bounded() {
    let start = tokio::time::Instant::now();
    let ms = |n| start + Duration::from_millis(n);
    let mut save = Autosave::default();
    assert!(save.deadline.is_none());
    save.edited(start);
    assert_eq!(save.deadline, Some(ms(250)));
    save.edited(ms(100));
    assert_eq!(save.deadline, Some(ms(350)));
    for n in [200, 400, 600, 800, 990] {
        save.edited(ms(n));
        assert_eq!(save.deadline, Some(ms((n + 250).min(1000))));
    }
    // Commands and timer flushes both start a fresh bounded batch.
    save = Autosave::default();
    save.edited(ms(1100));
    assert_eq!(save.deadline, Some(ms(1350)));
}

#[test]
fn failed_flush_retains_latest_mailbox_input_and_fences_further_writes() {
    let temp = Temp::new();
    let options = LocalOptions::synthetic(1);
    let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
    store
        .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "committed"))]))
        .unwrap();
    let edits = Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(3, "latest unsaved"),
    )]));
    store.fail_write = true;
    assert!(flush(&mut store, &edits).is_err());
    assert_eq!(edits.lock().unwrap()["chat:a"].revision, 3);
    assert_eq!(store.book.drafts["chat:a"].revision, 1);
    assert!(flush(&mut store, &edits).is_err());
    assert_eq!(edits.lock().unwrap()["chat:a"].text, "latest unsaved");
    drop(store);
    assert_eq!(
        Store::open(temp.0.clone(), options.host())
            .unwrap()
            .book
            .drafts["chat:a"]
            .text,
        "committed"
    );
}

#[tokio::test]
async fn queued_close_bypasses_the_autosave_deadline() {
    let daemon = Daemon::start(Behavior::Accept).await;
    // A ready Close must flush without waiting for any autosave timer.
    let temp = Temp::new();
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (close, close_receiver) = async_channel::bounded(1);
    let (updates, output) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(1, "close now"),
    )])));
    wake.try_send(()).unwrap();
    close.try_send(()).unwrap();
    let task = tokio::spawn(run(
        daemon.options.clone(),
        Ok(store),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits,
            updates,
            replace: output.clone(),
            close: close_receiver,
        },
    ));
    task.await.unwrap();
    assert!(output.recv().await.unwrap().flushed);
    drop(commands);
    let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(restored.book.drafts["chat:a"].text, "close now");
    assert!(daemon.seen.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn disconnected_clients_exit_in_one_poll_even_when_the_final_save_fails() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    for mode in ["healthy", "write-failure", "faulted", "failed-open"] {
        let options = LocalOptions::synthetic(1); // No network commands.
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
        store
            .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "committed"))]))
            .unwrap();
        let committed = fs::read(temp.0.join("state-v1.json")).unwrap();
        let store = match mode {
            "failed-open" => {
                drop(store);
                fs::write(temp.0.join("state-v1.json"), b"{corrupt").unwrap();
                let result = Store::open(temp.0.clone(), options.host());
                assert!(result.is_err());
                result
            }
            "write-failure" | "faulted" => {
                store.fail_write = true;
                if mode == "faulted" {
                    assert!(
                        store
                            .save_edits(BTreeMap::from([("chat:a".into(), draft(2, "failed"))]))
                            .is_err()
                    );
                    assert!(store.is_faulted());
                }
                Ok(store)
            }
            _ => Ok(store),
        };
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, wake_receiver) = async_channel::bounded(1);
        let (close, close_receiver) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let edits = Arc::new(Mutex::new(BTreeMap::from([(
            "chat:a".into(),
            draft(3, "latest unsaved"),
        )])));
        drop((commands, wake, close));
        let mut worker = std::pin::pin!(run(
            options.clone(),
            store,
            WorkerChannels {
                commands: receiver,
                wake: wake_receiver,
                edits: edits.clone(),
                updates,
                replace: output.clone(),
                close: close_receiver,
            }
        ));
        // No wall-clock timeout or scheduler luck: disconnected close must be a
        // terminal branch, not an endless series of ready failed-Close requests.
        assert!(
            matches!(
                worker
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Ready(())
            ),
            "{mode}"
        );
        assert!(
            !output.try_recv().unwrap().flushed,
            "disconnection must not invent a save acknowledgment: {mode}"
        );
        if mode == "healthy" {
            assert!(edits.lock().unwrap().is_empty());
            let restored = Store::open(temp.0.clone(), options.host()).unwrap();
            assert_eq!(restored.book.drafts["chat:a"].revision, 3);
        } else {
            assert_eq!(edits.lock().unwrap()["chat:a"].text, "latest unsaved");
            assert_eq!(
                fs::read(temp.0.join("state-v1.json")).unwrap(),
                if mode == "failed-open" {
                    b"{corrupt".to_vec()
                } else {
                    committed
                }
            );
        }
    }
}

#[tokio::test]
async fn explicit_failed_close_reports_error_waits_without_spinning_and_then_disconnects() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    for failed_open in [false, true] {
        let options = LocalOptions::synthetic(1);
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), options.host()).unwrap();
        store
            .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "committed"))]))
            .unwrap();
        let store = if failed_open {
            drop(store);
            fs::write(temp.0.join("state-v1.json"), b"{corrupt").unwrap();
            let result = Store::open(temp.0.clone(), options.host());
            assert!(result.is_err());
            result
        } else {
            store.fail_write = true;
            Ok(store)
        };
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, wake_receiver) = async_channel::bounded(1);
        let (close, close_receiver) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let edits = Arc::new(Mutex::new(BTreeMap::from([(
            "chat:a".into(),
            draft(2, "keep unsaved input"),
        )])));
        close.try_send(()).unwrap();
        let mut worker = std::pin::pin!(run(
            options,
            store,
            WorkerChannels {
                commands: receiver,
                wake: wake_receiver,
                edits: edits.clone(),
                updates,
                replace: output.clone(),
                close: close_receiver,
            }
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(worker.as_mut().poll(&mut cx), Poll::Pending));
        let error = output.try_recv().unwrap();
        assert!(error.error.is_some());
        assert!(!error.flushed);
        assert_eq!(edits.lock().unwrap()["chat:a"].text, "keep unsaved input");
        // Live clients must have time to inspect/copy the error, not be forced
        // closed or busy-looped merely because their explicit save failed.
        assert!(matches!(worker.as_mut().poll(&mut cx), Poll::Pending));
        assert!(matches!(
            output.try_recv(),
            Err(async_channel::TryRecvError::Empty)
        ));
        drop((commands, wake, close));
        assert!(matches!(worker.as_mut().poll(&mut cx), Poll::Ready(())));
        assert!(output.try_recv().is_err());
    }
}

#[tokio::test]
async fn queued_command_flushes_in_its_first_poll_without_waiting_for_a_timer() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let options = LocalOptions::synthetic(1); // No network work is requested.
    let temp = Temp::new();
    let store = Store::open(temp.0.clone(), options.host()).unwrap();
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (_close, close_receiver) = async_channel::bounded(1);
    let (updates, output) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::from([(
        "chat:a".into(),
        draft(1, "save before action"),
    )])));
    wake.try_send(()).unwrap();
    commands
        .try_send(WriteCommand::RetireEmpty {
            key: "chat:a".into(),
            revision: 0,
        })
        .unwrap();
    let mut worker = std::pin::pin!(run(
        options.clone(),
        Ok(store),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits,
            updates,
            replace: output.clone(),
            close: close_receiver,
        }
    ));
    assert!(matches!(
        worker
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    let status = output.try_recv().unwrap();
    assert_eq!(
        status.book.unwrap().drafts["chat:a"].text,
        "save before action"
    );
    let disk: Book =
        serde_json::from_slice(&fs::read(temp.0.join("state-v1.json")).unwrap()).unwrap();
    assert_eq!(disk.drafts["chat:a"].revision, 1);
}

#[tokio::test]
async fn sustained_edits_autosave_before_idle_and_close_flushes_the_latest() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (commands, receiver) = async_channel::bounded(8);
    let (wake, wake_receiver) = async_channel::bounded(1);
    let (close, close_receiver) = async_channel::bounded(1);
    let (updates_tx, updates) = async_channel::bounded(1);
    let edits = Arc::new(Mutex::new(BTreeMap::new()));
    let client = Interaction {
        commands,
        attachment_root: None,
        pasted_attachment_directory: None,
        edits: edits.clone(),
        wake,
        close,
    };
    let worker = tokio::spawn(run(
        daemon.options.clone(),
        Store::open(temp.0.clone(), daemon.options.host()),
        WorkerChannels {
            commands: receiver,
            wake: wake_receiver,
            edits,
            updates: updates_tx,
            replace: updates.clone(),
            close: close_receiver,
        },
    ));
    until(&updates, |s| s.book.is_some()).await;
    let latest = Arc::new(AtomicU64::new(0));
    let recorded = latest.clone();
    let writer = client.clone();
    let producer = tokio::spawn(async move {
        for revision in 1..=200 {
            assert!(writer.edit(
                "chat:a".into(),
                draft(revision, "synthetic sustained input")
            ));
            recorded.store(revision, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    let saved = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts.contains_key("chat:a"))
    })
    .await;
    assert!(
        !producer.is_finished(),
        "autosave must not wait until continuous typing ends"
    );
    assert!(saved.book.as_ref().unwrap().drafts["chat:a"].revision > 1);
    let disk: Book =
        serde_json::from_slice(&fs::read(temp.0.join("state-v1.json")).unwrap()).unwrap();
    assert!(
        disk.drafts["chat:a"].revision >= saved.book.as_ref().unwrap().drafts["chat:a"].revision
    );
    producer.abort();
    let _ = producer.await;
    let final_revision = latest.load(Ordering::SeqCst) + 1;
    assert!(client.edit(
        "chat:a".into(),
        draft(final_revision, "final unsaved input")
    ));
    assert!(client.command(WriteCommand::Close));
    let closed = until(&updates, |s| s.flushed).await;
    assert_eq!(
        closed.book.unwrap().drafts["chat:a"].revision,
        final_revision
    );
    drop(client);
    // Join before reopening: channel/status delivery alone does not guarantee
    // that the worker has dropped the persistent ownership lock yet.
    worker.await.unwrap();
    let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert_eq!(restored.book.drafts["chat:a"].text, "final unsaved input");
    assert_eq!(restored.book.drafts["chat:a"].revision, final_revision);
    assert!(daemon.seen.lock().unwrap().requests.is_empty());
}

#[test]
#[ignore = "explicit isolated synthetic autosave disk replay, not real-time or GUI evidence"]
fn coalesced_snapshot_writer_workload() {
    use crate::delivery_store::{DRAFT_CAP, TEXT_CAP};
    use std::os::unix::fs::MetadataExt;
    struct Observation {
        writes: u64,
        bytes: u64,
        elapsed: Duration,
    }
    let replay = |legacy: bool| {
        let temp = Temp::new();
        let mut store = Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).unwrap();
        let text = "x".repeat(TEXT_CAP);
        store
            .save_edits(
                (0..DRAFT_CAP)
                    .map(|i| (format!("chat:synthetic-{i}"), draft(1, &text)))
                    .collect(),
            )
            .unwrap();
        let edits = Mutex::new(BTreeMap::new());
        let mut writes = 0;
        let mut bytes = 0;
        let mut persist = |store: &mut Store| {
            let path = temp.0.join("state-v1.json");
            let before = fs::metadata(&path).unwrap().ino();
            flush(store, &edits).unwrap();
            let after = fs::metadata(path).unwrap();
            if before != after.ino() {
                writes += 1;
                bytes += after.len();
            }
        };
        let start = tokio::time::Instant::now();
        let wall = std::time::Instant::now();
        let mut autosave = Autosave::default();
        // Identical 10 logical seconds of sustained 20 Hz edits. Advance a
        // logical clock, but actually serialize/fsync/rename every due snapshot.
        for tick in 0..200 {
            let now = start + Duration::from_millis(tick * 50);
            if autosave.deadline.is_some_and(|due| due <= now) {
                persist(&mut store);
                autosave = Autosave::default();
            }
            edits
                .lock()
                .unwrap()
                .insert("chat:synthetic-0".into(), draft(tick + 2, &text));
            if legacy {
                // Exact previous first-edit + 250ms fixed batching policy.
                autosave
                    .deadline
                    .get_or_insert(now + Duration::from_millis(250));
            } else {
                autosave.edited(now);
            }
        }
        // Normal close always saves the latest input, even before an idle timer.
        persist(&mut store);
        let elapsed = wall.elapsed();
        assert_eq!(store.book.drafts["chat:synthetic-0"].revision, 201);
        drop(store);
        let restored = Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).unwrap();
        assert_eq!(restored.book.drafts["chat:synthetic-0"].revision, 201);
        assert_eq!(restored.book.drafts["chat:synthetic-0"].text, text);
        Observation {
            writes,
            bytes,
            elapsed,
        }
    };
    let before = replay(true);
    let after = replay(false);
    assert_eq!(before.writes, 40);
    assert_eq!(after.writes, 10);
    assert!(after.bytes * 3 < before.bytes);
    for (label, observation) in [("legacy250ms", before), ("idle250ms/max1s", after)] {
        eprintln!(
            "Synthetic 128x32KiB / 10 logical seconds / 200 edits {label}: {} atomic replacements; {} encoded bytes; {:.3} ms actual replay wall",
            observation.writes,
            observation.bytes,
            observation.elapsed.as_secs_f64() * 1000.
        );
    }
}
