//! Round numbers count the rounds the user answered, not question-set
//! revisions: an enrollment's empty bootstrap set is never a round.
use pilot_day_native::plan_host::{self, Local};
use serde_json::{Value, json};

fn submission(set: u64, op: &str) -> Value {
    json!({"interview": {"submission": {
        "operationId": op,
        "fence": {"questionSetRevision": set},
        "questions": [{"id": format!("q{set}"), "prompt": "Why?"}],
        "answers": [{"questionId": format!("q{set}"), "selectedOption": {"meaning": "Because"}, "text": ""}],
    }}})
}

#[test]
fn the_first_answered_round_is_round_1_after_an_empty_bootstrap_set() {
    let question = json!({"id": "q3", "section": "acceptance", "prompt": "What else?", "options": [], "recommendedOptionId": null});
    let read = json!({
        "missionId": "m1",
        "fresh": true,
        "status": "available",
        "capabilities": {},
        "questionDigests": {"q3": "d3"},
        "view": {
            "plan": null,
            "destination": "",
            "interview": {
                "questions": [question],
                "answers": [],
                "revision": 24,
                "fence": {"enrollmentId": "e1", "questionSetRevision": 3},
            },
            // Set 1 was the enrollment's empty bootstrap; sets 2 and 3 were answered.
            "interviewHistory": [submission(2, "op-2")],
        },
    });
    let page = plan_host::page(&read, &[], &Local::default());
    let titles: Vec<&str> = page.rounds.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(titles, ["Round 1"]);
    assert_eq!(page.interview.expect("current round").round, 2);
}
