use super::*;
use crate::chat_settings_fixture::{Mode, Server};
use serde_json::json;

fn snapshot(on: bool, revision: &str) -> Snapshot {
    Snapshot {
        auto_handoff: on,
        revision: revision.into(),
    }
}

#[test]
fn parse_accepts_only_the_exact_schema_one_document() {
    assert_eq!(
        parse(br#"{"schemaVersion":1,"autoHandoff":true,"revision":"r1"}"#),
        Some(snapshot(true, "r1"))
    );
    for bad in [
        r#"{"schemaVersion":2,"autoHandoff":true,"revision":"r1"}"#,
        r#"{"schemaVersion":1,"autoHandoff":true,"revision":""}"#,
        r#"{"schemaVersion":1,"autoHandoff":"yes","revision":"r1"}"#,
        r#"{"schemaVersion":1,"revision":"r1"}"#,
        r#"{"schemaVersion":1,"autoHandoff":false,"revision":"r1","extra":0}"#,
        r#"{"schemaVersion":1,"autoHandoff":false,"autoHandoff":true,"revision":"r1"}"#,
        r#"{"schemaVersion":1,"autoHandoff":false,"revision":"a\nb"}"#,
        "<html>Not found</html>",
    ] {
        assert_eq!(parse(bad.as_bytes()), None, "{bad}");
    }
    let long = json!({"schemaVersion":1,"autoHandoff":false,"revision":"r".repeat(257)});
    assert_eq!(parse(long.to_string().as_bytes()), None);
}

#[test]
fn model_never_saves_from_unknown_and_shows_only_acknowledged_values() {
    let mut model = Model::default();
    assert_eq!(
        model.begin_save(true),
        None,
        "nothing to save from before a read"
    );
    let (read, job) = model.begin_read().unwrap();
    assert_eq!(job, Job::Read);
    assert_eq!(model.begin_read(), None, "one request at a time");
    assert!(model.finish(read, Reply::Read(Ok(snapshot(false, "r1")))));
    assert_eq!(model.value(), Some(false));
    assert_eq!(
        model.begin_save(false),
        None,
        "no write for an unchanged value"
    );

    let (save, job) = model.begin_save(true).unwrap();
    assert_eq!(
        job,
        Job::Save {
            auto_handoff: true,
            expected_revision: "r1".into()
        }
    );
    assert_eq!(model.phase(), Phase::Saving(true));
    assert_eq!(
        model.value(),
        Some(false),
        "no optimistic value before the ACK"
    );
    assert!(
        !model.finish(read, Reply::Save(Saved::Ack(snapshot(false, "x")))),
        "stale reply"
    );
    assert!(model.finish(save, Reply::Save(Saved::Ack(snapshot(true, "r2")))));
    assert!(
        !model.finish(save, Reply::Save(Saved::Unknown)),
        "duplicate reply"
    );
    assert_eq!(
        (model.value(), model.note()),
        (Some(true), Some(Note::Saved(true)))
    );
    assert!(model.clear_saved());
    assert_eq!(model.note(), None);

    let (save, _) = model.begin_save(false).unwrap();
    assert!(model.finish(save, Reply::Save(Saved::Unknown)));
    assert_eq!(
        (model.value(), model.note()),
        (None, Some(Note::Unknown(false)))
    );
    assert_eq!(
        model.begin_save(true),
        None,
        "Unknown must be read again first"
    );

    let (read, _) = model.begin_read().unwrap();
    assert!(model.finish(read, Reply::Read(Err(ReadFailure::Unsupported))));
    assert_eq!(
        (model.value(), model.note()),
        (None, Some(Note::Unsupported))
    );
}

#[test]
fn rejected_and_unsent_keep_the_acknowledged_value_conflict_adopts_the_read_back() {
    let mut model = Model::default();
    let (read, _) = model.begin_read().unwrap();
    model.finish(read, Reply::Read(Ok(snapshot(false, "r1"))));
    for (reply, note) in [
        (Saved::Rejected, Note::Rejected),
        (Saved::NotSent, Note::NotSent),
    ] {
        let (save, _) = model.begin_save(true).unwrap();
        model.finish(save, Reply::Save(reply));
        assert_eq!((model.value(), model.note()), (Some(false), Some(note)));
    }
    let (save, _) = model.begin_save(true).unwrap();
    model.finish(
        save,
        Reply::Save(Saved::Conflict(Ok(snapshot(false, "r9")))),
    );
    assert_eq!(
        (model.value(), model.note()),
        (Some(false), Some(Note::Conflict))
    );
    assert_eq!(
        model.begin_save(true).unwrap().1,
        Job::Save {
            auto_handoff: true,
            expected_revision: "r9".into()
        },
        "the next explicit toggle uses the read-back revision"
    );
}

async fn reply(server: &Server, job: Job) -> Reply {
    run(&client().unwrap(), &server.options, job).await
}

#[tokio::test]
async fn read_then_patch_sends_exactly_the_contract_body() {
    let server = Server::start(Mode::Accept);
    assert_eq!(
        reply(&server, Job::Read).await,
        Reply::Read(Ok(snapshot(false, "r1")))
    );
    let saved = reply(
        &server,
        Job::Save {
            auto_handoff: true,
            expected_revision: "r1".into(),
        },
    )
    .await;
    assert_eq!(saved, Reply::Save(Saved::Ack(snapshot(true, "r2"))));
    let state = server.state.lock().unwrap();
    assert_eq!(
        state.patches(),
        [json!({"autoHandoff":true,"expectedRevision":"r1"})]
    );
    assert_eq!(state.count("GET"), 1, "no read-back after an exact ACK");
}

#[tokio::test]
async fn older_daemon_is_unsupported_not_off() {
    let server = Server::start(Mode::Unsupported);
    assert_eq!(
        reply(&server, Job::Read).await,
        Reply::Read(Err(ReadFailure::Unsupported))
    );
    let malformed = Server::start(Mode::Malformed);
    assert_eq!(
        reply(&malformed, Job::Read).await,
        Reply::Read(Err(ReadFailure::Unreadable))
    );
}

#[tokio::test]
async fn failures_map_to_truthful_outcomes() {
    let save = |revision: &str| Job::Save {
        auto_handoff: true,
        expected_revision: revision.into(),
    };
    let conflict = Server::start(Mode::Conflict);
    assert_eq!(
        reply(&conflict, save("r1")).await,
        Reply::Save(Saved::Conflict(Ok(snapshot(false, "r2"))))
    );
    let stale = Server::start(Mode::Accept);
    assert_eq!(
        reply(&stale, save("r0")).await,
        Reply::Save(Saved::Conflict(Ok(snapshot(false, "r1"))))
    );
    let unavailable = Server::start(Mode::Unavailable);
    assert_eq!(
        reply(&unavailable, save("r1")).await,
        Reply::Save(Saved::Unknown)
    );
    assert_eq!(
        reply(&unavailable, Job::Read).await,
        Reply::Read(Err(ReadFailure::Unavailable))
    );
    let rejected = Server::start(Mode::Rejected);
    assert_eq!(
        reply(&rejected, save("r1")).await,
        Reply::Save(Saved::Rejected)
    );
    let mismatch = Server::start(Mode::Mismatch);
    assert_eq!(
        reply(&mismatch, save("r1")).await,
        Reply::Save(Saved::Unknown),
        "a 200 that does not echo the request is not an ACK"
    );
    assert_eq!(
        reply(&mismatch, save("")).await,
        Reply::Save(Saved::NotSent)
    );
    let gone = {
        let server = Server::start(Mode::Accept);
        server.options.clone()
    };
    assert_eq!(
        run(&client().unwrap(), &gone, save("r1")).await,
        Reply::Save(Saved::NotSent),
        "an unreachable daemon never received the write"
    );
}
