//! The class TSX holds: a read model it can mirror and intents it can
//! send. It has no transport, so the screen cannot reach a daemon through
//! it.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::{
    desk::{Desk, PULSE_COUNT, PULSE_EVERY},
    model::{AskIntent, DecideIntent, DecisionRef, IntentOutcome, Scenario, Today},
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
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl TodayFeed {
    /// Sends the read model to every listener, in order with other posts.
    fn publish(&self) {
        let today = self.desk.today().clone();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(today.clone());
        }
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &Desk {
        &self.desk
    }
}

#[class]
impl TodayFeed {
    /// A feed of mock data from `scenario` (the decisions world when left
    /// out).
    pub fn new(scenario: Option<Scenario>) -> Self {
        TodayFeed {
            desk: Desk::new(scenario.unwrap_or_default()),
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// The read model now.
    pub fn snapshot(&self) -> Today {
        self.desk.today().clone()
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

    /// Puts a decision at the end of the queue. It stays unanswered.
    pub fn later(&mut self, intent: DecisionRef) -> IntentOutcome {
        let before = self.desk.today().revision;
        let outcome = self.desk.later(&intent);
        if self.desk.today().revision != before {
            self.publish();
        }
        outcome
    }

    /// Reads whether an unconfirmed send or push landed. Never resends.
    pub async fn check(this: Instance<Self>, intent: DecisionRef) -> IntentOutcome {
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

    /// Asks Pilot a question about a decision; the answer joins the
    /// decision's `answers`.
    pub async fn ask(this: Instance<Self>, intent: AskIntent) -> IntentOutcome {
        let started = this.with_mut(|feed| feed.desk.begin_ask(&intent).map(|()| feed.latency));
        let latency = match started {
            Ok(latency) => latency,
            Err(outcome) => return outcome,
        };
        timer(latency).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_ask(&intent);
            feed.publish();
            outcome
        })
    }

    /// Runs the update workload: one pulse every `everyMs` (100 when left
    /// out), `count` times (300 when left out), each publishing the whole
    /// read model. Resolves with the number of pulses made. For
    /// measurements only: it is not a user intent.
    pub async fn pulse(this: Instance<Self>, every_ms: Option<u32>, count: Option<u32>) -> u32 {
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
