//! The failed chat's Retry: one eligibility read, then the shared non-replayable
//! chat action. A startup failure reloads its worker (`retry-startup`); a failed
//! turn uses Swift's failed-turn Retry (`rewind` with `retry`). Never automatic.
use super::*;
use crate::{
    chat_actions::{Action, Evidence, Failure as Refusal},
    chat_actions_view::RetryView,
    session_failure::Failure,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RetryOffer {
    View(RetryView),
    /// Shown disabled with this reason. Nothing can be submitted.
    Unavailable(Refusal),
}

const CHANGED: Refusal = "This failure changed. Nothing was submitted.";
const INELIGIBLE: Refusal = "This failure can no longer be retried here. Nothing was submitted.";

impl LocalViewer {
    /// Retry for the shown failure, or None when this chat offers none (earlier
    /// failures, read-only history, no Local chat actions).
    pub(super) fn failure_retry(&self, failure: &Failure, cx: &App) -> Option<RetryOffer> {
        let id = self.selected.as_deref()?;
        let chat = self.state.chats.iter().find(|c| c.id == id)?;
        let actions = self.chat_actions.read(cx);
        if !chat.writable
            || actions.options.is_none()
            || self.session_failure_fence.historical(failure)
        {
            return None;
        }
        let connected = self.state.status.starts_with("Connected")
            || self.state.status.starts_with("Synthetic");
        let unavailable = if !connected {
            Some("Reconnect to Local to retry.")
        } else if self.editor.read(cx).waiting_for(&format!("chat:{id}")) {
            Some("Wait until your last message is confirmed.")
        } else if failure.startup {
            None
        } else if failure.next_model {
            // pilotd applies a saved choice only to a startup retry or a new message.
            Some("Your saved model applies to the next message you send. Send one to continue.")
        } else if !self.state.loaded {
            Some("Loading the conversation.")
        } else if self.state.retry_entry.is_none() {
            Some("This failure has no turn to retry. Send a message to continue.")
        } else {
            None
        };
        // This chat's own pending, sent and unconfirmed outcomes come first.
        Some(match (actions.retry_view(id, failure.at), unavailable) {
            (RetryView::Ready | RetryView::Failed(_), Some(reason)) => {
                RetryOffer::Unavailable(reason)
            }
            (view, _) => RetryOffer::View(view),
        })
    }

    pub(super) fn retry_failure(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(failure) = self.selected_failure().cloned() else {
            return;
        };
        if !matches!(
            self.failure_retry(&failure, cx),
            Some(RetryOffer::View(RetryView::Ready | RetryView::Failed(_)))
        ) {
            return;
        }
        let entry = if failure.startup {
            None
        } else {
            self.state.retry_entry
        };
        let Some(id) = self.selected.clone() else {
            return;
        };
        let Some(chat) = self
            .state
            .chats
            .iter()
            .find(|c| c.id == id && !c.local_draft)
            .cloned()
        else {
            return;
        };
        let Some(target) = self.chat_actions.read(cx).target(chat) else {
            return;
        };
        if !self.chat_action_ready(&target, w, cx) {
            return self.retry_refused(
                &id,
                "This chat changed or Local is unavailable. Nothing was submitted.",
                cx,
            );
        }
        let Some(token) = self
            .chat_actions
            .update(cx, |a, _| a.begin_retry_check(&id, failure.at))
        else {
            return;
        };
        let known_ack = self.chat_actions.read(cx).inspection_ack(&id);
        let rx = self
            .chat_actions
            .read(cx)
            .worker
            .as_ref()
            .ok_or("Chat actions aren't available right now.")
            .and_then(|worker| worker.inspect(target));
        let rx = match rx {
            Ok(rx) => rx,
            Err(error) => {
                self.chat_actions
                    .update(cx, |a, _| a.end_retry_check(token, &id));
                return self.retry_refused(&id, error, cx);
            }
        };
        self.chat_actions.update(cx, |_, cx| cx.notify());
        cx.notify();
        let generation = self.generation;
        cx.spawn_in(w, async move |v, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Chat actions aren't available right now."));
            let _ = v.update_in(cx, |v, w, cx| {
                v.retry_inspected(
                    (token, &id, generation),
                    &failure,
                    entry,
                    known_ack,
                    result,
                    w,
                    cx,
                )
            });
        })
        .detach();
    }

    #[allow(clippy::too_many_arguments)]
    fn retry_inspected(
        &mut self,
        (token, id, generation): (u64, &str, u64),
        failure: &Failure,
        entry: Option<u64>,
        known_ack: Option<u64>,
        result: Result<Evidence, Refusal>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self
            .chat_actions
            .update(cx, |a, _| a.end_retry_check(token, id))
        {
            return;
        }
        cx.notify();
        let evidence = match result {
            Ok(evidence) => evidence,
            // The row menu's wording; here the failure itself is what changed.
            Err(crate::chat_actions::CHANGED | crate::chat_actions::INELIGIBLE) => {
                return self.retry_refused(id, CHANGED, cx);
            }
            Err(error) => return self.retry_refused(id, error, cx),
        };
        self.chat_actions
            .update(cx, |a, _| a.inspected(&evidence, known_ack));
        // Navigating away abandons the request before anything was submitted.
        if self.selected.as_deref() != Some(id) || self.generation != generation {
            return;
        }
        // The exact failure, attempt and failed turn the user saw, still current.
        let current = self.selected_failure() == Some(failure)
            && !self.session_failure_fence.historical(failure)
            && (failure.startup || self.state.retry_entry == entry)
            && matches!(
                self.failure_retry(failure, cx),
                Some(RetryOffer::View(RetryView::Ready | RetryView::Failed(_)))
            );
        if !current {
            return self.retry_refused(id, CHANGED, cx);
        }
        let action = match entry {
            None if evidence.can_retry_startup => Action::Retry,
            Some(entry) if evidence.can_retry_turn => Action::RetryTurn(entry),
            _ => return self.retry_refused(id, INELIGIBLE, cx),
        };
        self.chat_row_action(evidence, action, w, cx);
    }

    fn retry_refused(&mut self, id: &str, error: Refusal, cx: &mut Context<Self>) {
        self.chat_actions.update(cx, |a, cx| {
            a.retry_failed(id, error);
            cx.notify();
        });
        cx.notify();
    }
}
