use super::*;
use crate::{
    mission_brief_fixture::{Reply, Server, brief},
    mission_browser_fixture as f,
};
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
fn request(kind: Kind) -> Request {
    Request {
        source: source(),
        generation: 1,
        kind,
    }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}
#[tokio::test]
async fn existing_current_history_revision_and_exact_put_cas_contracts() {
    let s = Server::start(Some("one"));
    let c = client();
    let Data::Current(current) = fetch(&c, &s.options, &request(Kind::Current))
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(current.number(), 1);
    let Data::History(rows) = fetch(&c, &s.options, &request(Kind::History))
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(rows.len(), 1);
    let save = Save::capture(source(), 1, "one", "\u{feff} two \n").unwrap();
    assert!(
        matches!(write(&c,&s.options,&save).await,Outcome::Confirmed(b) if b.revision.number==2 && b.markdown.as_ref()=="two")
    );
    let Data::Revision(old) = fetch(&c, &s.options, &request(Kind::Revision(1)))
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(old.markdown.as_ref(), "one");
    assert_eq!(s.puts(), 1);
    let state = s.state.lock().unwrap();
    let (_, path, body) = state.seen.iter().find(|(m, _, _)| m == "PUT").unwrap();
    assert_eq!(path, "/api/missions/mission-A/brief");
    assert_eq!(
        body,
        &json!({"markdown":"\u{feff} two \n","expectedRevision":1})
    );
}
#[tokio::test]
async fn no_op_and_empty_initial_save_have_different_revision_rules() {
    let c = client();
    let s = Server::start(Some("one"));
    let save = Save::capture(source(), 1, "one", " one ").unwrap();
    assert!(
        matches!(write(&c,&s.options,&save).await,Outcome::Confirmed(b) if b.revision.number==1)
    );
    let empty = Server::start(None);
    let save = Save::capture(source(), 0, "", "").unwrap();
    assert!(
        matches!(write(&c,&empty.options,&save).await,Outcome::Confirmed(b) if b.revision.number==1 && b.markdown.is_empty())
    );
}
#[tokio::test]
async fn predipatch_source_base_and_revision_refusals_send_no_put() {
    let c = client();
    let s = Server::start(Some("one"));
    let mut save = Save::capture(source(), 1, "one", "two").unwrap();
    save.source.key.home.daemon = "other".into();
    assert!(matches!(
        write(&c, &s.options, &save).await,
        Outcome::Rejected(_)
    ));
    assert!(s.state.lock().unwrap().seen.is_empty());
    let save = Save::capture(source(), 1, "wrong known base", "two").unwrap();
    assert!(matches!(
        write(&c, &s.options, &save).await,
        Outcome::Rejected(_)
    ));
    let save = Save::capture(source(), 0, "", "two").unwrap();
    assert!(matches!(
        write(&c, &s.options, &save).await,
        Outcome::Conflict
    ));
    assert_eq!(s.puts(), 0);
}
#[tokio::test]
async fn post_commit_error_drop_malformed_ack_and_later_get_are_not_ack() {
    let c = client();
    for (status, bytes) in [
        (
            Some(400),
            serde_json::to_vec(&json!({"error":"post commit observer failure"})).unwrap(),
        ),
        (None, Vec::new()),
        (Some(200), b"invalid".to_vec()),
        (Some(200), serde_json::to_vec(&brief(7, "wrong")).unwrap()),
    ] {
        let s = Server::start(Some("one"));
        s.reply(
            "PUT",
            "/api/missions/mission-A/brief",
            Reply {
                status,
                bytes,
                delay: 0,
                after_commit: true,
            },
        );
        let save = Save::capture(source(), 1, "one", "two").unwrap();
        assert!(matches!(
            write(&c, &s.options, &save).await,
            Outcome::Unknown(_)
        ));
        let Data::Current(value) = fetch(&c, &s.options, &request(Kind::Current))
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(value.text(), "two");
        assert_eq!(
            s.puts(),
            1,
            "no automatic replay after a visible committed read"
        );
    }
}
#[tokio::test]
async fn wire_history_caps_and_revision_zero_evidence_fail_closed() {
    let c = client();
    let s = Server::start(Some("one"));
    s.reply(
        "GET",
        "/api/missions/mission-A/brief",
        Reply::json(404, json!({})),
    );
    assert!(
        fetch(&c, &s.options, &request(Kind::Current))
            .await
            .is_err(),
        "404 after knownrevision1 is not empty"
    );
    let empty = Server::start(None);
    assert!(
        matches!(fetch(&c,&empty.options,&request(Kind::Current)).await.unwrap(),Data::Current(c) if c.brief.is_none())
    );
    // Explicit oversized wire bodies are refused before JSON decode.
    s.reply(
        "GET",
        "/api/missions/mission-A/brief/revisions",
        Reply {
            status: Some(200),
            bytes: vec![b' '; model::HISTORY_BYTES + 1],
            delay: 0,
            after_commit: false,
        },
    );
    assert!(
        fetch(&c, &s.options, &request(Kind::History))
            .await
            .unwrap_err()
            .contains("wire limit")
    );
    assert_eq!(s.puts(), 0);
}
#[tokio::test]
async fn worker_read_cancel_does_not_cancel_admitted_save_and_exit_closes_lanes() {
    let s = Server::start(Some("one"));
    let mut reply = Reply::json(200, brief(2, "two"));
    reply.after_commit = true;
    reply.delay = 100;
    s.reply("PUT", "/api/missions/mission-A/brief", reply);
    let (worker, updates) = Reader::start(s.options.clone()).unwrap();
    let save = Save::capture(source(), 1, "one", "two").unwrap();
    assert!(worker.save(save.clone()));
    assert!(!worker.save(save.clone()), "one explicit save slot");
    assert!(worker.read(None));
    assert!(worker.read(Some(request(Kind::History))));
    let result = tokio::time::timeout(Duration::from_secs(3), updates.saves.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.save, save);
    assert!(matches!(result.outcome, Outcome::Confirmed(_)));
    assert_eq!(s.puts(), 1);
    worker.disconnect_fixture();
    tokio::time::timeout(Duration::from_secs(3), async {
        while updates.reads.recv().await.is_ok() {}
    })
    .await
    .unwrap();
    assert!(!worker.read(Some(request(Kind::Current))));
    assert!(!worker.save(save));
}
