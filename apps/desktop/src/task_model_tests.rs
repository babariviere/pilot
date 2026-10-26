use super::*;
use crate::mission_browser_fixture as f;
use serde_json::json;
pub(super) fn source() -> Source {
    Source {
        target: Target {
            key: f::key("mission-A"),
            task: "task-A".into(),
            number: 1,
        },
        project: "project-A".into(),
    }
}
fn catalog() -> Catalog {
    serde_json::from_value(crate::task_model_fixture::models()).unwrap()
}
#[test]
fn defaults_scope_patterns_and_unsupported_thinking() {
    let c = catalog();
    assert!(Preference::default().admitted(&c));
    let mut p = Preference {
        model: Some("p/b*#~".into()),
        thinking: None,
    };
    assert!(p.admitted(&c));
    p.thinking = Some("high".into());
    assert!(!p.admitted(&c));
    p.thinking = Some("off".into());
    assert!(p.admitted(&c));
    p.model = None;
    assert!(!p.valid());
    assert!(
        !Preference {
            model: Some("p/unknown".into()),
            thinking: None
        }
        .admitted(&c)
    );
}
#[test]
fn immutable_pending_unknown_no_replay_and_late_completion() {
    let mut state = State::default();
    let source = source();
    let p = Preference {
        model: Some("p/a".into()),
        thinking: None,
    };
    let s = state.begin(&source, &p, &catalog()).unwrap();
    assert!(
        state
            .begin(&source, &Preference::default(), &catalog())
            .is_err()
    );
    let mut other = s.clone();
    other.source.project = "foreign".into();
    assert!(!state.finish(&other, Outcome::Saved));
    assert!(state.finish(&s, Outcome::Unknown("lost")));
    assert!(!state.finish(&s, Outcome::Saved));
    assert!(state.blocked());
    assert!(state.begin(&source, &p, &catalog()).is_err());
    let mut state = State::default();
    let s = state.begin(&source, &p, &catalog()).unwrap();
    state.finish(&s, Outcome::NotSent("before POST"));
    assert!(state.begin(&source, &p, &catalog()).is_ok());
}
#[test]
fn ack_pins_home_project_mission_task_number_capture_and_value() {
    let s = State::default()
        .begin(
            &source(),
            &Preference {
                model: Some("p/a".into()),
                thinking: None,
            },
            &catalog(),
        )
        .unwrap();
    let v = json!({"operationId":s.id,"home":{"daemonId":"test-daemon","lineageId":"test-lineage"},"missionId":"mission-A","projectId":"project-A","task":{"id":"task-A","number":1,"preferredModel":"p/a","preferredModelSetBy":"user"}});
    assert!(ack(&s, &v));
    for pointer in [
        "/operationId",
        "/home/daemonId",
        "/home/lineageId",
        "/missionId",
        "/projectId",
        "/task/id",
        "/task/preferredModel",
        "/task/preferredModelSetBy",
    ] {
        let mut bad = v.clone();
        *bad.pointer_mut(pointer).unwrap() = json!("wrong");
        assert!(!ack(&s, &bad), "{pointer}");
    }
    let mut bad = v;
    bad["task"]["number"] = json!(2);
    assert!(!ack(&s, &bad));
    let mut source = source();
    source.target.task = "123".into();
    assert!(!source.valid());
}
