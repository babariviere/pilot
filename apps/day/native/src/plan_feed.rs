//! The class the New and planning screens hold: a read model they can
//! mirror and intents they can send. It has no transport of its own. Mock
//! data backs `PlanFeed::new`; the trusted native bootstrap builds
//! `PlanFeed::from_host` in Rust only, which reads and writes saved
//! interviews through the host (docs/technical/day-native-host.md).

use std::{cell::RefCell, rc::Rc, time::Duration};

use async_channel::{Receiver, Sender};
use nsh_core::prelude::*;

use crate::{
    feed::MOCK_LATENCY,
    host::{Error, NativeHost},
    model::IntentOutcome,
    plan::{
        AnswerIntent, InterviewRef, NewIntent, OutcomeStatus, PlanAvailability, PlanOutcome,
        PlanPage, PlanScenario, Planning, Setup, SubmitIntent,
    },
    plan_desk::PlanDesk,
    plan_host::{self, Local},
};

type Listeners = Rc<RefCell<Vec<(u64, Callback<Planning>)>>>;

/// Why New cannot start anything on the native host yet.
const NO_CREATE: &str =
    "Starting a mission or a chat from Day is not connected yet. Nothing was sent.";

/// The selected mission and what the feed is doing for it.
#[derive(Debug, Default)]
struct HostState {
    mission: Option<String>,
    local: Local,
    revision: u32,
}

/// The native host side: the host, the selected mission, and a lock that
/// sends one planning action at a time (the host refuses a second while one
/// is unsettled).
#[derive(Clone)]
struct HostSide {
    host: NativeHost,
    state: Rc<RefCell<HostState>>,
    token: (Sender<()>, Receiver<()>),
}

impl HostSide {
    fn snapshot(&self) -> Planning {
        let state = self.state.borrow();
        let plans = state
            .mission
            .as_ref()
            .and_then(|m| self.page(m, &state))
            .filter(|p| p.available)
            .map(|p| vec![plan_host::row(&p, "")])
            .unwrap_or_default();
        Planning {
            revision: state.revision,
            availability: PlanAvailability::Live,
            reason: String::new(),
            setup: Setup::default(),
            can_create: false,
            create_reason: NO_CREATE.into(),
            plans,
            started: Vec::new(),
        }
    }

    fn page(&self, mission: &str, state: &HostState) -> Option<PlanPage> {
        if state.mission.as_deref() != Some(mission) {
            return None;
        }
        let read = self.host.planning(mission)?;
        let ops = self.host.planning_operations(mission);
        Some(plan_host::page(&read, &ops, &state.local))
    }

    fn mission(&self) -> Option<String> {
        self.state.borrow().mission.clone()
    }

    async fn lock(&self) {
        let _ = self.token.1.recv().await;
    }

    fn unlock(&self) {
        let _ = self.token.0.try_send(());
    }
}

fn outcome(status: OutcomeStatus, message: &str, mission: Option<String>) -> PlanOutcome {
    PlanOutcome {
        status,
        revision: 0,
        message: message.into(),
        mission_id: mission,
    }
}

/// The screen's outcome of a host reply. A missing reply after sending is
/// unknown, never a refusal.
fn host_outcome(
    reply: Result<Result<IntentOutcome, Error>, async_channel::RecvError>,
    accepted: &str,
    mission: Option<String>,
) -> PlanOutcome {
    match reply {
        Ok(Ok(o)) => match o.status {
            OutcomeStatus::Accepted => outcome(o.status, accepted, mission),
            OutcomeStatus::Unknown => outcome(
                o.status,
                "Pilot sent it but heard nothing back. It sends nothing more until it checks.",
                mission,
            ),
            _ => outcome(
                o.status,
                "The service refused it. Read it again; your text is kept here.",
                mission,
            ),
        },
        Ok(Err(Error::Stale)) => outcome(
            OutcomeStatus::Stale,
            "This question or its plan changed. Your text is kept here; read it again.",
            mission,
        ),
        Ok(Err(Error::Unknown)) => outcome(
            OutcomeStatus::Unknown,
            "An earlier action is not confirmed. Pilot checks it before it sends anything else.",
            mission,
        ),
        Ok(Err(_)) => outcome(
            OutcomeStatus::Rejected,
            "Pilot could not reach the planning service. Nothing was sent; your text is kept here.",
            mission,
        ),
        Err(_) => outcome(
            OutcomeStatus::Unknown,
            "No answer came back. Pilot sends nothing more until it checks.",
            mission,
        ),
    }
}

/// New, mission interviews and planning, kept in Rust, and the only way to
/// change them. The screens mirror `snapshot()`, read `page()` again on
/// every change, and hear changes through `onChange`. Saving an answer
/// never submits it; submitting is one explicit intent; neither starts work.
#[class]
pub struct PlanFeed {
    desk: PlanDesk,
    native: Option<HostSide>,
    watch_task: Option<Spawned<()>>,
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

    /// Publishes a host-side change.
    fn changed(&self) {
        if let Some(side) = &self.native {
            side.state.borrow_mut().revision += 1;
        }
        self.publish();
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &PlanDesk {
        &self.desk
    }

    /// Native-only factory, called under the app root owner. Never exported
    /// to TSX. The bootstrap that selected the host owns it and closes it.
    pub fn from_host(host: NativeHost) -> Self {
        let listeners: Listeners = Rc::default();
        let (tx, rx) = async_channel::bounded(1);
        let _ = tx.try_send(());
        let side = HostSide {
            host: host.clone(),
            state: Rc::default(),
            token: (tx, rx),
        };
        let weak = Rc::downgrade(&listeners);
        let changes = host.changes();
        let source = side.clone();
        let watch_task = spawn(async move {
            while changes.recv().await.is_ok() {
                let Some(listeners) = weak.upgrade() else {
                    break;
                };
                source.state.borrow_mut().revision += 1;
                let planning = source.snapshot();
                for (_, listener) in listeners.borrow().iter() {
                    listener.post(planning.clone());
                }
            }
        });
        PlanFeed {
            desk: PlanDesk::new(PlanScenario::Fresh),
            native: Some(side),
            watch_task: Some(watch_task),
            listeners,
            next_listener: 0,
            latency: Duration::ZERO,
        }
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

    /// Sends one host write built from the selected read, one at a time.
    async fn host_write(
        this: &Instance<Self>,
        side: HostSide,
        build: impl FnOnce(
            &serde_json::Value,
        ) -> Result<(String, serde_json::Value), plan_host::Refusal>,
        mark: impl Fn(&mut Local, bool),
        accepted: &str,
    ) -> PlanOutcome {
        side.lock().await;
        let mission = side.mission();
        let read = mission.as_deref().and_then(|m| side.host.planning(m));
        let (Some(mission), Some(read)) = (mission, read) else {
            side.unlock();
            return outcome(
                OutcomeStatus::Rejected,
                "Open the mission's planning first. Nothing was sent.",
                None,
            );
        };
        let (digest, request) = match build(&read) {
            Ok(built) => built,
            Err((status, message)) => {
                side.unlock();
                return outcome(status, message, Some(mission));
            }
        };
        mark(&mut side.state.borrow_mut().local, true);
        if !this.is_disposed() {
            this.with(Self::changed);
        }
        let reply = side
            .host
            .write_interview(mission.clone(), digest, request)
            .recv()
            .await;
        mark(&mut side.state.borrow_mut().local, false);
        side.unlock();
        if !this.is_disposed() {
            this.with(Self::changed);
        }
        host_outcome(reply, accepted, Some(mission))
    }
}

impl Drop for PlanFeed {
    fn drop(&mut self) {
        if let Some(task) = self.watch_task.take() {
            task.cancel();
        }
    }
}

#[class]
impl PlanFeed {
    /// A feed of mock data from `scenario` (one mission interview when left out).
    pub fn new(scenario: Option<PlanScenario>) -> Self {
        PlanFeed {
            desk: PlanDesk::new(scenario.unwrap_or_default()),
            native: None,
            watch_task: None,
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// Planning now: availability, setup and missions in planning.
    pub fn snapshot(&self) -> Planning {
        self.native
            .as_ref()
            .map_or_else(|| self.desk.planning().clone(), HostSide::snapshot)
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
        match &self.native {
            Some(side) => side.page(&mission_id, &side.state.borrow()),
            None => self.desk.page(&mission_id),
        }
    }

    /// Reads one mission's saved interview and plan. Opening never answers,
    /// submits or starts anything.
    pub async fn open(this: Instance<Self>, mission_id: String) -> PlanOutcome {
        let Some(side) = this.with(|f| f.native.clone()) else {
            let known = this.with(|f| f.desk.page(&mission_id).is_some());
            return if known {
                outcome(OutcomeStatus::Accepted, "", Some(mission_id))
            } else {
                outcome(
                    OutcomeStatus::Rejected,
                    "This mission is not in planning.",
                    None,
                )
            };
        };
        {
            let mut state = side.state.borrow_mut();
            if state.mission.as_deref() != Some(mission_id.as_str()) {
                state.mission = Some(mission_id.clone());
                state.local = Local::default();
            }
        }
        this.with(Self::changed);
        let reply = side.host.read_planning(mission_id.clone()).recv().await;
        if !this.is_disposed() {
            this.with(Self::changed);
        }
        match reply {
            Ok(Ok(_)) => outcome(OutcomeStatus::Accepted, "", Some(mission_id)),
            _ => outcome(
                OutcomeStatus::Rejected,
                "Pilot could not read this mission's planning. What was read before stays on screen.",
                Some(mission_id),
            ),
        }
    }

    /// Starts a mission from the user's goal, named with the setup shown.
    /// Pilot asks its questions first; nothing else starts. Resolves with
    /// the new mission once its first questions arrive.
    pub async fn plan(this: Instance<Self>, intent: NewIntent) -> PlanOutcome {
        if this.with(|f| f.native.is_some()) {
            return outcome(OutcomeStatus::Rejected, NO_CREATE, None);
        }
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
        if this.with(|f| f.native.is_some()) {
            return outcome(OutcomeStatus::Rejected, NO_CREATE, None);
        }
        let (id, latency) = match Self::begin(&this, |desk| desk.begin_start(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |desk| desk.settle_start(&id))
    }

    /// Saves one answer as a draft, named with the question list and the
    /// question's digest shown. It never submits and never wakes Pilot.
    pub async fn save_answer(this: Instance<Self>, intent: AnswerIntent) -> PlanOutcome {
        if let Some(side) = this.with(|f| f.native.clone()) {
            let question = intent.question_id.clone();
            return Self::host_write(
                &this,
                side,
                |read| plan_host::save_request(read, &intent),
                move |local, on| {
                    if on {
                        local.saving.insert(question.clone());
                    } else {
                        local.saving.remove(&question);
                    }
                },
                "",
            )
            .await;
        }
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
        if let Some(side) = this.with(|f| f.native.clone()) {
            return Self::host_write(
                &this,
                side,
                |read| plan_host::submit_request(read, &intent),
                |local, on| local.submitting = on,
                "Submitted. Your answers are fixed.",
            )
            .await;
        }
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
        if let Some(side) = this.with(|f| f.native.clone()) {
            let mission = side.mission();
            let operation = mission
                .as_deref()
                .and_then(|m| plan_host::unsettled_operation(&side.host.planning_operations(m)));
            let Some(operation) = operation else {
                return outcome(
                    OutcomeStatus::Rejected,
                    "There is nothing to check.",
                    mission,
                );
            };
            side.state.borrow_mut().local.checking = true;
            this.with(Self::changed);
            let reply = side.host.check_planning(operation).recv().await;
            side.state.borrow_mut().local.checking = false;
            if let Some(m) = &mission {
                let _ = side.host.read_planning(m.clone()).recv().await;
            }
            if !this.is_disposed() {
                this.with(Self::changed);
            }
            let _ = &intent;
            return host_outcome(reply, "It arrived. Nothing was sent again.", mission);
        }
        let ((), latency) = match Self::begin(&this, |desk| desk.begin_check(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        let outcome = Self::settle(&this, |desk| desk.settle_check(&intent));
        Self::continue_after(&this, &outcome, latency).await;
        outcome
    }
}
