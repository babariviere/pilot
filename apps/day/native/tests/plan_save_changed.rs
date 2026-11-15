//! A question Pilot reworded keeps its earlier answer only as a hint: saving
//! any answer leaves that stale answer out, so the daemon accepts the save.
use pilot_day_native::plan::AnswerIntent;
use pilot_day_native::plan_host::{self, Local};
use serde_json::json;

#[test]
fn saving_leaves_out_answers_to_an_earlier_wording() {
    let question = |id: &str| json!({"id": id, "section": "outcome", "prompt": format!("{id}?"), "options": [], "recommendedOptionId": null});
    let read = json!({
        "missionId": "m1",
        "fresh": true,
        "status": "available",
        "capabilities": {"answers": 1},
        "contextDigest": "c".repeat(64),
        "questionDigests": {"q1": "now1", "q2": "now2", "q3": "now3"},
        "view": {
            "plan": null,
            "destination": "",
            "interviewHistory": [],
            "interview": {
                "questions": [question("q1"), question("q2"), question("q3")],
                "answers": [
                    {"questionId": "q1", "questionDigest": "before1", "selectedOption": null, "text": "old"},
                    {"questionId": "q3", "questionDigest": "now3", "selectedOption": null, "text": "kept"},
                ],
                "revision": 9,
                "fence": {"enrollmentId": "e1", "questionSetRevision": 5},
            },
        },
    });
    let page = plan_host::page(&read, &[], &Local::default());
    let interview = page.interview.expect("interview");
    let intent = AnswerIntent {
        interview_id: interview.id.clone(),
        question_set: 5,
        question_id: "q2".into(),
        digest: "now2".into(),
        choice_id: None,
        text: "new".into(),
    };
    let (_, request) = plan_host::save_request(&read, &intent).expect("saved");
    let saved: Vec<(&str, &str)> = request["answers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["questionId"].as_str().unwrap(),
                a["questionDigest"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(saved, [("q2", "now2"), ("q3", "now3")]);

    // Unstick's fix sends the same list without the earlier answer, and only when offered.
    assert!(plan_host::drop_earlier_request(&read, "m1").is_err());
    let mut offered = read.clone();
    offered["unstick"] =
        json!({"state": "stuck", "line": "Stuck.", "fix": "drop-earlier-answers", "checks": ["a"]});
    let unstick = plan_host::page(&offered, &[], &Local::default())
        .unstick
        .expect("unstick");
    assert_eq!(
        unstick.fix,
        pilot_day_native::plan::UnstickFix::DropEarlierAnswers
    );
    let (_, dropped) = plan_host::drop_earlier_request(&offered, "m1").expect("offered");
    assert_eq!(dropped["answers"].as_array().unwrap().len(), 1);
    assert_eq!(dropped["answers"][0]["questionId"], "q3");
}
