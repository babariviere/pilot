//! Registration waits share the sole writer with ordinary text, never commands.
use super::send_waits::{disconnected, disk};
use super::*;
use crate::{
    project_registration::Outcome,
    project_registration_fixture::{Behavior, Server},
};
const PATH: &str = "/synthetic/日本語 e\u{301} 👩‍💻";
fn seed(server: &Server, temp: &Temp) -> (Draft, Intent) {
    let mut captured = crate::subagent_wait_fixture::captured();
    captured.project_id = Some("project".into());
    captured.model_choice.as_mut().unwrap().project_id = "project".into();
    captured.answer = None;
    captured.text = "Original source 日本語 👩‍💻".into();
    let answer = crate::subagent_wait_fixture::captured();
    let mut store = Store::open(temp.0.clone(), server.options.host()).unwrap();
    store
        .prepare_project("prior-attempt", "/synthetic/prior")
        .unwrap();
    store
        .save_edits(BTreeMap::from([("chat:source".into(), captured.clone())]))
        .unwrap();
    let question = crate::question::Question::parse(
        7,
        &json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true}),
    )
    .unwrap();
    let intent = store
        .prepare_answer(
            "chat:sealed",
            &answer,
            &question,
            answer.answer.as_ref().unwrap(),
        )
        .unwrap();
    store.pending(&intent.id).unwrap();
    (captured, store.book.pending[&intent.id].clone())
}
fn submit(client: &Interaction) {
    assert!(client.command(WriteCommand::Project {
        id: "captured-attempt".into(),
        path: Some(PATH.into())
    }));
}
async fn edit(
    client: &Interaction,
    updates: &async_channel::Receiver<WriteState>,
    temp: &Temp,
    captured: &Draft,
) {
    let mut newer = captured.clone();
    newer.revision = 9;
    newer.text = "Newer source 未送信 e\u{301} 🦀".into();
    assert!(client.edit("chat:source".into(), newer.clone()));
    assert!(client.edit("chat:other".into(), draft(3, "Other target 日本語")));
    let original = disk(temp).drafts["chat:sealed"].clone();
    let mut sealed = original.clone();
    sealed.revision = 9;
    sealed.text = "Editable sealed text".into();
    sealed.answer = None;
    sealed.project_id = None;
    sealed.cwd = "/changed".into();
    sealed.model_choice = None;
    assert!(client.edit("chat:sealed".into(), sealed));
    let saved = until(updates, |s| {
        s.book.as_ref().is_some_and(|b| {
            b.drafts["chat:source"].revision == 9
                && b.drafts["chat:sealed"].revision == 9
                && b.drafts.contains_key("chat:other")
        })
    })
    .await;
    assert_eq!(saved.checkpoint, None);
    let book = disk(temp);
    assert_eq!(
        book.drafts["chat:source"].text, newer.text,
        "durable BEFORE HTTP release"
    );
    assert!(book.drafts["chat:sealed"].answer == original.answer);
    assert_eq!(book.drafts["chat:sealed"].project_id, original.project_id);
    assert_eq!(book.drafts["chat:sealed"].cwd, original.cwd);
    assert_eq!(
        book.drafts["chat:sealed"].model_choice,
        original.model_choice
    );
}

async fn reached(server: &Server) {
    tokio::time::timeout(Duration::from_secs(5), server.entered.recv())
        .await
        .unwrap()
        .unwrap();
}
async fn start(server: &Server, temp: &Temp) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    (client, updates)
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
async fn registration_autosaves_before_held_http_release() {
    for (method, path, nth, behavior) in [
        ("POST", "/api/projects", 1, Behavior::Accept),
        ("GET", "/api/hello", 1, Behavior::Accept),
        ("GET", "/api/projects", 1, Behavior::Accept),
        ("GET", "/api/hello", 2, Behavior::Accept),
        ("GET", "/api/projects", 2, Behavior::Accept),
        ("POST", "/api/projects", 1, Behavior::Lost),
        ("POST", "/api/projects", 1, Behavior::Malformed),
        ("POST", "/api/projects", 1, Behavior::InvalidReceipt),
        ("POST", "/api/projects", 1, Behavior::Status(403)),
        ("POST", "/api/projects", 1, Behavior::Status(503)),
    ] {
        let server = Server::held(behavior, method, path, nth);
        let temp = Temp::new();
        let (captured, sealed) = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        submit(&client);
        reached(&server).await;
        assert!(client.command(WriteCommand::Checkpoint(29)));
        edit(&client, &updates, &temp, &captured).await;
        let book = disk(&temp);
        assert!(book.pending[&sealed.id] == sealed);
        assert_eq!(
            book.project_registrations.contains_key("captured-attempt"),
            method == "POST" || nth == 2
        );
        if let Some(attempt) = book.project_registrations.get("captured-attempt") {
            assert_eq!(attempt.path, PATH);
            assert_eq!(attempt.created.is_some(), nth == 2);
        }
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| s.checkpoint == Some(29)).await;
        let accepted = matches!(behavior, Behavior::Accept);
        let reply = done.project.as_ref().unwrap();
        assert_eq!(reply.id, "captured-attempt");
        assert_eq!(matches!(reply.result, Ok(Outcome::Created(_))), accepted);
        assert_eq!(
            reply.catalog.as_ref().unwrap().as_ref().unwrap()[0].path,
            PATH
        );
        assert_eq!(done.project_receipt.is_some(), accepted);
        assert!(disk(&temp).pending[&sealed.id] == sealed);
        assert!(
            disk(&temp).project_registrations["prior-attempt"]
                .created
                .is_none()
        );
        assert_eq!(
            disk(&temp).project_registrations["captured-attempt"]
                .created
                .is_some(),
            accepted
        );
        assert_eq!(
            server.seen.lock().unwrap().bodies,
            [serde_json::to_vec(&json!({"path":PATH})).unwrap()]
        );
        if !accepted {
            // A matching catalogue is current evidence, never settlement/replay authority.
            let original = disk(&temp).project_registrations;
            assert!(client.command(WriteCommand::Project {
                id: "inspect".into(),
                path: None
            }));
            assert!(client.command(WriteCommand::Checkpoint(30)));
            until(&updates, |s| s.checkpoint == Some(30)).await;
            assert!(disk(&temp).project_registrations == original);
            server.seen.lock().unwrap().projects.clear();
            submit(&client);
            assert!(client.command(WriteCommand::Checkpoint(31)));
            until(&updates, |s| s.checkpoint == Some(31)).await;
            assert!(disk(&temp).project_registrations == original);
            assert_eq!(server.posts(), 1);
        }
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn registration_inspection_saves_without_settling_prior_attempts() {
    let server = Server::held(Behavior::Accept, "GET", "/api/projects", 1);
    let temp = Temp::new();
    let (captured, sealed) = seed(&server, &temp);
    server.seen.lock().unwrap().projects =
        vec![json!({"id":"observed","path":"/synthetic/prior","name":"Observed"})];
    let original = disk(&temp).project_registrations;
    let (client, updates) = start(&server, &temp).await;
    assert!(client.command(WriteCommand::Project {
        id: "inspect".into(),
        path: None
    }));
    reached(&server).await;
    edit(&client, &updates, &temp, &captured).await;
    server.release.send(()).await.unwrap();
    let done = until(&updates, |s| {
        s.project.as_ref().is_some_and(|r| r.catalog.is_some())
    })
    .await;
    assert_eq!(done.project.unwrap().result, Ok(Outcome::Read));
    assert!(disk(&temp).project_registrations == original);
    assert!(disk(&temp).pending[&sealed.id] == sealed);
    assert_eq!(server.posts(), 0);
    close(client, updates, &server, &temp).await;
}

#[tokio::test]
async fn registration_preflight_refusals_never_reserve_or_post() {
    for duplicate in [false, true] {
        let server = Server::held(Behavior::Accept, "GET", "/api/hello", 1);
        let temp = Temp::new();
        let (captured, _) = seed(&server, &temp);
        let original = disk(&temp).project_registrations;
        if duplicate {
            server.seen.lock().unwrap().projects =
                vec![json!({"id":"existing","path":PATH,"name":"Existing"})];
        } else {
            server.seen.lock().unwrap().hello["daemonId"] = json!("foreign");
        }
        let (client, updates) = start(&server, &temp).await;
        submit(&client);
        reached(&server).await;
        edit(&client, &updates, &temp, &captured).await;
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| {
            s.project.as_ref().is_some_and(|r| r.result.is_err())
        })
        .await;
        assert!(done.project_receipt.is_none());
        assert!(disk(&temp).project_registrations == original);
        assert_eq!(server.posts(), 0);
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn registration_close_flushes_and_releases_store_before_late_response() {
    for (method, path, nth, count) in [
        ("GET", "/api/hello", 1, 1),
        ("POST", "/api/projects", 1, 3),
        ("GET", "/api/projects", 2, 5),
    ] {
        let server = Server::held(Behavior::Accept, method, path, nth);
        let temp = Temp::new();
        let (captured, sealed) = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        submit(&client);
        reached(&server).await;
        edit(&client, &updates, &temp, &captured).await;
        let mut latest = captured.clone();
        latest.revision = 10;
        latest.text = "Latest before Close 日本語".into();
        assert!(client.edit("chat:source".into(), latest.clone()));
        assert!(client.command(WriteCommand::Close));
        let done = until(&updates, |s| s.flushed).await;
        assert_eq!(done.project_receipt.is_some(), nth == 2);
        disconnected(client, updates).await;
        let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
        assert_eq!(reopened.book.drafts["chat:source"].text, latest.text);
        assert!(reopened.book.pending[&sealed.id] == sealed);
        assert_eq!(
            reopened
                .book
                .project_registrations
                .contains_key("captured-attempt"),
            method == "POST" || nth == 2
        );
        if let Some(attempt) = reopened.book.project_registrations.get("captured-attempt") {
            assert_eq!(attempt.path, PATH);
            assert_eq!(attempt.created.is_some(), nth == 2);
        }
        server.release.send(()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            for _ in 0..count {
                server.completed.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(
            disk(&temp) == reopened.book,
            "late HTTP cannot write into a reopened Store"
        );
    }
}

#[tokio::test]
async fn registration_disk_fault_fences_admission_but_keeps_accepted_evidence() {
    for method in ["GET", "POST"] {
        let server = Server::held(Behavior::Accept, method, "/api/projects", 1);
        let temp = Temp::new();
        let (captured, _) = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        submit(&client);
        reached(&server).await;
        let original = disk(&temp);
        let snapshot = temp.0.join("state-v1.json");
        let backup = temp.0.join("before-fault.json");
        fs::rename(&snapshot, &backup).unwrap();
        fs::create_dir(&snapshot).unwrap();
        let mut newer = captured;
        newer.revision = 9;
        newer.text = "Unsaved fault text".into();
        assert!(client.edit("chat:source".into(), newer.clone()));
        until(&updates, |s| s.error.is_some()).await;
        assert_eq!(client.edits.lock().unwrap()["chat:source"].text, newer.text);
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| {
            s.project.as_ref().is_some_and(|r| r.catalog.is_some())
        })
        .await;
        assert!(done.error.is_some());
        assert!(done.book.unwrap().as_ref() == &original);
        assert_eq!(server.posts(), usize::from(method == "POST"));
        if method == "POST" {
            assert_eq!(
                done.project_receipt,
                Some(("captured-attempt".into(), "registered-project".into()))
            );
            assert_eq!(
                done.project.unwrap().result,
                Ok(Outcome::Created("registered-project".into()))
            );
        } else {
            assert!(done.project_receipt.is_none());
        }
        disconnected(client, updates).await;
        fs::remove_dir(&snapshot).unwrap();
        fs::rename(&backup, &snapshot).unwrap();
        assert!(
            Store::open(temp.0.clone(), server.options.host())
                .unwrap()
                .book
                == original
        );
    }
}
