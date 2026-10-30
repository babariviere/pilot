//! Ordinary Send uses the real worker, temporary durable state and gated faux HTTP.
use super::*;

async fn stalled(
    behavior: Behavior,
    path: &'static str,
) -> (
    Daemon,
    async_channel::Receiver<Value>,
    async_channel::Sender<()>,
) {
    let (entered, arrived) = async_channel::bounded(1);
    let (release, released) = async_channel::bounded(1);
    let stall = Arc::new(HttpStall {
        path,
        claimed: std::sync::atomic::AtomicBool::new(false),
        entered,
        release: released,
    });
    (
        Daemon::start_with_stall(behavior, Some(stall)).await,
        arrived,
        release,
    )
}

async fn arrived(receiver: &async_channel::Receiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("Send reached gated HTTP")
        .unwrap()
}

fn disk(temp: &Temp) -> Book {
    serde_json::from_slice(&fs::read(temp.0.join("state-v1.json")).unwrap()).unwrap()
}

async fn disconnected(client: Interaction, updates: async_channel::Receiver<WriteState>) {
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates.recv().await.is_ok() {}
    })
    .await
    .expect("writer released ownership");
}

#[tokio::test]
async fn ordinary_send_autosaves_exact_newer_input_before_preflight_and_delivery_resume() {
    for (key, path, behavior) in [
        ("chat:a", "/api/hello", Behavior::Accept),
        ("chat:a", "/api/sessions/a", Behavior::Accept),
        ("new:wait", "/api/projects", Behavior::Accept),
        ("chat:a", "/api/operations/receipt", Behavior::Accept),
        ("chat:a", "/api/operations", Behavior::Accept),
        ("new:wait", "/api/operations", Behavior::Accept),
        ("chat:a", "/api/operations", Behavior::LostAccepted),
        ("chat:a", "/api/operations", Behavior::LostBeforeAdmission),
        ("chat:a", "/api/operations", Behavior::Pending),
        ("chat:a", "/api/operations", Behavior::Reject),
        ("chat:a", "/api/operations", Behavior::WrongReceipt),
    ] {
        let (daemon, reached, release) = stalled(behavior, path).await;
        let temp = Temp::new();
        // A question answer is a separate existing owner. Pending delivery
        // intentionally freezes that answer while ordinary text remains editable.
        let mut original = draft(1, "Original 日本語 👩‍💻");
        original.answer = key.starts_with("chat:").then(|| {
            crate::question::AnswerDraft::capture(
                &question_answer_fixture(),
                1,
                std::collections::BTreeSet::from([1]),
                "unsent answer".into(),
            )
            .unwrap()
        });
        {
            let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
            store
                .save_edits(BTreeMap::from([(key.into(), original.clone())]))
                .unwrap();
        }
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, key, 1, "Original 日本語 👩‍💻", 1, false);
        let envelope = arrived(&reached).await;
        let reserved = disk(&temp).pending.values().next().cloned();
        assert_eq!(reserved.is_some(), path.starts_with("/api/operations"));

        let mut newer = draft(2, "Newer 未送信 e\u{301} 🦀");
        newer.answer = original.answer.clone();
        assert!(client.edit(key.into(), newer.clone()));
        assert!(client.edit("chat:other".into(), draft(4, "Other exact 日本語")));
        // This is the production autosave acknowledgment, not a forced checkpoint.
        let saved = until(&updates, |s| {
            s.error.is_some()
                || s.book.as_ref().is_some_and(|b| {
                    b.drafts.get(key).is_some_and(|d| d.revision == 2)
                        && b.drafts.get("chat:other").is_some_and(|d| d.revision == 4)
                })
        })
        .await;
        assert!(
            saved.error.is_none(),
            "{key} {path} {behavior:?}: {:?}",
            saved.error
        );
        assert!(!saved.handled.contains_key(key), "HTTP is still held");
        let before = disk(&temp);
        assert!(saved.book.as_ref().unwrap().as_ref() == &before);
        assert_eq!(before.drafts[key].text, newer.text);
        assert!(before.drafts[key].answer == newer.answer);
        assert_eq!(before.drafts["chat:other"].text, "Other exact 日本語");
        if let Some(intent) = &reserved {
            assert!(before.pending[&intent.id] == *intent);
            assert_eq!(
                envelope,
                serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap()
            );
        }
        assert_eq!(
            daemon.seen.lock().unwrap().executions,
            usize::from(path == "/api/operations" && behavior != Behavior::LostBeforeAdmission)
        );

        release.send(()).await.unwrap();
        let settled = until(&updates, |s| s.handled.get(key) == Some(&1)).await;
        let book = settled.book.as_ref().unwrap();
        assert_eq!(book.drafts[key].text, newer.text);
        assert_eq!(book.drafts[key].revision, 2);
        assert!(
            book.drafts[key].answer == newer.answer,
            "Send cannot consume a question answer"
        );
        assert_eq!(book.drafts["chat:other"].revision, 4);
        if matches!(
            behavior,
            Behavior::LostAccepted | Behavior::LostBeforeAdmission | Behavior::WrongReceipt
        ) {
            let intent = book.pending.values().next().unwrap();
            assert_eq!(intent.state, "unknown");
            assert_eq!(intent.revision, 1);
        } else if behavior == Behavior::Pending {
            assert_eq!(book.pending.values().next().unwrap().state, "pending");
        } else {
            assert!(book.pending.is_empty());
            assert_eq!(
                book.drafts[key].last.as_ref().unwrap().state,
                if behavior == Behavior::Reject {
                    "rejected"
                } else {
                    "accepted"
                }
            );
        }
        {
            let seen = daemon.seen.lock().unwrap();
            assert_eq!(
                seen.envelopes.len(),
                1,
                "lost or mismatched ACK never replays"
            );
            let payload: Value =
                serde_json::from_str(seen.envelopes[0]["payload"].as_str().unwrap()).unwrap();
            assert_eq!(payload["message"], "Original 日本語 👩‍💻");
            assert_eq!(seen.stops, 0);
        }
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
        let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        assert!(restored.book == *book.as_ref());
    }
}

#[tokio::test]
async fn ordinary_send_keeps_second_mutation_stop_and_checkpoint_in_fifo_order() {
    for second_key in ["chat:a", "chat:b"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations").await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "first", 1, false);
        arrived(&reached).await;
        submit(&client, second_key, 2, "second", 2, false);
        assert!(client.command(WriteCommand::Submit {
            key: "chat:a".into(),
            draft: Box::new(draft(3, "unsent Stop composer")),
            follow_up: false,
            stop: true,
            request: 3,
        }));
        assert!(client.command(WriteCommand::Checkpoint(77)));
        let saved = until(&updates, |s| {
            s.book
                .as_ref()
                .is_some_and(|b| b.drafts.get(second_key).is_some_and(|d| d.revision == 2))
        })
        .await;
        assert!(saved.handled.is_empty());
        assert_eq!(
            saved.checkpoint, None,
            "checkpoint cannot certify an in-flight Send"
        );
        assert_eq!(client.commands.len(), 3);
        assert_eq!(disk(&temp).drafts[second_key].text, "second");
        assert_eq!(daemon.seen.lock().unwrap().stops, 0);
        release.send(()).await.unwrap();
        let settled = until(&updates, |s| s.checkpoint == Some(77)).await;
        assert_eq!(settled.handled.get("chat:a"), Some(&3));
        assert_eq!(
            settled.book.as_ref().unwrap().drafts["chat:a"].text,
            "unsent Stop composer"
        );
        {
            let seen = daemon.seen.lock().unwrap();
            assert_eq!(seen.envelopes.len(), 2);
            assert_eq!(seen.envelopes[0]["sequence"], 1);
            assert_eq!(seen.envelopes[1]["sequence"], 2);
            assert_eq!(
                seen.envelopes[1]["targetId"],
                second_key.strip_prefix("chat:").unwrap()
            );
            assert_eq!(seen.stops, 1);
            let mutations: Vec<_> = seen
                .requests
                .iter()
                .filter(|(_, p)| p == "/api/operations" || p.ends_with("/stop"))
                .map(|(_, p)| p.as_str())
                .collect();
            assert_eq!(
                mutations,
                ["/api/operations", "/api/operations", "/api/sessions/a/stop"]
            );
        }
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn ordinary_send_close_cancels_gated_http_despite_saturated_mutation_queue() {
    for path in ["/api/hello", "/api/operations/receipt", "/api/operations"] {
        let (daemon, reached, _release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "original", 1, false);
        arrived(&reached).await;
        for request in 2..=9 {
            assert!(client.command(WriteCommand::Submit {
                key: "chat:a".into(),
                draft: Box::new(draft(request, "queued Stop")),
                follow_up: false,
                stop: true,
                request,
            }));
        }
        assert!(!client.command(WriteCommand::Checkpoint(88)));
        assert!(client.edit("chat:a".into(), draft(20, "latest unsaved 日本語")));
        assert!(client.edit("chat:other".into(), draft(21, "other unsaved")));
        assert!(client.command(WriteCommand::Close));
        let closed = until(&updates, |s| s.flushed).await;
        assert_eq!(closed.checkpoint, None);
        assert_eq!(closed.handled.get("chat:a"), Some(&1));
        disconnected(client, updates).await;
        let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        assert_eq!(restored.book.drafts["chat:a"].text, "latest unsaved 日本語");
        assert_eq!(restored.book.drafts["chat:other"].text, "other unsaved");
        assert_eq!(
            restored.book.pending.len(),
            usize::from(path != "/api/hello")
        );
        assert!(restored.book.pending.values().all(|i| i.state == "unknown"));
        assert_eq!(daemon.seen.lock().unwrap().stops, 0);
        assert_eq!(
            daemon.seen.lock().unwrap().executions,
            usize::from(path == "/api/operations")
        );
    }
}

#[tokio::test]
async fn ordinary_send_io_fault_fences_dispatch_but_retains_an_already_issued_exact_ack() {
    for path in ["/api/hello", "/api/operations/receipt", "/api/operations"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, path).await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "durable original", 1, false);
        arrived(&reached).await;
        let snapshot = temp.0.join("state-v1.json");
        let backup = temp.0.join("before-fault.json");
        let committed = fs::read(&snapshot).unwrap();
        // A real rename failure confined to this fixture, not a production hook.
        fs::rename(&snapshot, &backup).unwrap();
        fs::create_dir(&snapshot).unwrap();
        assert!(client.edit("chat:a".into(), draft(2, "unsaved newer 日本語")));
        assert!(client.edit("chat:other".into(), draft(3, "unsaved other")));
        let failed = until(&updates, |s| s.error.is_some()).await;
        assert!(!failed.flushed);
        assert!(!failed.handled.contains_key("chat:a"));
        assert_eq!(
            client.edits.lock().unwrap()["chat:a"].text,
            "unsaved newer 日本語"
        );
        release.send(()).await.unwrap();
        let settled = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        assert!(settled.error.is_some());
        assert!(!settled.flushed);
        assert_eq!(
            settled.book.as_ref().unwrap().drafts["chat:a"].text,
            "durable original"
        );
        assert_eq!(
            client.edits.lock().unwrap()["chat:other"].text,
            "unsaved other"
        );
        let dispatched = path == "/api/operations";
        assert_eq!(
            daemon.seen.lock().unwrap().envelopes.len(),
            usize::from(dispatched)
        );
        if dispatched {
            let report = settled.delivery_reports.values().next().unwrap();
            let diagnostic = report.delivery.diagnostic.unwrap();
            assert_eq!(diagnostic.acknowledgment, Acknowledgment::Accepted);
            assert_eq!(diagnostic.category, Category::PrivateWrite);
            assert!(!report.saved);
            assert_eq!(settled.book.as_ref().unwrap().pending.len(), 1);
        }
        disconnected(client, updates).await;
        assert_eq!(fs::read(&backup).unwrap(), committed);
        fs::remove_dir(&snapshot).unwrap();
        fs::rename(&backup, &snapshot).unwrap();
        let restored = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        assert_eq!(restored.book.drafts["chat:a"].revision, 1);
        assert_eq!(
            restored.book.pending.len(),
            usize::from(path != "/api/hello")
        );
    }
}

#[tokio::test]
async fn ordinary_send_capacity_failure_retains_mailbox_and_does_not_authorize_dispatch() {
    for path in ["/api/operations/receipt", "/api/operations"] {
        let (daemon, reached, release) = stalled(Behavior::Accept, path).await;
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
        let (client, updates) = ready(&daemon, &temp).await;
        submit(&client, "chat:a", 1, "original", 1, false);
        arrived(&reached).await;
        assert!(client.edit("chat:a".into(), draft(2, "unsaved capacity text")));
        // Two existing rows plus127 new rows exceed the durable128-row cap.
        for i in 0..crate::delivery_store::DRAFT_CAP - 1 {
            assert!(client.edit(format!("chat:capacity-{i}"), draft(1, "unsaved other")));
        }
        let failed = until(&updates, |s| s.error.is_some()).await;
        assert!(!failed.handled.contains_key("chat:a"));
        assert_eq!(
            client.edits.lock().unwrap().len(),
            crate::delivery_store::DRAFT_CAP
        );
        assert_eq!(disk(&temp).drafts.len(), 2);
        release.send(()).await.unwrap();
        let settled = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
        assert!(settled.error.is_some());
        assert_eq!(
            client.edits.lock().unwrap()["chat:a"].text,
            "unsaved capacity text"
        );
        let dispatched = path == "/api/operations";
        assert_eq!(
            daemon.seen.lock().unwrap().envelopes.len(),
            usize::from(dispatched)
        );
        let report = settled.delivery_reports.values().next().unwrap();
        let diagnostic = report.delivery.diagnostic.unwrap();
        assert_eq!(
            diagnostic.acknowledgment,
            if dispatched {
                Acknowledgment::Accepted
            } else {
                Acknowledgment::Unknown
            }
        );
        if !dispatched {
            assert_eq!(diagnostic.category, Category::PrivateState);
        }
        assert_eq!(
            settled.book.as_ref().unwrap().pending.len(),
            usize::from(!dispatched)
        );
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn ordinary_send_rechecks_local_identity_after_post_reservation_wait() {
    let (daemon, reached, release) = stalled(Behavior::Accept, "/api/operations/receipt").await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    submit(&client, "chat:a", 1, "reserved original", 1, false);
    arrived(&reached).await;
    let original = disk(&temp).pending.values().next().unwrap().clone();
    assert!(client.edit("chat:a".into(), draft(2, "newer input")));
    until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts["chat:a"].revision == 2)
    })
    .await;
    daemon.seen.lock().unwrap().bad_identity = true;
    release.send(()).await.unwrap();
    let settled = until(&updates, |s| s.handled.get("chat:a") == Some(&1)).await;
    assert_eq!(
        settled.book.as_ref().unwrap().drafts["chat:a"].text,
        "newer input"
    );
    let retained = &settled.book.as_ref().unwrap().pending[&original.id];
    assert!(retained.operation == original.operation);
    assert_eq!(retained.state, "unknown");
    assert_eq!(
        settled.delivery_reports[&original.id]
            .delivery
            .diagnostic
            .unwrap()
            .category,
        Category::Identity
    );
    assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    disconnected(client, updates).await;
}
