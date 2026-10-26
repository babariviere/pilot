use super::*;
use crate::mission_browser_fixture as f;
pub(crate) fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
#[test]
fn exact_normalization_and_utf16_bounds() {
    assert_eq!(
        Metadata::capture("\u{feff} 日本語 👩‍💻 \u{a0}", "\u{2028}Goal\u{feff}").unwrap(),
        Metadata {
            title: "日本語 👩‍💻".into(),
            goal: "Goal".into()
        }
    );
    assert!(Metadata::capture("\u{feff}\u{a0}", "").is_err());
    assert!(Metadata::capture(&"😀".repeat(100), &"😀".repeat(2000)).is_ok());
    assert!(Metadata::capture(&"😀".repeat(101), "").is_err());
    assert!(Metadata::capture("T", &"x".repeat(4001)).is_err());
    assert!(Metadata::capture(&format!(" {}", "x".repeat(200)), "").is_err());
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
        Outcome::Saved(Metadata {
            title: "wrong".into(),
            goal: "".into()
        })
    ));
    assert!(matches!(state.attempt, Some((_, Outcome::Unknown(_)))));
}
#[test]
fn source_and_response_are_not_guessed_or_clipped() {
    let mut v = f::detail("mission-A")["mission"].clone();
    assert!(parse(&source(), &v).is_ok());
    v["projectId"] = "project-B".into();
    assert!(parse(&source(), &v).is_err());
    v["projectId"] = "project-A".into();
    v["goal"] = serde_json::Value::String("😀".repeat(2001));
    assert!(parse(&source(), &v).is_err());
}
