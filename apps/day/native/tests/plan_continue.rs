//! Continue planning shows only when the daemon offers it, and names the
//! planning state the user saw.
use pilot_day_native::plan::{AskState, ContinueIntent, OutcomeStatus, QuestionAskIntent};
use pilot_day_native::plan_host::{self, Local};
use serde_json::{Value, json};

fn read(available: bool) -> Value {
    json!({
        "missionId": "m1",
        "fresh": true,
        "status": "available",
        "capabilities": {},
        "questionDigests": {},
        "continuePlanning": {"available": available, "contextDigest": "c".repeat(64), "reason": ""},
        "view": {"plan": null, "destination": "", "interview": null, "interviewHistory": []},
    })
}

#[test]
fn continue_shows_only_when_the_daemon_offers_it() {
    assert!(plan_host::page(&read(true), &[], &Local::default()).can_continue);
    assert!(!plan_host::page(&read(false), &[], &Local::default()).can_continue);
    let mut stale = read(true);
    stale["fresh"] = json!(false);
    assert!(!plan_host::page(&stale, &[], &Local::default()).can_continue);
}

#[test]
fn continue_names_the_planning_state_shown_and_refuses_otherwise() {
    let (digest, request) =
        plan_host::continue_request(&read(true), &intent("m1", " ")).expect("offered");
    assert_eq!(digest, "c".repeat(64));
    assert_eq!(request, json!({"purpose": "plan-continue"}));
    let refused =
        plan_host::continue_request(&read(false), &intent("m1", "")).expect_err("not offered");
    assert_eq!(refused.0, OutcomeStatus::Rejected);
    assert!(plan_host::continue_request(&read(true), &intent("other", "")).is_err());
}

#[test]
fn feedback_goes_word_for_word_within_its_limit() {
    let text = "Too technical. Say it plainly.";
    let (_, request) =
        plan_host::continue_request(&read(true), &intent("m1", text)).expect("offered");
    assert_eq!(
        request,
        json!({"purpose": "plan-continue", "feedback": text})
    );
    let long = "x".repeat(8001);
    assert!(plan_host::continue_request(&read(true), &intent("m1", &long)).is_err());
}

#[test]
fn a_round_waiting_for_answers_takes_only_a_comment() {
    let mut waiting = read(true);
    waiting["continuePlanning"]["feedbackOnly"] = json!(true);
    let page = plan_host::page(&waiting, &[], &Local::default());
    assert!(!page.can_continue);
    assert!(page.can_comment);
    assert!(plan_host::continue_request(&waiting, &intent("m1", "")).is_err());
    assert!(plan_host::continue_request(&waiting, &intent("m1", "Plainer, please")).is_ok());
}

#[test]
fn a_reply_to_the_planner_goes_as_a_note_and_its_last_words_show() {
    let mut stuck = read(true);
    stuck["unstick"] = json!({"state":"stuck","line":"It may be waiting for your reply.","fix":"continue",
        "checks":[],"reply":true,"plannerSays":"Which database?"});
    let page = plan_host::page(&stuck, &[], &Local::default());
    let u = page.unstick.expect("unstick");
    assert!(u.reply);
    assert_eq!(u.planner_says, "Which database?");
    let reply = ContinueIntent {
        note: "Use Postgres.".into(),
        ..intent("m1", "")
    };
    let (_, request) = plan_host::continue_request(&stuck, &reply).expect("a reply sends");
    assert_eq!(
        request,
        json!({"purpose":"plan-continue","note":"Use Postgres."})
    );
    // A reply is not a comment on a waiting round, and has a size limit.
    let mut waiting = stuck.clone();
    waiting["continuePlanning"]["feedbackOnly"] = json!(true);
    assert!(plan_host::continue_request(&waiting, &reply).is_err());
    let long = ContinueIntent {
        note: "x".repeat(2001),
        ..intent("m1", "")
    };
    assert!(plan_host::continue_request(&stuck, &long).is_err());
}

fn intent(mission: &str, feedback: &str) -> ContinueIntent {
    ContinueIntent {
        mission_id: mission.into(),
        feedback: feedback.into(),
        note: String::new(),
    }
}

#[test]
fn an_ask_names_the_question_shown_and_its_answer_shows_under_it() {
    let mut page = read(true);
    page["questionDigests"] = json!({"q1": "d1"});
    let ask = |question: &str, text: &str| QuestionAskIntent {
        mission_id: "m1".into(),
        question_id: question.into(),
        text: text.into(),
    };
    let (digest, request) =
        plan_host::ask_request(&page, &ask("q1", " What is native? ")).expect("shown");
    assert_eq!(digest, "d1");
    assert_eq!(
        request,
        json!({"purpose": "plan-question-ask", "questionId": "q1", "text": "What is native?"})
    );
    assert!(plan_host::ask_request(&page, &ask("gone", "Why?")).is_err());
    assert!(plan_host::ask_request(&page, &ask("q1", "  ")).is_err());

    page["view"]["interview"] = json!({
        "questions": [{"id": "q1", "section": "outcome", "prompt": "Native?", "options": [], "recommendedOptionId": null}],
        "answers": [], "revision": 2, "fence": {"enrollmentId": "e1", "questionSetRevision": 2},
    });
    page["questionAsks"] = json!([
        {"id": "a1", "questionId": "q1", "text": "What is native?", "state": "answered", "answer": "The app you see.", "reason": ""},
        {"id": "a2", "questionId": "other", "text": "No", "state": "asking", "answer": "", "reason": ""},
    ]);
    let shown = plan_host::page(&page, &[], &Local::default());
    let asks = &shown.interview.expect("interview").questions[0].asks;
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].state, AskState::Answered);
    assert_eq!(asks[0].answer, "The app you see.");
}
