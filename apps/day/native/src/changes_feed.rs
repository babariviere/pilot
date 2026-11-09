//! The class the Changes screens hold: a read model they can mirror and
//! intents they can send. It has no transport of its own. Mock data backs
//! `ChangesFeed::new`; binding a trusted native host to the retained-review
//! reads and the review request snooze and resume is separate work.

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
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl ChangesFeed {
    fn publish(&self) {
        let list = self.desk.list().clone();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(list.clone());
        }
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &ChangesDesk {
        &self.desk
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

#[class]
impl ChangesFeed {
    /// A feed of mock data from `scenario` (the review world when left out).
    pub fn new(scenario: Option<ChangesScenario>) -> Self {
        ChangesFeed {
            desk: ChangesDesk::new(scenario.unwrap_or_default()),
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// The list of kept changes now.
    pub fn snapshot(&self) -> ChangeList {
        self.desk.list().clone()
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
        self.desk.page(&snapshot_id)
    }

    /// Reads one kept snapshot exactly: its bytes, reviews, requests and
    /// landing checks. Reading approves, reviews and resumes nothing.
    pub async fn open(this: Instance<Self>, intent: ChangeRef) -> IntentOutcome {
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
        let (operation, latency) = match Self::begin(&this, |d| d.begin_check(&intent)) {
            Ok(started) => started,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        Self::settle(&this, |d| d.settle_check(&intent.snapshot_id, &operation))
    }

    /// Reads the next page of kept changes, if there is one.
    pub fn more(&mut self) -> IntentOutcome {
        let outcome = self.desk.more();
        self.publish();
        outcome
    }
}
