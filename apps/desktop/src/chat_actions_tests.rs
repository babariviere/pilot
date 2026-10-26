use super::*;
use crate::{
    chat_actions_fixture::{Behavior, Daemon, source},
    chat_actions_worker as transport,
};
use serde_json::json;

fn target(options: &LocalOptions, value: &Value) -> Target {
    Target::new(options, crate::local_model::chat(value).unwrap())
}
#[test]
fn policy_matches_swift_working_retained_history_and_guarded_conversion() {
    let options = LocalOptions::synthetic(1);
    let ordinary = source();
    let e = Evidence::read(&target(&options, &ordinary), &ordinary, true).unwrap();
    assert!(e.archive && e.can_archive && e.can_convert);
    for (field, value) in [
        ("working", json!(true)),
        ("runningJobs", json!([{"id":"job"}])),
    ] {
        let mut raw = ordinary.clone();
        raw[field] = value;
        let e = Evidence::read(&target(&options, &raw), &raw, true).unwrap();
        assert!(!e.can_archive); // Never offers an implicit Stop.
    }
    let mut raw = ordinary.clone();
    raw["archivedAt"] = json!(1234);
    raw["control"] = json!(true);
    let e = Evidence::read(&target(&options, &raw), &raw, true).unwrap();
    assert!(!e.archive && !e.can_archive && !e.can_convert);
    for (field, value) in [
        ("role", json!("specialist")),
        ("missionId", json!("mission")),
        ("continuedTo", json!("next")),
        ("diagnosticHost", json!({"id":"host"})),
    ] {
        let mut raw = ordinary.clone();
        raw[field] = value;
        assert!(
            !Evidence::read(&target(&options, &raw), &raw, true)
                .unwrap()
                .can_convert
        );
    }
    assert!(
        !Evidence::read(&target(&options, &ordinary), &ordinary, false)
            .unwrap()
            .can_convert
    );
}
#[test]
fn original_identity_metadata_and_case_are_not_row_indices_or_titles() {
    let options = LocalOptions::synthetic(1);
    let raw = source();
    let original = target(&options, &raw);
    for field in ["id", "projectId", "cwd", "title", "state"] {
        let mut other = raw.clone();
        other[field] = json!("changed");
        assert!(Evidence::read(&original, &other, true).is_err(), "{field}");
    }
    assert!(!original.matches(&LocalOptions::synthetic(2)));
    let mut other = original.clone();
    other.home.lineage = "another".into();
    assert!(!other.matches(&options));
    let mut other = original.clone();
    other.host.host_id = "remote".into();
    assert!(!other.matches(&options));
    let mut other = original.clone();
    other.chat.local_draft = true;
    assert!(!other.matches(&options));
}

#[test]
fn malformed_or_oversized_metadata_is_not_actionable() {
    let o = LocalOptions::synthetic(1);
    for (field, value) in [
        ("control", json!("false")),
        ("working", json!(1)),
        ("projectId", json!({})),
        ("missionId", json!(123)),
        ("runningJobs", json!({})),
        ("title", json!(null)),
        ("cwd", json!(null)),
        ("archivedAt", json!(-1)),
    ] {
        let mut raw = source();
        raw[field] = value;
        assert!(
            Evidence::read(&target(&o, &raw), &raw, true).is_err(),
            "{field}"
        );
    }
    let mut raw = source();
    raw["title"] = json!("x".repeat(65537));
    assert!(Evidence::read(&target(&o, &raw), &raw, true).is_err());
}
#[test]
fn completion_is_immutable_and_exact_owner_not_current_selection() {
    let o = LocalOptions::synthetic(1);
    let raw = source();
    let e = Evidence::read(&target(&o, &raw), &raw, true).unwrap();
    let mut r = Report {
        id: 42,
        evidence: e.clone(),
        outcome: None,
        observed_current: false,
    };
    let mut other = e.clone();
    other.target.chat.id = "other".into();
    assert!(!r.finish(42, &other, Outcome::Unknown));
    assert!(!r.finish(41, &e, Outcome::Unknown));
    assert!(r.finish(42, &e, Outcome::Acknowledged));
    assert!(!r.finish(42, &e, Outcome::Unknown));
    assert!(r.outcome == Some(Outcome::Acknowledged));
}
#[tokio::test]
async fn inspection_is_get_only_then_exact_archive_and_restore_paths_with_no_body() {
    let daemon = Daemon::start(Behavior::Accept).await;
    let client = transport::client().unwrap();
    let raw = daemon.seen.lock().unwrap().source.clone();
    let t = target(&daemon.options, &raw);
    let e = transport::inspect(&client, &daemon.options, &t)
        .await
        .unwrap();
    assert!(
        daemon
            .seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|r| r.0 == "GET")
    );
    assert!(transport::set(&client, &daemon.options, &e).await == Outcome::Acknowledged);
    let raw = daemon.seen.lock().unwrap().source.clone();
    let t = target(&daemon.options, &raw);
    let e = transport::inspect(&client, &daemon.options, &t)
        .await
        .unwrap();
    assert!(!e.archive);
    assert!(transport::set(&client, &daemon.options, &e).await == Outcome::Acknowledged);
    let seen = daemon.seen.lock().unwrap();
    let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0].1, "/api/sessions/source/archive");
    assert_eq!(posts[1].1, "/api/sessions/source/restore");
    assert!(posts.iter().all(|r| r.2.is_null()));
}
#[tokio::test]
async fn stale_metadata_working_and_wrong_hello_fail_before_any_post() {
    for change in [
        "title",
        "control",
        "working",
        "missionId",
        "daemonId",
        "lineageId",
        "updatedAt",
        "executionPermission",
    ] {
        let d = Daemon::start(Behavior::Accept).await;
        let c = transport::client().unwrap();
        let raw = source();
        let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
            .await
            .unwrap();
        {
            let mut s = d.seen.lock().unwrap();
            match change {
                "daemonId" | "lineageId" => s.hello[change] = json!("wrong"),
                "control" | "working" => s.source[change] = json!(true),
                _ => s.source[change] = json!("changed"),
            }
        }
        assert!(matches!(
            transport::set(&c, &d.options, &e).await,
            Outcome::Rejected(_)
        ));
        assert!(d.seen.lock().unwrap().requests.iter().all(|r| r.0 == "GET"));
    }
}
#[tokio::test]
async fn post_dispatch_failures_are_unknown_and_readback_never_replays_or_settles() {
    for behavior in [Behavior::Lost, Behavior::ErrorAfter, Behavior::WrongId] {
        let d = Daemon::start(behavior).await;
        let c = transport::client().unwrap();
        let raw = source();
        let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
            .await
            .unwrap();
        let outcome = transport::set(&c, &d.options, &e).await;
        assert!(outcome == Outcome::Unknown);
        let raw = d.seen.lock().unwrap().source.clone();
        assert!(raw["archivedAt"].is_number());
        let observed = transport::inspect(&c, &d.options, &target(&d.options, &raw))
            .await
            .unwrap();
        assert!(!observed.archive);
        assert!(outcome == Outcome::Unknown);
        assert_eq!(
            d.seen
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|r| r.0 == "POST")
                .count(),
            1
        );
    }
}
#[tokio::test]
async fn late_ack_stays_original_and_only_explicit_set_submits() {
    let d = Daemon::start(Behavior::Slow).await;
    let c = transport::client().unwrap();
    let raw = source();
    let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
        .await
        .unwrap();
    let release = d.released.clone();
    let seen = d.seen.clone();
    let release_task = tokio::spawn(async move {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if seen.lock().unwrap().requests.iter().any(|r| r.0 == "POST") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release.notify_one();
    });
    assert!(transport::set(&c, &d.options, &e).await == Outcome::Acknowledged);
    release_task.await.unwrap();
    assert_eq!(e.target.chat.id, "source");
    assert_eq!(
        d.seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.0 == "POST")
            .count(),
        1
    );
}
