use super::*;
use crate::{
    slack_triage::Status,
    slack_triage_fixture::{Reply, Server, item, project, source},
};
use serde_json::json;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

fn server() -> Server {
    let mut closed = item("closed", "p1", "Spam", "dismissed", "low", 3);
    closed["slack"]["closedByLabel"] = json!("Spam");
    Server::start(
        vec![
            project("p1", "Atlas", &["C1"]),
            project("p2", "Boreal", &[]),
            project("p3", "Cirrus", &["C9"]),
        ],
        vec![source("p1", "ok"), source("p3", "syncing")],
        vec![
            item("m1", "p1", "Checkout fails", "open", "high", 1),
            item("m2", "p1", "Question", "done", "low", 2),
            item("gone", "p1", "Gone", "dismissed", "low", 4),
            closed,
            item("c1", "p3", "Other project", "open", "medium", 5),
        ],
    )
}

#[tokio::test]
async fn reads_scoped_projects_only_through_get_and_the_pinned_identity() {
    let s = server();
    let board = read(&client(), &s.options, None, false).await.unwrap();
    let ids: Vec<_> = board
        .projects
        .iter()
        .map(|p| p.project.id.as_str())
        .collect();
    assert_eq!(
        ids,
        ["p1", "p3"],
        "only Slack-tracking projects in All projects"
    );
    let p1 = board.project("p1").unwrap();
    let items: Vec<_> = p1.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        items,
        ["m1", "m2", "closed"],
        "label-closed rows read for Show hidden"
    );
    assert_eq!(p1.active_total, 2);
    assert!(
        board
            .project("p3")
            .unwrap()
            .source
            .as_ref()
            .unwrap()
            .syncing()
    );
    let one = read(&client(), &s.options, Some("p2"), true).await.unwrap();
    assert_eq!(one.projects.len(), 1);
    assert!(!one.projects[0].project.tracks_slack() && one.projects[0].items.is_empty());
    let shown = read(&client(), &s.options, Some("p1"), true).await.unwrap();
    assert_eq!(
        shown.projects[0].items.len(),
        4,
        "Show dismissed reads every dismissed row"
    );
    assert_eq!(
        read(&client(), &s.options, Some("missing"), false).await,
        Err("This project is no longer available.")
    );
    assert!(s.state.lock().unwrap().writes().is_empty());
}

#[tokio::test]
async fn foreign_identity_and_malformed_replies_are_refused_whole() {
    let s = server();
    s.state.lock().unwrap().daemon = "other".into();
    assert!(read(&client(), &s.options, None, false).await.is_err());
    let s = server();
    s.reply(
        "GET",
        "/api/tracked-items",
        Reply::status(
            Some(200),
            json!({"items":[{"kind":"slack","id":"x"}],"total":1}),
        ),
    );
    assert_eq!(
        read(&client(), &s.options, Some("p1"), false).await,
        Err("Pilot's Slack messages couldn't be read.")
    );
}

#[tokio::test]
async fn patch_sends_one_narrow_override_and_confirms_the_echo() {
    let s = server();
    let outcome = patch(
        &client(),
        &s.options,
        "m1",
        "p1",
        &Change::Status(Status::Done),
    )
    .await;
    let Outcome::Saved(saved) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(saved.triage.status, Status::Done);
    let writes = s.state.lock().unwrap().writes();
    assert_eq!(
        writes,
        [(
            "PATCH".to_owned(),
            "/api/tracked-items/m1".to_owned(),
            json!({"slack":{"status":"done"}})
        )]
    );
}

#[tokio::test]
async fn unconfirmed_patches_are_unknown_and_sent_once() {
    for (status, apply, body) in [
        (Some(500), true, json!({"error":"disk"})),
        (
            Some(400),
            false,
            json!({"error":"Unknown project Slack label"}),
        ),
        (None, true, json!(null)),
        (
            Some(200),
            false,
            item("m1", "p1", "Checkout fails", "open", "high", 1),
        ),
        (
            Some(200),
            false,
            item("m2", "p1", "Another", "done", "low", 1),
        ),
    ] {
        let s = server();
        s.reply(
            "PATCH",
            "/api/tracked-items/m1",
            Reply {
                apply,
                ..Reply::status(status, body)
            },
        );
        let outcome = patch(
            &client(),
            &s.options,
            "m1",
            "p1",
            &Change::Status(Status::Done),
        )
        .await;
        assert!(
            matches!(outcome, Outcome::Unknown(_)),
            "{status:?} {outcome:?}"
        );
        assert_eq!(s.state.lock().unwrap().writes().len(), 1, "never resent");
    }
    let s = server();
    s.state.lock().unwrap().daemon = "other".into();
    let outcome = patch(
        &client(),
        &s.options,
        "m1",
        "p1",
        &Change::Status(Status::Done),
    )
    .await;
    assert!(matches!(outcome, Outcome::NotSent(_)));
    assert!(
        s.state.lock().unwrap().writes().is_empty(),
        "foreign daemon is never written"
    );
}

#[tokio::test]
async fn excerpts_and_polls_keep_pilotd_reasons() {
    let s = server();
    s.state.lock().unwrap().excerpts.insert(
        "m1".into(),
        json!({"itemId":"m1","author":"Ana","text":"Bonjour 日本 👩‍💻\nline two","truncated":true}),
    );
    let e = excerpt(&client(), &s.options, "m1").await.unwrap();
    assert_eq!(e.author.as_deref(), Some("Ana"));
    assert_eq!(e.text, "Bonjour 日本 👩‍💻\nline two");
    assert!(e.truncated);
    assert_eq!(
        excerpt(&client(), &s.options, "m2").await,
        Err("Couldn't read this message from Slack.".into())
    );
    assert_eq!(poll(&client(), &s.options, "p1").await, PollOutcome::Done);
    s.reply(
        "POST",
        "/api/sources/p1:slack/poll",
        Reply::status(
            Some(409),
            json!({"error":"Slack hourly budget reached. Resumes next hour."}),
        ),
    );
    assert_eq!(
        poll(&client(), &s.options, "p1").await,
        PollOutcome::Refused("Slack hourly budget reached. Resumes next hour.".into())
    );
    let posts: Vec<_> = s
        .state
        .lock()
        .unwrap()
        .writes()
        .into_iter()
        .map(|(m, p, b)| (m, p, b))
        .collect();
    assert_eq!(posts.len(), 2);
    assert!(
        posts
            .iter()
            .all(|(m, p, b)| m == "POST" && p == "/api/sources/p1:slack/poll" && b.is_null()),
        "never forced"
    );
}
