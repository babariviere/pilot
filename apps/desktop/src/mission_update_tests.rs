use super::*;
use crate::mission_browser_fixture::key;
use serde_json::json;

#[test]
fn bounded_native_text_uses_ecmascript_trim_and_utf16() {
    assert!(validate("\u{feff}\u{a0}\n").is_err());
    assert!(validate(&"🦀".repeat(4000)).is_ok());
    assert!(validate(&"🦀".repeat(4001)).is_err());
    assert!(validate(&format!("{} ", "a".repeat(TEXT_UNITS))).is_err());
    assert!(validate("e\u{301} 日本語 👩‍💻\nLiteral <script>").is_ok());
}
#[test]
fn exact_completion_only_and_unknown_never_replay() {
    let mut state = State::default();
    let s = state.begin(&key("mission-A"), " text ").unwrap();
    let mut wrong = s.clone();
    wrong.id.push('x');
    assert!(!state.finish(&wrong, Outcome::Acknowledged(1)));
    wrong = s.clone();
    wrong.key = key("mission-B");
    assert!(!state.finish(&wrong, Outcome::Acknowledged(1)));
    assert!(state.begin(&key("mission-B"), "other").is_err());
    assert!(state.finish(&s, Outcome::Unknown("lost")));
    assert!(!state.finish(&s, Outcome::Acknowledged(1)));
    assert!(state.begin(&s.key, &s.text).is_err());
}
#[test]
fn only_provably_unsent_attempt_can_retry_explicitly() {
    let mut state = State::default();
    let s = state.begin(&key("mission-A"), "text").unwrap();
    assert!(state.finish(&s, Outcome::NotSent("identity failed")));
    let next = state.begin(&s.key, &s.text).unwrap();
    assert_ne!(next.id, s.id);
    assert!(!state.finish(&s, Outcome::Unknown("old worker")));
    assert!(state.finish(&next, Outcome::Acknowledged(42)));
    assert!(state.blocked());
}
#[test]
fn ack_requires_exact_update_without_fabricated_actor() {
    let s = State::default()
        .begin(&key("mission-A"), "\u{feff}日本語 👩‍💻 ")
        .unwrap();
    let v = json!({"id":42,"kind":"update","text":"日本語 👩‍💻","at":1});
    assert_eq!(acknowledge(&s, &v), Ok(42));
    for (k, value) in [
        ("id", json!(0)),
        ("kind", json!("handoff")),
        ("text", json!("other")),
        ("sessionId", json!("agent")),
        ("taskId", json!("task")),
        ("health", json!("on_track")),
        ("at", json!(-1)),
    ] {
        let mut bad = v.clone();
        bad[k] = value;
        assert!(acknowledge(&s, &bad).is_err(), "{k}");
    }
}
