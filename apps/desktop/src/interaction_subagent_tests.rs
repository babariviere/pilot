//! Production FIFO writer, seeded answer/configuration and owned child HTTP only.
use super::send_waits::{disconnected, disk};
use super::*;
use crate::subagent_wait_fixture::{self as fixture, Behavior, POST, Server};

fn seed(server: &Server, temp: &Temp) -> (Draft, Intent) {
    let answer = fixture::captured();
    let mut captured = answer.clone();
    captured.answer = None; // Child drafts never own parent question replies.
    let mut store = Store::open(temp.0.clone(), server.options.host()).unwrap();
    store
        .save_edits(BTreeMap::from([(
            fixture::target().key(),
            captured.clone(),
        )]))
        .unwrap();
    let question = crate::question::Question::parse(
        7,
        &json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true}),
    )
    .unwrap();
    let sealed = store
        .prepare_answer(
            "chat:sealed",
            &answer,
            &question,
            answer.answer.as_ref().unwrap(),
        )
        .unwrap();
    store.pending(&sealed.id).unwrap();
    (captured, store.book.pending[&sealed.id].clone())
}
async fn start(server: &Server, temp: &Temp) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    (client, updates)
}
fn send(client: &Interaction, captured: &Draft) {
    assert!(client.command(WriteCommand::Submit {
        key: fixture::target().key(),
        draft: Box::new(captured.clone()),
        follow_up: true,
        stop: false,
        request: 17
    }));
}
async fn reached(server: &Server) {
    tokio::time::timeout(Duration::from_secs(5), server.entered.recv())
        .await
        .unwrap()
        .unwrap();
}
async fn edit(
    client: &Interaction,
    updates: &async_channel::Receiver<WriteState>,
    temp: &Temp,
    captured: &Draft,
) -> Draft {
    let key = fixture::target().key();
    let mut newer = captured.clone();
    newer.revision = 9;
    newer.text = "Newer child 未送信 e\u{301} 🦀".into();
    newer.answer = None;
    newer.model_choice = None;
    newer.cwd = "/changed".into();
    newer.project_id = None;
    assert!(client.edit(key.clone(), newer.clone()));
    assert!(client.edit("chat:other".into(), draft(3, "Other target 日本語")));
    let sealed = disk(temp).drafts["chat:sealed"].clone();
    let mut changed = sealed.clone();
    changed.revision = 9;
    changed.text = "Sealed text remains editable".into();
    changed.answer = None;
    changed.cwd = "/changed".into();
    changed.project_id = None;
    changed.model_choice = None;
    assert!(client.edit("chat:sealed".into(), changed));
    let saved = until(updates, |s| {
        s.book.as_ref().is_some_and(|b| {
            b.drafts.get(&key).is_some_and(|d| d.revision == 9)
                && b.drafts.contains_key("chat:other")
                && b.drafts["chat:sealed"].revision == 9
        })
    })
    .await;
    assert_eq!(
        saved.checkpoint, None,
        "checkpoint cannot overtake held HTTP"
    );
    assert_eq!(
        disk(temp).drafts[&key].text,
        newer.text,
        "durable before HTTP release"
    );
    let saved = disk(temp);
    assert!(saved.drafts["chat:sealed"].answer == sealed.answer);
    assert_eq!(
        saved.drafts["chat:sealed"].model_choice,
        sealed.model_choice
    );
    assert_eq!(saved.drafts["chat:sealed"].cwd, sealed.cwd);
    assert_eq!(saved.drafts["chat:sealed"].project_id, sealed.project_id);
    newer
}
async fn close(
    client: Interaction,
    updates: async_channel::Receiver<WriteState>,
    server: &Server,
    temp: &Temp,
) {
    assert!(client.command(WriteCommand::Close));
    let done = until(&updates, |s| s.flushed).await;
    disconnected(client, updates).await;
    assert!(
        Store::open(temp.0.clone(), server.options.host())
            .unwrap()
            .book
            == *done.book.unwrap()
    );
}

#[tokio::test]
async fn subagent_autosaves_before_held_response_release() {
    for (path, behavior) in [
        (POST, Behavior::Accept),
        ("/api/hello", Behavior::Accept),
        ("/api/sessions/Parent-A", Behavior::Accept),
        (POST, Behavior::Lost),
        (POST, Behavior::Reject),
        (POST, Behavior::Wrong),
        (POST, Behavior::Malformed),
    ] {
        let server = Server::start(behavior, path);
        let temp = Temp::new();
        let (captured, sealed) = seed(&server, &temp);
        let key = fixture::target().key();
        let (client, updates) = start(&server, &temp).await;
        send(&client, &captured);
        reached(&server).await;
        let reserved = disk(&temp).drafts[&key]
            .pending
            .as_ref()
            .map(|id| disk(&temp).pending[id].clone());
        assert_eq!(reserved.is_some(), path == POST);
        assert!(client.command(WriteCommand::Checkpoint(29)));
        let newer = edit(&client, &updates, &temp, &captured).await;
        let before = disk(&temp);
        assert!(before.pending[&sealed.id] == sealed);
        if let Some(intent) = &reserved {
            assert!(before.pending[&intent.id] == *intent);
            assert!(before.drafts[&key].answer == captured.answer);
            assert_eq!(before.drafts[&key].model_choice, captured.model_choice);
            assert_eq!(before.drafts[&key].cwd, captured.cwd);
            assert_eq!(before.drafts[&key].project_id, captured.project_id);
        }
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| s.checkpoint == Some(29)).await;
        assert_eq!(done.handled.get(&key), Some(&17));
        let book = done.book.unwrap();
        assert_eq!(book.drafts[&key].text, newer.text);
        let sent = server
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| m == "POST")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(sent.len(), 1);
        let intent = reserved
            .as_ref()
            .or_else(|| book.pending.values().find(|i| i.key == key));
        let id = book.drafts[&key]
            .last
            .as_ref()
            .map(|l| l.id.as_str())
            .or_else(|| intent.map(|i| i.id.as_str()))
            .unwrap();
        assert_eq!(sent[0].1, POST);
        assert_eq!(
            server.bodies.lock().unwrap().as_slice(),
            [
                json!({"message":captured.text,"mode":"followUp","requestId":id})
                    .to_string()
                    .into_bytes()
            ]
        );
        assert_eq!(
            sent[0].2,
            json!({"message":captured.text,"mode":"followUp","requestId":id})
        );
        let accepted = behavior == Behavior::Accept;
        assert_eq!(book.drafts[&key].pending.is_none(), accepted);
        if !accepted {
            let original = book.pending[id].clone();
            assert_eq!(original.state, "unknown");
            assert!(client.command(WriteCommand::Check {
                id: id.into(),
                retry: true
            }));
            assert!(client.command(WriteCommand::Checkpoint(30)));
            until(&updates, |s| s.checkpoint == Some(30)).await;
            assert!(disk(&temp).pending[id] == original);
            assert_eq!(
                server
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(m, _, _)| m == "POST")
                    .count(),
                1,
                "no receipt or blind retry"
            );
        }
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn subagent_refuses_changed_generation_and_existing_pending_without_replay() {
    for pending in [false, true] {
        let server = Server::with_generation(Behavior::Accept, "/api/sessions/Parent-A", 2);
        let temp = Temp::new();
        let (captured, _) = seed(&server, &temp);
        let key = fixture::target().key();
        let original = if pending {
            Some(
                Store::open(temp.0.clone(), server.options.host())
                    .unwrap()
                    .prepare(&key, &captured, false, false)
                    .unwrap(),
            )
        } else {
            None
        };
        let (client, updates) = start(&server, &temp).await;
        send(&client, &captured);
        if !pending {
            reached(&server).await;
            edit(&client, &updates, &temp, &captured).await;
            server.release.send(()).await.unwrap();
        }
        until(&updates, |s| s.handled.get(&key) == Some(&17)).await;
        assert!(
            server
                .seen
                .lock()
                .unwrap()
                .iter()
                .all(|(m, _, _)| m != "POST")
        );
        if let Some(original) = original {
            edit(&client, &updates, &temp, &captured).await;
            assert!(disk(&temp).pending[&original.id] == original);
            assert!(disk(&temp).drafts[&key].answer == captured.answer);
        } else {
            assert!(disk(&temp).drafts[&key].pending.is_none());
        }
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn subagent_close_immediate_reopen_fences_late_ack_and_flushes_latest_text() {
    for path in ["/api/sessions/Parent-A", POST] {
        let server = Server::start(Behavior::Accept, path);
        let temp = Temp::new();
        let (captured, sealed) = seed(&server, &temp);
        let key = fixture::target().key();
        let (client, updates) = start(&server, &temp).await;
        send(&client, &captured);
        reached(&server).await;
        let original = disk(&temp).pending.clone();
        edit(&client, &updates, &temp, &captured).await;
        let mut latest = captured.clone();
        latest.revision = 10;
        latest.text = "Latest on Close 日本語".into();
        assert!(client.edit(key.clone(), latest.clone()));
        close(client, updates, &server, &temp).await;
        let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
        assert_eq!(reopened.book.drafts[&key].text, latest.text);
        assert_eq!(reopened.book.pending.len(), original.len());
        for (id, intent) in &original {
            let actual = &reopened.book.pending[id];
            assert!(actual.operation == intent.operation);
            assert_eq!(actual.answer, intent.answer);
            assert_eq!(actual.key, intent.key);
            assert_eq!(actual.target, intent.target);
            assert_eq!(actual.revision, intent.revision);
            assert_eq!(actual.state, intent.state);
        }
        assert!(reopened.book.pending[&sealed.id] == sealed);
        server.release.send(()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server.completed.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            disk(&temp) == reopened.book,
            "late response cannot settle reopened Store"
        );
    }
}

#[tokio::test]
async fn subagent_disk_fault_retains_exact_accepted_report_without_replay() {
    for path in ["/api/sessions/Parent-A", POST] {
        let server = Server::start(Behavior::Accept, path);
        let temp = Temp::new();
        let (captured, _) = seed(&server, &temp);
        let key = fixture::target().key();
        let (client, updates) = start(&server, &temp).await;
        send(&client, &captured);
        reached(&server).await;
        let original = disk(&temp);
        let snapshot = temp.0.join("state-v1.json");
        let backup = temp.0.join("before-fault.json");
        fs::rename(&snapshot, &backup).unwrap();
        fs::create_dir(&snapshot).unwrap();
        let mut newer = captured.clone();
        newer.revision = 9;
        newer.text = "Unsaved fault text".into();
        assert!(client.edit(key.clone(), newer.clone()));
        until(&updates, |s| s.error.is_some()).await;
        assert_eq!(client.edits.lock().unwrap()[&key].text, newer.text);
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| s.handled.get(&key) == Some(&17)).await;
        assert!(done.error.is_some());
        assert!(done.book.unwrap().as_ref() == &original);
        let posts = server
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| m == "POST")
            .count();
        assert_eq!(posts, usize::from(path == POST));
        if path == POST {
            let id = original.drafts[&key].pending.as_ref().unwrap();
            assert_eq!(
                done.delivery_reports[id]
                    .delivery
                    .diagnostic
                    .unwrap()
                    .acknowledgment,
                Acknowledgment::Accepted
            );
            assert!(client.command(WriteCommand::Check {
                id: id.clone(),
                retry: true
            }));
            until(&updates, |s| {
                s.delivery_reports.get(id).is_some_and(|r| !r.saved) && s.error.is_some()
            })
            .await;
        }
        disconnected(client, updates).await;
        fs::remove_dir(&snapshot).unwrap();
        fs::rename(&backup, &snapshot).unwrap();
        assert!(disk(&temp) == original);
        assert_eq!(
            server
                .seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _, _)| m == "POST")
                .count(),
            posts
        );
    }
}
