//! The single owner of the Today read model, with no UI and no JS. Each
//! intent is checked against the revision and delivery state it names
//! before anything changes. Missions are projected from the daemon's v1
//! reads (`DayOverview`, `MissionDetail`, control receipts). For now a mock
//! coordinator and a mock daemon answer; in production this is where the
//! daemon adapter sits, behind the same two-step begin/settle shape.

use std::time::Duration;

use crate::{
    actions::Actions,
    contract::{
        self as c, ControlAction, ControlCommand, ControlMember, ControlOperation, DayOverview,
        MissionDetail, OperationState, ReportView,
    },
    fixture::{self, Ack, ControlAck, NOW, World, world},
    model::{
        Answer, AnswerRef, AnswerState, AskIntent, ControlAsk, DecideIntent, Decision,
        DecisionKind, DecisionRef, Delivery, DoneEntry, Evidence, FreshnessState, IntentOutcome,
        LifecycleAction, LifecycleIntent, MissionPage, MissionRef, OutcomeStatus, PauseIntent,
        RenameIntent, ResumeIntent, Scenario, StopReplanningIntent, Today, Tone,
    },
    project::{self, ControlLocal, Inputs},
};

/// The most results Today keeps. Older ones are counted, not sent.
pub const DONE_LIMIT: usize = 20;

/// The longest question a user may ask, in characters.
pub const QUESTION_LIMIT: usize = 500;

/// How often the update workload changes the read model by default.
pub const PULSE_EVERY: Duration = Duration::from_millis(100);

/// How many changes the update workload makes by default.
pub const PULSE_COUNT: u32 = 300;

/// Keeps the newest [`DONE_LIMIT`] results and counts the rest.
pub fn limit_done(today: &mut Today) {
    if today.done.len() > DONE_LIMIT {
        let hidden = today.done.len() - DONE_LIMIT;
        today.done.truncate(DONE_LIMIT);
        today.done_hidden += hidden as u32;
    }
}

/// The owner of the Today read model and the mock coordinator behind it.
#[derive(Debug, Clone)]
pub struct Desk {
    native: bool,
    native_controls: bool,
    /// Whether the service links re-plans (`missionReplanning`).
    native_replanning: bool,
    /// Missions the mock service archived, for Reopen.
    archived: Vec<c::DashboardMission>,
    today: Today,
    overview: Option<DayOverview>,
    details: Vec<MissionDetail>,
    freshness: (FreshnessState, String),
    now: u64,
    local: Vec<(String, ControlLocal)>,
    /// Receipts the mock daemon saved, by operation. Lookups read them;
    /// nothing here executes a command twice.
    daemon_ops: Vec<ControlOperation>,
    next_operation: u32,
    acks: Vec<(String, Ack)>,
    control_acks: Vec<(String, ControlAck)>,
    answers: Vec<(String, String)>,
    /// Decisions whose next answer to a question is lost on the way back.
    lost_answers: Vec<String>,
    /// Answers the mock help service saved, by question: lookups read them.
    saved_answers: Vec<(String, String)>,
    /// The decision revision each question was asked about.
    asked_at: Vec<(String, u32)>,
    next_answer: u32,
    actions: Actions,
    pulses: u32,
}

/// A Pause or Resume that was recorded and sent, and waits for its answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedControl {
    /// The mission.
    pub mission_id: String,
    /// The operation, recorded before the send.
    pub operation_id: String,
    /// How the mock daemon will answer.
    pub ack: ControlAck,
}

/// A started intent that waits for the coordinator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    /// The decision.
    pub decision_id: String,
    /// How the mock coordinator will answer.
    pub ack: Ack,
}

impl Desk {
    /// The desk for `scenario`.
    pub fn new(scenario: Scenario) -> Self {
        Self::from_world(world(scenario))
    }

    /// The desk for a world built elsewhere (tests, generated loads).
    pub fn from_world(world: World) -> Self {
        let mut today = world.today;
        limit_done(&mut today);
        let mut desk = Desk {
            native: false,
            native_controls: true,
            native_replanning: true,
            archived: Vec::new(),
            today,
            overview: world.overview,
            details: world.details,
            freshness: (world.freshness.0, world.freshness.1.to_owned()),
            now: NOW,
            local: Vec::new(),
            daemon_ops: Vec::new(),
            next_operation: 0,
            acks: world.acks,
            control_acks: world.control_acks,
            answers: world.answers,
            lost_answers: world.lost_answers,
            saved_answers: Vec::new(),
            asked_at: Vec::new(),
            next_answer: 0,
            actions: world.actions,
            pulses: 0,
        };
        desk.project();
        desk
    }

    /// The same desk after Day restarts: the service's rows and receipts
    /// and Day's journal stay; requests in flight become unknown.
    pub fn restart(&self) -> Self {
        let mut desk = Desk {
            actions: self.actions.restart(),
            ..self.clone()
        };
        desk.changed();
        desk
    }

    pub(crate) fn actions_mut(&mut self) -> &mut Actions {
        &mut self.actions
    }

    /// Adds a confirmed result of the user's own action.
    pub(crate) fn note(&mut self, note: String) {
        self.today.notes.push(note);
    }

    pub(crate) fn changed_actions(&mut self) {
        self.changed();
    }

    pub(crate) fn outcome_now(&self, status: OutcomeStatus, message: &str) -> IntentOutcome {
        self.outcome(status, message)
    }

    /// Projects missions and freshness from the reads into the read model.
    fn project(&mut self) {
        self.today.problems_known = self.overview.as_ref().is_some_and(|o| {
            o.dashboard
                .needs_you
                .as_ref()
                .is_some_and(|s| s.total as usize == s.items.len())
        });
        self.today.problems = self
            .overview
            .as_ref()
            .map_or_else(Vec::new, project::problems);
        self.today.actions = self.actions.view();
        self.today.freshness = project::freshness(
            self.freshness.0,
            self.overview.as_ref().map(|o| o.observed_at),
            &self.freshness.1,
            self.now,
        );
        // Mock decisions and actions share the missions' read. The native
        // feed replaces this with the attention read's own freshness.
        self.today.attention = self.today.freshness.clone();
        let groups = match &self.overview {
            Some(overview) => project::missions(&Inputs {
                overview,
                details: &self.details,
                decisions: &self.today.decisions,
                local: &self.local,
                live: self.live(),
                now: self.now,
            }),
            None => project::Groups::default(),
        };
        self.today.moving = groups.moving;
        self.today.not_moving = groups.not_moving;
        self.today.unreported = groups.unreported;
        self.today.intake = self
            .overview
            .as_ref()
            .map(|o| crate::intake::intake(&o.dashboard.tracked, self.now))
            .unwrap_or_default();
    }

    /// Whether the read is live. Controls need it.
    fn live(&self) -> bool {
        self.freshness.0 == FreshnessState::Live && self.overview.is_some() && self.native_controls
    }

    /// Takes a new, complete read. It replaces the last one; local requests
    /// still waiting keep their state.
    pub fn apply_overview(&mut self, overview: DayOverview) -> Result<(), c::ReadError> {
        c::check_overview(&overview)?;
        self.now = self.now.max(overview.observed_at);
        self.overview = Some(overview);
        self.freshness = (FreshnessState::Live, String::new());
        self.changed();
        Ok(())
    }

    /// Marks the read as no longer live, keeping it on screen: `state` is
    /// stale, offline or unreadable, with `reason` in a few words.
    pub fn lose_read(&mut self, state: FreshnessState, reason: &str) {
        self.freshness = (state, reason.to_owned());
        self.changed();
    }

    /// Moves the clock to `now` (epoch ms). Ages and expiry follow it.
    pub fn set_now(&mut self, now: u64) {
        self.now = now;
        self.changed();
    }

    /// The overview of mission `id`, or None when it is not in the read.
    pub fn mission(&self, id: &str) -> Option<MissionPage> {
        let overview = self.overview.as_ref()?;
        let mut page = project::page(
            &Inputs {
                overview,
                details: &self.details,
                decisions: &self.today.decisions,
                local: &self.local,
                live: self.live(),
                now: self.now,
            },
            id,
            self.today.freshness.clone(),
        )?;
        page.can_replan &= self.native_replanning;
        Some(page)
    }

    /// The read model.
    pub fn today(&self) -> &Today {
        &self.today
    }

    /// Empty native projection. No fixture decisions or fabricated authority.
    pub(crate) fn native() -> Self {
        let mut desk = Self::new(Scenario::Unreadable);
        desk.native = true;
        desk.native_controls = false;
        desk.native_replanning = false;
        desk.today = Today::default();
        desk.overview = None;
        desk.details.clear();
        desk.now = 0;
        desk.lose_read(FreshnessState::Unreadable, "No daemon read yet.");
        desk
    }

    /// Replace exact details only after the native host checks their source.
    pub(crate) fn native_read(&mut self, overview: DayOverview, details: Vec<MissionDetail>) {
        self.details = details;
        self.apply_overview(overview)
            .expect("host checked overview");
    }

    /// Native reads used only for a fresh, host-qualified control intent.
    pub(crate) fn native_overview(&self) -> Option<&DayOverview> {
        self.overview.as_ref()
    }

    pub(crate) fn native_capability(&mut self, allowed: bool) {
        self.native_controls = allowed;
    }

    pub(crate) fn native_replanning(&mut self, allowed: bool) {
        self.native_replanning = allowed;
    }

    /// The mock service's Stop re-planning: the open link becomes
    /// abandoned, on both missions' rows. Nothing else changes.
    pub fn stop_replanning(&mut self, intent: &StopReplanningIntent) -> IntentOutcome {
        let Some(overview) = self.overview.as_mut() else {
            return self.outcome(OutcomeStatus::Rejected, "Nothing was read yet.");
        };
        let missions = &mut overview.dashboard.missions.items;
        let open = missions.iter().any(|m| {
            m.id == intent.mission_id
                && m.successor
                    .as_ref()
                    .is_some_and(|l| l.open() && l.mission_id == intent.successor_id)
        });
        if !open {
            return self.outcome(
                OutcomeStatus::Stale,
                "Re-planning changed since you looked. Nothing was stopped.",
            );
        }
        for m in missions.iter_mut() {
            let id = m.id.clone();
            for link in [m.successor.as_mut(), m.replaces.as_mut()]
                .into_iter()
                .flatten()
            {
                if (id == intent.mission_id && link.mission_id == intent.successor_id)
                    || (id == intent.successor_id && link.mission_id == intent.mission_id)
                {
                    link.state = "abandoned".into();
                }
            }
        }
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// The mock service's archive and reopen: an archived mission leaves the
    /// overview and Reopen brings it back. Nothing else changes. Missions in
    /// [`fixture::ARCHIVE_REFUSED`] are refused with the service's words.
    pub fn lifecycle(
        &mut self,
        intent: &LifecycleIntent,
        action: LifecycleAction,
    ) -> IntentOutcome {
        let id = intent.mission_id.as_str();
        let Some(overview) = self.overview.as_mut() else {
            return self.outcome(OutcomeStatus::Rejected, "Nothing was read yet.");
        };
        let listed = overview
            .dashboard
            .missions
            .items
            .iter()
            .position(|m| m.id == id);
        let archived = self.archived.iter().position(|m| m.id == id);
        let status = match (listed, archived) {
            (Some(_), _) => "active",
            (None, Some(_)) => "archived",
            (None, None) => return self.outcome(OutcomeStatus::Rejected, "That mission is gone."),
        };
        if intent.check {
            return if status == action.target() {
                self.outcome(OutcomeStatus::Accepted, "")
            } else {
                self.outcome(
                    OutcomeStatus::Rejected,
                    "It did not change. Nothing was sent again.",
                )
            };
        }
        if status != action.expected() {
            return self.outcome(
                OutcomeStatus::Rejected,
                "The confirmed mission has changed; review it again",
            );
        }
        if action == LifecycleAction::Archive && fixture::ARCHIVE_REFUSED.contains(&id) {
            return self.outcome(
                OutcomeStatus::Rejected,
                "A chat archive is already in progress. Wait and review the mission again",
            );
        }
        let missions = &mut overview.dashboard.missions;
        match (action, listed, archived) {
            (LifecycleAction::Archive, Some(i), _) => {
                self.archived.push(missions.items.remove(i));
                missions.total -= 1;
            }
            (LifecycleAction::Reopen, _, Some(i)) => {
                missions.items.push(self.archived.remove(i));
                missions.total += 1;
            }
            _ => {}
        }
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// The mock service's rename: the title changes on Today and the page.
    /// Nothing else changes. Missions in [`fixture::RENAME_LOST`] change but
    /// their answer is lost; Check only reads the title.
    pub fn rename(&mut self, intent: &RenameIntent) -> IntentOutcome {
        let title = match crate::model::mission_title(&intent.title) {
            Ok(title) => title.to_owned(),
            Err(message) => return self.outcome(OutcomeStatus::Rejected, message),
        };
        let id = intent.mission_id.as_str();
        let Some(overview) = self.overview.as_mut() else {
            return self.outcome(OutcomeStatus::Rejected, "Nothing was read yet.");
        };
        let Some(mission) = overview
            .dashboard
            .missions
            .items
            .iter_mut()
            .find(|m| m.id == id)
        else {
            return self.outcome(OutcomeStatus::Rejected, "That mission is gone.");
        };
        if intent.check {
            return if mission.title == title {
                self.outcome(OutcomeStatus::Accepted, "")
            } else {
                self.outcome(
                    OutcomeStatus::Rejected,
                    "Not renamed: the mission keeps its title. Nothing was sent again.",
                )
            };
        }
        mission.title = title.clone();
        for detail in self.details.iter_mut().filter(|d| d.mission.id == id) {
            detail.mission.title = title.clone();
        }
        self.changed();
        if fixture::RENAME_LOST.contains(&id) {
            return self.outcome(
                OutcomeStatus::Unknown,
                "The answer was lost, so the new title is not confirmed. Check reads the mission again; nothing is sent again.",
            );
        }
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Restore or show one exact journaled operation. Never sends it.
    pub(crate) fn native_pending(
        &mut self,
        mission: &str,
        command: &ControlCommand,
        delivery: Delivery,
    ) {
        let local = self.local_mut(mission);
        local.delivery = delivery;
        local.asked = Some(match command.action {
            ControlAction::Pause => ControlAsk::Pause,
            ControlAction::Resume => ControlAsk::Resume,
        });
        local.command = Some(command.clone());
        self.changed();
    }

    /// An acknowledged exact receipt can settle delivery, not an overview/WS.
    pub(crate) fn native_receipt(&mut self, receipt: ControlOperation) -> IntentOutcome {
        if receipt.state == OperationState::Acknowledged {
            return self.apply_receipt(receipt);
        }
        let mission = receipt.mission_id.clone();
        self.native_pending(&mission, &receipt.command, Delivery::Unknown);
        self.local_mut(&mission).receipt = Some(receipt);
        self.changed();
        self.outcome(
            OutcomeStatus::Unknown,
            "This operation has not been acknowledged. Check only; do not resend.",
        )
    }

    pub(crate) fn native_cancel(&mut self, mission: &str) {
        let local = self.local_mut(mission);
        local.delivery = Delivery::Idle;
        local.command = None;
        local.asked = None;
        self.changed();
    }

    pub(crate) fn native_outcome(&self, status: OutcomeStatus, message: &str) -> IntentOutcome {
        self.outcome(status, message)
    }

    fn outcome(&self, status: OutcomeStatus, message: &str) -> IntentOutcome {
        IntentOutcome {
            status,
            revision: self.today.revision,
            message: message.to_owned(),
        }
    }

    fn changed(&mut self) {
        self.today.revision += 1;
        self.project();
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.today.decisions.iter().position(|d| d.id == id)
    }

    /// The decision `id` at `revision`, or why the intent cannot use it.
    fn current(&self, id: &str, revision: u32) -> Result<usize, IntentOutcome> {
        let Some(at) = self.position(id) else {
            return Err(self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting."));
        };
        if self.today.decisions[at].revision != revision {
            return Err(self.outcome(
                OutcomeStatus::Stale,
                "This decision changed. Read it again before you answer.",
            ));
        }
        Ok(at)
    }

    fn touch(&mut self, at: usize) -> &mut Decision {
        self.today.revision += 1;
        let decision = &mut self.today.decisions[at];
        decision.revision += 1;
        decision
    }

    /// Checks a decide intent and marks the decision as sending.
    pub fn begin_decide(&mut self, intent: &DecideIntent) -> Result<Started, IntentOutcome> {
        if self.native {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Decision transport is unavailable.",
            ));
        }
        let at = self.current(&intent.decision_id, intent.revision)?;
        let decision = &self.today.decisions[at];
        match decision.delivery {
            Delivery::Idle => {}
            Delivery::Sending => {
                return Err(self.outcome(
                    OutcomeStatus::Rejected,
                    "Your answer is already on its way.",
                ));
            }
            Delivery::Unknown | Delivery::Checking => {
                return Err(self.outcome(
                    OutcomeStatus::Rejected,
                    "Pilot must check the earlier outcome first. It never sends twice without checking.",
                ));
            }
        }
        if decision.kind == DecisionKind::Unknown {
            return Err(self.outcome(OutcomeStatus::Rejected, "Only a check can settle this."));
        }
        if !decision.options.iter().any(|o| o.id == intent.option_id) {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "That answer is not one of the options.",
            ));
        }
        let ack = self
            .acks
            .iter()
            .find(|(id, _)| *id == intent.decision_id)
            .map_or(Ack::Confirm, |(_, ack)| *ack);
        let decision = self.touch(at);
        decision.delivery = Delivery::Sending;
        decision.sent_option = Some(intent.option_id.clone());
        self.project();
        Ok(Started {
            decision_id: intent.decision_id.clone(),
            ack,
        })
    }

    /// Applies the coordinator's answer to a started decide intent.
    pub fn settle_decide(&mut self, started: &Started) -> IntentOutcome {
        let Some(at) = self.position(&started.decision_id) else {
            return self.outcome(
                OutcomeStatus::Unknown,
                "The decision went away while your answer was sent.",
            );
        };
        match started.ack {
            Ack::Confirm => {
                let decision = self.today.decisions.remove(at);
                let label = decision
                    .sent_option
                    .as_deref()
                    .and_then(|id| decision.options.iter().find(|o| o.id == id))
                    .map_or("your answer", |o| o.label.as_str())
                    .to_owned();
                self.today.notes.push(format!(
                    "{} has your answer: {label}.",
                    decision.mission_title
                ));
                self.coordinator_reports(&decision.mission_id, "Back on it after your answer.");
                self.changed();
                self.outcome(OutcomeStatus::Accepted, "")
            }
            Ack::Lose => {
                let decision = self.touch(at);
                decision.delivery = Delivery::Unknown;
                self.project();
                self.outcome(
                    OutcomeStatus::Unknown,
                    "Pilot sent your answer but heard nothing back. It will check before it sends anything again.",
                )
            }
        }
    }

    /// Moves a waiting decision to the end of the queue, for later today.
    /// Putting it off does not answer it.
    pub fn later(&mut self, intent: &DecisionRef) -> IntentOutcome {
        let at = match self.current(&intent.decision_id, intent.revision) {
            Ok(at) => at,
            Err(outcome) => return outcome,
        };
        if self.today.decisions[at].delivery != Delivery::Idle {
            return self.outcome(
                OutcomeStatus::Rejected,
                "This decision is waiting on a send or a check.",
            );
        }
        if self.today.decisions.len() < 2 {
            return self.outcome(OutcomeStatus::Rejected, "Nothing else is waiting.");
        }
        let decision = self.today.decisions.remove(at);
        self.today.decisions.push(decision);
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Checks a check intent and marks the decision as checking.
    pub fn begin_check(&mut self, intent: &DecisionRef) -> Result<Started, IntentOutcome> {
        let at = self.current(&intent.decision_id, intent.revision)?;
        if self.today.decisions[at].delivery != Delivery::Unknown {
            return Err(self.outcome(OutcomeStatus::Rejected, "There is nothing to check."));
        }
        let decision = self.touch(at);
        decision.delivery = Delivery::Checking;
        self.project();
        Ok(Started {
            decision_id: intent.decision_id.clone(),
            ack: Ack::Confirm,
        })
    }

    /// Applies what the check read. The mock check always finds that the
    /// earlier send or push landed.
    pub fn settle_check(&mut self, started: &Started) -> IntentOutcome {
        let Some(at) = self.position(&started.decision_id) else {
            return self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting.");
        };
        let decision = self.today.decisions.remove(at);
        let what = if decision.kind == DecisionKind::Unknown {
            "It landed"
        } else {
            "Your answer arrived"
        };
        self.today
            .notes
            .push(format!("Checked {}: {what}.", decision.mission_title));
        self.coordinator_reports(&decision.mission_id, "Confirmed. Back on it.");
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Checks a question against the decision's revision and shows it as
    /// asking. Help is not an answer: the decision, its revision and its
    /// delivery stay as they are. Returns the question's id.
    pub fn begin_ask(&mut self, intent: &AskIntent) -> Result<String, IntentOutcome> {
        let at = self.current(&intent.decision_id, intent.revision)?;
        let question = intent.question.trim();
        if question.is_empty() {
            return Err(self.outcome(OutcomeStatus::Rejected, "Write a question first."));
        }
        if question.chars().count() > QUESTION_LIMIT {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Keep the question under 500 characters.",
            ));
        }
        self.next_answer += 1;
        let id = format!("question-{}", self.next_answer);
        self.asked_at.push((id.clone(), intent.revision));
        self.today.decisions[at].answers.push(Answer {
            id: id.clone(),
            question: intent.question.clone(),
            ..Answer::default()
        });
        self.changed();
        Ok(id)
    }

    fn answer_mut(&mut self, decision_id: &str, answer_id: &str) -> Option<&mut Answer> {
        let at = self.position(decision_id)?;
        self.today.decisions[at]
            .answers
            .iter_mut()
            .find(|a| a.id == answer_id)
    }

    /// Marks an answer ready, and whether its decision changed since the
    /// question was asked.
    fn answered(&mut self, decision_id: &str, answer_id: &str, text: String) {
        let asked = self
            .asked_at
            .iter()
            .find(|(id, _)| id == answer_id)
            .map(|(_, revision)| *revision);
        let now = self
            .position(decision_id)
            .map(|at| self.today.decisions[at].revision);
        if let Some(answer) = self.answer_mut(decision_id, answer_id) {
            answer.answer = text;
            answer.state = AnswerState::Ready;
            answer.earlier = asked != now;
        }
    }

    /// Adds Pilot's answer to the question asked as `answer_id`. The
    /// question is kept exactly as written. The mock help service saves
    /// every answer; a lost one stays unknown until a check reads it.
    pub fn settle_ask(&mut self, decision_id: &str, answer_id: &str) -> IntentOutcome {
        if self.position(decision_id).is_none() {
            return self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting.");
        }
        let answer = self
            .answers
            .iter()
            .find(|(id, _)| id == decision_id)
            .map_or("Pilot will answer from the mission's history.", |(_, a)| {
                a.as_str()
            })
            .to_owned();
        self.saved_answers
            .push((answer_id.to_owned(), answer.clone()));
        if let Some(lost) = self.lost_answers.iter().position(|id| id == decision_id) {
            self.lost_answers.remove(lost);
            if let Some(a) = self.answer_mut(decision_id, answer_id) {
                a.state = AnswerState::Unknown;
            }
            self.changed();
            return self.outcome(
                OutcomeStatus::Unknown,
                "Pilot asked, but no answer came back. It will check before it asks again.",
            );
        }
        self.answered(decision_id, answer_id, answer);
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Starts a read-only check of a question whose answer was lost.
    pub fn begin_check_answer(&mut self, intent: &AnswerRef) -> Result<(), IntentOutcome> {
        let Some(answer) = self.answer_mut(&intent.decision_id, &intent.answer_id) else {
            return Err(self.outcome(OutcomeStatus::Stale, "This question is no longer here."));
        };
        if answer.state != AnswerState::Unknown {
            return Err(self.outcome(OutcomeStatus::Rejected, "There is nothing to check."));
        }
        answer.state = AnswerState::Checking;
        self.changed();
        Ok(())
    }

    /// Reads the saved answer, if any. Never asks again.
    pub fn settle_check_answer(&mut self, intent: &AnswerRef) -> IntentOutcome {
        let saved = self
            .saved_answers
            .iter()
            .find(|(id, _)| *id == intent.answer_id)
            .map(|(_, a)| a.clone());
        match saved {
            Some(answer) => {
                self.answered(&intent.decision_id, &intent.answer_id, answer);
                self.changed();
                self.outcome(OutcomeStatus::Accepted, "")
            }
            None => {
                if let Some(a) = self.answer_mut(&intent.decision_id, &intent.answer_id) {
                    a.state = AnswerState::Unknown;
                }
                self.changed();
                self.outcome(
                    OutcomeStatus::Unknown,
                    "Pilot found no saved answer yet. It did not ask again.",
                )
            }
        }
    }

    /// The mock coordinator reports its mission moving again, as a real
    /// coordinator would after an answer. Movement only ever comes from a
    /// report; answering a decision alone moves nothing.
    fn coordinator_reports(&mut self, mission_id: &str, summary: &str) {
        let now = self.now;
        let Some(overview) = self.overview.as_mut() else {
            return;
        };
        let mut view: ReportView = fixture::report(&fixture::ReportSpec {
            mission: mission_id,
            task: &format!("{mission_id}-coordination"),
            by: &format!("c-{mission_id}"),
            minutes_ago: 0,
            movement: c::Movement::Moving,
            currentness: c::Currentness::Current,
            summary,
            next: "Go on within the agreement.",
            evidence: &[],
        });
        view.report.reported_at = now;
        overview.reports.push(view);
    }

    fn local(&self, mission_id: &str) -> Option<&ControlLocal> {
        self.local
            .iter()
            .find(|(id, _)| id == mission_id)
            .map(|(_, local)| local)
    }

    fn local_mut(&mut self, mission_id: &str) -> &mut ControlLocal {
        let at = match self.local.iter().position(|(id, _)| id == mission_id) {
            Some(at) => at,
            None => {
                self.local
                    .push((mission_id.to_owned(), ControlLocal::default()));
                self.local.len() - 1
            }
        };
        &mut self.local[at].1
    }

    /// Checks a Pause or Resume against the read the screen showed, then
    /// records its command before anything is sent.
    fn begin_control(
        &mut self,
        mission_id: &str,
        revision: u32,
        ask: ControlAsk,
        pause_operation_id: Option<&str>,
    ) -> Result<StartedControl, IntentOutcome> {
        if self.native {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Native controls require the authenticated host.",
            ));
        }
        if !self.live() {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Pilot needs a fresh read before it can pause or resume. Nothing was sent.",
            ));
        }
        let overview = self.overview.as_ref().expect("a live read");
        let Some(mission) = overview
            .dashboard
            .missions
            .items
            .iter()
            .find(|m| m.id == mission_id)
        else {
            return Err(self.outcome(OutcomeStatus::Stale, "This mission is no longer active."));
        };
        match self
            .local(mission_id)
            .map_or(Delivery::Idle, |l| l.delivery)
        {
            Delivery::Idle => {}
            Delivery::Sending => {
                return Err(
                    self.outcome(OutcomeStatus::Rejected, "A request is already on its way.")
                );
            }
            Delivery::Unknown | Delivery::Checking => {
                return Err(self.outcome(
                    OutcomeStatus::Rejected,
                    "Pilot must check the earlier request first. It never sends twice without checking.",
                ));
            }
        }
        let Some(control) = overview
            .controls
            .iter()
            .find(|c| c.mission_id == mission_id)
        else {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Pilot cannot read this mission's controls. Nothing was sent.",
            ));
        };
        if control.revision != u64::from(revision) {
            return Err(self.outcome(
                OutcomeStatus::Stale,
                "This mission's controls changed. Read them again.",
            ));
        }
        match ask {
            ControlAsk::Pause if control.state != c::ControlState::Running || control.held => {
                return Err(self.outcome(OutcomeStatus::Rejected, "This mission is not running."));
            }
            ControlAsk::Resume
                if control.state != c::ControlState::Paused
                    || control.pause_operation_id.as_deref() != pause_operation_id =>
            {
                return Err(self.outcome(
                    OutcomeStatus::Stale,
                    "Only the Pause shown can be resumed. Read the mission again.",
                ));
            }
            _ => {}
        }
        self.next_operation += 1;
        let command = ControlCommand {
            version: 1,
            // Production uses a random UUID, saved durably before the send.
            operation_id: format!("op-{mission_id}-{}", self.next_operation),
            home: fixture::home(),
            project_id: overview.project_id.clone(),
            coordinator_session_id: mission.coordinator_session_id.clone(),
            expected_revision: control.revision,
            action: match ask {
                ControlAsk::Pause => ControlAction::Pause,
                ControlAsk::Resume => ControlAction::Resume,
            },
            pause_operation_id: pause_operation_id.map(str::to_owned),
        };
        let ack = self
            .control_acks
            .iter()
            .find(|(id, _)| id == mission_id)
            .map_or(ControlAck::Acknowledge, |(_, ack)| *ack);
        let started = StartedControl {
            mission_id: mission_id.to_owned(),
            operation_id: command.operation_id.clone(),
            ack,
        };
        let local = self.local_mut(mission_id);
        local.delivery = Delivery::Sending;
        local.asked = Some(ask);
        local.command = Some(command);
        self.changed();
        Ok(started)
    }

    /// Checks a Pause intent and records its command.
    pub fn begin_pause(&mut self, intent: &PauseIntent) -> Result<StartedControl, IntentOutcome> {
        self.begin_control(&intent.mission_id, intent.revision, ControlAsk::Pause, None)
    }

    /// Checks a Resume intent and records its command. Only the Pause the
    /// screen showed may resume.
    pub fn begin_resume(&mut self, intent: &ResumeIntent) -> Result<StartedControl, IntentOutcome> {
        self.begin_control(
            &intent.mission_id,
            intent.revision,
            ControlAsk::Resume,
            Some(&intent.pause_operation_id),
        )
    }

    /// The mock daemon runs a command once and saves its receipt, the way
    /// the real one answers `POST /api/missions/:id/controls`.
    fn daemon_execute(
        &mut self,
        command: &ControlCommand,
        mission_id: &str,
        ack: ControlAck,
    ) -> ControlOperation {
        let overview = self.overview.as_ref().expect("a read");
        let prior = overview
            .controls
            .iter()
            .find(|c| c.mission_id == mission_id)
            .cloned()
            .expect("a control");
        let mut sessions: Vec<String> = Vec::new();
        let mut add = |id: &str| {
            if !sessions.iter().any(|s| s == id) {
                sessions.push(id.to_owned());
            }
        };
        let working: Vec<&str> = overview
            .dashboard
            .working
            .items
            .iter()
            .filter(|w| w.mission_id.as_deref() == Some(mission_id))
            .map(|w| w.session_id.as_str())
            .collect();
        if let Some(coordinator) = overview
            .dashboard
            .missions
            .items
            .iter()
            .find(|m| m.id == mission_id)
            .and_then(|m| m.coordinator_session_id.as_deref())
        {
            add(coordinator);
        }
        for id in &working {
            add(id);
        }
        for task in self
            .details
            .iter()
            .filter(|d| d.mission.id == mission_id)
            .flat_map(|d| d.tasks.iter())
        {
            if let Some(id) = task.session_id.as_deref() {
                add(id);
            }
        }
        let pause = command.action == ControlAction::Pause;
        let inspect = ack == ControlAck::Inspect;
        let mut flagged = false;
        let members = sessions
            .into_iter()
            .map(|session_id| {
                let busy = working.contains(&session_id.as_str());
                let (state, reason) = if inspect && busy && !flagged {
                    flagged = true;
                    (
                        c::MemberState::Unknown,
                        Some("The chat did not confirm its checkpoint.".to_owned()),
                    )
                } else if !busy {
                    (c::MemberState::Held, None)
                } else if pause {
                    (c::MemberState::Paused, None)
                } else {
                    (c::MemberState::Resumed, None)
                };
                ControlMember {
                    session_id,
                    state,
                    reason,
                }
            })
            .collect();
        let acknowledged = !inspect;
        let control = c::Control {
            revision: prior.revision + 2,
            pause_generation: prior.pause_generation + u64::from(pause),
            held: pause || !acknowledged,
            state: match (pause, acknowledged) {
                (true, true) => c::ControlState::Paused,
                (true, false) => c::ControlState::Pausing,
                (false, true) => c::ControlState::Running,
                (false, false) => c::ControlState::Unknown,
            },
            operation_id: Some(command.operation_id.clone()),
            pause_operation_id: if pause {
                Some(command.operation_id.clone())
            } else {
                command.pause_operation_id.clone()
            },
            ..prior
        };
        let receipt = ControlOperation {
            version: 1,
            mission_id: mission_id.to_owned(),
            command: command.clone(),
            control,
            members,
            issues: Vec::new(),
            state: if acknowledged {
                OperationState::Acknowledged
            } else {
                OperationState::Unknown
            },
        };
        self.daemon_ops.push(receipt.clone());
        receipt
    }

    /// Takes a receipt: the control it reports replaces the read's, and the
    /// user's request is settled.
    fn apply_receipt(&mut self, receipt: ControlOperation) -> IntentOutcome {
        let needs_look = receipt.state != OperationState::Acknowledged;
        if let Some(overview) = self.overview.as_mut()
            && let Some(control) = overview
                .controls
                .iter_mut()
                .find(|c| c.mission_id == receipt.mission_id)
            && receipt.control.revision >= control.revision
        {
            *control = receipt.control.clone();
        }
        let local = self.local_mut(&receipt.mission_id.clone());
        local.delivery = Delivery::Idle;
        local.asked = None;
        local.command = None;
        local.receipt = Some(receipt);
        self.changed();
        if needs_look {
            self.outcome(
                OutcomeStatus::Unknown,
                "It did not finish everywhere. Some work needs a look before anything else is sent.",
            )
        } else {
            self.outcome(OutcomeStatus::Accepted, "")
        }
    }

    /// Applies the mock daemon's answer to a started Pause or Resume.
    pub fn settle_control(&mut self, started: &StartedControl) -> IntentOutcome {
        let Some(command) = self
            .local(&started.mission_id)
            .and_then(|l| l.command.clone())
            .filter(|c| c.operation_id == started.operation_id)
        else {
            return self.outcome(OutcomeStatus::Unknown, "Pilot lost track of this request.");
        };
        let receipt = self.daemon_execute(&command, &started.mission_id, started.ack);
        if started.ack == ControlAck::Lose {
            self.local_mut(&started.mission_id).delivery = Delivery::Unknown;
            self.changed();
            return self.outcome(
                OutcomeStatus::Unknown,
                "Pilot asked but heard nothing back. It will not ask again until it checks.",
            );
        }
        self.apply_receipt(receipt)
    }

    /// Starts a read-only lookup of a request whose answer was lost.
    pub fn begin_check_control(&mut self, intent: &MissionRef) -> Result<String, IntentOutcome> {
        let Some(operation_id) = self
            .local(&intent.mission_id)
            .filter(|l| l.delivery == Delivery::Unknown)
            .and_then(|l| l.command.as_ref())
            .map(|c| c.operation_id.clone())
        else {
            return Err(self.outcome(OutcomeStatus::Rejected, "There is nothing to check."));
        };
        self.local_mut(&intent.mission_id).delivery = Delivery::Checking;
        self.changed();
        Ok(operation_id)
    }

    /// Applies what the lookup read. It never sends the command again.
    pub fn settle_check_control(&mut self, mission_id: &str, operation_id: &str) -> IntentOutcome {
        let found = self
            .daemon_ops
            .iter()
            .find(|op| op.command.operation_id == operation_id)
            .cloned();
        match found {
            Some(receipt) if receipt.state == OperationState::Entered => {
                self.local_mut(mission_id).delivery = Delivery::Unknown;
                self.changed();
                self.outcome(
                    OutcomeStatus::Unknown,
                    "It is still in progress. Check again in a moment.",
                )
            }
            Some(receipt) => self.apply_receipt(receipt),
            None => {
                let local = self.local_mut(mission_id);
                local.delivery = Delivery::Idle;
                local.asked = None;
                local.command = None;
                self.changed();
                self.outcome(
                    OutcomeStatus::Accepted,
                    "Pilot found no record of that request. Nothing changed.",
                )
            }
        }
    }

    /// One step of the update workload, the same for both Today screens:
    /// the next moving mission (in turn) moves one task on and its agent's
    /// newest report says so, and every fourth step adds a result at the
    /// top. Decisions do not change, so a pulse never races an intent.
    /// Returns the step's number.
    pub fn pulse(&mut self) -> u32 {
        self.pulses += 1;
        let step = self.pulses;
        let rows = if self.today.moving.is_empty() {
            &self.today.not_moving
        } else {
            &self.today.moving
        };
        if let (Some(overview), false) = (self.overview.as_mut(), rows.is_empty()) {
            let row = &rows[(step as usize - 1) % rows.len()];
            let (id, title) = (row.id.clone(), row.title.clone());
            if let Some(m) = overview
                .dashboard
                .missions
                .items
                .iter_mut()
                .find(|m| m.id == id)
            {
                let counted =
                    m.tasks_done + m.tasks_in_review + m.tasks_in_progress + m.tasks_blocked;
                if m.tasks_total > counted {
                    m.tasks_in_progress += 1;
                } else if m.tasks_in_progress > 0 {
                    m.tasks_in_progress -= 1;
                    m.tasks_done += 1;
                } else {
                    m.tasks_done = 0;
                }
            }
            if let Some(view) = overview
                .reports
                .iter_mut()
                .filter(|v| v.report.mission_id == id)
                .max_by_key(|v| v.report.reported_at)
            {
                view.report.write.summary = format!("Working on update {step}.");
                view.report.reported_at = self.now;
                view.currentness = c::Currentness::Current;
            }
            if step.is_multiple_of(4) {
                let entry = DoneEntry {
                    id: format!("pulse-{step}"),
                    text: format!("Update {step} landed with its checks."),
                    mission_title: title,
                    evidence: vec![Evidence {
                        label: format!("{step:07x}"),
                        tone: Tone::Neutral,
                    }],
                    basis: crate::model::DoneBasis::Reported,
                };
                self.today.done.insert(0, entry);
                limit_done(&mut self.today);
            }
        }
        self.changed();
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(id: &str, revision: u32, option: &str) -> DecideIntent {
        DecideIntent {
            decision_id: id.into(),
            revision,
            option_id: option.into(),
        }
    }

    #[test]
    fn a_confirmed_answer_removes_the_decision_and_moves_the_mission() {
        let mut desk = Desk::new(Scenario::Decisions);
        let started = desk.begin_decide(&decide("q1", 1, "a")).unwrap();
        let q1 = &desk.today().decisions[0];
        assert_eq!((q1.delivery, q1.revision), (Delivery::Sending, 2));
        let outcome = desk.settle_decide(&started);
        assert_eq!(outcome.status, OutcomeStatus::Accepted);
        assert!(desk.today().decisions.iter().all(|d| d.id != "q1"));
        assert!(desk.today().moving.iter().any(|m| m.id == "notify"));
        assert_eq!(
            desk.today().notes,
            ["Quieter notifications has your answer: One summary at 18:00."]
        );
    }

    #[test]
    fn a_stale_or_repeated_answer_changes_nothing() {
        let mut desk = Desk::new(Scenario::Decisions);
        let before = desk.today().clone();
        let stale = desk.begin_decide(&decide("q1", 7, "a")).unwrap_err();
        assert_eq!(stale.status, OutcomeStatus::Stale);
        let wrong = desk.begin_decide(&decide("q1", 1, "z")).unwrap_err();
        assert_eq!(wrong.status, OutcomeStatus::Rejected);
        assert_eq!(desk.today(), &before);
        desk.begin_decide(&decide("q1", 1, "a")).unwrap();
        let twice = desk.begin_decide(&decide("q1", 2, "a")).unwrap_err();
        assert_eq!(twice.status, OutcomeStatus::Rejected);
    }

    #[test]
    fn a_lost_confirmation_stays_unknown_until_a_check() {
        let mut desk = Desk::new(Scenario::Trouble);
        let started = desk.begin_decide(&decide("f1", 1, "a")).unwrap();
        let outcome = desk.settle_decide(&started);
        assert_eq!(outcome.status, OutcomeStatus::Unknown);
        let f1 = desk.today().decisions[0].clone();
        assert_eq!(
            (f1.delivery, f1.sent_option.as_deref()),
            (Delivery::Unknown, Some("a"))
        );
        // No resend, not even of the same answer.
        let again = desk
            .begin_decide(&decide("f1", f1.revision, "a"))
            .unwrap_err();
        assert_eq!(again.status, OutcomeStatus::Rejected);
        let check = desk
            .begin_check(&DecisionRef {
                decision_id: "f1".into(),
                revision: f1.revision,
            })
            .unwrap();
        assert_eq!(desk.settle_check(&check).status, OutcomeStatus::Accepted);
        assert!(desk.today().decisions.iter().all(|d| d.id != "f1"));
    }

    #[test]
    fn later_reorders_without_answering() {
        let mut desk = Desk::new(Scenario::Decisions);
        let outcome = desk.later(&DecisionRef {
            decision_id: "q1".into(),
            revision: 1,
        });
        assert_eq!(outcome.status, OutcomeStatus::Accepted);
        let ids: Vec<_> = desk
            .today()
            .decisions
            .iter()
            .map(|d| d.id.as_str())
            .collect();
        assert_eq!(ids, ["q2", "r1", "q1"]);
        assert!(desk.today().notes.is_empty());
    }

    #[test]
    fn questions_keep_their_exact_text() {
        let mut desk = Desk::new(Scenario::Decisions);
        let ask = AskIntent {
            decision_id: "q2".into(),
            revision: 1,
            question: "  Does it touch my data?\nReally? ".into(),
        };
        let id = desk.begin_ask(&ask).unwrap();
        assert_eq!(
            desk.today().decisions[1].answers[0].state,
            AnswerState::Asking
        );
        desk.settle_ask("q2", &id);
        assert_eq!(desk.today().decisions[1].answers[0].question, ask.question);
        let empty = AskIntent {
            decision_id: "q2".into(),
            revision: 1,
            question: " \n ".into(),
        };
        assert_eq!(
            desk.begin_ask(&empty).unwrap_err().status,
            OutcomeStatus::Rejected
        );
    }

    #[test]
    fn help_never_answers_or_changes_the_decision() {
        let mut desk = Desk::new(Scenario::Decisions);
        let before = desk.today().decisions[0].clone();
        let ask = AskIntent {
            decision_id: "q1".into(),
            revision: before.revision,
            question: "Just pick the best one?".into(),
        };
        let id = desk.begin_ask(&ask).unwrap();
        desk.settle_ask("q1", &id);
        let after = &desk.today().decisions[0];
        assert_eq!(after.id, "q1");
        assert_eq!(
            (after.revision, after.delivery, after.sent_option.clone()),
            (before.revision, Delivery::Idle, None)
        );
        assert_eq!(after.answers[0].state, AnswerState::Ready);
        assert!(!after.answers[0].earlier);
        assert!(desk.today().notes.is_empty());
        assert!(
            desk.today()
                .notes
                .iter()
                .all(|n| !n.contains("has your answer"))
        );
    }

    #[test]
    fn a_question_names_the_revision_and_a_changed_decision_marks_its_answer() {
        let mut desk = Desk::new(Scenario::Trouble);
        let stale = AskIntent {
            decision_id: "f1".into(),
            revision: 4,
            question: "Why?".into(),
        };
        assert_eq!(
            desk.begin_ask(&stale).unwrap_err().status,
            OutcomeStatus::Stale
        );
        let ask = AskIntent {
            revision: 1,
            ..stale
        };
        let id = desk.begin_ask(&ask).unwrap();
        // The user answers the decision while the question is out.
        desk.begin_decide(&decide("f1", 1, "a")).unwrap();
        desk.settle_ask("f1", &id);
        let answer = &desk.today().decisions[0].answers[0];
        assert_eq!((answer.state, answer.earlier), (AnswerState::Ready, true));
    }

    #[test]
    fn a_lost_answer_stays_unknown_and_a_check_only_reads_it() {
        let mut desk = Desk::new(Scenario::Trouble);
        let ask = AskIntent {
            decision_id: "u1".into(),
            revision: desk.today().decisions[1].revision,
            question: "What if it did not land?".into(),
        };
        let id = desk.begin_ask(&ask).unwrap();
        let lost = desk.settle_ask("u1", &id);
        assert_eq!(lost.status, OutcomeStatus::Unknown);
        let answer = &desk.today().decisions[1].answers[0];
        assert_eq!(
            (answer.state, answer.answer.as_str()),
            (AnswerState::Unknown, "")
        );
        let saved = desk.saved_answers.len();
        let check = AnswerRef {
            decision_id: "u1".into(),
            answer_id: id,
        };
        desk.begin_check_answer(&check).unwrap();
        assert_eq!(
            desk.settle_check_answer(&check).status,
            OutcomeStatus::Accepted
        );
        assert_eq!(
            desk.saved_answers.len(),
            saved,
            "the check asked nothing again"
        );
        assert_eq!(
            desk.today().decisions[1].answers[0].state,
            AnswerState::Ready
        );
        assert_eq!(desk.today().decisions[1].answers.len(), 1);
    }

    #[test]
    fn large_worlds_keep_today_limited() {
        let desk = Desk::new(Scenario::Large);
        assert_eq!(desk.today().done.len(), DONE_LIMIT);
        assert_eq!(desk.today().done_hidden, 103);
        let today = desk.today();
        assert_eq!(
            today.moving.len() + today.not_moving.len() + today.unreported.len(),
            204
        );
    }

    #[test]
    fn pulses_change_missions_and_results_but_never_decisions() {
        let mut desk = Desk::new(Scenario::Large);
        let before = desk.today().clone();
        let total = |p: &crate::model::Progress| p.done + p.review + p.active + p.blocked + p.todo;
        for _ in 0..8 {
            desk.pulse();
        }
        let after = desk.today();
        assert_eq!(after.revision, before.revision + 8);
        assert_eq!(after.decisions, before.decisions);
        assert_eq!(after.done.len(), DONE_LIMIT);
        assert_eq!(after.done_hidden, before.done_hidden + 2);
        assert_eq!(after.done[0].id, "pulse-8");
        assert_eq!(after.moving[7].line, "Working on update 8.");
        for (a, b) in after.moving.iter().zip(&before.moving) {
            assert_eq!(total(&a.progress), total(&b.progress));
        }
        // The same steps give the same model: both screens see one workload.
        let mut again = Desk::new(Scenario::Large);
        for _ in 0..8 {
            again.pulse();
        }
        assert_eq!(again.today(), after);
    }

    fn ids(rows: &[crate::model::MissionRow]) -> Vec<&str> {
        rows.iter().map(|r| r.id.as_str()).collect()
    }

    fn row<'a>(desk: &'a Desk, id: &str) -> &'a crate::model::MissionRow {
        let t = desk.today();
        t.moving
            .iter()
            .chain(&t.not_moving)
            .chain(&t.unreported)
            .find(|r| r.id == id)
            .unwrap()
    }

    fn pause(desk: &Desk, id: &str) -> PauseIntent {
        PauseIntent {
            mission_id: id.into(),
            revision: row(desk, id).control.revision,
        }
    }

    #[test]
    fn missions_move_only_on_current_agent_reports() {
        use crate::model::{Currentness, MissionState};
        let desk = Desk::new(Scenario::Decisions);
        let t = desk.today();
        assert_eq!(ids(&t.moving), ["search"]);
        assert_eq!(ids(&t.not_moving), ["native", "notify"]);
        // Working chats and task counts are not movement, and a missing
        // report is not "not moving".
        assert_eq!(ids(&t.unreported), ["docs"]);
        assert_eq!(row(&desk, "docs").state, MissionState::Unreported);
        assert_eq!(row(&desk, "docs").working, 1);
        let search = row(&desk, "search").report.clone().unwrap();
        assert_eq!(search.age, "12 min ago");
        assert!(!search.by_coordinator);
        assert_eq!(search.evidence, ["7c1e04a", "Benchmark chart"]);
        assert_eq!(row(&desk, "native").state, MissionState::Waiting);

        let quiet = Desk::new(Scenario::Quiet);
        let notify = row(&quiet, "notify");
        assert_eq!(ids(&quiet.today().unreported), ["notify"]);
        assert_eq!(
            notify.report.as_ref().unwrap().currentness,
            Currentness::Unavailable
        );

        let trouble = Desk::new(Scenario::Trouble);
        let notify = row(&trouble, "notify");
        assert_eq!(notify.state, MissionState::Paused);
        assert_eq!(
            notify.report.as_ref().unwrap().currentness,
            Currentness::Stale
        );
        assert_eq!(notify.report.as_ref().unwrap().age, "yesterday");
        assert!(trouble.today().not_moving.iter().any(|r| r.id == "notify"));
        assert_eq!(row(&trouble, "search").state, MissionState::Stuck);
    }

    #[test]
    fn a_pause_is_pausing_until_its_receipt_says_paused() {
        use crate::model::{ControlState, MemberState, MissionState};
        let mut desk = Desk::new(Scenario::Decisions);
        let intent = pause(&desk, "search");
        let started = desk.begin_pause(&intent).unwrap();
        let search = row(&desk, "search");
        assert_eq!(search.state, MissionState::Pausing);
        assert_eq!(search.control.state, ControlState::Running);
        assert!(!search.control.can_pause && !search.control.can_resume);
        assert!(desk.today().not_moving.iter().any(|r| r.id == "search"));
        let command = desk.local("search").unwrap().command.clone().unwrap();
        assert_eq!(command.coordinator_session_id.as_deref(), Some("c-search"));
        assert_eq!(
            (command.expected_revision, command.project_id.as_str()),
            (0, "mock-project")
        );
        assert_eq!(command.home, crate::fixture::home());
        // A second Pause while the first is on its way is refused.
        let again = desk.begin_pause(&intent).unwrap_err();
        assert_eq!(again.status, OutcomeStatus::Rejected);

        assert_eq!(
            desk.settle_control(&started).status,
            OutcomeStatus::Accepted
        );
        let search = row(&desk, "search");
        assert_eq!(search.state, MissionState::Paused);
        assert_eq!(search.control.state, ControlState::Paused);
        assert!(search.control.can_resume && !search.control.needs_look);
        assert_eq!(
            search.control.pause_operation_id.as_deref(),
            Some(started.operation_id.as_str())
        );
        let members: Vec<_> = search
            .control
            .members
            .iter()
            .map(|m| (m.title.as_str(), m.state))
            .collect();
        assert_eq!(
            members,
            [
                ("Coordinator", MemberState::Held),
                ("#3 Integration tests on Linux", MemberState::Paused),
            ]
        );
    }

    #[test]
    fn resume_names_the_exact_pause_and_only_a_report_moves_it_again() {
        use crate::model::MissionState;
        let mut desk = Desk::new(Scenario::Trouble);
        let notify = row(&desk, "notify").control.clone();
        let wrong = desk
            .begin_resume(&ResumeIntent {
                mission_id: "notify".into(),
                revision: notify.revision,
                pause_operation_id: "op-other".into(),
            })
            .unwrap_err();
        assert_eq!(wrong.status, OutcomeStatus::Stale);
        let started = desk
            .begin_resume(&ResumeIntent {
                mission_id: "notify".into(),
                revision: notify.revision,
                pause_operation_id: notify.pause_operation_id.clone().unwrap(),
            })
            .unwrap();
        assert_eq!(row(&desk, "notify").state, MissionState::Resuming);
        let command = desk.local("notify").unwrap().command.clone().unwrap();
        assert_eq!(command.pause_operation_id.as_deref(), Some("op-earlier"));
        assert_eq!(
            desk.settle_control(&started).status,
            OutcomeStatus::Accepted
        );
        // Running again, but its only report is old: not reported, not moving.
        assert_eq!(row(&desk, "notify").state, MissionState::Unreported);
        assert!(desk.today().unreported.iter().any(|r| r.id == "notify"));
    }

    #[test]
    fn a_lost_answer_stays_unknown_and_a_check_only_reads() {
        use crate::model::{ControlState, MissionState};
        let mut desk = Desk::new(Scenario::Trouble);
        let started = desk.begin_pause(&pause(&desk, "release")).unwrap();
        assert_eq!(desk.settle_control(&started).status, OutcomeStatus::Unknown);
        let release = row(&desk, "release");
        assert_eq!(release.state, MissionState::Unconfirmed);
        assert_eq!(release.control.delivery, Delivery::Unknown);
        assert_eq!(
            release.control.state,
            ControlState::Running,
            "no answer, no new state"
        );
        assert!(!release.control.can_pause);
        let refused = desk.begin_pause(&pause(&desk, "release")).unwrap_err();
        assert_eq!(refused.status, OutcomeStatus::Rejected);
        let mission = MissionRef {
            mission_id: "release".into(),
        };
        let operation = desk.begin_check_control(&mission).unwrap();
        assert_eq!(operation, started.operation_id);
        assert_eq!(row(&desk, "release").control.delivery, Delivery::Checking);
        assert_eq!(
            desk.settle_check_control("release", &operation).status,
            OutcomeStatus::Accepted
        );
        assert_eq!(row(&desk, "release").state, MissionState::Paused);
        // The daemon ran the command once; the check only read its receipt.
        assert_eq!(desk.daemon_ops.len(), 1);
        assert_eq!(
            desk.begin_check_control(&mission).unwrap_err().status,
            OutcomeStatus::Rejected
        );
    }

    #[test]
    fn an_unfinished_pause_stays_pausing_and_needs_a_look() {
        use crate::model::{MemberState, MissionState};
        let mut desk = Desk::new(Scenario::Trouble);
        let started = desk.begin_pause(&pause(&desk, "native")).unwrap();
        assert_eq!(desk.settle_control(&started).status, OutcomeStatus::Unknown);
        let native = row(&desk, "native");
        assert_eq!(native.state, MissionState::Pausing);
        assert!(native.control.needs_look && native.control.held);
        assert!(!native.control.can_pause && !native.control.can_resume);
        assert!(
            native
                .control
                .members
                .iter()
                .any(|m| m.state == MemberState::Unknown
                    && m.reason.as_deref() == Some("The chat did not confirm its checkpoint."))
        );
    }

    #[test]
    fn controls_need_a_live_read_and_the_revision_shown() {
        let mut desk = Desk::new(Scenario::Decisions);
        let stale = desk
            .begin_pause(&PauseIntent {
                mission_id: "search".into(),
                revision: 9,
            })
            .unwrap_err();
        assert_eq!(stale.status, OutcomeStatus::Stale);
        desk.lose_read(FreshnessState::Offline, "Pilot's service is not answering.");
        assert!(!row(&desk, "search").control.can_pause);
        let offline = desk.begin_pause(&pause(&desk, "search")).unwrap_err();
        assert_eq!(offline.status, OutcomeStatus::Rejected);
        assert!(
            desk.local("search").is_none(),
            "nothing was recorded or sent"
        );

        let offline = Desk::new(Scenario::Offline);
        assert_eq!(offline.today().freshness.state, FreshnessState::Offline);
        assert_eq!(offline.today().freshness.age, "6 min ago");
        assert_eq!(
            ids(&offline.today().moving),
            ["search"],
            "the last read stays visible"
        );

        let unreadable = Desk::new(Scenario::Unreadable);
        let t = unreadable.today();
        assert_eq!(t.freshness.state, FreshnessState::Unreadable);
        assert!(t.moving.is_empty() && t.not_moving.is_empty() && t.unreported.is_empty());
        assert!(unreadable.mission("search").is_none());
    }

    #[test]
    fn the_mission_page_lists_tasks_reports_and_working_chats() {
        use crate::model::TaskStatus;
        let desk = Desk::new(Scenario::Decisions);
        let page = desk.mission("search").unwrap();
        assert!(page.tasks_known);
        assert_eq!(
            page.goal,
            "Show search results in under 200 ms for large workspaces."
        );
        let tasks: Vec<_> = page
            .tasks
            .iter()
            .map(|t| (t.number, t.status, t.report.is_some()))
            .collect();
        assert_eq!(
            tasks,
            [
                (1, TaskStatus::Done, false),
                (2, TaskStatus::Done, false),
                (3, TaskStatus::InProgress, true),
                (4, TaskStatus::Todo, false),
            ]
        );
        assert_eq!(page.chats.len(), 1);
        assert_eq!(page.chats[0].since, "34 min ago");
        // Every chat the page names can open read only.
        assert_eq!(page.chats[0].id, "w-search");
        assert_eq!(page.coordinator_session_id.as_deref(), Some("c-search"));
        let owners: Vec<_> = page.tasks.iter().map(|t| t.session_id.as_deref()).collect();
        assert_eq!(owners, [None, None, Some("w-search"), None]);
        assert_eq!(page.row.stage, "Verify");
        let notify = desk.mission("notify").unwrap();
        assert!(!notify.tasks_known && notify.tasks.is_empty());
        assert!(desk.mission("nope").is_none());
    }

    #[test]
    fn re_planning_names_both_missions_and_stop_only_ends_the_link() {
        use crate::model::{MissionLink, StopReplanningIntent};
        let mut desk = Desk::new(Scenario::Decisions);
        let docs = desk.mission("docs").unwrap();
        let search = MissionLink {
            mission_id: "search".into(),
            title: "Faster search".into(),
        };
        assert_eq!(docs.replanning_as, Some(search));
        assert!(!docs.can_replan && !docs.replan_draft.is_empty());
        assert_eq!(
            desk.mission("search").unwrap().replaces.map(|l| l.title),
            Some("Docs refresh".to_owned())
        );
        let needs_you = desk.today().decisions.len();
        let stop = |successor: &str| StopReplanningIntent {
            mission_id: "docs".into(),
            successor_id: successor.into(),
        };
        assert_eq!(
            desk.stop_replanning(&stop("native")).status,
            OutcomeStatus::Stale
        );
        assert_eq!(
            desk.stop_replanning(&stop("search")).status,
            OutcomeStatus::Accepted
        );
        assert_eq!(
            desk.stop_replanning(&stop("search")).status,
            OutcomeStatus::Stale
        );
        let docs = desk.mission("docs").unwrap();
        assert!(docs.replanning_as.is_none() && docs.can_replan);
        assert!(desk.mission("search").unwrap().replaces.is_none());
        assert_eq!(
            desk.today().decisions.len(),
            needs_you,
            "neither needs the user"
        );
        // A service without missionReplanning offers no re-plan.
        desk.native_replanning(false);
        assert!(!desk.mission("docs").unwrap().can_replan);
    }

    #[test]
    fn rename_trims_refuses_empty_and_check_only_reads() {
        use crate::model::RenameIntent;
        let mut desk = Desk::new(Scenario::Decisions);
        let rename = |id: &str, title: &str, check: bool| RenameIntent {
            mission_id: id.into(),
            title: title.into(),
            check,
        };
        let before = desk.today().revision;
        let empty = desk.rename(&rename("search", "  \n", false));
        assert_eq!(empty.status, OutcomeStatus::Rejected);
        assert_eq!(desk.today().revision, before, "nothing changed");
        assert_eq!(
            desk.rename(&rename("search", "  Quick search ", false))
                .status,
            OutcomeStatus::Accepted
        );
        assert_eq!(desk.mission("search").unwrap().row.title, "Quick search");
        // A lost answer: Check only reads, and finds the new title.
        assert_eq!(
            desk.rename(&rename("docs", "Setup docs", false)).status,
            OutcomeStatus::Unknown
        );
        let revision = desk.today().revision;
        assert_eq!(
            desk.rename(&rename("docs", "Setup docs", true)).status,
            OutcomeStatus::Accepted
        );
        assert_eq!(
            desk.rename(&rename("docs", "Other words", true)).status,
            OutcomeStatus::Rejected
        );
        assert_eq!(desk.today().revision, revision, "Check sends nothing");
        assert_eq!(desk.mission("docs").unwrap().row.title, "Setup docs");
    }

    #[test]
    fn a_new_read_replaces_the_old_one_and_reports_age_with_the_clock() {
        use crate::model::MissionState;
        let mut desk = Desk::new(Scenario::Decisions);
        desk.lose_read(FreshnessState::Offline, "Pilot's service is not answering.");
        let mut next = desk.overview.clone().unwrap();
        next.observed_at = NOW + 30 * crate::project::MINUTE;
        next.reports.retain(|v| v.report.mission_id != "search");
        desk.apply_overview(next).unwrap();
        assert_eq!(desk.today().freshness.state, FreshnessState::Live);
        assert_eq!(row(&desk, "search").state, MissionState::Unreported);
        assert_eq!(
            row(&desk, "notify").report.as_ref().unwrap().age,
            "50 min ago"
        );
        let mut bad = desk.overview.clone().unwrap();
        bad.version = 2;
        assert!(desk.apply_overview(bad).is_err());
    }
}
