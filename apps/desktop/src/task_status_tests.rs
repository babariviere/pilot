use super::*;
use crate::{
    mission_browser_fixture as f,
    task_status_fixture::{Reply, Server},
    task_status_transport::submit,
};
use serde_json::json;
fn target() -> Target {
    Target {
        key: f::key("mission-A"),
        task: "task-A".into(),
        number: 1,
        title: "Keep the draft".into(),
        current: "done".into(),
    }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap()
}
#[test]
fn immutable_intent_and_receipt_fences() {
    let mut state = State::default();
    let t = target();
    assert!(state.begin(&t, "done").is_err());
    assert!(state.begin(&t, "made-up").is_err());
    let s = state.begin(&t, "todo").unwrap();
    let mut other = s.clone();
    other.id = "other".into();
    assert!(!state.finish(&other, Outcome::Acknowledged));
    assert!(state.begin(&t, "blocked").is_err());
    assert!(state.finish(&s, Outcome::Unknown("lost")));
    assert!(state.begin(&t, "todo").is_err());
    assert!(!state.finish(&s, Outcome::Acknowledged));
    assert!(backward("done", "todo"));
    assert!(backward("in_review", "blocked"));
    assert!(!backward("todo", "done"));
}
#[test]
fn validates_exact_ack_including_projected_stored_status() {
    let s = State::default().begin(&target(), "todo").unwrap();
    let v = json!({"id":"task-A","number":1,"title":"Keep the draft","status":"blocked","storedStatus":"todo","updatedAt":2});
    assert!(acknowledge(&s, &v));
    for (key, value) in [
        ("id", json!("task-B")),
        ("number", json!(2)),
        ("storedStatus", json!("done")),
        ("updatedAt", json!(null)),
        ("missionId", json!("mission-B")),
    ] {
        let mut wrong = v.clone();
        wrong[key] = value;
        assert!(!acknowledge(&s, &wrong), "{key}");
    }
}
#[test]
fn phase_gated_snapshot_captures_stored_work_status_without_changing_readonly_label() {
    let mut v = f::detail("mission-A");
    v["tasks"][1]["status"] = json!("blocked");
    v["tasks"][1]["storedStatus"] = json!("in_progress");
    let snapshot = crate::mission_tasks::parse(&f::key("mission-A"), &v).unwrap();
    let task = snapshot.task("task-A").unwrap();
    assert_eq!(task.status, "blocked");
    assert_eq!(task.work_status, "in_progress");
    v["tasks"][1]["storedStatus"] = json!(false);
    assert!(crate::mission_tasks::parse(&f::key("mission-A"), &v).is_err());
}
#[tokio::test]
async fn exact_status_only_patch_assigned_and_closed_missions() {
    for lifecycle in ["active", "done", "archived"] {
        let server = Server::start();
        let mut detail = f::detail("mission-A");
        detail["mission"]["status"] = json!(lifecycle);
        server.reply("GET", "/api/missions/mission-A", Reply::json(200, detail));
        let s = State::default().begin(&target(), "todo").unwrap();
        assert_eq!(
            submit(&client(), &server.options, &s).await,
            Outcome::Acknowledged
        );
        let state = server.state.lock().unwrap();
        let writes: Vec<_> = state.seen.iter().filter(|(m, _, _)| m != "GET").collect();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "PATCH");
        assert_eq!(writes[0].1, "/api/missions/mission-A/tasks/task-A");
        assert_eq!(writes[0].2, json!({"status":"todo"}));
    }
}
#[tokio::test]
async fn bad_home_canonical_source_and_stale_task_never_write() {
    let server = Server::start();
    let mut s = State::default().begin(&target(), "todo").unwrap();
    s.target.key.home.daemon = "foreign".into();
    assert!(matches!(
        submit(&client(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(server.writes(), 0);
    let s = State::default().begin(&target(), "todo").unwrap();
    let mut detail = f::detail("mission-A");
    detail["tasks"][1]["status"] = json!("todo");
    server.reply("GET", "/api/missions/mission-A", Reply::json(200, detail));
    assert!(matches!(
        submit(&client(), &server.options, &s).await,
        Outcome::NotSent(_)
    ));
    assert_eq!(server.writes(), 0);
}
#[tokio::test]
async fn lost_errors_redirects_malformed_and_wrong_ack_remain_unknown() {
    for code in [None, Some(400), Some(409), Some(500), Some(302), Some(200)] {
        let server = Server::start();
        let mut r = Reply::json(code.unwrap_or(200), json!({"id":"wrong"}));
        r.status = code;
        server.reply("PATCH", "/api/missions/mission-A/tasks/task-A", r);
        let mut state = State::default();
        let s = state.begin(&target(), "todo").unwrap();
        let outcome = submit(&client(), &server.options, &s).await;
        assert!(matches!(outcome, Outcome::Unknown(_)));
        state.finish(&s, outcome);
        assert!(state.begin(&target(), "todo").is_err());
        assert_eq!(server.writes(), 1);
        // A later matching read is neither passed to State nor an ACK.
        assert!(state.blocked());
    }
}
