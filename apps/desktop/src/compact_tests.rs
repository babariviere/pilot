use super::*;
use crate::{
    chat_actions_fixture::{Behavior, Daemon, source},
    chat_actions_worker as transport,
};
use serde_json::json;

#[test]
fn compact_requires_a_healthy_idle_interactive_session() {
    let options = LocalOptions::synthetic(1);
    let read = |raw: &Value| {
        Evidence::read(
            &Target::new(&options, crate::local_model::chat(raw).unwrap()),
            raw,
            true,
        )
        .unwrap()
    };
    assert!(read(&source()).can_compact);
    for (key, value) in [
        ("state", json!("working")),
        ("state", json!("failed")),
        ("working", json!(true)),
        ("archivedAt", json!(1)),
        ("failure", json!("broken")),
        ("outcome", json!("failed")),
        ("preparing", json!(true)),
        ("initializing", json!(true)),
        ("control", json!(true)),
        ("continuedTo", json!("next")),
        ("runningJobs", json!([{"id":"job"}])),
        ("pending", json!([{}])),
        ("subscriptionPause", json!({"forced":false})),
        ("continuationPending", json!(true)),
        ("sleepPaused", json!(true)),
        ("offlinePaused", json!(true)),
        ("kernelRestartPending", json!(true)),
    ] {
        let mut raw = source();
        raw[key] = value;
        assert!(!read(&raw).can_compact, "{key}: {raw}");
    }
}

#[tokio::test]
async fn compact_posts_once_and_only_the_real_ack_is_accepted() {
    for (behavior, expected) in [
        (Behavior::Accept, Outcome::Acknowledged),
        (Behavior::Lost, Outcome::Unknown),
        (Behavior::WrongId, Outcome::Unknown),
        (Behavior::ErrorAfter, Outcome::Unknown),
        (
            Behavior::Refuse(409),
            Outcome::CompactRefused("synthetic refusal".into()),
        ),
        (
            Behavior::Refuse(400),
            Outcome::CompactRefused("synthetic refusal".into()),
        ),
        (Behavior::Refuse(500), Outcome::Unknown),
        (Behavior::Refuse(200), Outcome::Unknown),
        (Behavior::Refuse(202), Outcome::Unknown),
        (
            Behavior::Refuse(404),
            Outcome::CompactRefused("synthetic refusal".into()),
        ),
    ] {
        let daemon = Daemon::start(behavior).await;
        let client = transport::client().unwrap();
        let target = Target::new(
            &daemon.options,
            crate::local_model::chat(&source()).unwrap(),
        );
        let evidence = transport::inspect(&client, &daemon.options, &target)
            .await
            .unwrap();
        assert!(
            transport::set(&client, &daemon.options, &evidence, Action::Compact).await == expected
        );
        let seen = daemon.seen.lock().unwrap();
        let posts: Vec<_> = seen
            .requests
            .iter()
            .filter(|(method, _, _)| method == "POST")
            .collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1, "/api/sessions/source/compact");
        assert_eq!(posts[0].2, json!({}));
    }
}

#[tokio::test]
async fn compact_rechecks_session_and_hello_before_any_post() {
    for hello in [false, true] {
        let daemon = Daemon::start(Behavior::Accept).await;
        let client = transport::client().unwrap();
        let target = Target::new(
            &daemon.options,
            crate::local_model::chat(&source()).unwrap(),
        );
        let evidence = transport::inspect(&client, &daemon.options, &target)
            .await
            .unwrap();
        {
            let mut seen = daemon.seen.lock().unwrap();
            if hello {
                seen.hello["daemonId"] = json!("other");
            } else {
                seen.source["working"] = json!(true);
            }
        }
        assert!(matches!(
            transport::set(&client, &daemon.options, &evidence, Action::Compact).await,
            Outcome::Rejected(_)
        ));
        assert!(
            daemon
                .seen
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _, _)| m != "POST")
        );
    }
}
