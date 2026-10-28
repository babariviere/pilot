//! The selected chat's unresolved ordinary send, shown at the conversation's end.
//! The composer owns the delivery; this only projects it, and hides it once the
//! message's own queue row or history entry (newer than when it was first shown,
//! with the exact same text) is already in the conversation. An accepted send
//! stays as Sent until then, or until the next queue update: Local commits the
//! admission before it acknowledges, so that update normally includes it.
use super::{LocalViewer, Page};
use crate::chat_editor::sending::{SENDING_KEY, Sending};
use crate::model::{Message, ReaderKey};
use crate::queued_message::Snapshot;
use gpui_kit::{App, Context};
use std::sync::Arc;

/// Newest queued submission and history entry in a conversation.
type Marks = (u64, u64);

#[derive(Default)]
pub(super) struct SendingView {
    /// What was last projected (before echo checks), for change detection.
    shown: Option<(String, Sending)>,
    /// Marks when this exact send first showed. Only newer rows can be its echo.
    baseline: Option<(String, u64, Marks)>,
    /// The queue snapshot when this send first showed as Sent.
    sent_queue: Option<(u64, Arc<Snapshot>)>,
    /// A send the conversation already replaced. It never shows again.
    replaced: Option<(String, u64)>,
}

pub(super) fn is_sending_row(row: &Message) -> bool {
    row.id() & !(SENDING_KEY - 1) == SENDING_KEY && row.reader_key().is_none()
}

fn marks(rows: &[Message]) -> Marks {
    rows.iter().fold((0, 0), |(queued, entry), row| {
        (
            queued.max(crate::local_model::queued_submission(row).unwrap_or(0)),
            entry.max(match row.reader_key() {
                Some(ReaderKey::Entry { entry, .. }) => entry,
                _ => 0,
            }),
        )
    })
}

fn newer(row: &Message, (queued, entry): Marks) -> bool {
    crate::local_model::queued_submission(row).is_some_and(|id| id > queued)
        || matches!(row.reader_key(), Some(ReaderKey::Entry { entry: e, .. }) if e > entry)
}

/// Returns the rows, and whether an accepted send was replaced.
fn project(
    view: &mut SendingView,
    mut rows: Vec<Message>,
    current: Option<(String, Sending)>,
    queue: &Arc<Snapshot>,
) -> (Vec<Message>, bool) {
    rows.retain(|row| !is_sending_row(row));
    view.shown = current.clone();
    let Some((chat, sending)) = current else {
        return (rows, false);
    };
    let sent = sending.status == "Sent";
    if view.replaced.as_ref() == Some(&(chat.clone(), sending.key)) {
        return (rows, sent);
    }
    let baseline = match &view.baseline {
        Some((owner, key, marks)) if *owner == chat && *key == sending.key => *marks,
        _ => {
            let now = marks(&rows);
            view.baseline = Some((chat.clone(), sending.key, now));
            now
        }
    };
    let mut replaced = rows.iter().any(|row| {
        row.label().starts_with("You") && row.source() == sending.text && newer(row, baseline)
    });
    if sent {
        let first = match &view.sent_queue {
            Some((key, first)) if *key == sending.key => first.clone(),
            _ => {
                view.sent_queue = Some((sending.key, queue.clone()));
                queue.clone()
            }
        };
        replaced |= !Arc::ptr_eq(&first, queue);
    }
    if replaced {
        view.replaced = Some((chat, sending.key));
    } else {
        rows.push(
            Message::live(sending.key, "You".into(), sending.text).with_pending(sending.status),
        );
    }
    (rows, replaced && sent)
}

impl LocalViewer {
    fn current_sending(&self, cx: &App) -> Option<(String, Sending)> {
        let chat = self.selected.clone()?;
        let sending = self.editor.read(cx).sending(&chat)?;
        Some((chat, sending))
    }

    /// Replaces any previous projection with the current unresolved send.
    pub(super) fn with_sending(
        &mut self,
        rows: Vec<Message>,
        queue: &Arc<Snapshot>,
        cx: &mut Context<Self>,
    ) -> Vec<Message> {
        let current = self.current_sending(cx);
        let chat = current.as_ref().map(|(chat, _)| chat.clone());
        let (rows, sent) = project(&mut self.sending_view, rows, current, queue);
        if sent && let Some(chat) = chat {
            self.editor
                .update(cx, |editor, _| editor.forget_sent(&chat));
        }
        rows
    }

    /// Editor changes re-project only when the unresolved send itself changed.
    pub(super) fn sync_sending(&mut self, cx: &mut Context<Self>) {
        if self.current_sending(cx) == self.sending_view.shown {
            return;
        }
        if let Some((rows, reset)) = self.pending_transcript.take() {
            let queue = self.state.user_queue.clone();
            let rows = self.with_sending(rows, &queue, cx);
            self.pending_transcript = Some((rows, reset));
        } else if self.page == Page::Chat {
            let rows = self.transcript.read(cx).rows().to_vec();
            let queue = self.state.user_queue.clone();
            let rows = self.with_sending(rows, &queue, cx);
            self.transcript
                .update(cx, |view, cx| view.replace_readonly(rows, false, cx));
        }
    }
}

#[cfg(test)]
#[path = "submit_visibility_tests.rs"]
mod tests;
