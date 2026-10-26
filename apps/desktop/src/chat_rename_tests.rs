use super::*;
use crate::{
    chat_actions::{Evidence, Target},
    chat_rename_fixture::{self as f, Behavior, Daemon},
};
#[test]
fn bounded_ecmascript_titles() {
    assert_eq!(normalized(" \u{feff}Hi\t 👩‍💻  é  "), Some("Hi 👩‍💻 é".into()));
    assert_eq!(normalized("\u{feff} "), None);
    assert_eq!(normalized("\u{85}"), Some("\u{85}".into()));
    assert!(bounded(&"😀".repeat(100)));
    assert!(!bounded(&"😀".repeat(101)));
    assert!(normalized(&"a".repeat(201)).is_none());
}
#[tokio::test]
async fn exact_transport_and_ambiguous_receipts_never_replay() {
    for behavior in [
        Behavior::Accept,
        Behavior::Lost,
        Behavior::ErrorAfter,
        Behavior::WrongId,
    ] {
        let d = Daemon::start(behavior).await;
        let target = Target::new(&d.options, crate::local_model::chat(&f::source()).unwrap());
        let e = Evidence::read(&target, &f::source(), true).unwrap();
        let result = rename(&d.options, &e, " New   title 👩‍💻 ").await;
        assert!(
            result
                == if matches!(behavior, Behavior::Accept) {
                    Outcome::Acknowledged
                } else {
                    Outcome::Unknown
                }
        );
        let s = d.seen.lock().unwrap();
        let posts: Vec<_> = s.requests.iter().filter(|r| r.0 == "POST").collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1, "/api/sessions/source/title");
        assert_eq!(posts[0].2, serde_json::json!({"title":"New title 👩‍💻"}));
        assert_eq!(s.source["title"], "New title 👩‍💻");
    }
}
#[tokio::test]
async fn invalid_or_changed_source_never_posts() {
    let d = Daemon::start(Behavior::Accept).await;
    let target = Target::new(&d.options, crate::local_model::chat(&f::source()).unwrap());
    let e = Evidence::read(&target, &f::source(), true).unwrap();
    assert!(matches!(
        rename(&d.options, &e, "   ").await,
        Outcome::Rejected(_)
    ));
    d.seen.lock().unwrap().source["projectId"] = serde_json::json!("changed");
    assert!(matches!(
        rename(&d.options, &e, "new").await,
        Outcome::Rejected(_)
    ));
    assert!(
        !d.seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|r| r.0 == "POST")
    );
}

#[tokio::test]
async fn archived_and_running_titles_use_the_same_exact_contract() {
    for archived in [false, true] {
        let d = Daemon::start(Behavior::Accept).await;
        let mut raw = f::source();
        if archived {
            raw["archivedAt"] = serde_json::json!(1234);
        } else {
            raw["state"] = serde_json::json!("working");
            raw["working"] = serde_json::json!(true);
        }
        d.seen.lock().unwrap().source = raw.clone();
        let target = Target::new(&d.options, crate::local_model::chat(&raw).unwrap());
        let e = Evidence::read(&target, &raw, true).unwrap();
        assert!(rename(&d.options, &e, "A user title").await == Outcome::Acknowledged);
        let seen = d.seen.lock().unwrap();
        for key in [
            "projectId",
            "cwd",
            "mode",
            "archivedAt",
            "state",
            "working",
            "missionId",
        ] {
            assert_eq!(seen.source[key], raw[key]);
        }
        assert_eq!(seen.requests.iter().filter(|r| r.0 == "POST").count(), 1);
    }
}
#[tokio::test]
async fn retained_control_and_wrong_home_are_never_submitted() {
    let d = Daemon::start(Behavior::Accept).await;
    let target = Target::new(&d.options, crate::local_model::chat(&f::source()).unwrap());
    let mut e = Evidence::read(&target, &f::source(), true).unwrap();
    e.stamp["control"] = serde_json::json!(true);
    assert!(matches!(
        rename(&d.options, &e, "New title").await,
        Outcome::Rejected(_)
    ));
    e.stamp["control"] = serde_json::Value::Null;
    e.target.endpoint.push_str("/wrong");
    assert!(matches!(
        rename(&d.options, &e, "New title").await,
        Outcome::Rejected(_)
    ));
    assert!(d.seen.lock().unwrap().requests.is_empty());
}
