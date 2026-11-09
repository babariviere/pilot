//! The class the Changes screens hold: a read model they can mirror and
//! intents they can send. It has no transport of its own. Mock data backs
//! `ChangesFeed::new`; `from_host` is a Rust-only binding to retained reads
//! and journaled native review-request transitions.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::{
    changes::{AttentionAsk, AttentionIntent, ChangeList, ChangePage, ChangeRef, ChangesScenario},
    changes_desk::ChangesDesk,
    feed::MOCK_LATENCY,
    model::IntentOutcome,
};

type Listeners = Rc<RefCell<Vec<(u64, Callback<ChangeList>)>>>;

/// Kept changes, kept in Rust, and the only way to act on them. The screens
/// mirror `snapshot()`, read `change()` again on every change, and hear
/// changes through `onChange`. Reopening reads the exact snapshot and
/// changes nothing; Later and Bring back name the request revision shown
/// and never approve anything.
#[class]
pub struct ChangesFeed {
    desk: ChangesDesk,
    native: Option<crate::host::NativeHost>,
    watch_task: Option<Spawned<()>>,
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl ChangesFeed {
    fn publish(&self) {
        let list = self.snapshot();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(list.clone());
        }
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &ChangesDesk {
        &self.desk
    }

    /// Construct under the native root owner. Bootstrap owns and joins the host;
    /// disposing this feed cancels only its notification task, never entered I/O.
    /// This constructor is not exported to the screen VM.
    pub fn from_host(host: crate::host::NativeHost) -> Self {
        let listeners: Listeners = Rc::default();
        let weak = Rc::downgrade(&listeners);
        let changes = host.changes();
        let initial = host.read_changes();
        let source = host.clone();
        let watch_task = spawn(async move {
            let mut pending = initial;
            for _ in 0..3 {
                if !matches!(pending.recv().await, Ok(Err(crate::host::Error::Stale))) {
                    break;
                }
                // Only a passive read raced by initial WS admission may retry.
                pending = source.read_changes();
            }
            while changes.recv().await.is_ok() {
                let Some(listeners) = weak.upgrade() else {
                    break;
                };
                let list = source.changes_snapshot();
                for (_, listener) in listeners.borrow().iter() {
                    listener.post(list.clone());
                }
            }
        });
        Self {
            desk: ChangesDesk::new(ChangesScenario::Empty),
            native: Some(host),
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
        use crate::{host::Error, model::OutcomeStatus};
        match result.recv().await {
            Ok(Ok(outcome)) => outcome,
            error => IntentOutcome { status: match error {
                Ok(Err(Error::Unknown)) | Err(_) => OutcomeStatus::Unknown,
                Ok(Err(Error::Stale | Error::Identity)) => OutcomeStatus::Stale,
                _ => OutcomeStatus::Rejected,
            }, revision: host.changes_snapshot().revision,
                message:"Read again with current native access, or check an unconfirmed operation. Nothing is resent.".into() }
        }
    }

    /// Runs `begin`; publishes when it started something.
    fn begin<T>(
        this: &Instance<Self>,
        begin: impl FnOnce(&mut ChangesDesk) -> Result<T, IntentOutcome>,
    ) -> Result<(T, Duration), IntentOutcome> {
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
        settle: impl FnOnce(&mut ChangesDesk) -> IntentOutcome,
    ) -> IntentOutcome {
        this.with_mut(|feed| {
            let outcome = settle(&mut feed.desk);
            feed.publish();
            outcome
        })
    }

    async fn attention(
        this: Instance<Self>,
        intent: AttentionIntent,
        ask: AttentionAsk,
    ) -> IntentOutcome {
        if let Some(host) = this.with(|feed| feed.native.clone()) {
            let result = host.change_attention(intent, ask);
            return Self::native_result(host, result).await;
        }
        let (operation, latency) = match Self::begin(&this, |d| d.begin_attention(&intent, ask)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |d| {
            d.settle_attention(&intent.snapshot_id, &operation)
        })
    }
}

impl Drop for ChangesFeed {
    fn drop(&mut self) {
        if let Some(task) = self.watch_task.take() {
            task.cancel();
        }
    }
}

#[class]
impl ChangesFeed {
    /// A feed of mock data from `scenario` (the review world when left out).
    pub fn new(scenario: Option<ChangesScenario>) -> Self {
        ChangesFeed {
            desk: ChangesDesk::new(scenario.unwrap_or_default()),
            native: None,
            watch_task: None,
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// The list of kept changes now.
    pub fn snapshot(&self) -> ChangeList {
        self.native
            .as_ref()
            .map_or_else(|| self.desk.list().clone(), |h| h.changes_snapshot())
    }

    /// Calls `listener` with the whole list after every change, until the
    /// returned function is called or its owner goes.
    pub fn on_change(&mut self, #[args(changes)] listener: Callback<ChangeList>) -> Stop {
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

    /// One kept snapshot in full, or null when it is not read yet or cannot
    /// be shown. Read it again after every change.
    pub fn change(&self, snapshot_id: String) -> Option<ChangePage> {
        if let Some(host) = &self.native {
            return host.change_page(&snapshot_id);
        }
        self.desk.page(&snapshot_id)
    }

    /// Reads one kept snapshot exactly: its bytes, reviews, requests and
    /// landing checks. Reading approves, reviews and resumes nothing.
    pub async fn open(this: Instance<Self>, intent: ChangeRef) -> IntentOutcome {
        if let Some(host) = this.with(|feed| feed.native.clone()) {
            let result = host.open_change(intent.snapshot_id);
            return Self::native_result(host, result).await;
        }
        let ((), latency) = match Self::begin(&this, |d| d.begin_open(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |d| d.settle_open(&intent))
    }

    /// Puts a review off, named with the request and revision shown. It
    /// still waits; nothing is approved or reviewed. A lost answer is
    /// `unknown`, and only `checkAttention` can settle it.
    pub async fn later(this: Instance<Self>, intent: AttentionIntent) -> IntentOutcome {
        Self::attention(this, intent, AttentionAsk::Later).await
    }

    /// Brings a review the user put off back to waiting, named with the
    /// request and revision shown.
    pub async fn bring_back(this: Instance<Self>, intent: AttentionIntent) -> IntentOutcome {
        Self::attention(this, intent, AttentionAsk::BringBack).await
    }

    /// Reads whether a Later or Bring back whose answer was lost landed.
    /// Never sends it again.
    pub async fn check_attention(this: Instance<Self>, intent: ChangeRef) -> IntentOutcome {
        if let Some(host) = this.with(|feed| feed.native.clone()) {
            let result = host.check_change_attention(intent.snapshot_id);
            return Self::native_result(host, result).await;
        }
        let (operation, latency) = match Self::begin(&this, |d| d.begin_check(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |d| d.settle_check(&intent.snapshot_id, &operation))
    }

    /// Reads the next page of kept changes, if there is one.
    pub fn more(&mut self) -> IntentOutcome {
        if let Some(host) = &self.native {
            let _ = host.read_changes();
            return IntentOutcome {
                status: crate::model::OutcomeStatus::Accepted,
                revision: host.changes_snapshot().revision,
                message: "Reading kept changes. This is not a completion acknowledgement.".into(),
            };
        }
        let outcome = self.desk.more();
        self.publish();
        outcome
    }
}
