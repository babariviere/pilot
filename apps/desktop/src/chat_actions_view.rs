//! Quiet per-window status and bounded non-replayable operation ownership.
#[cfg(test)]
#[path = "chat_actions_inspection_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    chat_actions::{Action, Evidence, Failure, Outcome, Report, Target},
    chat_actions_worker::Worker,
};
use gpui_kit::{
    Context, EventEmitter, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    Styled, TestSupportExt, Window, div,
};
use std::collections::BTreeMap;

pub(crate) struct Changed;
pub(crate) struct Actions {
    pub(crate) options: Option<LocalOptions>,
    pub(crate) worker: Option<Worker>,
    reports: BTreeMap<String, Report>,
    latest: Option<String>,
    error: Option<Failure>,
    next: u64,
    pub(crate) rename_observers: BTreeMap<String, gpui_kit::Subscription>,
    pub(crate) latest_rename: Option<String>,
    pub(crate) renames: BTreeMap<String, gpui_kit::Entity<crate::chat_rename_view::Rename>>,
}
impl EventEmitter<Changed> for Actions {}
impl Actions {
    pub(crate) fn new(_: &mut Context<Self>) -> Self {
        Self {
            options: None,
            worker: None,
            reports: BTreeMap::new(),
            latest: None,
            error: None,
            next: 0,
            renames: BTreeMap::new(),
            latest_rename: None,
            rename_observers: BTreeMap::new(),
        }
    }
    pub(crate) fn connect(&mut self, options: LocalOptions, cx: &mut Context<Self>) {
        // This owner is pinned once. Reconnecting to another home requires a new viewer.
        if self.options.is_some() {
            return;
        }
        match Worker::start(options.clone()) {
            Ok(worker) => {
                self.options = Some(options);
                self.worker = Some(worker);
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }
    pub(crate) fn error(&mut self, error: Failure, cx: &mut Context<Self>) {
        self.error = Some(error);
        cx.notify();
    }
    pub(crate) fn blocked(&self, id: &str) -> bool {
        self.blocked_reason(id).is_some()
    }
    pub(crate) fn blocked_reason(&self, id: &str) -> Option<Failure> {
        if self
            .reports
            .get(id)
            .is_some_and(|r| r.outcome == Some(Outcome::Unknown))
        {
            Some("Earlier action unconfirmed. Do not repeat it.")
        } else if self.reports.values().any(|r| r.outcome.is_none()) {
            Some("A chat action is still pending.")
        } else if !self.reports.contains_key(id) && self.reports.len() >= 16 {
            Some("This window has reached its chat-action report limit.")
        } else {
            None
        }
    }
    pub(crate) fn read_only(&self, id: &str) -> bool {
        self.reports.get(id).is_some_and(|r| {
            r.evidence.archive && matches!(r.outcome, None | Some(Outcome::Unknown))
                || (r.evidence.archive
                    && r.outcome == Some(Outcome::Acknowledged)
                    && !r.observed_current)
        })
    }
    pub(crate) fn observe(&mut self, chats: &[crate::local_model::Chat]) {
        for r in self.reports.values_mut() {
            if r.outcome == Some(Outcome::Acknowledged)
                && chats.iter().any(|c| {
                    c.id == r.evidence.target.chat.id
                        && c.project_id == r.evidence.target.chat.project_id
                        && c.archived == r.evidence.archive
                })
            {
                r.observed_current = true;
            }
        }
    }
    pub(crate) fn inspection_ack(&self, id: &str) -> Option<u64> {
        self.reports
            .get(id)
            .filter(|r| r.outcome == Some(Outcome::Acknowledged))
            .map(|r| r.id)
    }
    pub(crate) fn inspected(&mut self, evidence: &Evidence, known_ack: Option<u64>) {
        if let Some(r) = self.reports.get_mut(&evidence.target.chat.id)
            && known_ack == Some(r.id)
            && r.evidence.target.host == evidence.target.host
            && r.evidence.target.home == evidence.target.home
            && r.evidence.target.endpoint == evidence.target.endpoint
            && r.evidence.target.chat.project_id == evidence.target.chat.project_id
            && r.evidence.target.chat.cwd == evidence.target.chat.cwd
            && r.outcome == Some(Outcome::Acknowledged)
        {
            // Only a read ADMITTED AFTER this exact ACK can release its temporary
            // editor fence. A queued pre-ACK read, a new operation or Unknown cannot.
            r.observed_current = true;
        }
    }
    pub(crate) fn submit(
        &mut self,
        evidence: Evidence,
        action: Action,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.blocked(&evidence.target.chat.id) {
            return;
        }
        let eligible = if action == Action::Retry {
            evidence.can_retry_startup
        } else {
            evidence.can_archive
        };
        if !eligible {
            return;
        }
        let result = self
            .worker
            .as_ref()
            .ok_or("Local chat actions are unavailable.")
            .and_then(|worker| worker.set(evidence.clone(), action));
        let rx = match result {
            Ok(rx) => rx,
            Err(error) => {
                self.error(error, cx);
                return;
            }
        };
        self.next = self.next.checked_add(1).expect("chat action id exhausted");
        let id = self.next;
        let key = evidence.target.chat.id.clone();
        self.reports.insert(
            key.clone(),
            Report {
                id,
                evidence: evidence.clone(),
                outcome: None,
                observed_current: false,
            },
        );
        self.latest = Some(key.clone());
        self.error = None;
        cx.emit(Changed);
        cx.notify();
        cx.spawn_in(w, async move |owner, cx| {
            let outcome = rx.recv().await.unwrap_or(Outcome::Unknown);
            let _ = owner.update(cx, |owner, cx| {
                if owner
                    .reports
                    .get_mut(&key)
                    .is_some_and(|r| r.finish(id, &evidence, outcome))
                {
                    cx.emit(Changed);
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(crate) fn target(&self, chat: crate::local_model::Chat) -> Option<Target> {
        self.options.as_ref().map(|o| Target::new(o, chat))
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn outcome(&self, id: &str) -> Option<&Outcome> {
        self.reports.get(id)?.outcome.as_ref()
    }
}
impl Render for Actions {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::ui::{Notice, Tone};
        let report = self.latest.as_ref().and_then(|id| self.reports.get(id));
        div().id("chat-action-status").test_support().w_full().min_w_0()
            .children(report.map(|r| {
                let verb = if r.evidence.archive { "Archive" } else { "Restore" };
                let (status, detail, tone) = match r.outcome {
                    None => ("Pending", "Waiting for Local. This request will not be retried automatically.", Tone::Quiet),
                    Some(Outcome::Acknowledged) => ("Confirmed", "Local acknowledged this action. History and drafts are kept.", Tone::Success),
                    Some(Outcome::Rejected(error)) => ("Not submitted", error, Tone::Error),
                    Some(Outcome::Unknown) => ("Unconfirmed", "No valid acknowledgment. Do not repeat this action. Check this exact chat in Swift; later visibility is not a receipt.", Tone::Warning),
                };
                div().p_2().child(Notice::new(SharedString::from(format!("{verb} · {status}")))
                    .detail(SharedString::from(format!("{} ({})\n{detail}", r.evidence.target.chat.title, r.evidence.target.chat.id))).tone(tone))
            }))
            .children(self.latest_rename.as_ref().and_then(|id| self.renames.get(id)).and_then(|form| form.read(cx).status()).map(|(text,tone)|div().p_2().child(Notice::new(text).tone(tone))))
            .children(self.error.map(|e| div().p_2().child(Notice::new(e).tone(Tone::Error))))
    }
}
