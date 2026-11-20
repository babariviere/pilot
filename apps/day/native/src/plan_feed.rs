//! The class the New and planning screens hold in fixture entries: mock data
//! they can mirror and intents they can send. The connected app reads and
//! writes planning through the JSON bridge instead.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::{
    feed::MOCK_LATENCY,
    plan::{
        AnswerIntent, ConfirmRevisionIntent, ContinueIntent, InterviewRef, NewIntent,
        OutcomeStatus, PlanChat, PlanOutcome, PlanPage, PlanScenario, Planning, QuestionAskIntent,
        RepairApplyIntent, RevisionRef, RevisitIntent, SubmitIntent, UnstickIntent,
    },
    plan_desk::PlanDesk,
};

type Listeners = Rc<RefCell<Vec<(u64, Callback<Planning>)>>>;

fn outcome(status: OutcomeStatus, message: &str, mission: Option<String>) -> PlanOutcome {
    PlanOutcome {
        status,
        revision: 0,
        message: message.into(),
        mission_id: mission,
    }
}

/// New, mission interviews and planning, kept in Rust, and the only way to
/// change them. The screens mirror `snapshot()`, read `page()` again on
/// every change, and hear changes through `onChange`. Saving an answer
/// never submits it; submitting is one explicit intent; neither starts work.
#[class]
pub struct PlanFeed {
    desk: PlanDesk,
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl PlanFeed {
    fn publish(&self) {
        let planning = self.snapshot();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(planning.clone());
        }
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &PlanDesk {
        &self.desk
    }

    /// Runs `begin`; publishes when it started something.
    fn begin<T>(
        this: &Instance<Self>,
        begin: impl FnOnce(&mut PlanDesk) -> Result<T, PlanOutcome>,
    ) -> Result<(T, Duration), PlanOutcome> {
        this.with_mut(|feed| {
            let started = begin(&mut feed.desk);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        })
    }

    /// Runs `settle` and publishes.
    fn settle(
        this: &Instance<Self>,
        settle: impl FnOnce(&mut PlanDesk) -> PlanOutcome,
    ) -> PlanOutcome {
        this.with_mut(|feed| {
            let outcome = settle(&mut feed.desk);
            feed.publish();
            outcome
        })
    }

    /// The mock coordinator's step after a confirmed submission. It runs
    /// once per submission, after the screen has seen it submitted.
    async fn continue_after(this: &Instance<Self>, outcome: &PlanOutcome, latency: Duration) {
        let Some(mission_id) = outcome.mission_id.clone() else {
            return;
        };
        if outcome.status != OutcomeStatus::Accepted {
            return;
        }
        timer(latency * 2).await;
        if this.is_disposed() {
            return;
        }
        this.with_mut(|feed| {
            feed.desk.advance(&mission_id);
            feed.publish();
        });
    }
}

#[class]
impl PlanFeed {
    /// A feed of mock data from `scenario` (one mission interview when left out).
    pub fn new(scenario: Option<PlanScenario>) -> Self {
        PlanFeed {
            desk: PlanDesk::new(scenario.unwrap_or_default()),
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// Planning now: availability, setup and missions in planning.
    pub fn snapshot(&self) -> Planning {
        self.desk.planning().clone()
    }

    /// Calls `listener` with the whole planning read after every change,
    /// until the returned function is called or its owner goes.
    pub fn on_change(&mut self, #[args(planning)] listener: Callback<Planning>) -> Stop {
        let id = self.next_listener;
        self.next_listener += 1;
        self.listeners.borrow_mut().push((id, listener));
        let listeners = Rc::downgrade(&self.listeners);
        Stop::new(move || {
            if let Some(listeners) = listeners.upgrade() {
                listeners.borrow_mut().retain(|(at, _)| *at != id);
            }
        })
    }

    /// One mission's planning in full, or null when it is not read yet or
    /// not in planning. Read it again after every change.
    pub fn page(&self, mission_id: String) -> Option<PlanPage> {
        self.desk.page(&mission_id)
    }

    /// One mission's planning chat as read, or null before `readChat`.
    /// Read it again after every change.
    pub fn chat(&self, mission_id: String) -> Option<PlanChat> {
        self.desk.chat(&mission_id)
    }

    /// Opens the planning chat and reads its newest rows, or with `older`
    /// the rows before what shows. Reading sends nothing to the agent.
    /// While it is open, Pilot reads it again as the agent works.
    pub async fn read_chat(this: Instance<Self>, mission_id: String, older: bool) -> PlanOutcome {
        let _ = (this, older);
        outcome(OutcomeStatus::Accepted, "", Some(mission_id))
    }

    /// Closes the planning chat. Pilot no longer reads or keeps it.
    pub fn close_chat(&self) {}

    /// `mission_id`'s planning page closed. Pilot stops reading it as its
    /// agent works and closes its chat. Another mission's page stays.
    pub fn leave(&self, mission_id: String) {
        let _ = mission_id;
    }

    /// Reads one mission's saved interview and plan. Opening never answers,
    /// submits or starts anything.
    pub async fn open(this: Instance<Self>, mission_id: String) -> PlanOutcome {
        let known = this.with(|f| f.desk.page(&mission_id).is_some());
        if known {
            outcome(OutcomeStatus::Accepted, "", Some(mission_id))
        } else {
            outcome(
                OutcomeStatus::Rejected,
                "This mission is not in planning.",
                None,
            )
        }
    }

    /// Starts a mission from the user's goal, named with the setup shown.
    /// Pilot asks its questions first; nothing else starts. An acknowledged
    /// mission may still be preparing its complete first question list.
    pub async fn plan(this: Instance<Self>, intent: NewIntent) -> PlanOutcome {
        let (mission_id, latency) = match Self::begin(&this, |desk| desk.begin_plan(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |desk| desk.settle_plan(&mission_id))
    }

    /// Starts one new Build chat with exactly the user's words, named with
    /// the setup shown. It is not a mission and asks no questions.
    pub async fn start(this: Instance<Self>, intent: NewIntent) -> PlanOutcome {
        let (id, latency) = match Self::begin(&this, |desk| desk.begin_start(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |desk| desk.settle_start(&id))
    }

    /// Reads the selected planning setup for New. No enrollment or provider call.
    /// Uncertain identities stay checkable; unrelated requests may prepare independently.
    pub async fn prepare_new(this: Instance<Self>) -> PlanOutcome {
        let _ = this;
        outcome(OutcomeStatus::Accepted, "", None)
    }

    /// Checks one uncertain New enrollment using its saved exact receipt only.
    /// It never recreates a request, changes its owner or sends the enrollment again.
    pub async fn check_new(this: Instance<Self>) -> PlanOutcome {
        let _ = this;
        outcome(OutcomeStatus::Rejected, "There is nothing to check.", None)
    }

    /// Saves one answer as a draft, named with the question list and the
    /// question's digest shown. It never submits and never wakes Pilot.
    pub async fn save_answer(this: Instance<Self>, intent: AnswerIntent) -> PlanOutcome {
        let (ticket, latency) = match Self::begin(&this, |desk| desk.begin_save(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |desk| desk.settle_save(&ticket))
    }

    /// Submits an interview's saved answers, once, named with the saved
    /// revision (and, for a review, the plan) shown. Every question needs
    /// an answer. A lost answer is `unknown`, and only `checkSubmit` can
    /// settle it; nothing resends.
    pub async fn submit(this: Instance<Self>, intent: SubmitIntent) -> PlanOutcome {
        let (ticket, latency) = match Self::begin(&this, |desk| desk.begin_submit(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        let outcome = Self::settle(&this, |desk| desk.settle_submit(&ticket));
        Self::continue_after(&this, &outcome, latency).await;
        outcome
    }

    /// Reads whether an action whose answer was lost landed. Never sends it
    /// again.
    pub async fn check_submit(this: Instance<Self>, intent: InterviewRef) -> PlanOutcome {
        let ((), latency) = match Self::begin(&this, |desk| desk.begin_check(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        let outcome = Self::settle(&this, |desk| desk.settle_check(&intent));
        Self::continue_after(&this, &outcome, latency).await;
        outcome
    }

    /// Asks Pilot to revisit a mission: compare it with what was agreed and
    /// ask new questions only for the gaps. It changes, pauses and starts
    /// nothing; a revision applies only through `confirmRevision`.
    pub async fn revisit(this: Instance<Self>, intent: RevisitIntent) -> PlanOutcome {
        let ((), latency) = match Self::begin(&this, |desk| desk.begin_revisit(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency * 2).await;
        if this.is_disposed() {
            return outcome(OutcomeStatus::Unknown, "", None);
        }
        Self::settle(&this, |desk| desk.settle_revisit(&intent))
    }

    /// Asks the idle planning agent to continue planning. It answers,
    /// approves and starts nothing; mock flows have no planning agent to wake.
    pub async fn continue_planning(this: Instance<Self>, intent: ContinueIntent) -> PlanOutcome {
        let _ = this;
        outcome(
            OutcomeStatus::Rejected,
            "Continue planning is not available here. Nothing was sent.",
            Some(intent.mission_id),
        )
    }

    /// Applies Unstick's fix that removes saved answers to an earlier wording, so
    /// new answers save. It answers no question; Continue planning is its own action.
    pub async fn drop_earlier_answers(this: Instance<Self>, intent: UnstickIntent) -> PlanOutcome {
        let _ = this;
        outcome(
            OutcomeStatus::Rejected,
            "Unstick is not available here. Nothing was sent.",
            Some(intent.mission_id),
        )
    }

    /// Starts Unstick's repair agent: a read-only chat that reads the planner's chat
    /// and proposes one fix. It changes nothing in the mission.
    pub async fn repair_start(this: Instance<Self>, intent: UnstickIntent) -> PlanOutcome {
        let _ = this;
        outcome(
            OutcomeStatus::Rejected,
            "The repair agent is not available here. Nothing was sent.",
            Some(intent.mission_id),
        )
    }

    /// Applies the repair agent's fix, only while it still matches the mission.
    pub async fn repair_apply(this: Instance<Self>, intent: RepairApplyIntent) -> PlanOutcome {
        let _ = this;
        outcome(
            OutcomeStatus::Rejected,
            "The repair agent is not available here. Nothing was sent.",
            Some(intent.mission_id),
        )
    }

    /// Asks about one interview question. A read-only chat answers it on the
    /// planning page; the round keeps waiting for the user's answers.
    pub async fn ask_question(this: Instance<Self>, intent: QuestionAskIntent) -> PlanOutcome {
        let _ = this;
        outcome(
            OutcomeStatus::Rejected,
            "Questions about questions are not available here. Nothing was sent.",
            Some(intent.mission_id),
        )
    }

    /// Checkpoints only affected work for the exact revision shown.
    pub async fn pause_revision(
        this: Instance<Self>,
        intent: ConfirmRevisionIntent,
    ) -> PlanOutcome {
        let _ = (this, intent);
        outcome(
            OutcomeStatus::Rejected,
            "This fixture uses a mission-wide pause.",
            None,
        )
    }

    /// Explicit release of one exact selective checkpoint. Never automatic after apply.
    pub async fn resume_revision(
        this: Instance<Self>,
        intent: crate::plan::ResumeRevisionIntent,
    ) -> PlanOutcome {
        let _ = (this, intent);
        outcome(
            OutcomeStatus::Rejected,
            "No selective checkpoint in this fixture.",
            None,
        )
    }

    /// Confirms one revision exactly as shown: its id and digest. It applies
    /// only while the mission is what Pilot revised. It changes the agreement
    /// and open tasks; it resumes, starts and permits nothing. A lost answer
    /// is `unknown`, and only `checkRevision` can settle it.
    pub async fn confirm_revision(
        this: Instance<Self>,
        intent: ConfirmRevisionIntent,
    ) -> PlanOutcome {
        let (ticket, latency) = match Self::begin(&this, |desk| desk.begin_confirm(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |desk| desk.settle_confirm(&ticket))
    }

    /// Reads whether a confirmation whose answer was lost applied. Never
    /// sends it again.
    pub async fn check_revision(this: Instance<Self>, intent: RevisionRef) -> PlanOutcome {
        let ((), latency) = match Self::begin(&this, |desk| desk.begin_check_revision(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |desk| desk.settle_check_revision(&intent))
    }
}
