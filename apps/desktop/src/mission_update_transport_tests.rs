use super::*;
use crate::{
    mission_browser_fixture as f,
    mission_update_fixture::{Reply, Server},
};
use serde_json::json;
fn capture() -> Submission {
    model::State::default()
        .begin(&f::key("mission-A"), " Update 日本語 👩‍💻 ")
        .unwrap()
}
fn ack() -> Value {
    json!({"id":42,"kind":"update","text":"Update 日本語 👩‍💻","at":1})
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}
fn posts(server: &Server) -> usize {
    server
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, _, _)| m == "POST")
        .count()
}
#[tokio::test]
async fn exact_201_uses_only_supported_fields_and_captured_route() {
    let server = Server::start();
    server.reply(
        "POST",
        "/api/missions/mission-A/events",
        Reply::json(201, ack()),
    );
    assert!(matches!(
        submit(&client(), &server.options, &capture()).await,
        Outcome::Acknowledged(_)
    ));
    let state = server.state.lock().unwrap();
    let writes: Vec<_> = state.seen.iter().filter(|(m, _, _)| m != "GET").collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, "/api/missions/mission-A/events");
    assert_eq!(
        writes[0].2,
        json!({"text":" Update 日本語 👩‍💻 ","kind":"update"})
    );
}
#[tokio::test]
async fn bad_identity_or_absent_canonical_source_never_posts() {
    let server = Server::start();
    let mut s = capture();
    s.key.home.daemon = "foreign".into();
    assert!(matches!(
        submit(&client(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(posts(&server), 0);
    server.reply(
        "GET",
        "/api/mission-catalog",
        Reply::json(
            200,
            json!({"logicalMissions":[],"totals":{"logicalMissions":0},"truncated":false}),
        ),
    );
    assert!(matches!(
        submit(&client(), &server.options, &capture()).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(posts(&server), 0);
}
#[tokio::test]
async fn errors_redirect_lost_and_malformed_ack_are_unknown_never_replayed() {
    for status in [Some(400), Some(409), Some(500), Some(302), None, Some(201)] {
        let server = Server::start();
        let mut r = Reply::json(
            status.unwrap_or(201),
            json!({"id":"task-but-not-a-valid-ack"}),
        );
        r.status = status;
        server.reply("POST", "/api/missions/mission-A/events", r);
        assert!(
            matches!(
                submit(&client(), &server.options, &capture()).await,
                Outcome::Unknown(_)
            ),
            "{status:?}"
        );
        assert_eq!(posts(&server), 1);
        assert!(
            !server
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .any(|(_, p, _)| p.contains("redirect-target"))
        );
    }
}
#[tokio::test]
async fn oversized_and_wrong_response_identity_never_confirm() {
    for value in [json!("x".repeat(model::WIRE_BYTES + 1)), {
        let mut v = ack();
        v["sessionId"] = json!("agent");
        v
    }] {
        let server = Server::start();
        server.reply(
            "POST",
            "/api/missions/mission-A/events",
            Reply::json(201, value),
        );
        assert!(matches!(
            submit(&client(), &server.options, &capture()).await,
            Outcome::Unknown(_)
        ));
        assert_eq!(posts(&server), 1);
    }
}
