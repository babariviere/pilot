use super::*;
use crate::mission_browser_fixture as f;
pub(crate) fn source() -> Target {
    Target {
        key: f::key("mission-A"),
        task: "task-A".into(),
        number: 1,
    }
}
#[test]
fn exact_normalization_and_utf16_bounds() {
    assert_eq!(
        Content::capture("\u{feff} 日本語 👩‍💻 \u{a0}", "\u{2028}Goal\u{feff}").unwrap(),
        Content {
            title: "日本語 👩‍💻".into(),
            body: "Goal".into()
        }
    );
    assert!(Content::capture("\u{feff}\u{a0}", "").is_err());
    assert!(Content::capture(&"😀".repeat(100), &"😀".repeat(4000)).is_ok());
    assert!(Content::capture(&"😀".repeat(101), "").is_err());
    assert!(Content::capture("T", &"x".repeat(8001)).is_err());
    assert!(Content::capture(&format!(" {}", "x".repeat(200)), "").is_err());
}
#[test]
fn immutable_attempt_exact_late_ack_and_unknown_fence() {
    let mut state = State::default();
    let s = state.begin(&source(), "Title", "Goal").unwrap();
    let mut foreign = s.clone();
    foreign.source.key.id = "mission-B".into();
    assert!(!state.finish(&foreign, Outcome::Saved(s.value.clone())));
    assert!(state.begin(&source(), "Another", "").is_err());
    assert!(state.finish(&s, Outcome::Unknown("Lost ACK")));
    assert!(!state.finish(&s, Outcome::Saved(s.value.clone())));
    assert!(state.begin(&source(), "Title", "Goal").is_err());
    assert!(matches!(state.attempt, Some((_, Outcome::Unknown(_)))));
}
#[test]
fn only_not_sent_can_retry_and_ack_must_match() {
    let mut state = State::default();
    let s = state.begin(&source(), "T", "").unwrap();
    state.finish(&s, Outcome::NotSent("No request"));
    let next = state.begin(&source(), "T2", "").unwrap();
    assert_ne!(s.id, next.id);
    assert!(!state.finish(&s, Outcome::Saved(s.value.clone())));
    assert!(state.finish(
        &next,
        Outcome::Saved(Content {
            title: "wrong".into(),
            body: "".into()
        })
    ));
    assert!(matches!(state.attempt, Some((_, Outcome::Unknown(_)))));
}
#[test]
fn source_and_response_are_not_guessed_or_clipped() {
    let mut alias = source();
    alias.task = "1".into();
    assert!(
        !alias.valid(),
        "numeric IDs would be resolved as task-number aliases"
    );
    let mut v = f::detail("mission-A")["tasks"][1].clone();
    assert!(parse(&source(), &v).is_ok());
    v["id"] = "task-B".into();
    assert!(parse(&source(), &v).is_err());
    v["id"] = "task-A".into();
    v["number"] = 2.into();
    assert!(parse(&source(), &v).is_err());
    v["number"] = 1.into();
    v["body"] = serde_json::Value::String("😀".repeat(4001));
    assert!(parse(&source(), &v).is_err());
}
