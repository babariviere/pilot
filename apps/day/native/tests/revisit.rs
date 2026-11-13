//! Revisit on mock data: asking changes nothing, new questions only for
//! gaps, one submission that completes its round only, and a confirmation
//! of the exact revision shown that refuses stale, unpaused and uncertain
//! states and never resends.

use pilot_day_native::{
    plan::{
        AnswerIntent, ChangeKind, ConfirmRevisionIntent, ConfirmState, CorrectionKind,
        DecisionAction, OutcomeStatus, PauseNeed, PlanScenario, PlanStage, RevisionRef,
        RevisitIntent, RevisitStage, RoundKind, StepState, SubmitIntent,
    },
    plan_desk::PlanDesk,
};

fn ask(desk: &mut PlanDesk, mission: &str) -> OutcomeStatus {
    let intent = RevisitIntent {
        mission_id: mission.into(),
    };
    match desk.begin_revisit(&intent) {
        Ok(()) => desk.settle_revisit(&intent).status,
        Err(outcome) => outcome.status,
    }
}

fn answer_all(desk: &mut PlanDesk, mission: &str, picks: &[(&str, &str)]) {
    let view = desk.page(mission).unwrap().interview.unwrap();
    for (question, choice) in picks {
        let q = view.questions.iter().find(|q| q.id == *question).unwrap();
        let ticket = desk
            .begin_save(&AnswerIntent {
                interview_id: view.id.clone(),
                question_set: view.question_set,
                question_id: q.id.clone(),
                digest: q.digest.clone(),
                choice_id: Some((*choice).into()),
                text: String::new(),
            })
            .expect("save starts");
        assert_eq!(desk.settle_save(&ticket).status, OutcomeStatus::Accepted);
    }
}

fn submit(desk: &mut PlanDesk, mission: &str) -> OutcomeStatus {
    let view = desk.page(mission).unwrap().interview.unwrap();
    match desk.begin_submit(&SubmitIntent {
        interview_id: view.id,
        revision: view.revision,
        proposal: String::new(),
    }) {
        Ok(ticket) => desk.settle_submit(&ticket).status,
        Err(outcome) => outcome.status,
    }
}

fn shown(desk: &PlanDesk, mission: &str) -> ConfirmRevisionIntent {
    let revision = desk
        .page(mission)
        .and_then(|p| p.revisit)
        .and_then(|r| r.revision)
        .expect("a revision to review");
    ConfirmRevisionIntent {
        mission_id: mission.into(),
        revision_id: revision.id,
        digest: revision.digest,
    }
}

fn confirm(desk: &mut PlanDesk, intent: &ConfirmRevisionIntent) -> OutcomeStatus {
    match desk.begin_confirm(intent) {
        Ok(ticket) => desk.settle_confirm(&ticket).status,
        Err(outcome) => outcome.status,
    }
}

#[test]
fn asking_opens_new_questions_only_and_submitting_them_changes_nothing() {
    let mut desk = PlanDesk::new(PlanScenario::Revisit);
    let before = desk.page("notify").unwrap();
    let revisit = before.revisit.clone().unwrap();
    assert_eq!(revisit.stage, RevisitStage::Idle);
    assert!(revisit.can_ask && revisit.revision.is_none());
    assert_eq!(
        (
            revisit.open_tasks,
            revisit.finished_tasks,
            revisit.decisions
        ),
        (5, 3, 3)
    );

    assert_eq!(ask(&mut desk, "notify"), OutcomeStatus::Accepted);
    let page = desk.page("notify").unwrap();
    let interview = page.interview.clone().unwrap();
    assert_eq!(interview.kind, RoundKind::Revisit);
    assert_eq!(interview.round, 2);
    assert!(interview.questions.iter().all(|q| q.new));
    // None of the earlier round's questions is asked again.
    let earlier: Vec<_> = page.rounds[0]
        .answers
        .iter()
        .map(|a| a.prompt.clone())
        .collect();
    assert!(
        interview
            .questions
            .iter()
            .all(|q| !earlier.contains(&q.prompt))
    );
    assert_eq!(
        page.revisit.as_ref().unwrap().stage,
        RevisitStage::Questions
    );
    assert_eq!(page.stage, PlanStage::Questions);
    // A second ask while one is under way is refused.
    assert_eq!(ask(&mut desk, "notify"), OutcomeStatus::Rejected);

    // Every question needs an answer; a recommendation is not one.
    assert_eq!(submit(&mut desk, "notify"), OutcomeStatus::Rejected);
    answer_all(
        &mut desk,
        "notify",
        &[("mentions", "direct"), ("email", "allow")],
    );
    assert_eq!(submit(&mut desk, "notify"), OutcomeStatus::Rejected);
    answer_all(&mut desk, "notify", &[("quiet", "fixed")]);
    assert_eq!(submit(&mut desk, "notify"), OutcomeStatus::Accepted);

    let page = desk.page("notify").unwrap();
    let r = page.revisit.clone().unwrap();
    assert_eq!(r.stage, RevisitStage::Proposing);
    assert!(r.revision.is_none());
    // Submitting completed the round only: the agreement and the plan's steps stay.
    assert_eq!(
        (r.goal, r.plan, r.open_tasks),
        (revisit.goal.clone(), revisit.plan.clone(), 5)
    );
    assert_eq!(page.steps, before.steps);
    assert_eq!(page.rounds.last().unwrap().title, "Revisit, round 2");

    desk.advance("notify");
    let r = desk.page("notify").unwrap().revisit.unwrap();
    assert_eq!(r.stage, RevisitStage::Review);
    let revision = r.revision.unwrap();
    // "Keep the email digest": D2 is withdrawn with a reason; #7 stays.
    // "Keep fixed hours": D3 and #5 stay.
    assert!(revision.current);
    assert_eq!(revision.goal.kind, ChangeKind::Stays);
    assert_eq!(revision.plan.kind, ChangeKind::Changes);
    assert_eq!(revision.decisions.len(), 1);
    assert_eq!(revision.decisions[0].action, DecisionAction::Withdraw);
    assert!(revision.decisions[0].reason.contains("Revisit answer"));
    assert_eq!(revision.kept_decisions, 2);
    assert!(revision.tasks.iter().all(|t| t.kind == ChangeKind::Stays));
    assert_eq!(revision.finished, 3);
    assert_eq!(revision.confirm, ConfirmState::Open);
}

#[test]
fn confirming_applies_exactly_the_revision_shown_and_keeps_history() {
    let mut desk = PlanDesk::new(PlanScenario::Revisit);
    ask(&mut desk, "notify");
    answer_all(
        &mut desk,
        "notify",
        &[
            ("mentions", "direct"),
            ("email", "drop"),
            ("quiet", "focus"),
        ],
    );
    submit(&mut desk, "notify");
    desk.advance("notify");
    let page = desk.page("notify").unwrap();
    assert_eq!(page.stage, PlanStage::Review);
    let revision = page.revisit.unwrap().revision.unwrap();
    let kinds: Vec<_> = revision.tasks.iter().map(|t| (t.number, t.kind)).collect();
    assert_eq!(
        kinds,
        vec![
            (4, ChangeKind::Stays),
            (5, ChangeKind::Changes),
            (6, ChangeKind::Stays),
            (7, ChangeKind::Drops),
            (8, ChangeKind::Stays),
        ]
    );
    assert_eq!(revision.decisions[0].action, DecisionAction::Replace);
    // Corrections are listed apart and never applied.
    let corrections: Vec<_> = revision.corrections.iter().map(|c| c.kind).collect();
    assert!(corrections.contains(&CorrectionKind::Instruction));
    assert!(corrections.contains(&CorrectionKind::Permission));

    // A changed digest or another revision is refused, and nothing changes.
    let exact = shown(&desk, "notify");
    let wrong = ConfirmRevisionIntent {
        digest: "0".into(),
        ..exact.clone()
    };
    assert_eq!(confirm(&mut desk, &wrong), OutcomeStatus::Stale);
    assert_eq!(confirm(&mut desk, &exact), OutcomeStatus::Accepted);
    let page = desk.page("notify").unwrap();
    let r = page.revisit.unwrap();
    assert_eq!(r.stage, RevisitStage::Confirmed);
    assert!(r.revision.is_none());
    assert_eq!((r.open_tasks, r.finished_tasks, r.decisions), (4, 3, 3));
    assert!(r.plan.contains("macOS Focus"));
    let line = &r.history[0];
    assert!(line.earlier_plan.contains("22:00"));
    assert!(line.retired[0].contains("replaced by D4"));
    // The plan's own steps and work are untouched: nothing started.
    assert_eq!(page.steps[3].state, StepState::Unavailable);
    // Confirming again is refused; a new Revisit can be asked.
    assert_eq!(confirm(&mut desk, &exact), OutcomeStatus::Stale);
    assert!(r.can_ask);
}

#[test]
fn a_changed_mission_unpaused_work_and_lost_answers_never_apply_twice() {
    let mut desk = PlanDesk::new(PlanScenario::RevisitTrouble);

    // The mission changes while the user confirms: refused, then stale.
    let exact = shown(&desk, "notify");
    assert_eq!(confirm(&mut desk, &exact), OutcomeStatus::Stale);
    let r = desk.page("notify").unwrap().revisit.unwrap();
    let revision = r.revision.unwrap();
    assert!(!revision.current && revision.confirm == ConfirmState::Open);
    assert_eq!(confirm(&mut desk, &exact), OutcomeStatus::Stale);
    // Only a new revision can follow; asking makes one from earlier answers.
    assert!(r.can_ask);
    assert_eq!(ask(&mut desk, "notify"), OutcomeStatus::Accepted);
    let fresh = shown(&desk, "notify");
    assert_ne!(fresh.revision_id, exact.revision_id);
    assert_eq!(confirm(&mut desk, &fresh), OutcomeStatus::Accepted);

    // Chats still work: the confirmation is refused until work is paused.
    let digest = desk.page("digest").unwrap().revisit.unwrap();
    assert_eq!(digest.revision.as_ref().unwrap().pause, PauseNeed::Needed);
    let working = shown(&desk, "digest");
    assert_eq!(confirm(&mut desk, &working), OutcomeStatus::Rejected);
    assert_eq!(
        desk.page("digest")
            .unwrap()
            .revisit
            .unwrap()
            .revision
            .unwrap()
            .confirm,
        ConfirmState::Open
    );

    // A lost answer is unknown; confirming again is refused; a check only reads.
    let lost = shown(&desk, "alerts");
    assert_eq!(confirm(&mut desk, &lost), OutcomeStatus::Unknown);
    assert_eq!(desk.page("alerts").unwrap().stage, PlanStage::Unknown);
    assert_eq!(confirm(&mut desk, &lost), OutcomeStatus::Rejected);
    let check = RevisionRef {
        mission_id: "alerts".into(),
        revision_id: lost.revision_id.clone(),
    };
    desk.begin_check_revision(&check).expect("check starts");
    let outcome = desk.settle_check_revision(&check);
    assert_eq!(outcome.status, OutcomeStatus::Accepted);
    let r = desk.page("alerts").unwrap().revisit.unwrap();
    assert_eq!((r.stage, r.history.len()), (RevisitStage::Confirmed, 1));
    assert!(desk.begin_check_revision(&check).is_err());
}
