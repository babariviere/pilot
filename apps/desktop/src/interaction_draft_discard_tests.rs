//! Private synthetic snapshots only, never the user's draft directory.
use super::*;

#[tokio::test]
async fn discard_new_flushes_autosave_and_stays_removed_after_relaunch() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    for (key, text) in [("new:empty", ""), ("new:populated", "Unsent 日本語 👩‍💻")] {
        assert!(client.edit("new:other".into(), draft(2, "Keep other draft")));
        assert!(client.edit("chat:a".into(), draft(3, "Keep sent chat composer")));
        assert!(client.edit(key.into(), draft(4, text)));
        // The explicit command overtakes the autosave timer and flushes the mailbox.
        assert!(client.command(WriteCommand::DiscardNew {
            key: key.into(),
            revision: 4,
            request: 1,
        }));
        let state = until(&updates, |s| {
            s.discard
                .as_ref()
                .is_some_and(|(k, r, _, result)| k == key && *r == 4 && result.is_ok())
        })
        .await;
        assert!(!state.book.unwrap().drafts.contains_key(key));
    }
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    while updates.recv().await.is_ok() {}
    drop(client);
    let store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
    assert!(!store.book.drafts.contains_key("new:empty"));
    assert!(!store.book.drafts.contains_key("new:populated"));
    assert_eq!(store.book.drafts["new:other"].text, "Keep other draft");
    assert_eq!(store.book.drafts["chat:a"].text, "Keep sent chat composer");
    assert!(store.book.pending.is_empty());
}

#[tokio::test]
async fn discard_new_reply_keeps_exact_attempt_after_refusal_and_retry() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.edit("new:retry".into(), draft(2, "Retain newer content")));
    assert!(client.command(WriteCommand::DiscardNew {
        key: "new:retry".into(),
        revision: 1,
        request: 10
    }));
    let refused = until(&updates, |s| {
        s.discard
            .as_ref()
            .is_some_and(|(_, _, request, result)| *request == 10 && result.is_err())
    })
    .await;
    assert!(
        refused
            .book
            .as_ref()
            .unwrap()
            .drafts
            .contains_key("new:retry")
    );
    assert!(client.command(WriteCommand::DiscardNew {
        key: "new:retry".into(),
        revision: 2,
        request: 11
    }));
    let deleted = until(&updates, |s| {
        s.discard
            .as_ref()
            .is_some_and(|(_, revision, request, result)| {
                *revision == 2 && *request == 11 && result.is_ok()
            })
    })
    .await;
    assert!(
        !deleted
            .book
            .as_ref()
            .unwrap()
            .drafts
            .contains_key("new:retry")
    );
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    while updates.recv().await.is_ok() {}
}

#[tokio::test]
async fn discard_new_refuses_stale_revision_and_chat_or_delivery_slots() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let temp = Temp::new();
    {
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        store
            .save_edits(BTreeMap::from([
                ("new:pending".into(), draft(1, "Original delivery")),
                (
                    "new:created".into(),
                    Draft {
                        created: Some("created-chat".into()),
                        ..draft(1, "Keep created slot")
                    },
                ),
            ]))
            .unwrap();
        store
            .prepare("new:pending", &draft(1, "Original delivery"), false, false)
            .unwrap();
    }
    let (client, updates) = ready(&daemon, &temp).await;
    for (key, revision) in [
        ("new:stale", 1),
        ("chat:a", 2),
        ("new:pending", 1),
        ("new:created", 1),
    ] {
        if key == "new:stale" || key == "chat:a" {
            assert!(client.edit(key.into(), draft(2, "Retain newer content")));
        }
        assert!(client.command(WriteCommand::DiscardNew {
            key: key.into(),
            revision,
            request: 1,
        }));
        let state = until(&updates, |s| {
            s.discard
                .as_ref()
                .is_some_and(|(k, r, _, result)| k == key && *r == revision && result.is_err())
        })
        .await;
        assert!(state.book.as_ref().unwrap().drafts.contains_key(key));
        assert_eq!(state.book.as_ref().unwrap().pending.len(), 1);
    }
    assert!(client.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    while updates.recv().await.is_ok() {}
}
