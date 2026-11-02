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
        Err("A Slack message from Pilot couldn't be read (project)."),
        "the reason names what was unreadable"
    );
    let s = server();
    s.reply(
        "GET",
        "/api/tracked-items",
        Reply::status(
            Some(200),
            json!({"items":[item("m9", "p3", "Elsewhere", "open", "low", 1)],"total":1}),
        ),
    );
    assert_eq!(
        read(&client(), &s.options, Some("p1"), false).await,
        Err("Pilot listed a Slack message under the wrong project.")
    );
}

/// Installed pilotd 1.103 (and current) stores `updatedAt = Number(threadTs) * 1000`, so
/// every Slack item's time is fractional. One such item once failed the whole board.
#[tokio::test]
async fn production_fractional_times_and_optional_fields_load() {
    let s = server();
    for raw in s.state.lock().unwrap().items.iter_mut() {
        let ms = raw["updatedAt"].as_u64().unwrap() as f64 + 0.001;
        raw["updatedAt"] = json!(ms);
        raw["createdAt"] = json!(ms);
        raw["metadata"]["confidence"] = json!(0.92);
        raw["metadata"]["summary"] = json!("Synthetic summary 日本語");
        raw["slack"]["overrides"] = json!({});
        raw["linearParent"] = Value::Null;
    }
    let board = read(&client(), &s.options, None, false).await.unwrap();
    let m1 = board.item("m1").unwrap();
    assert_eq!(m1.updated_at, 1, "fractional milliseconds floor, not fail");
    assert_eq!(board.project("p1").unwrap().items.len(), 3);
    // The thread route is newer than pilotd 1.103: a 404 says to update, not "couldn't load".
    s.reply(
        "GET",
        "/api/tracked-items/m1/thread",
        Reply::status(Some(404), json!({"error":"Unknown tracking operation"})),
    );
    assert_eq!(
        crate::slack_triage_transport::thread(&client(), &s.options, "m1").await,
        Err(
            "This version of Pilot can't show Slack threads yet. Update Pilot to read them here."
                .into()
        )
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
async fn threads_and_polls_keep_pilotd_reasons() {
    let s = server();
    s.state.lock().unwrap().threads.insert(
        "m1".into(),
        json!({"itemId":"m1","more":true,"messages":[
            {"ts":"1700000000.000100","author":"Ana","text":"Bonjour 日本 👩‍💻\nline two","truncated":true},
            {"ts":"1700000100.000200","text":"","truncated":false}]}),
    );
    let thread = thread(&client(), &s.options, "m1").await.unwrap();
    assert!(thread.more);
    let [parent, reply] = &thread.messages[..] else {
        panic!("{thread:?}")
    };
    assert_eq!(parent.author.as_deref(), Some("Ana"));
    assert_eq!(parent.text, "Bonjour 日本 👩‍💻\nline two");
    assert!(parent.truncated);
    assert_eq!(parent.at(), Some(1_700_000_000_000));
    assert!(reply.author.is_none() && reply.text.is_empty());
    s.state.lock().unwrap().threads.insert(
        "m3".into(),
        json!({"itemId":"other","more":false,"messages":[{"ts":"1.000001","text":"x","truncated":false}]}),
    );
    assert_eq!(
        crate::slack_triage_transport::thread(&client(), &s.options, "m3").await,
        Err("Couldn't load this message.".into()),
        "another message's thread is never shown"
    );
    assert_eq!(
        crate::slack_triage_transport::thread(&client(), &s.options, "m2").await,
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
