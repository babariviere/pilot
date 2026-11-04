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
fn usage_pause_does_not_remove_manual_archive_or_implicitly_stop_a_run() {
    let options = LocalOptions::synthetic(1);
    let mut raw = source();
    raw["subscriptionPause"] = json!({"windows":[]});
    let e = Evidence::read(&target(&options, &raw), &raw, true).unwrap();
    assert!(e.archive && e.can_archive);
    raw["state"] = json!("working");
    let e = Evidence::read(&target(&options, &raw), &raw, true).unwrap();
    // Authoritative working:false remains idle for archive admission.
    assert_eq!(e.can_archive, raw["working"] == false);
    raw["working"] = json!(true);
    let e = Evidence::read(&target(&options, &raw), &raw, true).unwrap();
    assert!(!e.can_archive);
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
        action: Action::Archive,
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
    assert!(
        transport::set(&client, &daemon.options, &e, Action::Archive).await
            == Outcome::Acknowledged
    );
    let raw = daemon.seen.lock().unwrap().source.clone();
    let t = target(&daemon.options, &raw);
    let e = transport::inspect(&client, &daemon.options, &t)
        .await
        .unwrap();
    assert!(!e.archive);
    assert!(
        transport::set(&client, &daemon.options, &e, Action::Archive).await
            == Outcome::Acknowledged
    );
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
            transport::set(&c, &d.options, &e, Action::Archive).await,
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
        let outcome = transport::set(&c, &d.options, &e, Action::Archive).await;
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
    assert!(transport::set(&c, &d.options, &e, Action::Archive).await == Outcome::Acknowledged);
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
#[tokio::test]
async fn a_failed_startup_reloads_once_on_the_exact_route() {
    let d = Daemon::start(Behavior::Accept).await;
    let c = transport::client().unwrap();
    {
        let mut s = d.seen.lock().unwrap();
        s.source["state"] = json!("failed");
        s.source["canRetryStartup"] = json!(true);
    }
    let raw = d.seen.lock().unwrap().source.clone();
    let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
        .await
        .unwrap();
    assert!(e.can_retry_startup);
    assert!(transport::set(&c, &d.options, &e, Action::Retry).await == Outcome::Acknowledged);
    {
        let seen = d.seen.lock().unwrap();
        let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1, "/api/sessions/source/retry-startup");
        assert!(posts[0].2.is_null());
    }
    // A chat without a retryable failure never posts.
    let raw = d.seen.lock().unwrap().source.clone();
    let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
        .await
        .unwrap();
    assert!(!e.can_retry_startup);
    assert!(matches!(
        transport::set(&c, &d.options, &e, Action::Retry).await,
        Outcome::Rejected(_)
    ));
    let seen = d.seen.lock().unwrap();
    assert_eq!(seen.requests.iter().filter(|r| r.0 == "POST").count(), 1);
}

/// Options with a private native-action capability file, as pilotd's GUI home has.
fn with_capability(options: &LocalOptions) -> LocalOptions {
    use std::os::unix::fs::PermissionsExt;
    let home = std::env::temp_dir().join(format!("faux-capability-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&home).unwrap();
    let cap = home.join("github-app-capability");
    std::fs::write(
        &cap,
        json!({"daemonId":"test-daemon","lineageId":"test-lineage","token":"b".repeat(64)})
            .to_string(),
    )
    .unwrap();
    std::fs::set_permissions(&cap, std::fs::Permissions::from_mode(0o600)).unwrap();
    options.clone().with_scope_home(home)
}
fn posts(d: &Daemon) -> Vec<String> {
    let seen = d.seen.lock().unwrap();
    seen.requests
        .iter()
        .filter(|r| r.0 == "POST")
        .map(|r| r.1.clone())
        .collect()
}
#[tokio::test]
async fn setup_runs_again_once_with_native_authority_on_an_idle_chat() {
    let d = Daemon::start(Behavior::Accept).await;
    let c = transport::client().unwrap();
    let options = with_capability(&d.options);
    // A workspace without a recorded setup isn't offered one.
    let raw = d.seen.lock().unwrap().source.clone();
    let e = transport::inspect(&c, &options, &target(&options, &raw))
        .await
        .unwrap();
    assert!(!e.has_setup && !e.can_rerun_setup);
    assert!(matches!(
        transport::set(&c, &options, &e, Action::RerunSetup).await,
        Outcome::Rejected(_)
    ));
    assert!(posts(&d).is_empty());
    d.seen.lock().unwrap().source["workspaceSetup"] =
        json!({"state":"failed","detail":"Setup failed: Install (exit 1)"});
    let raw = d.seen.lock().unwrap().source.clone();
    let e = transport::inspect(&c, &options, &target(&options, &raw))
        .await
        .unwrap();
    assert!(e.has_setup && e.can_rerun_setup);
    assert!(transport::set(&c, &options, &e, Action::RerunSetup).await == Outcome::Acknowledged);
    assert_eq!(posts(&d), ["/api/sessions/source/setup"]);
    // Queued setup isn't offered again; neither is a working chat's.
    let raw = d.seen.lock().unwrap().source.clone();
    let e = transport::inspect(&c, &options, &target(&options, &raw))
        .await
        .unwrap();
    assert!(e.has_setup && !e.can_rerun_setup);
    let mut working = raw.clone();
    working["workspaceSetup"] = json!({"state":"ok"});
    working["working"] = json!(true);
    let e = Evidence::read(&target(&options, &working), &working, true).unwrap();
    assert!(e.has_setup && !e.can_rerun_setup);
}
#[tokio::test]
async fn setup_rerun_refusals_change_nothing_and_lost_answers_stay_unknown() {
    for (behavior, unknown) in [
        (Behavior::Refuse(409), false),
        (Behavior::Refuse(404), false),
        (Behavior::Refuse(403), false),
        (Behavior::Refuse(503), false),
        (Behavior::Lost, true),
        (Behavior::ErrorAfter, true),
        (Behavior::WrongId, true),
    ] {
        let d = Daemon::start(behavior).await;
        let c = transport::client().unwrap();
        let options = with_capability(&d.options);
        d.seen.lock().unwrap().source["workspaceSetup"] = json!({"state":"failed"});
        let raw = d.seen.lock().unwrap().source.clone();
        let e = transport::inspect(&c, &options, &target(&options, &raw))
            .await
            .unwrap();
        let outcome = transport::set(&c, &options, &e, Action::RerunSetup).await;
        assert_eq!(outcome == Outcome::Unknown, unknown);
        assert!(unknown || matches!(outcome, Outcome::Rejected(_)));
        assert_eq!(posts(&d).len(), 1, "one POST, never repeated");
    }
    // Without native authority nothing is sent.
    let d = Daemon::start(Behavior::Accept).await;
    let c = transport::client().unwrap();
    d.seen.lock().unwrap().source["workspaceSetup"] = json!({"state":"failed"});
    let raw = d.seen.lock().unwrap().source.clone();
    let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
        .await
        .unwrap();
    assert!(matches!(
        transport::set(&c, &d.options, &e, Action::RerunSetup).await,
        Outcome::Rejected(_)
    ));
    assert!(posts(&d).is_empty());
}

fn failed_turn() -> Value {
    let mut raw = source();
    raw["state"] = json!("parked");
    raw["outcome"] = json!("failed");
    raw["outcomeAt"] = json!(42);
    raw["outcomeReason"] = json!("Synthetic provider error 日本語");
    raw
}
#[test]
fn turn_retry_follows_visible_guards_and_never_a_saved_model() {
    let o = LocalOptions::synthetic(1);
    let raw = failed_turn();
    let e = Evidence::read(&target(&o, &raw), &raw, true).unwrap();
    assert!(e.can_retry_turn && !e.can_retry_startup);
    assert_eq!(e.stamp["outcomeAt"], 42);
    for (field, value) in [
        ("working", json!(true)),
        ("state", json!("working")),
        ("state", json!("failed")),
        ("runningJobs", json!([{"id":"job"}])),
        ("archivedAt", json!(5)),
        ("control", json!(true)),
        ("continuedTo", json!("next")),
        ("sleepPaused", json!(true)),
        ("offlinePaused", json!(true)),
        ("canRetryStartup", json!(true)),
        ("outcome", json!("done")),
        // pilotd applies a saved choice only to a startup retry or a new message.
        ("nextAttemptModel", json!({"model":"provider/next"})),
    ] {
        let mut raw = raw.clone();
        raw[field] = value;
        let e = Evidence::read(&target(&o, &raw), &raw, true).unwrap();
        assert!(!e.can_retry_turn, "{field}");
    }
    // A changed attempt or completion version is a different failure.
    for (field, value) in [
        ("outcomeAt", json!(43)),
        ("attempts", json!([{"id":"2","active":true}])),
    ] {
        let mut other = raw.clone();
        other[field] = value;
        assert!(
            matches!(Evidence::read(&target(&o, &raw), &other, true), Err(e) if e == CHANGED),
            "{field}"
        );
    }
}
#[tokio::test]
async fn a_failed_turn_retries_once_through_pilotd_and_never_reposts() {
    let d = Daemon::start(Behavior::Accept).await;
    let c = transport::client().unwrap();
    d.seen.lock().unwrap().source = failed_turn();
    let raw = failed_turn();
    let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
        .await
        .unwrap();
    assert!(
        transport::set(&c, &d.options, &e, Action::RetryTurn(7)).await == Outcome::Acknowledged
    );
    let seen = d.seen.lock().unwrap();
    let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].1, "/api/sessions/source/rewind");
    assert_eq!(posts[0].2, json!({"action":"retry","entryId":7}));
    assert!(
        !seen.requests.iter().any(|r| r.1.ends_with("/messages")),
        "the client never reposts the earlier message"
    );
}
#[tokio::test]
async fn turn_retry_refuses_before_post_when_stale_or_ineligible() {
    for change in [
        "outcomeAt",
        "working",
        "nextAttemptModel",
        "attempt",
        "daemonId",
    ] {
        let d = Daemon::start(Behavior::Accept).await;
        let c = transport::client().unwrap();
        d.seen.lock().unwrap().source = failed_turn();
        let raw = failed_turn();
        let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
            .await
            .unwrap();
        {
            let mut s = d.seen.lock().unwrap();
            match change {
                "outcomeAt" => s.source["outcomeAt"] = json!(43),
                "working" => s.source["working"] = json!(true),
                "nextAttemptModel" => {
                    s.source["nextAttemptModel"] = json!({"model":"provider/next"})
                }
                "attempt" => s.source["attempts"] = json!([{"id":"2","active":true}]),
                _ => s.hello[change] = json!("wrong"),
            }
        }
        assert!(
            matches!(
                transport::set(&c, &d.options, &e, Action::RetryTurn(7)).await,
                Outcome::Rejected(_)
            ),
            "{change}"
        );
        assert!(
            d.seen.lock().unwrap().requests.iter().all(|r| r.0 == "GET"),
            "{change}"
        );
    }
    // Ineligible evidence never posts, even when it is current.
    let d = Daemon::start(Behavior::Accept).await;
    let c = transport::client().unwrap();
    let mut raw = failed_turn();
    raw["nextAttemptModel"] = json!({"model":"provider/next"});
    d.seen.lock().unwrap().source = raw.clone();
    let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
        .await
        .unwrap();
    assert!(matches!(
        transport::set(&c, &d.options, &e, Action::RetryTurn(7)).await,
        Outcome::Rejected(_)
    ));
    assert!(d.seen.lock().unwrap().requests.iter().all(|r| r.0 == "GET"));
}
#[tokio::test]
async fn turn_retry_lost_conflict_or_mismatched_ack_is_unknown_and_validation_is_refused() {
    for (behavior, unknown) in [
        (Behavior::Lost, true),
        (Behavior::ErrorAfter, true),
        (Behavior::WrongId, true),
        (Behavior::Refuse(409), true),
        (Behavior::Refuse(500), true),
        (Behavior::Refuse(400), false),
        (Behavior::Refuse(404), false),
    ] {
        let d = Daemon::start(behavior).await;
        let c = transport::client().unwrap();
        d.seen.lock().unwrap().source = failed_turn();
        let raw = failed_turn();
        let e = transport::inspect(&c, &d.options, &target(&d.options, &raw))
            .await
            .unwrap();
        let outcome = transport::set(&c, &d.options, &e, Action::RetryTurn(7)).await;
        if unknown {
            assert!(outcome == Outcome::Unknown);
        } else {
            assert!(matches!(outcome, Outcome::Rejected(_)));
        }
        // A later read observes the new run; it is not a receipt and nothing is repeated.
        let _ = transport::inspect(&c, &d.options, &target(&d.options, &raw)).await;
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
