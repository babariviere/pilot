use super::*;
use crate::{
    project_settings::{Editor, Status},
    project_settings_fixture::{Reply, Server, project},
};
use serde_json::json;

fn editor(server: &Server, id: &str) -> Editor {
    let value = server.state.lock().unwrap().projects[id].clone();
    Editor::new(&crate::local_model::projects(&json!([value])).unwrap()[0])
}

#[tokio::test]
async fn save_patches_only_changed_fields_and_preserves_other_settings() {
    let server = Server::start(&[project("a", "Atlas"), project("b", "Atlas")]);
    let mut e = editor(&server, "a");
    e.set_name(" Atlas 日本語 👩‍💻 ");
    e.set_require_pull_request(false);
    let s = e.begin_save().unwrap();
    let outcome = submit(&client().unwrap(), &server.options, &s).await;
    let Outcome::Saved(saved, _) = &outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(saved.id, "a");
    assert!(e.finish(&s, outcome));
    assert_eq!(*e.status(), Status::Idle);
    assert!(!e.dirty());
    let state = server.state.lock().unwrap();
    assert_eq!(
        state.patches(),
        [json!({"name":"Atlas 日本語 👩‍💻","requirePullRequest":false})]
    );
    assert_eq!(
        state.projects["a"]["tracking"],
        json!({"slackChannels":["C1"]})
    );
    assert_eq!(
        state.projects["b"]["name"], "Atlas",
        "same-name neighbor untouched"
    );
    assert!(state.projects["a"].get("workspace").is_none());
}

#[tokio::test]
async fn removed_or_changed_project_is_not_patched() {
    let server = Server::start(&[project("a", "Atlas")]);
    let mut e = editor(&server, "a");
    e.set_isolated(false);
    let s = e.begin_save().unwrap();
    server.set(json!({"id":"a","name":"Atlas","path":"/synthetic/a","workspace":"direct"}));
    assert!(matches!(
        submit(&client().unwrap(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    server.remove("a");
    assert_eq!(
        submit(&client().unwrap(), &server.options, &s).await,
        Outcome::NotSent("This project was removed. Nothing was changed.")
    );
    assert!(server.state.lock().unwrap().patches().is_empty());
}

#[tokio::test]
async fn foreign_daemon_identity_is_not_patched() {
    let server = Server::start(&[project("a", "Atlas")]);
    server.reply(
        "GET",
        "/api/hello",
        Reply {
            body: json!({"daemonId":"other","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1}),
            ..Reply::status(Some(200), false)
        },
    );
    let mut e = editor(&server, "a");
    e.set_isolated(false);
    let s = e.begin_save().unwrap();
    assert!(matches!(
        submit(&client().unwrap(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert!(server.state.lock().unwrap().patches().is_empty());
}

#[tokio::test]
async fn errors_and_lost_replies_are_unknown_and_sent_once() {
    for (status, apply) in [
        (Some(500), true),
        (Some(400), false),
        (None, true),
        (Some(302), false),
    ] {
        let server = Server::start(&[project("a", "Atlas")]);
        server.reply("PATCH", "/api/projects/a", Reply::status(status, apply));
        let mut e = editor(&server, "a");
        e.set_isolated(false);
        let s = e.begin_save().unwrap();
        let outcome = submit(&client().unwrap(), &server.options, &s).await;
        assert!(matches!(outcome, Outcome::Unknown(_)), "{status:?}");
        e.finish(&s, outcome);
        assert!(matches!(e.status(), Status::Unknown(_)));
        assert!(e.dirty(), "edits survive");
        assert_eq!(server.state.lock().unwrap().patches().len(), 1, "no retry");
    }
}

#[tokio::test]
async fn ok_reply_without_the_change_is_not_saved() {
    let server = Server::start(&[project("a", "Atlas")]);
    server.reply(
        "PATCH",
        "/api/projects/a",
        Reply {
            body: project("a", "Atlas"),
            ..Reply::status(Some(200), false)
        },
    );
    let mut e = editor(&server, "a");
    e.set_isolated(false);
    let s = e.begin_save().unwrap();
    let outcome = submit(&client().unwrap(), &server.options, &s).await;
    e.finish(&s, outcome);
    assert!(matches!(e.status(), Status::Unknown(_)));
}

#[test]
fn background_start_reports_the_same_submission() {
    let server = Server::start(&[project("a", "Atlas")]);
    let mut e = editor(&server, "a");
    e.set_isolated(false);
    let s = e.begin_save().unwrap();
    let rx = start(server.options.clone(), s.clone()).unwrap();
    let (back, outcome) = rx.recv_blocking().unwrap();
    assert_eq!(back, s);
    assert!(matches!(outcome, Outcome::Saved(..)));
}

#[tokio::test]
async fn slack_save_replaces_tracking_once_and_keeps_everything_else() {
    let mut atlas = project("a", "Atlas");
    atlas["tracking"] =
        json!({"slackChannels":["C1"],"linearTeam":"T1","linearTeamName":"Platform"});
    let server = Server::start(&[atlas]);
    let client = client().unwrap();
    let read = crate::project_slack_reader::read(&client, &server.options, "a").await;
    let mut e = editor(&server, "a");
    let t = e.begin_read().unwrap();
    e.finish_read(t, read.tracking);
    e.add_channel("C0123ABCD", Some("日本-support"));
    let s = e.begin_save().unwrap();
    let outcome = submit(&client, &server.options, &s).await;
    assert!(e.finish(&s, outcome));
    assert_eq!(*e.status(), Status::Idle);
    assert!(!e.dirty());
    let state = server.state.lock().unwrap();
    assert_eq!(state.patches().len(), 1);
    assert_eq!(
        state.projects["a"]["tracking"],
        json!({"slackChannels":["C1","C0123ABCD"],"slackChannelNames":{"C0123ABCD":"日本-support"},
            "linearTeam":"T1","linearTeamName":"Platform"})
    );
    assert_eq!(
        state.projects["a"]["environment"],
        json!({"secret":"never shown"})
    );
    assert_eq!(state.projects["a"]["name"], "Atlas");
}

#[tokio::test]
async fn slack_save_is_refused_when_tracking_changed_after_the_read() {
    let server = Server::start(&[project("a", "Atlas")]);
    let mut e = editor(&server, "a");
    let t = e.begin_read().unwrap();
    e.finish_read(t, Ok(json!({"slackChannels":["C1"]})));
    e.remove_channel("C1");
    let s = e.begin_save().unwrap();
    let mut theirs = project("a", "Atlas");
    theirs["tracking"] = json!({"slackChannels":["C1"],"linearTeam":"T2"});
    server.set(theirs);
    assert!(matches!(
        submit(&client().unwrap(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert!(server.state.lock().unwrap().patches().is_empty());
}

#[tokio::test]
async fn slack_reads_are_get_only_and_project_scoped() {
    let server = Server::start(&[project("a", "Atlas")]);
    {
        let mut state = server.state.lock().unwrap();
        state.sources = json!([
            {"projectId":"b","kind":"slack","status":"error"},
            {"projectId":"a","kind":"slack","status":"ok","channels":[{"id":"C1","status":"pending"}]}
        ]);
        state.channels = json!({"status":"ok","items":[{"id":"C2","name":"日本","private":false}]});
    }
    let client = client().unwrap();
    let read = crate::project_slack_reader::read(&client, &server.options, "a").await;
    assert_eq!(read.tracking, Ok(json!({"slackChannels":["C1"]})));
    let source = read.source.unwrap();
    assert_eq!(
        (
            source.status.as_str(),
            source.channel("C1").unwrap().status.as_str()
        ),
        ("ok", "pending")
    );
    let lookup =
        crate::project_slack_reader::channels(&client, &server.options, " 日本 & co ").await;
    assert!(
        matches!(lookup, crate::project_slack::Lookup::Found { ref items, .. } if items[0].id == "C2")
    );
    let missing = crate::project_slack_reader::read(&client, &server.options, "gone").await;
    assert_eq!(missing.tracking, Err("This project was removed."));
    let state = server.state.lock().unwrap();
    assert!(state.seen.iter().all(|(m, _, _)| m == "GET"));
    assert_eq!(
        state.lookups(),
        ["/api/tracking/slack/channels?query=%E6%97%A5%E6%9C%AC+%26+co"]
    );
}
