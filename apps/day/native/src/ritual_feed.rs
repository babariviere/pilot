//! Root-owned ritual binding. The VM cannot select a clock, profile or storage.
use crate::{
    host::{Error, NativeHost},
    model::{IntentOutcome, OutcomeStatus},
    ritual::{RitualSnapshot, RitualVisit, RitualWrite},
};
use nsh_core::prelude::*;
use std::{cell::RefCell, rc::Rc};

type Listeners = Rc<RefCell<Vec<(u64, Callback<RitualSnapshot>)>>>;

/// Native-only construction; reads are passive and writes require explicit intents.
#[class]
pub struct RitualFeed {
    host: NativeHost,
    task: Option<Spawned<()>>,
    listeners: Listeners,
    next: u64,
}
impl RitualFeed {
    /// Call under the root owner. Bootstrap must await host.close before replacement.
    pub fn from_host(host: NativeHost) -> Self {
        let changes = host.changes();
        let listeners: Listeners = Rc::default();
        let weak = Rc::downgrade(&listeners);
        let source = host.clone();
        let task = spawn(async move {
            while changes.recv().await.is_ok() {
                let Some(listeners) = weak.upgrade() else {
                    break;
                };
                let view = source.ritual_snapshot();
                for (_, listener) in listeners.borrow().iter() {
                    listener.post(view.clone());
                }
            }
        });
        Self {
            host,
            task: Some(task),
            listeners,
            next: 0,
        }
    }
    async fn result(
        host: NativeHost,
        result: async_channel::Receiver<Result<IntentOutcome, Error>>,
    ) -> IntentOutcome {
        match result.recv().await {
            Ok(Ok(outcome)) => outcome,
            error => IntentOutcome {
                status: match error {
                    Ok(Err(Error::Unknown)) | Err(_) => OutcomeStatus::Unknown,
                    Ok(Err(Error::Stale | Error::Identity)) => OutcomeStatus::Stale,
                    _ => OutcomeStatus::Rejected,
                },
                revision: host.ritual_snapshot().revision,
                message: "Progress could not be confirmed. Read again; nothing is resent.".into(),
            },
        }
    }
}
impl Drop for RitualFeed {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.cancel();
        }
    }
}
#[class]
impl RitualFeed {
    /// Last native read. Mirror it and subscribe to changes.
    pub fn snapshot(&self) -> RitualSnapshot {
        self.host.ritual_snapshot()
    }
    /// Listen until this owner or the returned stop handle is disposed.
    pub fn on_change(&mut self, #[args(ritual)] listener: Callback<RitualSnapshot>) -> Stop {
        let id = self.next;
        self.next += 1;
        self.listeners.borrow_mut().push((id, listener));
        let weak = Rc::downgrade(&self.listeners);
        Stop::new(move || {
            if let Some(listeners) = weak.upgrade() {
                listeners.borrow_mut().retain(|(n, _)| *n != id);
            }
        })
    }
    /// Passive local read, including a fresh native date/time-zone sample.
    pub async fn refresh(this: Instance<Self>) -> IntentOutcome {
        let host = this.with(|feed| feed.host.clone());
        let result = host.read_ritual();
        Self::result(host, result).await
    }
    /// Refresh the bounded kept-change evidence. Unavailable never means no results.
    pub async fn refresh_results(this: Instance<Self>) -> IntentOutcome {
        let host = this.with(|feed| feed.host.clone());
        let result = host.read_ritual_results();
        Self::result(host, result).await
    }
    /// Acknowledge an actual presentation of Today, never a background read.
    pub async fn visit(this: Instance<Self>, intent: RitualVisit) -> IntentOutcome {
        let host = this.with(|feed| feed.host.clone());
        let result = host.visit_day(intent);
        Self::result(host, result).await
    }
    /// Save an explicit step, Done or Skip. Escape sends nothing.
    pub async fn save(this: Instance<Self>, intent: RitualWrite) -> IntentOutcome {
        let host = this.with(|feed| feed.host.clone());
        let result = host.save_ritual(intent);
        Self::result(host, result).await
    }
}
