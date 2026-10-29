use super::*;
use crate::{
    mission_browser_fixture as f,
    mission_lifecycle::{Action, State},
    mission_lifecycle_fixture::{Reply, Server},
};
use serde_json::json;
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
fn capture() -> Submission {
    State::default()
        .begin(
            &source(),
            &model::parse(&source(), &f::detail("mission-A")["mission"]).unwrap(),
            Action::Archive,
        )
        .unwrap()
}
fn ack(s: &Submission) -> Value {
    let mut m = f::detail("mission-A")["mission"].clone();
    m["status"] = json!(s.action.status());
    m["passiveLifecycle"] = json!(true);
    json!({"operationId":s.id,"mission":m})
}
fn writes(server: &Server) -> usize {
    server
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, _, _)| m != "GET")
        .count()
}
fn finished_detail() -> Value {
    let mut v = f::detail("mission-A");
    v["tasks"][0]["status"] = json!("dropped");
    v["mission"]["tasksTotal"] = json!(1);
    v
}
fn completion() -> Submission {
    State::default()
        .begin(
            &source(),
            &model::detail(&source(), &finished_detail()).unwrap(),
            Action::Complete,
        )
        .unwrap()
}
#[tokio::test]
async fn completion_requalifies_capability_identity_and_catalog_before_one_post() {
    let s = completion();
    for kind in [
        "eligible",
        "reopened",
        "offline",
        "incomplete",
        "foreign",
        "old-daemon",
    ] {
        let server = Server::start();
        let mut v = finished_detail();
        match kind {
            "reopened" => v["tasks"][1]["status"] = json!("todo"),
            "incomplete" => v["tasks"] = json!([]),
            "foreign" => v["mission"]["projectId"] = json!("other"),
            "old-daemon" => server.reply("GET", "/api/hello", Reply::json(200, json!({"daemonId":"test-daemon","lineageId":"test-lineage","capabilities":{"passiveMissionLifecycle":true}}))),
            _ => {}
        }
        server.reply(
            "GET",
            "/api/missions/mission-A",
            Reply::json(if kind == "offline" { 503 } else { 200 }, v),
        );
        server.reply(
            "POST",
            "/api/missions/mission-A/lifecycle",
            Reply::json(200, ack(&s)),
        );
        let outcome = write(&client().unwrap(), &server.options, &s).await;
        if kind == "eligible" {
            assert_eq!(outcome, Outcome::Ack);
            assert_eq!(writes(&server), 1);
        } else {
            assert!(
                matches!(outcome, Outcome::NotSent(_)),
                "{kind}: {outcome:?}"
            );
            assert_eq!(writes(&server), 0);
        }
    }
}
#[tokio::test]
async fn completion_error_lost_or_mismatched_ack_stays_unknown_without_replay() {
    for status in [Some(400), Some(409), Some(500), None, Some(200)] {
        let server = Server::start();
        server.reply(
            "GET",
            "/api/missions/mission-A",
            Reply::json(200, finished_detail()),
        );
        let mut state = State::default();
        let s = state
            .begin(&source(), &completion().before, Action::Complete)
            .unwrap();
        let mut reply = Reply::json(status.unwrap_or(200), json!({"operationId":"wrong"}));
        reply.status = status;
        server.reply("POST", "/api/missions/mission-A/lifecycle", reply);
        let outcome = write(&client().unwrap(), &server.options, &s).await;
        assert!(matches!(outcome, Outcome::Unknown(_)));
        assert!(state.finish(&s, outcome));
        let mut later = finished_detail();
        later["mission"] = ack(&s)["mission"].clone();
        server.reply("GET", "/api/missions/mission-A", Reply::json(200, later));
        assert_eq!(
            fetch(&client().unwrap(), &server.options, &source())
                .await
                .unwrap()
                .status,
            "done"
        );
        assert!(state.begin(&source(), &s.before, Action::Complete).is_err());
        assert!(matches!(state.attempt, Some((_, Outcome::Unknown(_)))));
        assert_eq!(writes(&server), 1);
    }
}
#[tokio::test]
async fn exact_post_and_ack_with_no_other_mutations() {
    let server = Server::start();
    let s = capture();
    server.reply(
        "POST",
        "/api/missions/mission-A/lifecycle",
        Reply::json(200, ack(&s)),
    );
    assert_eq!(
        write(&client().unwrap(), &server.options, &s).await,
        Outcome::Ack
    );
    let state = server.state.lock().unwrap();
    let mutations: Vec<_> = state.seen.iter().filter(|(m, _, _)| m != "GET").collect();
    assert_eq!(mutations.len(), 1);
    assert_eq!(
        mutations[0].2,
        json!({"operationId":s.id,"home":{"daemonId":"test-daemon","lineageId":"test-lineage"},"projectId":"project-A","expectedStatus":"active","action":"archive"})
    );
}
#[tokio::test]
async fn no_capability_foreign_home_or_stale_confirmation_never_writes() {
    let server = Server::start();
    let mut s = capture();
    s.source.key.home.daemon = "foreign".into();
    assert!(matches!(
        write(&client().unwrap(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    server.reply("GET","/api/hello",Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})));
    assert!(matches!(
        write(&client().unwrap(), &server.options, &capture()).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(writes(&server), 0);
    let server = Server::start();
    let mut m = f::detail("mission-A");
    m["mission"]["status"] = json!("done");
    server.reply("GET", "/api/missions/mission-A", Reply::json(200, m));
    assert!(matches!(
        write(&client().unwrap(), &server.options, &capture()).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(writes(&server), 0);
}
#[tokio::test]
async fn failures_bad_ack_and_matching_later_get_never_settle_or_retry() {
    for status in [Some(400), Some(409), Some(500), Some(302), None, Some(200)] {
        let server = Server::start();
        let mut state = State::default();
        let s = state
            .begin(
                &source(),
                &model::parse(&source(), &f::detail("mission-A")["mission"]).unwrap(),
                Action::Archive,
            )
            .unwrap();
        let mut r = Reply::json(status.unwrap_or(200), json!({"operationId":"wrong"}));
        r.status = status;
        server.reply("POST", "/api/missions/mission-A/lifecycle", r);
        let outcome = write(&client().unwrap(), &server.options, &s).await;
        assert!(matches!(outcome, Outcome::Unknown(_)));
        state.finish(&s, outcome);
        let mut later = f::detail("mission-A");
        later["mission"] = ack(&s)["mission"].clone();
        server.reply("GET", "/api/missions/mission-A", Reply::json(200, later));
        assert_eq!(
            fetch(&client().unwrap(), &server.options, &source())
                .await
                .unwrap()
                .status,
            "archived"
        );
        assert!(matches!(
            state.attempt.as_ref(),
            Some((_, Outcome::Unknown(_)))
        ));
        assert!(state.begin(&source(), &s.before, Action::Archive).is_err());
        assert_eq!(writes(&server), 1);
        let state = server.state.lock().unwrap();
        assert!(!state.seen.iter().any(|(_, p, _)| p == "/redirect-target"));
    }
}

#[tokio::test]
async fn whole_detail_declared() {
    whole_detail(false).await;
}
#[tokio::test]
async fn whole_detail_chunked() {
    whole_detail(true).await;
}
async fn whole_detail(chunked: bool) {
    let server = Server::start();
    let mut reply = Reply::json(200, f::many("mission-A", 300));
    assert!(reply.bytes.len() > CAP);
    reply.chunked = chunked;
    server.reply("GET", "/api/missions/mission-A", reply);
    let s = capture();
    assert_eq!(
        read(server.options.clone(), source(), Action::Archive)
            .unwrap()
            .recv()
            .await
            .unwrap()
            .unwrap(),
        s.before
    );
    server.reply(
        "POST",
        "/api/missions/mission-A/lifecycle",
        Reply::json(200, ack(&s)),
    );
    assert_eq!(
        write(&client().unwrap(), &server.options, &s).await,
        Outcome::Ack
    );
    assert_eq!(writes(&server), 1);
}
#[tokio::test]
async fn oversized_declared_and_chunked_post_ack_stays_unknown() {
    for chunked in [false, true] {
        let server = Server::start();
        let s = capture();
        let mut value = ack(&s);
        value["padding"] = json!("x".repeat(CAP));
        let mut reply = Reply::json(200, value);
        reply.chunked = chunked;
        server.reply("POST", "/api/missions/mission-A/lifecycle", reply);
        assert!(matches!(
            write(&client().unwrap(), &server.options, &s).await,
            Outcome::Unknown(_)
        ));
        assert_eq!(writes(&server), 1);
    }
}
