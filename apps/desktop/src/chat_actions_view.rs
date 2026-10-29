//! Quiet per-window status and non-replayable operation ownership.
#[cfg(test)]
#[path = "chat_actions_restore_tests.rs"]
mod restore_tests;
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

const PENDING: Failure = "A chat action is still pending.";
const RESTORE_UNKNOWN: Failure =
    "Restore wasn't confirmed. Don't repeat it. Check this chat in Swift.";
const ARCHIVE_UNKNOWN: Failure =
    "Archiving wasn't confirmed. Don't repeat it. Check this chat in Swift.";

/// What the archived chat's notice offers. Derived from the shared reports, so a
/// row-menu Restore and the notice's Restore show the same state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestoreView {
    Ready,
    /// Checking eligibility or waiting for Local's answer.
    Busy,
    /// Acknowledged; the chat list doesn't show it open yet.
    Restored,
    /// Nothing was submitted. Restore may be tried again.
    Failed(Failure),
    /// Unconfirmed, or another chat action is pending. Not offered.
    Blocked(Failure),
}

/// The archived notice's own eligibility check, before the shared submit.
#[derive(Default)]
pub(crate) struct Restore {
    checking: Option<(u64, String)>,
    error: Option<(String, Failure)>,
    /// The chat whose Restore the user pressed; its composer takes focus once.
    focus: Option<String>,
    /// The selected archived chat whose notice shows its own status.
    inline: Option<String>,
    next: u64,
    pub(crate) notice_focus: Option<gpui_kit::FocusHandle>,
}

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
    pub(crate) restore: Restore,
}
impl EventEmitter<Changed> for Actions {}
impl Actions {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn restart_safe(&self) -> bool {
        self.renames.is_empty()
            && self.reports.values().all(|r| {
                matches!(
                    r.outcome,
                    Some(Outcome::Acknowledged | Outcome::Rejected(_))
                )
            })
    }
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
            restore: Restore::default(),
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
            .ok_or("Chat actions aren't available right now.")
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
    pub(crate) fn restore_view(&self, id: &str) -> RestoreView {
        if let Some((_, chat)) = &self.restore.checking {
            return if chat == id {
                RestoreView::Busy
            } else {
                RestoreView::Blocked(PENDING)
            };
        }
        if let Some(r) = self.reports.get(id) {
            match (&r.outcome, r.evidence.archive) {
                (None, false) => return RestoreView::Busy,
                (Some(Outcome::Acknowledged), false) if !r.observed_current => {
                    return RestoreView::Restored;
                }
                (Some(Outcome::Rejected(error)), false) => return RestoreView::Failed(error),
                (Some(Outcome::Unknown), false) => return RestoreView::Blocked(RESTORE_UNKNOWN),
                (Some(Outcome::Unknown), true) => return RestoreView::Blocked(ARCHIVE_UNKNOWN),
                _ => {}
            }
        }
        if self.reports.values().any(|r| r.outcome.is_none()) {
            return RestoreView::Blocked(PENDING);
        }
        match &self.restore.error {
            Some((chat, error)) if chat == id => RestoreView::Failed(error),
            _ => RestoreView::Ready,
        }
    }
    /// Starts the one eligibility check for this exact chat, when Restore is offered.
    pub(crate) fn begin_restore_check(&mut self, id: &str) -> Option<u64> {
        if !matches!(
            self.restore_view(id),
            RestoreView::Ready | RestoreView::Failed(_)
        ) {
            return None;
        }
        // A rejected request submitted nothing; this explicit retry replaces it.
        if self
            .reports
            .get(id)
            .is_some_and(|r| matches!(r.outcome, Some(Outcome::Rejected(_))))
        {
            self.reports.remove(id);
        }
        self.restore.next += 1;
        self.restore.checking = Some((self.restore.next, id.to_owned()));
        self.restore.error = None;
        self.restore.focus = Some(id.to_owned());
        Some(self.restore.next)
    }
    /// False for a stale or repeated completion, which must not submit anything.
    pub(crate) fn end_restore_check(&mut self, token: u64, id: &str) -> bool {
        if self
            .restore
            .checking
            .as_ref()
            .is_some_and(|(t, chat)| *t == token && chat == id)
        {
            self.restore.checking = None;
            return true;
        }
        false
    }
    pub(crate) fn restore_failed(&mut self, id: &str, error: Failure) {
        self.restore.error = Some((id.to_owned(), error));
    }
    /// Whether the composer of `id` should take focus after its confirmed restore.
    /// Any other chat's composer clears the intent: the user moved on.
    pub(crate) fn take_restore_focus(&mut self, id: &str) -> bool {
        self.restore.focus.take().is_some_and(|chat| chat == id)
    }
    /// Returns whether the inline target changed.
    pub(crate) fn show_inline(&mut self, id: Option<&str>) -> bool {
        if self.restore.inline.as_deref() == id {
            return false;
        }
        self.restore.inline = id.map(str::to_owned);
        true
    }
    fn sidebar_report(&self) -> Option<&Report> {
        self.latest
            .as_ref()
            .filter(|id| self.restore.inline.as_ref() != Some(*id))
            .and_then(|id| self.reports.get(id))
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn outcome(&self, id: &str) -> Option<&Outcome> {
        self.reports.get(id)?.outcome.as_ref()
    }
}
impl Render for Actions {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::ui::{Notice, Tone};
        // The selected archived chat's notice shows its own status beside Restore.
        let report = self.sidebar_report();
        div().id("chat-action-status").test_support().w_full().min_w_0()
            .children(report.and_then(|r| {
                let verb = if r.evidence.archive { "Archive" } else { "Restore" };
                let (status, detail, tone) = match r.outcome {
                    None => ("Pending", "Waiting for Local. This request will not be retried automatically.", Tone::Quiet),
                    // Keep the exact ACK/report for fences and inspection, not routine success chrome.
                    Some(Outcome::Acknowledged) => return None,
                    Some(Outcome::Rejected(error)) => ("Not submitted", error, Tone::Error),
                    Some(Outcome::Unknown) => ("Unconfirmed", "No valid acknowledgment. Do not repeat this action. Check this exact chat in Swift; later visibility is not a receipt.", Tone::Warning),
                };
                Some(div().p_2().child(Notice::new(SharedString::from(format!("{verb} · {status}")))
                    .detail(SharedString::from(format!("{} ({})\n{detail}", r.evidence.target.chat.title, r.evidence.target.chat.id))).tone(tone)))
            }))
            .children(self.latest_rename.as_ref().and_then(|id| self.renames.get(id)).and_then(|form| form.read(cx).status()).map(|(text,tone)|div().p_2().child(Notice::new(text).tone(tone))))
            .children(self.error.map(|e| div().p_2().child(Notice::new(e).tone(Tone::Error))))
    }
}
