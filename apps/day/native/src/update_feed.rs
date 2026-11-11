//! The class the update page holds: Pilot's service as a read model it can
//! mirror, and the only intents that register or update it. Mock data backs
//! `UpdateFeed::new` grants no native authority. The native-only factory
//! uses the canonical window's existing bridge, gate and updater adapter.

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
    native: Option<crate::host::NativeHost>,
    native_window: Option<crate::bridge::UpdateWindow>,
    _watch_task: Option<Spawned<()>>,
    desk: UpdateDesk,
    listeners: Listeners,
    next_listener: u64,
    latency: Duration,
}

impl UpdateFeed {
    fn publish(&self) {
        let view = self
            .native
            .as_ref()
            .map_or_else(|| self.desk.view().clone(), |h| h.update_snapshot());
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(view.clone());
        }
    }

    /// The feed's owner, for a Rust screen or a test.
    pub fn desk(&self) -> &UpdateDesk {
        &self.desk
    }

    /// Native-only factory. Shares the canonical root's worker, journal and
    /// awaited close. No target, transport or credentials are exported to TSX.
    pub fn from_host(window: crate::bridge::UpdateWindow) -> Self {
        let host = window.host();
        let listeners: Listeners = Rc::default();
        let weak = Rc::downgrade(&listeners);
        let changes = host.changes();
        let read = window.request(crate::bridge::Command::UpdateRead);
        let selected = host.clone();
        let watch_task = spawn(async move {
            let _ = read.recv().await;
            while changes.recv().await.is_ok() {
                let Some(listeners) = weak.upgrade() else {
                    break;
                };
                for (_, listener) in listeners.borrow().iter() {
                    listener.post(selected.update_snapshot());
                }
            }
        });
        Self {
            native: Some(host),
            native_window: Some(window),
            _watch_task: Some(watch_task),
            desk: UpdateDesk::new(UpdateScenario::Current),
            listeners,
            next_listener: 0,
            latency: Duration::ZERO,
        }
    }

    async fn native_result(
        window: crate::bridge::UpdateWindow,
        command: crate::bridge::Command,
    ) -> IntentOutcome {
        let host = window.host();
        window
            .request(command)
            .recv()
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_else(|| IntentOutcome {
                status: OutcomeStatus::Unknown,
                revision: host.update_snapshot().revision,
                message: "Native result unavailable. Check only; nothing is resent.".into(),
            })
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
            native: None,
            native_window: None,
            _watch_task: None,
            desk: UpdateDesk::new(scenario.unwrap_or_default()),
            listeners: Rc::default(),
            next_listener: 0,
            latency: MOCK_LATENCY,
        }
    }

    /// Pilot's service now.
    pub fn snapshot(&self) -> ServiceView {
        self.native
            .as_ref()
            .map_or_else(|| self.desk.view().clone(), |h| h.update_snapshot())
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
        if let Some(window) = &self.native_window {
            let _ = window.request(crate::bridge::Command::UpdatePrepare(intent));
            return Prepared {
                status: OutcomeStatus::Accepted,
                message: "Preparing the exact native confirmation.".into(),
                confirmation: None,
            };
        }
        let prepared = self.desk.prepare(&intent);
        self.publish();
        prepared
    }

    /// Drops a prepared confirmation. Nothing was started.
    pub fn cancel(&mut self, intent: UpdateRef) -> IntentOutcome {
        if let Some(window) = &self.native_window {
            let _ = window.request(crate::bridge::Command::UpdateCancel(intent));
            return IntentOutcome {
                status: OutcomeStatus::Accepted,
                revision: window.host().update_snapshot().revision,
                message: "Cancellation requested.".into(),
            };
        }
        let outcome = self.desk.cancel(&intent);
        self.publish();
        outcome
    }

    /// Confirms a prepared update once, with where the user is. Forms are
    /// saved to their own stores first, by the screen. A second confirmation
    /// is refused; a lost answer is `unknown` and nothing resends it.
    pub async fn confirm(this: Instance<Self>, intent: ConfirmIntent) -> IntentOutcome {
        if let Some(window) = this.with(|f| f.native_window.clone()) {
            return Self::native_result(window, crate::bridge::Command::UpdateConfirm(intent))
                .await;
        }
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
        if let Some(window) = this.with(|f| f.native_window.clone()) {
            return Self::native_result(window, crate::bridge::Command::UpdateCheck).await;
        }
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

    /// Says the new window showed its saved view. It is display-only, in
    /// the mock rules too: it never resumes, starts or sends anything. The
    /// service owns exact selective execution recovery.
    pub async fn restored(this: Instance<Self>, intent: UpdateRef) -> IntentOutcome {
        if let Some(window) = this.with(|f| f.native_window.clone()) {
            return Self::native_result(window, crate::bridge::Command::UpdateRestored(intent))
                .await;
        }
        this.with_mut(|feed| {
            let restored = feed.desk.restored(&intent);
            feed.publish();
            restored.map_or_else(
                |outcome| outcome,
                |()| IntentOutcome {
                    status: OutcomeStatus::Accepted,
                    revision: feed.desk.view().revision,
                    message: String::new(),
                },
            )
        })
    }
}
