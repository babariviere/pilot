//! Unstick's repair agent: start only when offered, and apply only the fix it
//! proposed, while it still matches the mission.
use pilot_day_native::plan::{RepairApplyIntent, RepairFix, RepairState};
use pilot_day_native::plan_host::{self, Local};
use serde_json::{Value, json};

fn read(fix: &str, current: bool) -> Value {
    json!({
        "fresh": true,
        "missionId": "m1",
        "status": "available",
        "capabilities": {"answers": 1},
        "view": {"plan": null, "destination": "", "interviewHistory": [], "interview": null},
        "continuePlanning": {"available": true, "contextDigest": "continue-digest"},
        "unstick": {"state": "stuck", "line": "Stuck.", "fix": "continue", "checks": []},
        "repair": {
            "available": true, "contextDigest": "repair-digest", "state": "proposed", "chatId": "c1",
            "current": current, "reason": null,
            "proposal": {"fix": fix, "cause": "Full map.", "note": "Merge a and b.", "certainty": "high", "evidence": ["plan-map refused"]},
        },
    })
}

fn apply(read: &Value, note: &str) -> Result<(String, Value), plan_host::Refusal> {
    plan_host::repair_apply_request(
        read,
        &RepairApplyIntent {
            mission_id: "m1".into(),
            note: note.into(),
        },
    )
}

#[test]
fn repair_starts_when_offered_and_applies_only_its_current_fix() {
    let r = read("planner-note", true);
    let page = plan_host::page(&r, &[], &Local::default());
    let repair = page.unstick.and_then(|u| u.repair).expect("repair");
    assert_eq!(repair.state, RepairState::Proposed);
    assert_eq!(
        repair.proposal.expect("proposal").fix,
        RepairFix::PlannerNote
    );

    let (digest, start) = plan_host::repair_start_request(&r, "m1").expect("offered");
    assert_eq!(
        (digest.as_str(), &start),
        ("repair-digest", &json!({"purpose": "plan-repair-start"}))
    );
    let mut busy = r.clone();
    busy["repair"]["available"] = json!(false);
    assert!(plan_host::repair_start_request(&busy, "m1").is_err());

    // The agent's note, or the user's edit of it.
    let (digest, sent) = apply(&r, "").expect("note");
    assert_eq!(digest, "continue-digest");
    assert_eq!(
        sent,
        json!({"purpose": "plan-continue", "note": "Merge a and b."})
    );
    assert_eq!(apply(&r, " Keep c. ").expect("edited").1["note"], "Keep c.");
    assert!(apply(&r, &"x".repeat(2001)).is_err());

    // Continue, and nothing for a code fix or none.
    assert_eq!(
        apply(&read("continue", true), "").expect("continue").1,
        json!({"purpose": "plan-continue"})
    );
    assert!(apply(&read("code-repair", true), "").is_err());
    assert!(apply(&read("none", true), "").is_err());
    // A mission that changed since the agent looked refuses.
    assert!(apply(&read("planner-note", false), "").is_err());
}
