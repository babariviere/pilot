use super::*;
use crate::mission_create_fixture::{Reply, Server, ack};
use serde_json::json;
fn submission(server: &Server) -> Submission {
    Submission {
        id: "intent-A".into(),
        home: Home::local(&server.options.host()),
        project: "project-A".into(),
        title: " Title 日本語 ".into(),
        body: " Goal 👩‍💻 ".into(),
    }
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
#[tokio::test]
async fn creates_only_empty_mission_with_exact_project_and_ack() {
    let server = Server::start();
    let s = submission(&server);
    assert_eq!(
        submit(&client(), &server.options, &s).await,
        Outcome::Created("mission-created".into())
    );
    let seen = &server.state.lock().unwrap().seen;
    assert_eq!(seen.iter().filter(|(m, _, _)| m == "POST").count(), 1);
    assert_eq!(
        seen.iter().find(|(m, _, _)| m == "POST").unwrap().2,
        json!({"projectId":"project-A","title":s.title,"goal":s.body,"startCoordinator":false})
    );
    assert_eq!(
        seen.iter()
            .map(|(m, p, _)| format!("{m} {p}"))
            .collect::<Vec<_>>(),
        [
            "GET /api/hello",
            "GET /api/projects",
            "GET /api/hello",
            "POST /api/missions"
        ]
    );
}
#[tokio::test]
async fn errors_after_post_are_unknown_not_retryable_and_never_reconciled() {
    for status in [None, Some(400), Some(409), Some(500), Some(302), Some(201)] {
        let server = Server::start();
        let s = submission(&server);
        server.reply(
            "POST",
            "/api/missions",
            Reply {
                status,
                bytes: b"not json".to_vec(),
                delay: 0,
            },
        );
        assert!(matches!(
            submit(&client(), &server.options, &s).await,
            Outcome::Unknown(_)
        ));
        assert_eq!(server.posts(), 1);
        assert_eq!(server.state.lock().unwrap().seen.len(), 4);
    }
}
#[tokio::test]
async fn unproven_home_or_catalog_prevents_post() {
    for value in [
        json!([]),
        json!([{"id":"project-A","path":"relative"}]),
        json!({"projects":[]}),
    ] {
        let server = Server::start();
        let s = submission(&server);
        server.reply("GET", "/api/projects", Reply::json(200, value));
        assert!(matches!(
            submit(&client(), &server.options, &s).await,
            Outcome::NotSent(_)
        ));
        assert_eq!(server.posts(), 0);
    }
    let server = Server::start();
    let mut s = submission(&server);
    s.home.daemon = "other".into();
    assert!(matches!(
        submit(&client(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(server.state.lock().unwrap().seen.len(), 0);
    s = submission(&server);
    server.reply(
        "GET",
        "/api/hello",
        Reply::json(200, json!({"daemonId":"changed"})),
    );
    assert!(matches!(
        submit(&client(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(server.posts(), 0);
}
#[test]
fn acknowledgements_are_scoped_empty_and_cannot_retarget_pending_intent() {
    let server = Server::start();
    let s = submission(&server);
    let good = ack(&json!({"projectId":s.project,"title":s.title,"goal":s.body}));
    assert!(model::acknowledge(&s, &good).is_ok());
    for (field, value) in [
        ("projectId", json!("project-B")),
        ("title", json!("Other")),
        ("goal", json!("Other")),
        ("coordinatorSessionId", json!("chat-A")),
        ("briefRevision", json!(1)),
    ] {
        let mut v = good.clone();
        v["mission"][field] = value;
        assert!(model::acknowledge(&s, &v).is_err());
    }
    for field in [
        "tasks",
        "phases",
        "decisions",
        "decisionProposals",
        "comments",
        "artifacts",
        "resources",
    ] {
        let mut v = good.clone();
        v[field] = json!([{}]);
        assert!(model::acknowledge(&s, &v).is_err());
    }
    let mut state = model::State::default();
    let pending = state.begin(&s.home, &s.project, &s.title, &s.body).unwrap();
    assert!(state.begin(&s.home, "project-B", "Other", "Goal").is_err());
    let mut wrong = pending.clone();
    wrong.project = "project-B".into();
    assert!(!state.finish(&wrong, Outcome::Created("wrong".into())));
    assert!(state.finish(&pending, Outcome::Unknown("lost")));
    assert!(state.begin(&s.home, &s.project, &s.title, &s.body).is_err());
    assert!(!state.finish(&pending, Outcome::Created("late".into())));
}
#[test]
fn bounded_unicode_validation_uses_daemon_whitespace_and_utf16_limits() {
    assert!(model::validate("\u{feff}", "Goal").is_err());
    assert!(model::validate("Title", "\u{a0}").is_err());
    assert!(model::validate(&"😀".repeat(100), &"😀".repeat(2000)).is_ok());
    assert!(model::validate(&"😀".repeat(101), "Goal").is_err());
    assert!(model::validate("Title", &"😀".repeat(2001)).is_err());
}
