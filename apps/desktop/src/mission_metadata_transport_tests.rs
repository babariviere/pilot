use super::*;
use crate::{
    mission_browser_fixture as f,
    mission_metadata_fixture::{Reply, Server},
};
use serde_json::json;
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
fn capture() -> Save {
    model::State::default()
        .begin(&source(), " Title 日本語 ", " Goal 👩‍💻 ")
        .unwrap()
}
fn ack() -> Value {
    json!({"id":"mission-A","projectId":"project-A","title":"Title 日本語","goal":"Goal 👩‍💻"})
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
#[tokio::test]
async fn exact_patch_and_ack_only_title_goal() {
    let server = Server::start();
    server.reply("PATCH", "/api/missions/mission-A", Reply::json(200, ack()));
    assert!(matches!(
        write(&client().unwrap(), &server.options, &capture()).await,
        Outcome::Saved(_)
    ));
    let state = server.state.lock().unwrap();
    let mutations: Vec<_> = state.seen.iter().filter(|(m, _, _)| m != "GET").collect();
    assert_eq!(mutations.len(), 1);
    assert_eq!(mutations[0].0, "PATCH");
    assert_eq!(mutations[0].1, "/api/missions/mission-A");
    assert_eq!(
        mutations[0].2,
        json!({"title":"Title 日本語","goal":"Goal 👩‍💻"})
    );
}
#[tokio::test]
async fn foreign_home_missing_catalog_and_wrong_project_never_patch() {
    let server = Server::start();
    let mut s = capture();
    s.source.key.home.daemon = "foreign".into();
    assert!(matches!(
        write(&client().unwrap(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    server.reply(
        "GET",
        "/api/missions/mission-A",
        Reply::json(200, f::detail("mission-B")),
    );
    assert!(matches!(
        write(&client().unwrap(), &server.options, &capture()).await,
        Outcome::NotSent(_)
    ));
    server.reply(
        "GET",
        "/api/mission-catalog",
        Reply::json(
            200,
            json!({"logicalMissions":[],"totals":{"logicalMissions":0},"truncated":false}),
        ),
    );
    assert!(matches!(
        write(&client().unwrap(), &server.options, &capture()).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(writes(&server), 0);
}
#[tokio::test]
async fn errors_redirect_disconnect_and_bad_success_never_replay_or_get_settle() {
    for status in [Some(400), Some(409), Some(500), Some(302), None, Some(200)] {
        let server = Server::start();
        let mut reply = Reply::json(status.unwrap_or(200), json!({"id":"mission-B"}));
        reply.status = status;
        server.reply("PATCH", "/api/missions/mission-A", reply);
        let mut state = model::State::default();
        let s = state.begin(&source(), "Title 日本語", "Goal 👩‍💻").unwrap();
        let outcome = write(&client().unwrap(), &server.options, &s).await;
        assert!(matches!(outcome, Outcome::Unknown(_)), "{status:?}");
        state.finish(&s, outcome);
        assert!(state.begin(&source(), "Title 日本語", "Goal 👩‍💻").is_err());
        // Matching later read remains only a snapshot, not an ACK.
        let mut detail = f::detail("mission-A");
        detail["mission"] = ack();
        server.reply("GET", "/api/missions/mission-A", Reply::json(200, detail));
        assert_eq!(
            fetch(&client().unwrap(), &server.options, &source())
                .await
                .unwrap(),
            s.value
        );
        assert!(matches!(state.attempt, Some((_, Outcome::Unknown(_)))));
        assert_eq!(writes(&server), 1);
    }
}
#[tokio::test]
async fn malformed_oversized_and_wrong_content_ack_are_unknown() {
    for bytes in [
        b"{".to_vec(),
        vec![b' '; model::WIRE_BYTES + 1],
        serde_json::to_vec(
            &json!({"id":"mission-A","projectId":"project-A","title":"different","goal":"Goal 👩‍💻"}),
        )
        .unwrap(),
    ] {
        let server = Server::start();
        server.reply(
            "PATCH",
            "/api/missions/mission-A",
            Reply {
                status: Some(200),
                bytes,
                delay: 0,
            },
        );
        assert!(matches!(
            write(&client().unwrap(), &server.options, &capture()).await,
            Outcome::Unknown(_)
        ));
        assert_eq!(writes(&server), 1);
    }
}
