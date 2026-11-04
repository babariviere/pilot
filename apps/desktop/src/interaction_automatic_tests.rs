//! Background recovery uses real private state and a faux daemon, never user data.
use super::*;

#[tokio::test]
async fn explicit_offline_question_reply_recovers_its_atomic_question_id() {
    let daemon = Daemon::start(Behavior::AnswerLost).await;
    {
        let mut seen = daemon.seen.lock().unwrap();
        seen.offline = true;
        seen.question_replies = true;
    }
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
    assert!(intent.automatic.is_some());
    let payload: Value = serde_json::from_str(&intent.operation.as_ref().unwrap().payload).unwrap();
    assert_eq!(payload["questionReplyId"], 4);
    daemon.seen.lock().unwrap().offline = false;
    // The first connected execution loses its ACK before admission. Recovery
    // reuses this same question-fenced envelope, not the latest projected ask.
    let settled = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = updates.recv().await.unwrap();
            if state.book.as_ref().is_some_and(|b| b.pending.is_empty()) {
                break state;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        settled.book.as_ref().unwrap().drafts["chat:a"].text,
        "Keep ordinary 日本語 👩‍💻"
    );
    assert_eq!(daemon.seen.lock().unwrap().executions, 1);
    assert!(
        daemon
            .seen
            .lock()
            .unwrap()
            .envelopes
            .iter()
            .all(|op| *op == serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap())
    );
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn attachment_capture_refuses_changed_bytes_and_recovers_only_the_original() {
    let daemon = Daemon::start(Behavior::ImageBuild).await;
    daemon.seen.lock().unwrap().offline = true;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        2,
        2,
        image::Rgba([10, 20, 30, 255]),
    ))
    .write_to(&mut bytes, image::ImageFormat::Png)
    .unwrap();
    let attachments = crate::image_attachments::save(
        &temp.0,
        vec![crate::image_attachments::Incoming::Bytes(
            bytes.into_inner(),
        )],
    )
    .unwrap();
    let original = fs::read(&attachments[0].path).unwrap();
    let path = attachments[0].path.clone();
    let mut captured = draft(1, "exact attachment");
    captured.attachments = attachments;
    client.command(WriteCommand::Submit {
        key: "chat:a".into(),
        draft: Box::new(captured),
        follow_up: false,
        stop: false,
        request: 1,
    });
    until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    fs::write(&path, b"changed bytes").unwrap();
    daemon.seen.lock().unwrap().offline = false;
    until(&updates, |s| s.notice.starts_with("Attached image changed")).await;
    assert_eq!(daemon.seen.lock().unwrap().executions, 0);
    fs::write(&path, original).unwrap();
    until(&updates, |s| {
        s.book.as_ref().is_some_and(|b| b.pending.is_empty())
    })
    .await;
    assert_eq!(daemon.seen.lock().unwrap().executions, 1);
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn offline_capture_preserves_input_and_recovers_on_reconnection() {
    for key in ["new:offline", "chat:a"] {
        let daemon = Daemon::start(Behavior::Accept).await;
        daemon.seen.lock().unwrap().offline = true;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, key, 1, "retain exact offline input", 1, false);
        let state = until(&updates, |s| s.handled.get(key) == Some(&1)).await;
        let intent = state
            .book
            .as_ref()
            .unwrap()
            .pending
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(intent.automatic.is_some());
        assert_eq!(
            state.book.as_ref().unwrap().drafts[key].text,
            "retain exact offline input"
        );
        daemon.seen.lock().unwrap().offline = false;
        let state = until(&updates, |s| {
            s.book.as_ref().is_some_and(|b| b.pending.is_empty())
        })
        .await;
        assert_eq!(
            state.book.as_ref().unwrap().drafts[key]
                .last
                .as_ref()
                .unwrap()
                .id,
            intent.id
        );
        assert_eq!(daemon.seen.lock().unwrap().executions, 1);
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn discard_cancels_automatic_retry_without_claiming_nonacceptance() {
    let daemon = Daemon::start(Behavior::LostBeforeAdmission).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "cancel this capture", 1, false);
    until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    client.command(WriteCommand::Discard {
        key: "chat:a".into(),
        revision: 1,
    });
    until(&updates, |s| {
        s.book.as_ref().is_some_and(|b| b.pending.is_empty())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(daemon.seen.lock().unwrap().envelopes.len(), 1);
    assert_eq!(daemon.seen.lock().unwrap().executions, 0);
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn distinct_identical_creations_keep_distinct_operations_and_targets() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    for key in ["new:first", "new:second"] {
        submit(&client, key, 1, "identical text", 1, false);
        until(&updates, |s| s.handled.get(key) == Some(&1)).await;
    }
    let seen = daemon.seen.lock().unwrap();
    assert_eq!(seen.executions, 2);
    assert_ne!(
        seen.envelopes[0]["operationId"],
        seen.envelopes[1]["operationId"]
    );
    assert_ne!(seen.envelopes[0]["targetId"], seen.envelopes[1]["targetId"]);
    drop(seen);
    client.command(WriteCommand::Close);
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn lost_ack_and_nonadmission_recover_without_a_user_check() {
    for behavior in [Behavior::LostAccepted, Behavior::LostBeforeAdmission] {
        let daemon = Daemon::start(behavior).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "exact 日本語 👩‍💻", 1, false);
        let saved = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        let intent = saved
            .book
            .as_ref()
            .unwrap()
            .pending
            .values()
            .next()
            .unwrap()
            .clone();
        assert!(intent.automatic.is_some());
        let settled = until(&updates, |s| {
            s.book.as_ref().is_some_and(|b| b.pending.is_empty())
        })
        .await;
        assert_eq!(
            settled.book.unwrap().drafts["chat:a"]
                .last
                .as_ref()
                .unwrap()
                .state,
            "accepted"
        );
        let seen = daemon.seen.lock().unwrap();
        assert_eq!(seen.executions, 1);
        assert!(
            seen.envelopes
                .iter()
                .all(|e| *e == serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap())
        );
        drop(seen);
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn create_and_chat_resume_same_saved_operation_after_writer_restart() {
    for key in ["new:recover", "chat:a"] {
        let daemon = Daemon::start(Behavior::LostBeforeAdmission).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, key, 1, "same words", 1, false);
        let saved = until(&updates, |s| s.handled.get(key) == Some(&1)).await;
        let intent = saved
            .book
            .as_ref()
            .unwrap()
            .pending
            .values()
            .next()
            .unwrap()
            .clone();
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
        send_waits::disconnected(client, updates).await;
        let (client, updates) = ready(&daemon, &temp).await;
        let settled = until(&updates, |s| {
            s.book.as_ref().is_some_and(|b| b.pending.is_empty())
        })
        .await;
        assert_eq!(
            settled.book.as_ref().unwrap().drafts[key]
                .last
                .as_ref()
                .unwrap()
                .id,
            intent.id
        );
        assert_eq!(daemon.seen.lock().unwrap().executions, 1);
        if key.starts_with("new:") {
            assert_eq!(
                settled.book.as_ref().unwrap().drafts[key]
                    .created
                    .as_deref(),
                Some(intent.target.as_str())
            );
        }
        client.command(WriteCommand::Close);
        until(&updates, |s| s.flushed).await;
    }
}

#[tokio::test]
async fn historical_unknown_is_never_opted_into_background_replay() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let retained = {
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        store
            .prepare("chat:a", &draft(1, "historical unknown"), false, false)
            .unwrap()
    };
    assert!(retained.automatic.is_none());
    let (client, updates) = ready(&daemon, &temp).await;
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert!(daemon.seen.lock().unwrap().requests.is_empty());
    client.command(WriteCommand::Close);
    let state = until(&updates, |s| s.flushed).await;
    assert!(state.book.unwrap().pending.contains_key(&retained.id));
}
