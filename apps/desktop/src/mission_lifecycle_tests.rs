use super::*;
use crate::mission_browser_fixture as f;
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
#[test]
fn transition_matrix_and_response_identity() {
    for status in ["active", "done", "archived"] {
        assert_eq!(Action::Archive.allowed(status), status != "archived");
        assert_eq!(Action::Reopen.allowed(status), status != "active");
    }
    assert!(!Action::Archive.allowed("unknown"));
    assert!(!Action::Reopen.allowed("unknown"));
    assert!(parse(&source(), &f::detail("mission-A")["mission"]).is_ok());
    assert!(parse(&source(), &f::detail("mission-B")["mission"]).is_err());
}
#[test]
fn exact_capture_fences_late_results_and_all_replays() {
    let mut state = State::default();
    let before = Snapshot {
        title: "Same 日本語".into(),
        status: "active".into(),
    };
    let send = state.begin(&source(), &before, Action::Archive).unwrap();
    let mut wrong = send.clone();
    wrong.source.key = f::key("mission-B");
    assert!(!state.finish(&wrong, Outcome::Ack));
    assert!(state.finish(&send, Outcome::Unknown("lost")));
    assert!(!state.finish(&send, Outcome::Ack));
    assert!(state.begin(&source(), &before, Action::Archive).is_err());
}
