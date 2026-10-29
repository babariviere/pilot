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
    let Outcome::Saved(saved) = &outcome else {
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
    assert!(matches!(outcome, Outcome::Saved(_)));
}
