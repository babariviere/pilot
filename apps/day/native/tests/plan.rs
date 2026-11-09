//! The planning rules on mock data: saved drafts, the one explicit
//! submission, fences, topic binding, lost answers and changed plans.

use pilot_day_native::{
    plan::{
        AnswerIntent, Interview, InterviewRef, NewIntent, OutcomeStatus, PlanAvailability,
        PlanScenario, PlanStage, QuestionState, RoundKind, StepState, SubmitIntent, SubmitState,
    },
    plan_desk::PlanDesk,
};

fn interview(desk: &PlanDesk, mission: &str) -> Interview {
    desk.page(mission)
        .and_then(|p| p.interview)
        .unwrap_or_else(|| panic!("{mission} has an open interview"))
}

fn answer(view: &Interview, question: &str, choice: Option<&str>, text: &str) -> AnswerIntent {
    let q = view
        .questions
        .iter()
        .find(|q| q.id == question)
        .expect("question");
    AnswerIntent {
        interview_id: view.id.clone(),
        question_set: view.question_set,
        question_id: q.id.clone(),
        digest: q.digest.clone(),
        choice_id: choice.map(Into::into),
        text: text.into(),
    }
}

/// Saves one answer as shown now and returns the outcome's status.
fn save(
    desk: &mut PlanDesk,
    mission: &str,
    question: &str,
    choice: Option<&str>,
    text: &str,
) -> OutcomeStatus {
    let view = interview(desk, mission);
    match desk.begin_save(&answer(&view, question, choice, text)) {
        Ok(ticket) => desk.settle_save(&ticket).status,
        Err(outcome) => outcome.status,
    }
}

fn submit(desk: &mut PlanDesk, mission: &str) -> (OutcomeStatus, String) {
    let view = interview(desk, mission);
    let proposal = if view.kind == RoundKind::Review {
        view.proposal.clone()
    } else {
        String::new()
    };
    let intent = SubmitIntent {
        interview_id: view.id.clone(),
        revision: view.revision,
        proposal,
    };
    match desk.begin_submit(&intent) {
        Ok(ticket) => {
            let o = desk.settle_submit(&ticket);
            (o.status, o.message)
        }
        Err(o) => (o.status, o.message),
    }
}

#[test]
fn a_recommendation_is_not_an_answer() {
    let mut desk = PlanDesk::new(PlanScenario::Interview);
    let view = interview(&desk, "export");
    assert_eq!((view.answered, view.questions.len()), (3, 7));
    let open = view.questions.iter().find(|q| q.id == "what").unwrap();
    assert!(open.choices.iter().any(|c| c.recommended));
    assert_eq!(open.chosen, None);
    assert_eq!(open.state, QuestionState::Open);
    let (status, message) = submit(&mut desk, "export");
    assert_eq!(status, OutcomeStatus::Rejected);
    assert_eq!(message, "Answer every question first. 4 are left.");
    assert_eq!(desk.continuations("export"), 0);
}

#[test]
fn answers_in_any_order_then_one_submission_and_a_dependent_round() {
    let mut desk = PlanDesk::new(PlanScenario::Interview);
    assert_eq!(
        save(&mut desk, "export", "pr", Some("yes"), ""),
        OutcomeStatus::Accepted
    );
    assert_eq!(
        save(
            &mut desk,
            "export",
            "check",
            None,
            "Exports open in Obsidian"
        ),
        OutcomeStatus::Accepted
    );
    assert_eq!(
        save(
            &mut desk,
            "export",
            "where",
            Some("panel"),
            "Remember the folder"
        ),
        OutcomeStatus::Accepted
    );
    // Saving drafts never wakes the coordinator.
    assert_eq!(desk.continuations("export"), 0);
    assert_eq!(
        save(&mut desk, "export", "what", Some("tools"), ""),
        OutcomeStatus::Accepted
    );
    let view = interview(&desk, "export");
    assert_eq!(view.answered, 7);
    let check = view.questions.iter().find(|q| q.id == "check").unwrap();
    assert_eq!(
        (check.chosen.clone(), check.text.as_str()),
        (None, "Exports open in Obsidian")
    );
    let (status, _) = submit(&mut desk, "export");
    assert_eq!(status, OutcomeStatus::Accepted);
    assert_eq!(desk.continuations("export"), 1);
    // Submitted answers are fixed.
    assert_eq!(
        save(&mut desk, "export", "pr", Some("no"), ""),
        OutcomeStatus::Rejected
    );
    assert_eq!(submit(&mut desk, "export").0, OutcomeStatus::Rejected);
    desk.advance("export");
    let page = desk.page("export").unwrap();
    let next = page.interview.unwrap();
    assert_eq!(next.round, 2);
    assert!(
        next.questions
            .iter()
            .all(|q| q.new && q.state == QuestionState::Open)
    );
    assert_eq!(page.rounds.len(), 1);
    assert_eq!(page.rounds[0].line, "7 answers, submitted");
}

#[test]
fn messages_only_needs_no_second_round() {
    let mut desk = PlanDesk::new(PlanScenario::Interview);
    for (q, c) in [
        ("what", "messages"),
        ("where", "panel"),
        ("check", "fast"),
        ("pr", "yes"),
    ] {
        assert_eq!(
            save(&mut desk, "export", q, Some(c), ""),
            OutcomeStatus::Accepted
        );
    }
    assert_eq!(submit(&mut desk, "export").0, OutcomeStatus::Accepted);
    desk.advance("export");
    let page = desk.page("export").unwrap();
    assert_eq!(page.interview.unwrap().kind, RoundKind::Review);
    assert_eq!(page.stage, PlanStage::Review);
}

#[test]
fn switching_suggestions_keeps_the_text() {
    let mut desk = PlanDesk::new(PlanScenario::Interview);
    save(&mut desk, "export", "what", Some("tools"), "Skip images");
    save(&mut desk, "export", "what", Some("all"), "Skip images");
    let q = interview(&desk, "export")
        .questions
        .into_iter()
        .find(|q| q.id == "what")
        .unwrap();
    assert_eq!(
        (q.chosen.as_deref(), q.text.as_str()),
        (Some("all"), "Skip images")
    );
    // Clearing the suggestion keeps the text as the user's own answer.
    save(&mut desk, "export", "what", None, "Skip images");
    let q = interview(&desk, "export")
        .questions
        .into_iter()
        .find(|q| q.id == "what")
        .unwrap();
    assert_eq!((q.chosen, q.state), (None, QuestionState::Answered));
}

#[test]
fn saves_name_the_question_shown() {
    let mut desk = PlanDesk::new(PlanScenario::Interview);
    let view = interview(&desk, "export");
    let mut old = answer(&view, "what", Some("tools"), "");
    old.digest = "0000".into();
    assert_eq!(
        desk.begin_save(&old).unwrap_err().status,
        OutcomeStatus::Stale
    );
    let mut old = answer(&view, "what", Some("tools"), "");
    old.question_set += 1;
    assert_eq!(
        desk.begin_save(&old).unwrap_err().status,
        OutcomeStatus::Stale
    );
    let gone = answer(&view, "what", Some("pdf"), "");
    assert_eq!(
        desk.begin_save(&gone).unwrap_err().status,
        OutcomeStatus::Stale
    );
    let mut long = answer(&view, "what", None, "");
    long.text = "x".repeat(4001);
    assert_eq!(
        desk.begin_save(&long).unwrap_err().status,
        OutcomeStatus::Rejected
    );
    assert_eq!(interview(&desk, "export").revision, view.revision);
}

#[test]
fn a_topic_interview_answers_only_its_topic() {
    let mut desk = PlanDesk::new(PlanScenario::Wayfinder);
    let topic = interview(&desk, "linux");
    assert_eq!(
        (topic.kind, topic.topic.as_str()),
        (RoundKind::Topic, "Which desktops count")
    );
    let mission = interview(&desk, "export");
    let mut forged = answer(&mission, "who", Some("you"), "");
    forged.interview_id = topic.id.clone();
    forged.question_set = topic.question_set;
    let refused = desk.begin_save(&forged).unwrap_err();
    assert_eq!(refused.status, OutcomeStatus::Rejected);
    assert!(
        refused.message.contains("only its own topic"),
        "{}",
        refused.message
    );
    for (q, c) in [
        ("first", "gnome-kde"),
        ("working", "core"),
        ("packages", "portable"),
    ] {
        assert_eq!(
            save(&mut desk, "linux", q, Some(c), ""),
            OutcomeStatus::Accepted
        );
    }
    assert_eq!(submit(&mut desk, "linux").0, OutcomeStatus::Accepted);
    desk.advance("linux");
    let page = desk.page("linux").unwrap();
    let item = page
        .explorations
        .iter()
        .find(|e| e.id == "desktops")
        .unwrap();
    assert_eq!(item.result, "Answered in round 2");
    // Fog stays fog; it is never a blocker of its own.
    assert!(page.fog.iter().any(|f| f.active && f.after.is_empty()));
    assert!(!page.prototypes.available);
}

#[test]
fn changed_questions_keep_the_earlier_answer_but_it_does_not_count() {
    let mut desk = PlanDesk::new(PlanScenario::Trouble);
    let view = interview(&desk, "export");
    let changed: Vec<_> = view
        .questions
        .iter()
        .filter(|q| q.state == QuestionState::Changed)
        .collect();
    assert_eq!(changed.len(), 2);
    assert_eq!(changed[0].earlier, "Always the Downloads folder");
    assert_eq!(
        changed[1].earlier,
        "Any chat exports without errors. Including chats with images."
    );
    assert_eq!(changed[1].text, "Including chats with images.");
    assert_eq!(changed[1].chosen, None);
    assert_eq!(view.answered, 5);
    assert_eq!(submit(&mut desk, "export").0, OutcomeStatus::Rejected);
    save(&mut desk, "export", "where", Some("panel"), "");
    save(
        &mut desk,
        "export",
        "check",
        None,
        "Including chats with images.",
    );
    assert_eq!(interview(&desk, "export").answered, 7);
}

#[test]
fn a_lost_submission_is_only_checked_and_continues_once() {
    let mut desk = PlanDesk::new(PlanScenario::Trouble);
    save(&mut desk, "export", "where", Some("panel"), "");
    save(&mut desk, "export", "check", Some("fast"), "");
    let (status, _) = submit(&mut desk, "export");
    assert_eq!(status, OutcomeStatus::Unknown);
    assert_eq!(interview(&desk, "export").submit, SubmitState::Unknown);
    assert_eq!(desk.page("export").unwrap().stage, PlanStage::Unknown);
    assert_eq!(desk.continuations("export"), 0);
    // A second submission is refused: it never sends twice.
    let (again, message) = submit(&mut desk, "export");
    assert_eq!(again, OutcomeStatus::Rejected);
    assert!(message.contains("Check first"), "{message}");
    let id = InterviewRef {
        interview_id: interview(&desk, "export").id,
    };
    desk.begin_check(&id).unwrap();
    assert_eq!(desk.settle_check(&id).status, OutcomeStatus::Accepted);
    assert_eq!(desk.continuations("export"), 1);
    assert!(desk.begin_check(&id).is_err());
    assert_eq!(desk.continuations("export"), 1);
}

#[test]
fn a_round_whose_plan_changed_keeps_answers_but_cannot_be_submitted() {
    let mut desk = PlanDesk::new(PlanScenario::Trouble);
    assert!(!interview(&desk, "linux").current);
    for (q, c) in [
        ("first", "gnome"),
        ("working", "core"),
        ("packages", "portable"),
    ] {
        assert_eq!(
            save(&mut desk, "linux", q, Some(c), ""),
            OutcomeStatus::Accepted
        );
    }
    let (status, message) = submit(&mut desk, "linux");
    assert_eq!(status, OutcomeStatus::Rejected);
    assert!(message.contains("plan changed"), "{message}");
    assert_eq!(interview(&desk, "linux").answered, 3);
}

#[test]
fn a_plan_that_changes_during_review_needs_a_new_review() {
    let mut desk = PlanDesk::new(PlanScenario::Trouble);
    let first = interview(&desk, "search");
    assert_eq!(
        save(&mut desk, "search", "review", Some("approve"), ""),
        OutcomeStatus::Accepted
    );
    let page = desk.page("search").unwrap();
    let next = page.interview.clone().unwrap();
    assert_ne!(next.id, first.id);
    assert_ne!(next.proposal, first.proposal);
    assert_eq!(next.questions[0].chosen, None);
    assert_eq!(page.proposal.unwrap().slices.len(), 2);
    assert!(page.note.contains("does not count"));
    let old = SubmitIntent {
        interview_id: first.id,
        revision: first.revision + 1,
        proposal: first.proposal.clone(),
    };
    assert_eq!(
        desk.begin_submit(&old).unwrap_err().status,
        OutcomeStatus::Rejected
    );
    save(&mut desk, "search", "review", Some("approve"), "");
    let view = interview(&desk, "search");
    let stale = SubmitIntent {
        interview_id: view.id.clone(),
        revision: view.revision,
        proposal: first.proposal,
    };
    assert_eq!(
        desk.begin_submit(&stale).unwrap_err().status,
        OutcomeStatus::Stale
    );
    assert_eq!(submit(&mut desk, "search").0, OutcomeStatus::Accepted);
}

#[test]
fn approval_publication_and_work_are_separate() {
    let mut desk = PlanDesk::new(PlanScenario::Review);
    let page = desk.page("export").unwrap();
    assert_eq!(page.stage, PlanStage::Review);
    let proposal = page.proposal.unwrap();
    assert_eq!(proposal.spec.testing.len(), 3);
    assert_eq!(proposal.open_fog.len(), 1);
    save(&mut desk, "export", "review", Some("approve"), "");
    assert_eq!(submit(&mut desk, "export").0, OutcomeStatus::Accepted);
    let steps = desk.page("export").unwrap().steps;
    let state = |label: &str| steps.iter().find(|s| s.label == label).unwrap().state;
    assert_eq!(state("Plan approved"), StepState::Done);
    assert_eq!(state("Published as tasks"), StepState::Now);
    assert_eq!(state("Work started"), StepState::Unavailable);
    desk.advance("export");
    let page = desk.page("export").unwrap();
    assert_eq!(page.stage, PlanStage::Published);
    let work = page
        .steps
        .iter()
        .find(|s| s.label == "Work started")
        .unwrap();
    assert_eq!(work.state, StepState::Unavailable);
}

#[test]
fn asking_for_changes_brings_a_new_plan_and_review() {
    let mut desk = PlanDesk::new(PlanScenario::Review);
    let before = desk.page("export").unwrap().proposal.unwrap().digest;
    save(
        &mut desk,
        "export",
        "review",
        Some("revise"),
        "Add a copy-to-clipboard option",
    );
    assert_eq!(submit(&mut desk, "export").0, OutcomeStatus::Accepted);
    desk.advance("export");
    let page = desk.page("export").unwrap();
    let proposal = page.proposal.unwrap();
    assert_ne!(proposal.digest, before);
    assert!(
        proposal
            .spec
            .implementation
            .iter()
            .any(|l| l.ends_with("Add a copy-to-clipboard option"))
    );
    let review = page.interview.unwrap();
    assert_eq!(
        (review.kind, review.round, review.proposal),
        (RoundKind::Review, 4, proposal.digest)
    );
    assert_eq!(page.steps[2].state, StepState::Waiting);
}

#[test]
fn new_names_the_setup_shown_and_small_asks_start_directly() {
    let mut desk = PlanDesk::new(PlanScenario::Fresh);
    let setup = desk.planning().setup.digest.clone();
    let stale = NewIntent {
        goal: "Fix the flaky test".into(),
        setup: "old".into(),
    };
    assert_eq!(
        desk.begin_start(&stale).unwrap_err().status,
        OutcomeStatus::Stale
    );
    let blank = NewIntent {
        goal: "  ".into(),
        setup: setup.clone(),
    };
    assert_eq!(
        desk.begin_plan(&blank).unwrap_err().status,
        OutcomeStatus::Rejected
    );
    let ask = NewIntent {
        goal: "Fix the flaky test".into(),
        setup: setup.clone(),
    };
    let id = desk.begin_start(&ask).unwrap();
    desk.settle_start(&id);
    assert!(desk.planning().plans.is_empty());
    assert_eq!(desk.planning().started[0].text, "Fix the flaky test");
    let goal = NewIntent {
        goal: "Let people export a chat".into(),
        setup,
    };
    let mission = desk.begin_plan(&goal).unwrap();
    assert_eq!(desk.page(&mission).unwrap().interview, None);
    desk.settle_plan(&mission);
    let page = desk.page(&mission).unwrap();
    assert_eq!(page.interview.unwrap().questions.len(), 5);
    assert_eq!(desk.continuations(&mission), 0);
}

#[test]
fn unavailable_planning_sends_nothing() {
    let mut desk = PlanDesk::new(PlanScenario::Unavailable);
    assert_eq!(desk.planning().availability, PlanAvailability::Unavailable);
    let setup = desk.planning().setup.digest.clone();
    let goal = NewIntent {
        goal: "Anything".into(),
        setup,
    };
    assert_eq!(
        desk.begin_plan(&goal).unwrap_err().message,
        "Planning is not connected here. Nothing was sent."
    );
    assert!(desk.begin_start(&goal).is_err());
}

#[test]
fn a_held_submission_is_kept_and_nothing_continues() {
    let mut desk = PlanDesk::new(PlanScenario::Held);
    for (q, c) in [
        ("what", "messages"),
        ("where", "panel"),
        ("check", "fast"),
        ("pr", "yes"),
    ] {
        assert_eq!(
            save(&mut desk, "export", q, Some(c), ""),
            OutcomeStatus::Accepted
        );
    }
    assert_eq!(submit(&mut desk, "export").0, OutcomeStatus::Accepted);
    desk.advance("export");
    let page = desk.page("export").unwrap();
    assert_eq!(page.stage, PlanStage::Submitted);
    assert_eq!(desk.continuations("export"), 0);
    assert_eq!(page.steps[1].state, StepState::Unavailable);
    assert!(page.proposal.is_none());
}

#[test]
fn forty_questions_all_need_answers_and_the_answer_room_is_kept() {
    let mut desk = PlanDesk::new(PlanScenario::Long);
    let view = interview(&desk, "long");
    assert_eq!((view.questions.len(), view.answered), (40, 5));
    assert!(view.room > 0 && view.room < 12 * 1024);
    for q in view
        .questions
        .iter()
        .filter(|q| q.state == QuestionState::Open)
        .take(34)
    {
        assert_eq!(
            save(&mut desk, "long", &q.id, Some("move"), ""),
            OutcomeStatus::Accepted
        );
    }
    let (status, message) = submit(&mut desk, "long");
    assert_eq!(
        (status, message.as_str()),
        (
            OutcomeStatus::Rejected,
            "Answer every question first. One is left."
        )
    );
    // Long answers fill the room; the save past it is refused and nothing changes.
    let text = "x".repeat(2500);
    for q in ["q1", "q2"] {
        assert_eq!(
            save(&mut desk, "long", q, None, &text),
            OutcomeStatus::Accepted
        );
    }
    let before = interview(&desk, "long").revision;
    assert_eq!(
        save(&mut desk, "long", "q3", None, &text),
        OutcomeStatus::Rejected
    );
    assert_eq!(interview(&desk, "long").revision, before);
}
