//! The planning page reads the shared Wayfinder map (`view.map`), the same
//! projection the daemon gives the planning coordinator. Pure mapping: no
//! daemon, host or provider. The daemon's own tests build that projection
//! (packages/daemon/src/mission-plans.test.ts).
use pilot_day_native::{
    plan::{ExploreKind, ExploreState, PlanRoute},
    plan_host::{self, Local},
};
use serde_json::{Value, json};

fn read(map: Value) -> Value {
    json!({
        "missionId": "m1",
        "fresh": true,
        "status": "available",
        "capabilities": {},
        "questionDigests": {},
        "view": {
            "plan": {"revision": 4, "questions": [], "fog": [], "spec": null, "slices": []},
            "destination": "Linux desktops",
            "interview": {"questions": [], "answers": [], "fence": {"enrollmentId": "e1", "questionSetRevision": 2}},
            "interviewHistory": [],
            "map": map,
        },
    })
}

fn map() -> Value {
    json!({
        "version": 1,
        "planRevision": 4,
        "destination": "Linux desktops",
        "items": [
            {"id": "fact", "title": "Packaging formats", "question": "Which packages?", "kind": "research",
             "state": "settled", "dependsOn": [], "waitingOn": [], "claimedBy": null, "fromFog": "creds",
             "sources": [{"kind": "knowledge", "id": "k1", "label": "Knowledge: Packages, revision 1", "state": "changed"}],
             "settledBy": {"kind": "knowledge", "id": "k1", "label": "Knowledge: Packages, revision 1", "state": "changed"}},
            {"id": "pick", "title": "Which desktops", "question": "Which first?", "kind": "human",
             "state": "settled", "dependsOn": [], "waitingOn": [], "claimedBy": null, "fromFog": null, "sources": [],
             "settledBy": {"kind": "interview", "id": "op-2", "label": "Interview round 2", "state": "current"}},
            {"id": "feel", "title": "Status line", "question": "Enough?", "kind": "prototype",
             "state": "ready", "dependsOn": ["fact"], "waitingOn": [], "claimedBy": null, "fromFog": null,
             "sources": [{"kind": "decision", "id": "d1", "label": "A decision that is no longer active", "state": "missing"}],
             "settledBy": null,
             "evidence": {"state": "stale", "verdict": "inconclusive", "planRevision": 3,
                          "observations": ["Seen once"], "unresolvedQuestions": ["Is it enough?"]}},
            {"id": "later", "title": "Updates", "question": "How?", "kind": "human",
             "state": "waiting", "dependsOn": ["feel"], "waitingOn": ["feel"], "claimedBy": null, "fromFog": null,
             "sources": [], "settledBy": null},
            {"id": "run", "title": "Tray", "question": "Tray?", "kind": "research",
             "state": "claimed", "dependsOn": [], "waitingOn": [], "claimedBy": "s1", "fromFog": null,
             "sources": [], "settledBy": null}
        ],
        "fog": [
            {"id": "creds", "area": "Credentials", "why": "Tokens", "readyWhen": "Later", "dependsOn": [],
             "sources": [], "promotedTo": ["fact"]},
            {"id": "a11y", "area": "Accessibility", "why": "Readers", "readyWhen": "Desktops chosen",
             "dependsOn": ["pick"], "sources": [], "promotedTo": []}
        ],
        "counts": {"settled": 2, "asking": 0, "claimed": 1, "ready": 1, "waiting": 1, "activeFog": 1, "notCurrent": 3},
        "agreement": {"state": "published", "briefRevision": 5, "tasks": [
            {"sliceId": "save", "taskId": "t1", "number": 12, "title": "Save a plan", "status": "todo"},
            {"sliceId": "gone", "taskId": "t2", "number": null, "title": "Resume", "status": null}
        ]}
    })
}

#[test]
fn the_page_shows_the_shared_map_with_its_currentness_and_links() {
    let page = plan_host::page(&read(map()), &[], &Local::default());
    assert_eq!(page.route, PlanRoute::Wayfinder);
    let item = |id: &str| page.explorations.iter().find(|e| e.id == id).unwrap();

    let fact = item("fact");
    assert_eq!(
        (fact.kind, fact.state),
        (ExploreKind::Research, ExploreState::Resolved)
    );
    assert_eq!(
        fact.result,
        "Answered by Knowledge: Packages, revision 1. Not checked by Pilot. It changed since."
    );
    assert_eq!(fact.from_fog, "Credentials");
    assert_eq!(
        fact.sources,
        ["Knowledge: Packages, revision 1 (changed since)"]
    );
    assert_eq!(fact.changed.len(), 2);

    let pick = item("pick");
    assert_eq!(pick.result, "Answered in interview round 2");
    assert_eq!(pick.round, "op-2");
    assert!(pick.changed.is_empty());

    let feel = item("feel");
    assert_eq!(
        (feel.kind, feel.state),
        (ExploreKind::Prototype, ExploreState::Ready)
    );
    assert_eq!(
        feel.evidence,
        "Finding: inconclusive, from map revision 3. The map changed since, so it is kept as history."
    );
    assert_eq!(feel.observations, ["Seen once"]);
    assert_eq!(feel.unresolved, ["Is it enough?"]);
    assert_eq!(
        feel.changed,
        ["A decision that is no longer active is no longer available."]
    );

    // Only unsettled prerequisites hold a question back.
    let later = item("later");
    assert_eq!(later.state, ExploreState::Waiting);
    assert_eq!(later.after, ["Status line"]);
    assert_eq!(item("run").state, ExploreState::Running);

    let creds = page.fog.iter().find(|f| f.id == "creds").unwrap();
    assert!(!creds.active);
    assert_eq!(creds.became, ["Packaging formats"]);
    let a11y = page.fog.iter().find(|f| f.id == "a11y").unwrap();
    assert!(a11y.active);
    assert_eq!(a11y.after, ["Which desktops"]);

    let info = page.map.unwrap();
    assert_eq!(info.revision, 4);
    assert_eq!(
        info.agreement,
        "Published as spec revision 5, with 2 tasks. Publishing started no work."
    );
    assert_eq!(
        info.tasks
            .iter()
            .map(|t| (t.number, t.title.as_str(), t.status.as_str()))
            .collect::<Vec<_>>(),
        [
            (12, "Save a plan", "To do"),
            (0, "Resume", "Not in this read")
        ]
    );
}

#[test]
fn a_service_without_a_map_shows_no_invented_questions() {
    let mut value = read(Value::Null);
    value["view"]["map"] = Value::Null;
    let page = plan_host::page(&value, &[], &Local::default());
    assert!(page.explorations.is_empty() && page.fog.is_empty());
    assert!(page.map.is_none());
}
