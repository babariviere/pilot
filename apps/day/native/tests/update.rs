//! The mock update rules: one-use confirmations, selective pause and
//! resume, a saved view used once, refusals before replacement and lost
//! answers that only a check settles. Mock rules only, not the updater.

use pilot_day_native::{
    model::OutcomeStatus,
    update::{
        AgentState, ConfirmIntent, PlaceKind, PrepareIntent, SavedView, ServiceState, Stage,
        UpdateDesk, UpdateKind, UpdatePhase, UpdateRef, UpdateScenario, UpdateStepState,
        VIEW_LIMIT,
    },
};

fn view() -> SavedView {
    SavedView {
        place: PlaceKind::Plan,
        id: "export".into(),
        update: true,
        goal: "Export chats as Markdown, exactly — 書き出し".into(),
        chat: None,
        focused: "d-1".into(),
        questions: vec!["export-1/what".into()],
        ritual: "standup/start".into(),
        date: "2026-11-11".into(),
        step: 2,
        help: vec!["d-1/simpler".into()],
        see_all: vec!["export-1".into()],
        tab: String::new(),
        today_y: 412.5,
        today_row: "plan-export".into(),
        y: 96.0,
        input: "answer:export-1/what".into(),
        start: 3,
        end: 7,
        delivery: "task/project/export/t1".into(),
        notes: vec!["task/project/export/t1\n  Exact note 👩🏽‍💻\n".into()],
        reminders: vec![format!("task/project/export/t1#{}\nreport", "a".repeat(64))],
        linear: "project/ln-219".into(),
    }
}

/// Prepares the offer shown and confirms it with `view`.
fn start(desk: &mut UpdateDesk, view: SavedView) -> Result<Vec<Stage>, OutcomeStatus> {
    let shown = desk.view().clone();
    let kind = shown.offer.as_ref().map(|o| o.kind).unwrap_or_default();
    let prepared = desk.prepare(&PrepareIntent {
        kind,
        revision: shown.revision,
    });
    assert_eq!(
        prepared.status,
        OutcomeStatus::Accepted,
        "{}",
        prepared.message
    );
    let id = prepared.confirmation.unwrap().id;
    desk.begin(&ConfirmIntent {
        confirmation: id,
        view,
    })
    .map_err(|o| o.status)
}

/// Plays stages until one ends the run.
fn play(desk: &mut UpdateDesk, stages: Vec<Stage>) -> OutcomeStatus {
    for stage in stages {
        if let Some(outcome) = desk.apply(stage) {
            return outcome.status;
        }
    }
    panic!("the run did not end");
}

fn states(desk: &UpdateDesk) -> Vec<AgentState> {
    desk.view().agents.iter().map(|a| a.state).collect()
}

#[test]
fn an_update_pauses_only_working_agents_and_restores_the_exact_view_once_without_resuming() {
    let mut desk = UpdateDesk::new(UpdateScenario::Available);
    let before = states(&desk);
    assert_eq!(
        before,
        [AgentState::Working, AgentState::Working, AgentState::Held]
    );
    let stages = start(&mut desk, view()).unwrap();
    let mut paused = false;
    let mut ended = None;
    for stage in stages {
        ended = desk.apply(stage);
        if stage == Stage::Pause {
            assert_eq!(
                states(&desk),
                [AgentState::Paused, AgentState::Paused, AgentState::Held]
            );
            paused = true;
        }
        if ended.is_some() {
            break;
        }
    }
    assert!(paused);
    assert_eq!(ended.unwrap().status, OutcomeStatus::Accepted);
    // Waiting for the new window: not finished. The service resumed the
    // agents it paused on its own, before and apart from the window.
    let run = desk.view().run.clone().unwrap();
    assert_eq!(run.phase, UpdatePhase::Running);
    let restore = desk
        .view()
        .restore
        .clone()
        .expect("a saved view to restore");
    assert_eq!(restore.view, view());
    assert_eq!(
        states(&desk),
        [AgentState::Resumed, AgentState::Resumed, AgentState::Held]
    );

    let id = UpdateRef {
        id: restore.id.clone(),
    };
    let agents = states(&desk);
    assert_eq!(desk.restored(&id), Ok(()));
    assert!(desk.view().restore.is_none());
    assert_eq!(states(&desk), agents, "the acknowledgement resumes nothing");
    // Used once: a second acknowledgement is refused, a forged one is stale.
    assert_eq!(
        desk.restored(&id).unwrap_err().status,
        OutcomeStatus::Rejected
    );
    let forged = UpdateRef {
        id: "restore-forged".into(),
    };
    assert_eq!(
        desk.restored(&forged).unwrap_err().status,
        OutcomeStatus::Stale
    );

    let run = desk.view().run.clone().unwrap();
    assert_eq!(run.phase, UpdatePhase::Done);
    assert!(run.steps.iter().all(|s| s.state == UpdateStepState::Done));
    assert_eq!(
        (desk.view().app.as_str(), desk.view().service.as_str()),
        ("0.9.3", "0.9.3")
    );
    assert!(desk.view().offer.is_none());
}

#[test]
fn a_confirmation_is_used_once_and_names_what_was_shown() {
    let mut desk = UpdateDesk::new(UpdateScenario::Available);
    let revision = desk.view().revision;
    for (kind, revision) in [
        (UpdateKind::Both, revision + 7),
        (UpdateKind::Service, revision),
    ] {
        let prepared = desk.prepare(&PrepareIntent { kind, revision });
        assert_eq!(prepared.status, OutcomeStatus::Stale);
        assert!(prepared.confirmation.is_none());
    }
    let prepared = desk.prepare(&PrepareIntent {
        kind: UpdateKind::Both,
        revision,
    });
    let id = prepared.confirmation.unwrap().id;
    let wrong = desk.begin(&ConfirmIntent {
        confirmation: "confirm-forged".into(),
        view: view(),
    });
    assert_eq!(wrong.unwrap_err().status, OutcomeStatus::Stale);
    // The forged try used the one confirmation up: the real one is refused too.
    let late = desk.begin(&ConfirmIntent {
        confirmation: id,
        view: view(),
    });
    assert_eq!(late.unwrap_err().status, OutcomeStatus::Rejected);
    assert!(desk.view().run.is_none());
    assert_eq!(
        states(&desk),
        [AgentState::Working, AgentState::Working, AgentState::Held]
    );
}

#[test]
fn an_oversized_view_is_refused_whole_before_anything_pauses() {
    let mut desk = UpdateDesk::new(UpdateScenario::Available);
    let mut big = view();
    big.goal = "x".repeat(VIEW_LIMIT + 1);
    assert_eq!(start(&mut desk, big), Err(OutcomeStatus::Rejected));
    // Every text field counts, not only the goal; offsets must be plain.
    let mut desk = UpdateDesk::new(UpdateScenario::Available);
    let mut big = view();
    big.help = vec!["x".repeat(VIEW_LIMIT / 2), "y".repeat(VIEW_LIMIT / 2)];
    assert_eq!(start(&mut desk, big), Err(OutcomeStatus::Rejected));
    // Unsent Send back notes count too; they are never cut to fit.
    let mut desk = UpdateDesk::new(UpdateScenario::Available);
    let mut big = view();
    big.notes = vec![format!("task/p/m/a\n{}", "x".repeat(VIEW_LIMIT))];
    assert_eq!(start(&mut desk, big), Err(OutcomeStatus::Rejected));
    let mut desk = UpdateDesk::new(UpdateScenario::Available);
    let mut odd = view();
    odd.today_y = f64::NAN;
    assert_eq!(start(&mut desk, odd), Err(OutcomeStatus::Rejected));
    // The Linear page names one project and at most one issue, by their IDs.
    for linear in [
        "project/",
        "/ln-1",
        "project/ln-1/more",
        "pro ject",
        "project/ln 1",
    ] {
        let mut desk = UpdateDesk::new(UpdateScenario::Available);
        let mut odd = view();
        odd.linear = linear.into();
        assert_eq!(
            start(&mut desk, odd),
            Err(OutcomeStatus::Rejected),
            "{linear}"
        );
    }
    assert!(desk.view().run.is_none());
    assert!(desk.view().restore.is_none());
    assert_eq!(
        states(&desk),
        [AgentState::Working, AgentState::Working, AgentState::Held]
    );
}

#[test]
fn a_lost_answer_stays_unknown_and_blocks_a_new_attempt_until_checked() {
    let mut desk = UpdateDesk::new(UpdateScenario::Trouble);
    // The first confirmation is stale: a newer update replaced its target.
    assert_eq!(start(&mut desk, view()), Err(OutcomeStatus::Stale));
    assert_eq!(desk.view().offer.as_ref().unwrap().version, "0.9.4");
    assert!(desk.view().run.is_none());
    let stages = start(&mut desk, view()).unwrap();
    assert_eq!(play(&mut desk, stages), OutcomeStatus::Unknown);
    let run = desk.view().run.clone().unwrap();
    assert_eq!(run.phase, UpdatePhase::Unknown);
    assert!(
        run.steps
            .iter()
            .any(|s| s.state == UpdateStepState::Unknown)
    );
    assert_eq!(
        desk.view().service,
        "0.9.2",
        "an unknown answer never claims the new version"
    );
    assert!(!desk.view().blocked.is_empty());
    let revision = desk.view().revision;
    let again = desk.prepare(&PrepareIntent {
        kind: UpdateKind::Service,
        revision,
    });
    assert_eq!(again.status, OutcomeStatus::Rejected);
    assert!(desk.begin_check());
    assert_eq!(
        desk.view().run.as_ref().unwrap().phase,
        UpdatePhase::Checking
    );
    assert_eq!(desk.settle_check(true).status, OutcomeStatus::Accepted);
    assert_eq!(desk.view().service, "0.9.4");
    assert_eq!(
        states(&desk),
        [AgentState::Resumed, AgentState::Resuming, AgentState::Held]
    );
}

#[test]
fn refusals_stop_before_replacement_and_put_paused_agents_back() {
    let mut desk = UpdateDesk::new(UpdateScenario::Refused);
    let stages = start(&mut desk, view()).unwrap();
    assert_eq!(play(&mut desk, stages), OutcomeStatus::Rejected);
    let run = desk.view().run.clone().unwrap();
    assert_eq!(run.phase, UpdatePhase::Stopped);
    assert_eq!(run.steps[1].state, UpdateStepState::Failed);
    assert!(!run.next.is_empty());
    assert_eq!(
        states(&desk),
        [AgentState::Working, AgentState::Working, AgentState::Held]
    );

    let stages = start(&mut desk, view()).unwrap();
    assert_eq!(play(&mut desk, stages), OutcomeStatus::Rejected);
    assert_eq!(
        states(&desk),
        [AgentState::Working, AgentState::Unknown, AgentState::Held]
    );
    assert_eq!(desk.view().service, "0.9.2");
    assert!(desk.view().restore.is_none());
    let revision = desk.view().revision;
    let again = desk.prepare(&PrepareIntent {
        kind: UpdateKind::Service,
        revision,
    });
    assert_eq!(
        again.status,
        OutcomeStatus::Rejected,
        "an unproven job exit is a durable refusal"
    );
    // A check only reads; it clears nothing.
    assert!(!desk.begin_check());
    desk.settle_check(false);
    assert!(!desk.view().blocked.is_empty());

    let mut unverified = UpdateDesk::new(UpdateScenario::Unverified);
    let stages = start(&mut unverified, view()).unwrap();
    assert_eq!(play(&mut unverified, stages), OutcomeStatus::Rejected);
    let run = unverified.view().run.clone().unwrap();
    assert_eq!(run.steps[0].state, UpdateStepState::Failed);
    assert!(
        run.steps[1..]
            .iter()
            .all(|s| s.state == UpdateStepState::Waiting)
    );
    assert_eq!(
        states(&unverified),
        [AgentState::Working, AgentState::Working, AgentState::Held]
    );
}

#[test]
fn registration_is_explicit_and_an_uncertain_one_is_only_looked_up() {
    let mut absent = UpdateDesk::new(UpdateScenario::Absent);
    assert_eq!(absent.view().state, ServiceState::Absent);
    let stages = start(&mut absent, SavedView::default()).unwrap();
    assert_eq!(play(&mut absent, stages), OutcomeStatus::Unknown);
    assert_eq!(absent.view().state, ServiceState::Unknown);
    let revision = absent.view().revision;
    let again = absent.prepare(&PrepareIntent {
        kind: UpdateKind::Register,
        revision,
    });
    assert_eq!(again.status, OutcomeStatus::Rejected);
    assert!(absent.begin_check());
    absent.settle_check(true);
    assert_eq!(absent.view().state, ServiceState::Registered);
    assert_eq!(absent.view().service, "0.9.2");

    let mut denied = UpdateDesk::new(UpdateScenario::Denied);
    let stages = start(&mut denied, SavedView::default()).unwrap();
    assert_eq!(play(&mut denied, stages), OutcomeStatus::Rejected);
    assert_eq!(denied.view().state, ServiceState::Absent);
    let stages = start(&mut denied, SavedView::default()).unwrap();
    assert_eq!(play(&mut denied, stages), OutcomeStatus::Accepted);
    assert_eq!(denied.view().state, ServiceState::Registered);
}

#[test]
fn offline_holds_updates_and_newer_takes_an_app_only_update() {
    let mut offline = UpdateDesk::new(UpdateScenario::Offline);
    let revision = offline.view().revision;
    let prepared = offline.prepare(&PrepareIntent {
        kind: UpdateKind::Service,
        revision,
    });
    assert_eq!(prepared.status, OutcomeStatus::Rejected);

    let mut newer = UpdateDesk::new(UpdateScenario::Newer);
    assert_eq!(newer.view().state, ServiceState::Incompatible);
    let stages = start(&mut newer, view()).unwrap();
    assert!(!stages.contains(&Stage::Pause));
    assert_eq!(play(&mut newer, stages), OutcomeStatus::Accepted);
    assert_eq!(
        states(&newer),
        [AgentState::Working, AgentState::Working, AgentState::Held]
    );
    let restore = newer.view().restore.clone().unwrap();
    assert_eq!(newer.restored(&UpdateRef { id: restore.id }), Ok(()));
    assert_eq!(newer.view().run.as_ref().unwrap().phase, UpdatePhase::Done);
    assert_eq!(newer.view().state, ServiceState::Registered);
    assert_eq!(newer.view().app, "0.12.0");
}
