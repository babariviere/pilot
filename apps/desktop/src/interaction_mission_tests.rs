//! Captured conversion and editable drafts share the production FIFO writer.
use super::send_waits::{disconnected, disk};
use super::*;
use crate::{
    mission_conversion::{Action, Inspection, Outcome, Request, Target},
    mission_fixture::{Behavior as MissionBehavior, Daemon as MissionDaemon},
};

fn target() -> Target {
    Target {
        source: "source".into(),
        project: "project".into(),
        generation: 12,
    }
}
fn captured_request() -> Request {
    Request {
        project_id: "project".into(),
        from_session_id: "source".into(),
        title: "Captured 日本語 e\u{301}".into(),
        goal: "Exact goal 🦀".into(),
        coordinator: true,
        draft: false,
    }
}
fn seed(server: &MissionDaemon, temp: &Temp) -> (Draft, Intent) {
    let mut captured = crate::subagent_wait_fixture::captured();
    captured.project_id = Some("project".into());
    captured.model_choice.as_mut().unwrap().project_id = "project".into();
    captured.answer = None;
    captured.text = "Original source 日本語 👩‍💻".into();
    let answer = crate::subagent_wait_fixture::captured();
    let mut store = Store::open(temp.0.clone(), server.options.host()).unwrap();
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
    assert!(client.command(WriteCommand::Mission {
        target: target(),
        request: 17,
        action: Action::Submit {
            id: "captured-attempt".into(),
            request: captured_request()
        }
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

async fn reached(server: &MissionDaemon) {
    tokio::time::timeout(Duration::from_secs(5), server.entered.recv())
        .await
        .unwrap()
        .unwrap();
}
async fn start(
    server: &MissionDaemon,
    temp: &Temp,
) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    (client, updates)
}
async fn close(
    client: Interaction,
    updates: async_channel::Receiver<WriteState>,
    server: &MissionDaemon,
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
async fn mission_autosaves_before_held_conversion_response_release() {
    for (path, behavior) in [
        ("/api/missions", MissionBehavior::Accept),
        ("/api/hello", MissionBehavior::Accept),
        ("/api/sessions/source", MissionBehavior::Accept),
        ("/api/projects/project", MissionBehavior::Accept),
        ("/api/missions", MissionBehavior::LostBefore),
        ("/api/missions", MissionBehavior::LostAfter),
        ("/api/missions", MissionBehavior::AfterCommitFailure),
        ("/api/missions", MissionBehavior::BadReceipt),
        ("/api/missions", MissionBehavior::InvalidId),
        ("/api/missions", MissionBehavior::Malformed),
    ] {
        let server = MissionDaemon::held(behavior, path).await;
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
            book.missions.contains_key("source"),
            path == "/api/missions"
        );
        if path == "/api/missions" {
            assert_eq!(book.missions["source"].id, "captured-attempt");
            assert!(book.missions["source"].request == captured_request());
            assert!(book.missions["source"].outcome == Outcome::Unknown);
        }
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| s.checkpoint == Some(29)).await;
        let accepted = behavior == MissionBehavior::Accept;
        assert_eq!(
            matches!(
                done.mission.as_ref().unwrap().result,
                Ok(Inspection::Created { .. })
            ),
            accepted
        );
        assert_eq!(done.mission.as_ref().unwrap().request, 17);
        assert!(done.mission.as_ref().unwrap().target == target());
        assert_eq!(done.mission_receipts.contains_key("source"), accepted);
        let book = done.book.unwrap();
        assert_eq!(
            matches!(book.missions["source"].outcome, Outcome::Created { .. }),
            accepted
        );
        {
            let seen = server.seen.lock().unwrap();
            assert_eq!(
                seen.posts,
                [serde_json::to_value(captured_request()).unwrap()]
            );
            assert_eq!(
                seen.bodies,
                [serde_json::to_vec(&captured_request()).unwrap()]
            );
        }
        if !accepted {
            let original = book.missions["source"].clone();
            assert!(client.command(WriteCommand::Mission {
                target: target(),
                request: 18,
                action: Action::Check
            }));
            until(&updates, |s| {
                s.mission.as_ref().is_some_and(|r| {
                    r.request == 18 && !matches!(r.result, Ok(Inspection::Pending))
                })
            })
            .await;
            submit(&client);
            assert!(client.command(WriteCommand::Checkpoint(30)));
            until(&updates, |s| s.checkpoint == Some(30)).await;
            assert!(disk(&temp).missions["source"] == original);
            assert_eq!(
                server.seen.lock().unwrap().posts.len(),
                1,
                "no replay after membership observation"
            );
        }
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn mission_inspection_saves_without_creating_or_settling_an_attempt() {
    for pending in [false, true] {
        let server = MissionDaemon::held(MissionBehavior::Accept, "/api/sessions/source").await;
        let temp = Temp::new();
        let (captured, sealed) = seed(&server, &temp);
        if pending {
            Store::open(temp.0.clone(), server.options.host())
                .unwrap()
                .prepare_mission("original", captured_request())
                .unwrap();
        }
        let original = disk(&temp).missions;
        let (client, updates) = start(&server, &temp).await;
        assert!(client.command(WriteCommand::Mission {
            target: target(),
            request: 22,
            action: if pending {
                Action::Check
            } else {
                Action::Inspect
            }
        }));
        reached(&server).await;
        assert!(client.command(WriteCommand::Checkpoint(29)));
        edit(&client, &updates, &temp, &captured).await;
        server.release.send(()).await.unwrap();
        let done = until(&updates, |s| s.checkpoint == Some(29)).await;
        assert!(matches!(
            done.mission.unwrap().result,
            Ok(Inspection::Ready { .. }) | Ok(Inspection::Membership { mission_id: None })
        ));
        assert!(disk(&temp).missions == original);
        assert!(disk(&temp).pending[&sealed.id] == sealed);
        assert!(server.seen.lock().unwrap().posts.is_empty());
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn mission_refusal_and_target_mismatch_never_reserve_or_post() {
    for mismatch in [false, true] {
        let server = MissionDaemon::held(MissionBehavior::Accept, "/api/hello").await;
        let temp = Temp::new();
        let (captured, _) = seed(&server, &temp);
        server.seen.lock().unwrap().hello["capabilities"]["guardedMissionConversion"] =
            json!(false);
        let (client, updates) = start(&server, &temp).await;
        if mismatch {
            let mut wrong = captured_request();
            wrong.project_id = "different".into();
            assert!(client.command(WriteCommand::Mission {
                target: target(),
                request: 17,
                action: Action::Submit {
                    id: "never".into(),
                    request: wrong
                }
            }));
        } else {
            submit(&client);
            reached(&server).await;
            edit(&client, &updates, &temp, &captured).await;
            server.release.send(()).await.unwrap();
        }
        let done = until(&updates, |s| {
            s.mission.as_ref().is_some_and(|r| r.result.is_err())
        })
        .await;
        assert!(done.book.unwrap().missions.is_empty());
        assert!(server.seen.lock().unwrap().posts.is_empty());
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn mission_close_preserves_unknown_latest_edits_and_immediate_reopen() {
    for path in ["/api/sessions/source", "/api/missions"] {
        let server = MissionDaemon::held(MissionBehavior::Accept, path).await;
        let temp = Temp::new();
        let (captured, sealed) = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        submit(&client);
        reached(&server).await;
        edit(&client, &updates, &temp, &captured).await;
        let mut latest = captured.clone();
        latest.revision = 10;
        latest.text = "Latest Close 日本語".into();
        assert!(client.edit("chat:source".into(), latest.clone()));
        close(client, updates, &server, &temp).await;
        let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
        assert_eq!(reopened.book.drafts["chat:source"].text, latest.text);
        assert!(reopened.book.pending[&sealed.id] == sealed);
        assert_eq!(
            reopened.book.missions.contains_key("source"),
            path == "/api/missions"
        );
        if path == "/api/missions" {
            assert!(reopened.book.missions["source"].outcome == Outcome::Unknown);
        }
        server.release.send(()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let count = if path == "/api/missions" { 4 } else { 2 };
            for _ in 0..count {
                server.completed.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(
            disk(&temp) == reopened.book,
            "late HTTP cannot write a reopened Store"
        );
    }
}

#[tokio::test]
async fn mission_disk_fault_fences_admission_but_preserves_exact_accepted_evidence() {
    for path in ["/api/sessions/source", "/api/missions"] {
        let server = MissionDaemon::held(MissionBehavior::Accept, path).await;
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
            s.mission
                .as_ref()
                .is_some_and(|r| !matches!(r.result, Ok(Inspection::Pending)))
        })
        .await;
        assert!(done.error.is_some());
        assert!(done.book.unwrap().as_ref() == &original);
        assert_eq!(
            server.seen.lock().unwrap().posts.len(),
            usize::from(path == "/api/missions")
        );
        if path == "/api/missions" {
            let receipt = &done.mission_receipts["source"];
            assert_eq!(receipt.attempt_id, "captured-attempt");
            assert_eq!(receipt.project_id, "project");
            assert_eq!(receipt.mission_id, "mission-exact");
            assert!(matches!(
                done.mission.unwrap().result,
                Ok(Inspection::Created { .. })
            ));
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
