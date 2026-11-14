//! The class TSX holds: a read model it can mirror and intents it can
//! send. It has no transport, so the screen cannot reach a daemon through
//! it.

use std::{cell::RefCell, collections::BTreeMap, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::{
    actions::StartedAction,
    attention_feed::Native,
    desk::{Desk, PULSE_COUNT, PULSE_EVERY},
    model::{
        ActionAsk, ActionCheck, ActionRef, AnswerRef, AskIntent, CompleteIntent, DecideIntent,
        DecisionRef, Draft, DraftIntent, IntentOutcome, LifecycleAction, LifecycleIntent,
        MissionPage, MissionRef, OutcomeStatus, PauseIntent, ProgressIntent, RenameIntent,
        ReplyIntent, ResumeIntent, Scenario, StopReplanningIntent, Today,
    },
};

/// How long the mock coordinator takes to answer, so pending states show.
/// The Rust-only Today screen waits the same time.
pub const MOCK_LATENCY: Duration = Duration::from_millis(350);

type Listeners = Rc<RefCell<Vec<(u64, Callback<Today>)>>>;

/// Today's read model, kept in Rust, and the only way to change it. The
/// screen mirrors `snapshot()` and hears every change through `onChange`.
#[class]
pub struct TodayFeed {
    desk: Desk,
    native: Option<crate::host::NativeHost>,
    /// The native host's cards, drafts and this run's requests.
    side: Option<Native>,
    /// Mock drafts, by item, with the revision they were written on. Kept
    /// for this run only; the native side saves them in the host.
    drafts: BTreeMap<String, (u32, Draft)>,
    watch_task: Option<Spawned<()>>,
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl TodayFeed {
    /// Sends the read model to every listener, in order with other posts.
    fn publish(&self) {
        let today = self.snapshot();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(today.clone());
        }
    }

    /// Sends one recorded action request and applies its answer.
    async fn send_action(
        this: Instance<Self>,
        begin: impl FnOnce(&mut Desk) -> Result<StartedAction, IntentOutcome>,
    ) -> IntentOutcome {
        let started = this.with_mut(|feed| {
            let started = begin(&mut feed.desk);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        });
        let (started, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_action(&started);
            feed.publish();
            outcome
        })
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &Desk {
        &self.desk
    }

    fn side(this: &Instance<Self>) -> Option<Native> {
        this.with(|feed| feed.side.clone())
    }

    /// Puts the mock drafts on the items they were written for.
    fn with_drafts(&self, mut today: Today) -> Today {
        for d in &mut today.decisions {
            if let Some((revision, draft)) = self.drafts.get(&d.id)
                && *revision == d.revision
            {
                d.draft = draft.clone();
            }
        }
        for a in &mut today.actions {
            if let Some((revision, draft)) = self.drafts.get(&a.id)
                && *revision == a.revision
            {
                a.draft = draft.clone();
            }
        }
        today
    }

    /// Rust-only: how long native drafts wait for the next key before they
    /// are saved. Tests with a manual clock use zero.
    pub fn set_draft_delay(&self, delay: Duration) {
        if let Some(side) = &self.side {
            side.set_draft_delay(delay);
        }
    }

    /// Rust-only safe close for the native bootstrap: queues every unsaved
    /// draft on the host, then closes and joins it. Await it before quit or
    /// before replacing the selection.
    pub fn close(&self) -> Option<async_channel::Receiver<Result<(), crate::host::Error>>> {
        self.side.as_ref().map(Native::close)
    }

    /// Native-only factory, called under the app root owner. Never exported to TSX.
    /// Selection and credentials stay with the trusted native bootstrap.
    pub fn from_host(host: crate::host::NativeHost) -> Self {
        let listeners: Listeners = Rc::default();
        let changes = host.changes();
        let side = Native::new(host.clone(), listeners.clone());
        let weak = Rc::downgrade(&listeners);
        let source = side.clone();
        let watch_task = spawn(async move {
            source.reread().await;
            while changes.recv().await.is_ok() {
                if weak.upgrade().is_none() {
                    break;
                }
                source.publish();
            }
        });
        Self {
            desk: Desk::native(),
            native: Some(host),
            side: Some(side),
            drafts: BTreeMap::new(),
            watch_task: Some(watch_task),
            listeners,
            next_listener: 0,
            latency: Duration::ZERO,
        }
    }

    async fn native_result(
        host: crate::host::NativeHost,
        result: async_channel::Receiver<Result<IntentOutcome, crate::host::Error>>,
    ) -> IntentOutcome {
        match result.recv().await {
            Ok(Ok(outcome)) => outcome,
            error => IntentOutcome { status: if matches!(error, Ok(Err(crate::host::Error::Unknown))) { crate::model::OutcomeStatus::Unknown } else { crate::model::OutcomeStatus::Rejected }, revision: host.snapshot().revision, message: "This request could not be confirmed. Refresh or check the saved operation; nothing is resent.".into() }
        }
    }

    async fn lifecycle(
        this: Instance<Self>,
        intent: LifecycleIntent,
        action: LifecycleAction,
    ) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.lifecycle(intent, action);
            return Self::native_result(host, result).await;
        }
        this.with_mut(|feed| {
            let outcome = feed.desk.lifecycle(&intent, action);
            feed.publish();
            outcome
        })
    }
}

impl Drop for TodayFeed {
    fn drop(&mut self) {
        if let Some(task) = self.watch_task.take() {
            task.cancel();
        }
        if let Some(side) = &self.side {
            // Unsaved drafts are queued before the close fence.
            let _ = side.close();
        }
    }
}

#[class]
impl TodayFeed {
    /// A feed of mock data from `scenario` (the decisions world when left
    /// out).
    pub fn new(scenario: Option<Scenario>) -> Self {
        TodayFeed {
            desk: Desk::new(scenario.unwrap_or_default()),
            native: None,
            watch_task: None,
            side: None,
            drafts: BTreeMap::new(),
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// The read model now.
    pub fn snapshot(&self) -> Today {
        match &self.side {
            Some(side) => side.snapshot(),
            None => self.with_drafts(self.desk.today().clone()),
        }
    }

    /// Calls `listener` with the whole read model after every change, until
    /// the returned function is called or its owner goes.
    pub fn on_change(&mut self, #[args(today)] listener: Callback<Today>) -> Stop {
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

    /// Answers a decision with one of its options. Resolves once the
    /// coordinator confirms, or with `unknown` when no confirmation came.
    pub async fn decide(this: Instance<Self>, intent: DecideIntent) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side
                .answer(
                    &intent.decision_id,
                    intent.revision,
                    vec![intent.option_id],
                    "",
                )
                .await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_decide(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        });
        let (started, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_decide(&started);
            feed.publish();
            outcome
        })
    }

    /// Answers a decision in the user's own words, with or without one of
    /// its options, at the revision shown. A question that takes several
    /// options takes them all in `optionIds`. Only decisions that allow a
    /// reply take it. Resolves once the answer is confirmed, or with `unknown`.
    pub async fn reply(this: Instance<Self>, intent: ReplyIntent) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            let picks = intent
                .option_id
                .into_iter()
                .chain(intent.option_ids)
                .collect();
            return side
                .answer(&intent.decision_id, intent.revision, picks, &intent.text)
                .await;
        }
        if !intent.option_ids.is_empty() {
            return this.with(|feed| IntentOutcome {
                status: OutcomeStatus::Rejected,
                revision: feed.desk.today().revision,
                message:
                    "Mock data: answers with several picks need Pilot's service. Nothing was sent."
                        .into(),
            });
        }
        if intent.text.trim().is_empty()
            && let Some(option_id) = intent.option_id
        {
            let decide = DecideIntent {
                decision_id: intent.decision_id,
                revision: intent.revision,
                option_id,
            };
            return Self::decide(this, decide).await;
        }
        this.with(|feed| IntentOutcome {
            status: OutcomeStatus::Rejected,
            revision: feed.desk.today().revision,
            message: "Mock data: answers in your own words need Pilot's service. Nothing was sent."
                .into(),
        })
    }

    /// Keeps what the user picked or wrote on one item, at the revision
    /// shown. It never sends, answers or completes anything. Native drafts
    /// are saved after a short pause and on `flushDrafts`, and come back after
    /// a restart; a draft on an earlier revision picks nothing.
    pub fn save_draft(&mut self, intent: DraftIntent) -> IntentOutcome {
        if let Some(side) = &self.side {
            return side.save_draft(&intent);
        }
        let today = self.desk.today();
        let now = today.revision;
        let question = today.decisions.iter().any(|d| d.id == intent.item_id);
        let revision = today
            .decisions
            .iter()
            .find(|d| d.id == intent.item_id)
            .map(|d| d.revision)
            .or_else(|| {
                today
                    .actions
                    .iter()
                    .find(|a| a.id == intent.item_id)
                    .map(|a| a.revision)
            });
        let outcome = move |status, message: &str| IntentOutcome {
            status,
            revision: now,
            message: message.into(),
        };
        if revision != Some(intent.revision) {
            return outcome(
                OutcomeStatus::Stale,
                "This changed. Your words stay on screen.",
            );
        }
        // Only a question takes Later here, and a save that does not say
        // Later keeps it.
        let later = question
            && (intent.later
                || self
                    .drafts
                    .get(&intent.item_id)
                    .is_some_and(|(r, d)| *r == intent.revision && d.later));
        let put_off = later
            && !self
                .drafts
                .get(&intent.item_id)
                .is_some_and(|(r, d)| *r == intent.revision && d.later);
        self.drafts.insert(
            intent.item_id,
            (
                intent.revision,
                Draft {
                    pick: intent.pick,
                    picks: intent.picks,
                    text: intent.text,
                    question: intent.question,
                    later,
                    unsaved: false,
                },
            ),
        );
        if put_off {
            // The card says it was put off; other draft saves change nothing on screen.
            self.publish();
        }
        outcome(OutcomeStatus::Accepted, "")
    }

    /// Saves every waiting draft now, without the pause. Call it when a
    /// field loses focus or the user moves on.
    pub fn flush_drafts(&self) {
        if let Some(side) = &self.side {
            side.flush();
        }
    }

    /// Opens an action's link for the user, when Pilot may. Rust names the
    /// exact link the daemon pinned; opening it reports nothing.
    pub async fn open_link(this: Instance<Self>, intent: ActionRef) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side.open_link(&intent.action_id, intent.revision).await;
        }
        this.with(|feed| IntentOutcome {
            status: OutcomeStatus::Rejected,
            revision: feed.desk.today().revision,
            message: "Pilot cannot open links here. Copy the link instead; this reports nothing."
                .into(),
        })
    }

    /// Puts a decision at the end of the queue. It stays unanswered.
    pub fn later(&mut self, intent: DecisionRef) -> IntentOutcome {
        if let Some(side) = &self.side {
            return side.later(&intent.decision_id, intent.revision);
        }
        let before = self.desk.today().revision;
        let outcome = self.desk.later(&intent);
        if self.desk.today().revision != before {
            self.publish();
        }
        outcome
    }

    /// Reads whether an unconfirmed send or push landed. Never resends.
    pub async fn check(this: Instance<Self>, intent: DecisionRef) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side.check_answer_of(&intent.decision_id).await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_check(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        });
        let (started, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_check(&started);
            feed.publish();
            outcome
        })
    }

    /// Asks Pilot a question about a decision, named at the revision the
    /// screen showed. The question joins the decision's `answers` at once,
    /// as asking; the answer follows. Help never answers the decision.
    pub async fn ask(this: Instance<Self>, intent: AskIntent) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side
                .ask(&intent.decision_id, intent.revision, &intent.question)
                .await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_ask(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|id| (id, feed.latency))
        });
        let (id, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_ask(&intent.decision_id, &id);
            feed.publish();
            outcome
        })
    }

    /// Reads whether a question whose answer was lost has a saved answer.
    /// Never asks again.
    pub async fn check_answer(this: Instance<Self>, intent: AnswerRef) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side.check_help(&intent.answer_id).await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_check_answer(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|()| feed.latency)
        });
        let latency = match started {
            Ok(latency) => latency,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_check_answer(&intent);
            feed.publish();
            outcome
        })
    }

    /// Saves the user's progress on an action, named at the revision the
    /// screen showed. It does not complete the action.
    pub async fn save_progress(this: Instance<Self>, intent: ProgressIntent) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side
                .act(
                    &intent.action_id,
                    intent.revision,
                    ActionAsk::Progress,
                    &intent.progress,
                )
                .await;
        }
        Self::send_action(this, |desk| desk.begin_progress(&intent)).await
    }

    /// Puts an action off. It still waits for the user.
    pub async fn action_later(this: Instance<Self>, intent: ActionRef) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side
                .act(&intent.action_id, intent.revision, ActionAsk::Later, "")
                .await;
        }
        Self::send_action(this, |desk| desk.begin_action_later(&intent)).await
    }

    /// Reports an action done, in the user's words. Pilot keeps it as the
    /// user's report, not as proof that the action worked. A lost answer
    /// is `unknown`, and only `checkAction` can settle it.
    pub async fn complete(this: Instance<Self>, intent: CompleteIntent) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side
                .act(
                    &intent.action_id,
                    intent.revision,
                    ActionAsk::Complete,
                    &intent.report,
                )
                .await;
        }
        Self::send_action(this, |desk| desk.begin_complete(&intent)).await
    }

    /// Reads whether an action request whose answer was lost landed. Never
    /// sends it again.
    pub async fn check_action(this: Instance<Self>, intent: ActionCheck) -> IntentOutcome {
        if let Some(side) = Self::side(&this) {
            return side.check_action(&intent.action_id).await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_check_action(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|op| (op, feed.latency))
        });
        let (operation, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_check_action(&intent.action_id, &operation);
            feed.publish();
            outcome
        })
    }

    /// One mission in full: its row, tasks with their agents' reports,
    /// control and working chats. Null when the mission is not in the read.
    /// Read it again after every change.
    pub fn mission(&self, mission_id: String) -> Option<MissionPage> {
        self.native.as_ref().map_or_else(
            || self.desk.mission(&mission_id),
            |h| h.mission(&mission_id),
        )
    }

    /// Reads one mission's tasks, reports and working chats again, for its
    /// overview. It only reads: nothing is sent, paused or settled. Mock
    /// data has everything already.
    pub async fn open_mission(this: Instance<Self>, intent: MissionRef) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.read_mission(intent.mission_id);
            return match result.recv().await {
                Ok(Ok(outcome)) => outcome,
                _ => IntentOutcome {
                    status: OutcomeStatus::Rejected,
                    revision: host.snapshot().revision,
                    message: "Pilot could not read this mission again. What was read before stays on screen.".into(),
                },
            };
        }
        this.with(|feed| IntentOutcome {
            status: OutcomeStatus::Accepted,
            revision: feed.desk.today().revision,
            message: String::new(),
        })
    }

    /// Pauses all of a mission's work, named at the control revision the
    /// screen showed. Resolves once the service answers: paused, or still
    /// pausing with work that needs a look. A lost answer is `unknown`, and
    /// only `checkControl` can settle it.
    pub async fn pause(this: Instance<Self>, intent: PauseIntent) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.pause(intent.mission_id, intent.revision);
            return Self::native_result(host, result).await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_pause(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        });
        let (started, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_control(&started);
            feed.publish();
            outcome
        })
    }

    /// Resumes the work that the named Pause paused, and nothing else.
    pub async fn resume(this: Instance<Self>, intent: ResumeIntent) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.resume(
                intent.mission_id,
                intent.revision,
                intent.pause_operation_id,
            );
            return Self::native_result(host, result).await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_resume(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        });
        let (started, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_control(&started);
            feed.publish();
            outcome
        })
    }

    /// Reads whether a Pause or Resume whose answer was lost took effect.
    /// Never sends it again.
    pub async fn check_control(this: Instance<Self>, intent: MissionRef) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.check(intent.mission_id);
            return Self::native_result(host, result).await;
        }
        let started = this.with_mut(|feed| {
            let started = feed.desk.begin_check_control(&intent);
            if started.is_ok() {
                feed.publish();
            }
            started.map(|s| (s, feed.latency))
        });
        let (operation, latency) = match started {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed
                .desk
                .settle_check_control(&intent.mission_id, &operation);
            feed.publish();
            outcome
        })
    }

    /// Stops re-planning an old mission, named with the new mission the
    /// page showed. Only the link ends; both missions stay as they are. A
    /// lost answer is `unknown`; the next read shows whether it stopped.
    pub async fn stop_replanning(
        this: Instance<Self>,
        intent: StopReplanningIntent,
    ) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.stop_replanning(intent);
            return Self::native_result(host, result).await;
        }
        this.with_mut(|feed| {
            let outcome = feed.desk.stop_replanning(&intent);
            feed.publish();
            outcome
        })
    }

    /// Archives an active mission: it leaves Today, its history stays and no
    /// work is stopped. With `check`, only reads its status again after a
    /// lost answer. A refusal carries the service's own words.
    pub async fn archive(this: Instance<Self>, intent: LifecycleIntent) -> IntentOutcome {
        Self::lifecycle(this, intent, LifecycleAction::Archive).await
    }

    /// Reopens a mission this page archived. With `check`, only reads its
    /// status again.
    pub async fn reopen(this: Instance<Self>, intent: LifecycleIntent) -> IntentOutcome {
        Self::lifecycle(this, intent, LifecycleAction::Reopen).await
    }

    /// Renames a mission once. Rust trims the title and refuses an empty or
    /// too long one before sending. With `check`, only reads the title again
    /// after a lost answer. A refusal carries the service's own words.
    pub async fn rename(this: Instance<Self>, intent: RenameIntent) -> IntentOutcome {
        if let Some(host) = this.with(|f| f.native.clone()) {
            let result = host.rename(intent);
            return Self::native_result(host, result).await;
        }
        this.with_mut(|feed| {
            let outcome = feed.desk.rename(&intent);
            feed.publish();
            outcome
        })
    }

    /// Runs the update workload: one pulse every `everyMs` (100 when left
    /// out), `count` times (300 when left out), each publishing the whole
    /// read model. Resolves with the number of pulses made. For
    /// measurements only: it is not a user intent.
    pub async fn pulse(this: Instance<Self>, every_ms: Option<u32>, count: Option<u32>) -> u32 {
        if this.with(|f| f.native.is_some()) {
            return 0;
        }
        let every = every_ms.map_or(PULSE_EVERY, |ms| Duration::from_millis(ms.into()));
        let count = count.unwrap_or(PULSE_COUNT);
        let mut made = 0;
        while made < count {
            timer(every).await;
            if this.is_disposed() {
                break;
            }
            this.with_mut(|feed| {
                feed.desk.pulse();
                feed.publish();
            });
            made += 1;
        }
        made
    }
}
