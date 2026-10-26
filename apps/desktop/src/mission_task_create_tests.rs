use super::*;
use crate::mission_browser_fixture::key;
use serde_json::json;
pub(crate) fn ack() -> Value {
    json!({"id":"task-created","number":42,"title":"Task 日本語","body":"Body 👩‍💻","status":"todo","order":3,"createdAt":1,"updatedAt":1})
}
fn capture() -> Submission {
    State::default()
        .begin(&key("mission-A"), " \u{feff}Task 日本語 ", " Body 👩‍💻 ")
        .unwrap()
}
#[test]
fn validates_daemon_raw_utf16_limits_and_ecmascript_trim() {
    assert!(validate("\u{feff}\u{a0}", "").is_err());
    assert!(validate("\u{85}", "").is_ok());
    assert!(validate(&"😀".repeat(100), &"😀".repeat(4000)).is_ok());
    assert!(validate(&format!("{} ", "😀".repeat(100)), "").is_err());
    assert!(validate("x", &format!("{} ", "😀".repeat(4000))).is_err());
}
#[test]
fn ack_requires_exact_task_and_identity_not_title_lookup() {
    let s = capture();
    assert_eq!(acknowledge(&s, &ack()).unwrap().id, "task-created");
    for (field, value) in [
        ("id", json!("../x")),
        ("number", json!(0)),
        ("title", json!("Other")),
        ("body", json!("Other")),
        ("body", json!(false)),
        ("status", json!("in_progress")),
        ("sessionId", json!("chat-A")),
        ("missionId", json!("mission-B")),
        ("createdAt", json!(-1)),
        ("order", json!(null)),
        ("dependsOn", json!(["task-A"])),
    ] {
        let mut v = ack();
        v[field] = value;
        assert!(acknowledge(&s, &v).is_err(), "{field}");
    }
}
#[test]
fn immutable_pending_and_unknown_cannot_retry_or_accept_foreign_late_completion() {
    let key = key("mission-A");
    let mut state = State::default();
    let s = state.begin(&key, "Task", "").unwrap();
    assert!(state.begin(&key, "Different", "").is_err());
    let mut foreign = s.clone();
    foreign.id = "other".into();
    assert!(!state.finish(
        &foreign,
        Outcome::Created(Created {
            id: "task".into(),
            number: 1
        })
    ));
    let mut foreign = s.clone();
    foreign.key.id = "mission-B".into();
    assert!(!state.finish(&foreign, Outcome::NotSent("no")));
    assert!(state.finish(&s, Outcome::Unknown("lost")));
    assert!(state.begin(&key, "Task", "").is_err());
    assert!(!state.finish(
        &s,
        Outcome::Created(Created {
            id: "task".into(),
            number: 1
        })
    ));
}
#[test]
fn only_not_sent_allows_a_fresh_explicit_capture() {
    let key = key("mission-A");
    let mut state = State::default();
    let a = state.begin(&key, "x", "").unwrap();
    state.finish(&a, Outcome::NotSent("preflight"));
    let b = state.begin(&key, "x", "").unwrap();
    assert_ne!(a.id, b.id);
    assert!(!state.finish(&a, Outcome::Unknown("late")));
}
