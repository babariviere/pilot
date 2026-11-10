//! The class the update page holds: Pilot's service as a read model it can
//! mirror, and the only intents that register or update it. Mock data backs
//! `UpdateFeed::new`. It has no transport and no native authority: the
//! trusted adapter over the existing updater is a separate native seam.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::{
    feed::MOCK_LATENCY,
    model::{IntentOutcome, OutcomeStatus},
    update::{
        ConfirmIntent, PrepareIntent, Prepared, ServiceView, Stage, UpdateDesk, UpdateRef,
        UpdateScenario,
    },
};

type Listeners = Rc<RefCell<Vec<(u64, Callback<ServiceView>)>>>;

/// Pilot's service, kept in Rust, and the only way to register or update
/// it. The page mirrors `snapshot()` and hears changes through `onChange`.
/// Preparing returns a one-use confirmation; confirming it starts one run.
/// A lost answer stays unknown and only `check` reads it.
#[class]
pub struct UpdateFeed {
    desk: UpdateDesk,
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl UpdateFeed {
    fn publish(&self) {
        let view = self.desk.view().clone();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(view.clone());
        }
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &UpdateDesk {
        &self.desk
    }

    /// Plays `stages` one at a time, publishing each. Returns when one ends
    /// the run or waits for the new window.
    async fn play(this: &Instance<Self>, stages: Vec<Stage>) -> IntentOutcome {
        for stage in stages {
            timer(this.with(|feed| feed.latency)).await;
            let ended = this.with_mut(|feed| {
                let ended = feed.desk.apply(stage);
                feed.publish();
                ended
            });
            if let Some(outcome) = ended {
                return outcome;
            }
        }
        this.with(|feed| IntentOutcome {
            status: OutcomeStatus::Accepted,
            revision: feed.desk.view().revision,
            message: String::new(),
        })
    }
}

#[class]
impl UpdateFeed {
    /// A feed of mock data from `scenario` (up to date when left out).
    pub fn new(scenario: Option<UpdateScenario>) -> Self {
        UpdateFeed {
            desk: UpdateDesk::new(scenario.unwrap_or_default()),
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// Pilot's service now.
    pub fn snapshot(&self) -> ServiceView {
        self.desk.view().clone()
    }

    /// Calls `listener` with the whole view after every change, until the
    /// returned function is called or its owner goes.
    pub fn on_change(&mut self, #[args(service)] listener: Callback<ServiceView>) -> Stop {
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

    /// Prepares a one-use confirmation for the update or registration shown,
    /// named by its kind and the revision shown. It starts nothing.
    pub fn prepare(&mut self, intent: PrepareIntent) -> Prepared {
        let prepared = self.desk.prepare(&intent);
        self.publish();
        prepared
    }

    /// Drops a prepared confirmation. Nothing was started.
    pub fn cancel(&mut self, intent: UpdateRef) -> IntentOutcome {
        let outcome = self.desk.cancel(&intent);
        self.publish();
        outcome
    }

    /// Confirms a prepared update once, with where the user is. Forms are
    /// saved to their own stores first, by the screen. A second confirmation
    /// is refused; a lost answer is `unknown` and nothing resends it.
    pub async fn confirm(this: Instance<Self>, intent: ConfirmIntent) -> IntentOutcome {
        let begun = this.with_mut(|feed| {
            let begun = feed.desk.begin(&intent);
            feed.publish();
            begun
        });
        match begun {
            Ok(stages) => Self::play(&this, stages).await,
            Err(outcome) => outcome,
        }
    }

    /// Reads what happened to a run whose answer was lost, or reads the
    /// service again. Lookup only: it never registers, updates or resumes.
    pub async fn check(this: Instance<Self>) -> IntentOutcome {
        let lost = this.with_mut(|feed| {
            let lost = feed.desk.begin_check();
            feed.publish();
            lost
        });
        timer(this.with(|feed| feed.latency)).await;
        this.with_mut(|feed| {
            let outcome = feed.desk.settle_check(lost);
            feed.publish();
            outcome
        })
    }

    /// Says the new window showed its saved view. Used once; then only the
    /// agents this update paused resume.
    pub async fn restored(this: Instance<Self>, intent: UpdateRef) -> IntentOutcome {
        let resumes = this.with_mut(|feed| {
            let resumes = feed.desk.restored(&intent);
            feed.publish();
            resumes
        });
        match resumes {
            Ok(true) => Self::play(&this, vec![Stage::Resume]).await,
            Ok(false) => this.with(|feed| IntentOutcome {
                status: OutcomeStatus::Accepted,
                revision: feed.desk.view().revision,
                message: String::new(),
            }),
            Err(outcome) => outcome,
        }
    }
}
