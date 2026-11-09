//! The class TSX holds: a read model it can mirror and intents it can
//! send. It has no transport, so the screen cannot reach a daemon through
//! it.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use crate::{
    actions::StartedAction,
    desk::{Desk, PULSE_COUNT, PULSE_EVERY},
    model::{
        ActionCheck, ActionRef, AnswerRef, AskIntent, CompleteIntent, DecideIntent, DecisionRef,
        IntentOutcome, MissionPage, MissionRef, PauseIntent, ProgressIntent, ResumeIntent,
        Scenario, Today,
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

    /// Asks Pilot a question about a decision, named at the revision the
    /// screen showed. The question joins the decision's `answers` at once,
    /// as asking; the answer follows. Help never answers the decision.
    pub async fn ask(this: Instance<Self>, intent: AskIntent) -> IntentOutcome {
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
        Self::send_action(this, |desk| desk.begin_progress(&intent)).await
    }

    /// Puts an action off. It still waits for the user.
    pub async fn action_later(this: Instance<Self>, intent: ActionRef) -> IntentOutcome {
        Self::send_action(this, |desk| desk.begin_action_later(&intent)).await
    }

    /// Reports an action done, in the user's words. Pilot keeps it as the
    /// user's report, not as proof that the action worked. A lost answer
    /// is `unknown`, and only `checkAction` can settle it.
    pub async fn complete(this: Instance<Self>, intent: CompleteIntent) -> IntentOutcome {
        Self::send_action(this, |desk| desk.begin_complete(&intent)).await
    }

    /// Reads whether an action request whose answer was lost landed. Never
    /// sends it again.
    pub async fn check_action(this: Instance<Self>, intent: ActionCheck) -> IntentOutcome {
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
        self.desk.mission(&mission_id)
    }

    /// Pauses all of a mission's work, named at the control revision the
    /// screen showed. Resolves once the service answers: paused, or still
    /// pausing with work that needs a look. A lost answer is `unknown`, and
    /// only `checkControl` can settle it.
    pub async fn pause(this: Instance<Self>, intent: PauseIntent) -> IntentOutcome {
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
