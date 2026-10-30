//! Catalog refresh runs through the real writer and a gated faux HTTP response.
use super::send_waits::{arrived, disconnected, disk, stalled};
use super::*;
use crate::project_registration::Outcome;

#[tokio::test]
async fn catalog_autosaves_and_keeps_commands_fifo() {
    for behavior in [Behavior::Accept, Behavior::ProjectsUnavailable] {
        let (daemon, reached, release) = stalled(behavior, "/api/projects").await;
        let temp = Temp::new();
        let (client, updates) = ready(&daemon, &temp).await;
        assert!(client.command(WriteCommand::Project {
            id: "read".into(),
            path: None
        }));
        arrived(&reached).await;
        assert!(client.command(WriteCommand::Checkpoint(77)));
        assert!(client.edit("chat:a".into(), draft(2, "newer")));
        assert!(client.edit("chat:other".into(), draft(3, "other")));
        let saved = tokio::time::timeout(
            Duration::from_secs(2),
            until(&updates, |s| {
                s.book.as_ref().is_some_and(|b| {
                    b.drafts.get("chat:a").is_some_and(|d| d.revision == 2)
                        && b.drafts.get("chat:other").is_some_and(|d| d.revision == 3)
                })
            }),
        )
        .await
        .expect("drafts must persist while catalog response is held");
        let pending = saved.project.as_ref().unwrap();
        assert_eq!(pending.result, Ok(Outcome::Pending));
        assert!(pending.catalog.is_none());
        assert_eq!(saved.checkpoint, None);
        assert_eq!(client.commands.len(), 1);
        assert_eq!(disk(&temp).drafts["chat:a"].text, "newer");
        assert_eq!(disk(&temp).drafts["chat:other"].text, "other");
        release.send(()).await.unwrap();
        let done = until(&updates, |s| s.checkpoint == Some(77)).await;
        assert!(done.error.is_none());
        let reply = done.project.unwrap();
        assert_eq!(reply.id, "read");
        assert_eq!(reply.result, Ok(Outcome::Read));
        let catalog = reply.catalog.unwrap();
        if behavior == Behavior::Accept {
            assert_eq!(catalog.unwrap().len(), 2);
        } else {
            assert!(catalog.is_err());
        }
        assert!(client.command(WriteCommand::Close));
        until(&updates, |s| s.flushed).await;
        disconnected(client, updates).await;
    }
}

#[tokio::test]
async fn catalog_close_flushes_and_cancels_held_read() {
    let (daemon, reached, _release) = stalled(Behavior::Accept, "/api/projects").await;
    let temp = Temp::new();
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.command(WriteCommand::Project {
        id: "read".into(),
        path: None
    }));
    arrived(&reached).await;
    assert!(client.command(WriteCommand::Checkpoint(77)));
    assert!(client.edit("chat:a".into(), draft(2, "close saves")));
    assert!(client.command(WriteCommand::Close));
    let closed = until(&updates, |s| s.flushed).await;
    assert_eq!(closed.checkpoint, None);
    assert_eq!(disk(&temp).drafts["chat:a"].text, "close saves");
    let project = closed.project.unwrap();
    assert_eq!(project.result, Ok(Outcome::Pending));
    assert!(project.catalog.is_none());
    disconnected(client, updates).await;
}

#[tokio::test]
async fn catalog_disk_fault_preserves_read_result_and_fences_queued_command() {
    let (daemon, reached, release) = stalled(Behavior::Accept, "/api/projects").await;
    let temp = Temp::new();
    {
        let mut store = Store::open(temp.0.clone(), daemon.options.host()).unwrap();
        store
            .save_edits(BTreeMap::from([("chat:a".into(), draft(1, "durable"))]))
            .unwrap();
    }
    let (client, updates) = ready(&daemon, &temp).await;
    assert!(client.command(WriteCommand::Project {
        id: "read".into(),
        path: None
    }));
    arrived(&reached).await;
    let snapshot = temp.0.join("state-v1.json");
    let backup = temp.0.join("before-fault.json");
    fs::rename(&snapshot, &backup).unwrap();
    fs::create_dir(&snapshot).unwrap();
    assert!(client.edit("chat:a".into(), draft(2, "unsaved")));
    assert!(client.command(WriteCommand::Submit {
        key: "chat:a".into(),
        draft: Box::new(draft(3, "queued mutation")),
        follow_up: false,
        stop: false,
        request: 77,
    }));
    let failed = until(&updates, |s| s.error.is_some()).await;
    assert_eq!(failed.checkpoint, None);
    assert_eq!(client.edits.lock().unwrap()["chat:a"].text, "unsaved");
    release.send(()).await.unwrap();
    let settled = until(&updates, |s| {
        s.project.as_ref().is_some_and(|p| p.catalog.is_some())
            && s.handled.get("chat:a") == Some(&77)
    })
    .await;
    let project = settled.project.unwrap();
    assert_eq!(project.result, Ok(Outcome::Read));
    assert_eq!(project.catalog.unwrap().unwrap().len(), 2);
    assert!(settled.error.is_some());
    assert_eq!(settled.checkpoint, None);
    assert!(settled.book.unwrap().pending.is_empty());
    assert!(daemon.seen.lock().unwrap().envelopes.is_empty());
    disconnected(client, updates).await;
    fs::remove_dir(&snapshot).unwrap();
    fs::rename(&backup, &snapshot).unwrap();
    assert_eq!(disk(&temp).drafts["chat:a"].text, "durable");
}
