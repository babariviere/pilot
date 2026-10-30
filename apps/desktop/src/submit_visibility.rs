//! The selected chat's unresolved ordinary sends. The composer owns delivery;
//! this only projects it. A send submitted while the chat is busy (or first seen
//! already in progress, as when recovered after a restart) shows read-only above
//! the editor, where its queue row will appear; one submitted to an idle chat
//! shows at the end of the conversation. Placement is decided once per send, so
//! rows never move between the two while unresolved.
//!
//! A send hides once its own echo arrives: a queue row or history entry newer
//! than when it was first shown, with the exact same text. Each echo row belongs
//! to one send, oldest first, so identical texts keep their count, and a send
//! keeps the exact row it claimed (queue ID, then history entry). The queue and
//! history streams carry no operation link, so a queue echo continues as the
//! next unclaimed exact-text history entry: presentation only, never proof. It
//! never settles a delivery, and an echo already present when a send is first
//! seen (a restart) is not recognised. An accepted send stays as Sent until its
//! echo, even after newer sends.
use super::*;
use crate::chat_editor::sending::{SENDING_KEY, Sending};
use crate::model::{Message, ReaderKey};
use crate::queued_message::Snapshot;
use gpui_kit::{AnyElement, Pixels, StatefulInteractiveElement};
use std::collections::HashMap;
use std::sync::Arc;

/// Newest queued submission and history entry in a conversation.
type Marks = (u64, u64);

/// The exact row a send's echo is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Echo {
    Queued(u64),
    Entry(u64),
}

fn echo_of(row: &Message) -> Option<Echo> {
    crate::local_model::queued_submission(row)
        .map(Echo::Queued)
        .or(match row.reader_key() {
            Some(ReaderKey::Entry { entry, .. }) => Some(Echo::Entry(entry)),
            _ => None,
        })
}

struct Unresolved {
    sending: Sending,
    /// Marks when this send first showed. Only newer rows can be its echo.
    baseline: Marks,
    /// Shown above the editor rather than in the conversation.
    tray: bool,
    /// The row that replaced it. Kept while the editor still shows this send
    /// (so it never shows again), while that queue row can still become a newer
    /// history entry, or while a same-text send waits, so the row is never
    /// taken for another send's echo.
    echo: Option<Echo>,
}

#[derive(Default)]
pub(super) struct SendingView {
    /// Canonical queue rows live above the editor, not in the history scroller.
    pub(super) queued: Vec<Message>,
    /// Unresolved sends shown above the editor, and the chat they belong to.
    tray: (Option<String>, Vec<Message>),
    /// What was last projected (before echo checks), for change detection.
    shown: Option<(String, Sending)>,
    /// Per chat, oldest first. A chat leaves once nothing remains.
    chats: HashMap<String, Vec<Unresolved>>,
}

impl SendingView {
    /// The selected chat's unresolved sends above the editor, oldest first.
    /// Read-only: they are not queue rows and have no queue actions.
    pub(super) fn pending_rows(&self, selected: Option<&str>) -> &[Message] {
        match &self.tray {
            (Some(chat), rows) if Some(chat.as_str()) == selected => rows,
            _ => &[],
        }
    }
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

/// Returns the rows with the idle-submitted sends after them, and whether the
/// editor's accepted send was replaced (so it may forget the text). Sends
/// submitted while busy go to the tray slot.
fn project(
    view: &mut SendingView,
    mut rows: Vec<Message>,
    chat: Option<&str>,
    current: Option<Sending>,
    busy: bool,
) -> (Vec<Message>, bool) {
    rows.retain(|row| !is_sending_row(row));
    view.shown = chat.zip(current.clone()).map(|(c, s)| (c.into(), s));
    view.tray = (chat.map(Into::into), Vec::new());
    let Some(chat) = chat else {
        return (rows, false);
    };
    let sends = view.chats.entry(chat.into()).or_default();
    let key = current.as_ref().map(|s| s.key);
    // A send that left the editor unaccepted (refused, rejected, abandoned) has
    // no echo coming; an accepted one keeps showing as Sent until its echo.
    sends.retain_mut(|u| match &current {
        Some(s) if s.key == u.sending.key => {
            u.sending = s.clone();
            true
        }
        _ => u.echo.is_some() || u.sending.status == "Sent",
    });
    if let Some(s) = current
        && !sends.iter().any(|u| u.sending.key == s.key)
    {
        sends.push(Unresolved {
            baseline: marks(&rows),
            tray: busy || s.status != "Sending…",
            echo: None,
            sending: s,
        });
    }
    // Claimed echoes keep their exact row.
    let mut claimed = vec![false; rows.len()];
    let mut found: Vec<bool> = sends
        .iter()
        .map(|u| {
            let ix = u
                .echo
                .and_then(|e| rows.iter().position(|r| echo_of(r) == Some(e)));
            ix.inspect(|&ix| claimed[ix] = true).is_some()
        })
        .collect();
    // Oldest first, a send without its row claims the first unclaimed newer
    // exact-text row. A queue echo that left continues only as a history entry,
    // never as another queue row; a history echo that left is gone.
    for (u, found) in sends.iter_mut().zip(&mut found) {
        if *found || matches!(u.echo, Some(Echo::Entry(_))) {
            continue;
        }
        let history_only = u.echo.is_some();
        let ix = (0..rows.len()).find(|&ix| {
            let row = &rows[ix];
            !claimed[ix]
                && row.label().starts_with("You")
                && row.source() == u.sending.text
                && newer(row, u.baseline)
                && (!history_only || matches!(echo_of(row), Some(Echo::Entry(_))))
        });
        if let Some(ix) = ix {
            claimed[ix] = true;
            *found = true;
            u.echo = echo_of(&rows[ix]);
        }
    }
    let forget = sends
        .iter()
        .any(|u| Some(u.sending.key) == key && u.echo.is_some() && u.sending.status == "Sent");
    let waiting: Vec<String> = sends
        .iter()
        .filter(|u| u.echo.is_none())
        .map(|u| u.sending.text.clone())
        .collect();
    let mut found = found.into_iter();
    sends.retain(|u| {
        let found = found.next().unwrap_or(false);
        match u.echo {
            None => true,
            _ if Some(u.sending.key) == key => true,
            Some(Echo::Queued(_)) => found,
            Some(Echo::Entry(_)) => found && waiting.contains(&u.sending.text),
        }
    });
    for u in sends.iter().filter(|u| u.echo.is_none()) {
        let row = Message::live(u.sending.key, "You".into(), u.sending.text.clone())
            .with_pending(u.sending.status);
        if u.tray {
            view.tray.1.push(row);
        } else {
            rows.push(row);
        }
    }
    if sends.is_empty() {
        view.chats.remove(chat);
    }
    (rows, forget)
}

/// One unresolved send above the editor, beside the queue rows: its delivery
/// state and text, read-only (no actions). The queue tray places it. Tooltips
/// explain Sent and show the whole message; they grant no authority.
pub(super) fn pending_send_row(row: &Message, height: Pixels, cx: &App) -> AnyElement {
    use gpui_kit::component::tooltip::Tooltip;
    let id = row.id();
    let status = row.pending().unwrap_or("Sending…");
    let text = SharedString::from(row.source().to_owned());
    let preview = row
        .source()
        .chars()
        .take(160)
        .collect::<String>()
        .replace('\n', " ");
    div()
        .id(SharedString::from(format!("composer-pending-{id}")))
        .test_support()
        .h_flex()
        .w_full()
        .min_w_0()
        .h(height)
        .flex_shrink_0()
        .px_1()
        .gap_2()
        .child(
            div()
                .id(("pending-status", id))
                .test_support()
                .aria_label(status)
                .flex_none()
                .text_color(cx.theme().muted_foreground)
                .when(status == "Sent", |s| {
                    s.tooltip(|w, cx| {
                        Tooltip::new("Accepted by Local, not yet in the conversation.").build(w, cx)
                    })
                })
                .child(crate::ui::text(crate::ui::Text::Caption, status)),
        )
        .child(
            crate::ui::text(crate::ui::Text::Body, SharedString::from(preview))
                .id(("pending-preview", id))
                .test_support()
                .flex_1()
                .min_w_0()
                .truncate()
                .tooltip(move |w, cx| Tooltip::new(text.clone()).build(w, cx)),
        )
        .into_any_element()
}

impl LocalViewer {
    /// Only an admitted, local ordinary submit can arm arrival. Echo matching
    /// below is presentation-only, so never transfer motion by matching text.
    pub(super) fn sent_arrival(
        &mut self,
        chat: &str,
        id: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.page != Page::Chat || self.selected.as_deref() != Some(chat) {
            return;
        }
        self.transcript.update(cx, |view, cx| {
            if view
                .rows()
                .iter()
                .any(|r| r.id() == id && is_sending_row(r))
            {
                view.arrive(id, w, cx);
            }
        });
    }

    fn current_sending(&self, cx: &App) -> Option<(String, Sending)> {
        let chat = self.selected.clone()?;
        let sending = self.editor.read(cx).sending(&chat)?;
        Some((chat, sending))
    }

    /// Replaces any previous projection with the current unresolved sends. A
    /// queue snapshot alone is never an echo: only a matching row replaces a send.
    pub(super) fn with_sending(
        &mut self,
        rows: Vec<Message>,
        _queue: &Arc<Snapshot>,
        cx: &mut Context<Self>,
    ) -> Vec<Message> {
        let chat = self.selected.clone();
        let current = self.current_sending(cx).map(|(_, sending)| sending);
        let busy = self.state.queued > 0
            || chat
                .as_ref()
                .is_some_and(|id| self.state.chats.iter().any(|c| &c.id == id && c.busy));
        let (rows, forget) = project(&mut self.sending_view, rows, chat.as_deref(), current, busy);
        if forget && let Some(chat) = chat {
            self.editor
                .update(cx, |editor, _| editor.forget_sent(&chat));
        }
        let (queued, history) = rows
            .into_iter()
            .partition(|row| crate::local_model::queued_submission(row).is_some());
        self.sending_view.queued = queued;
        history
    }

    /// Editor changes re-project only when the unresolved send itself changed.
    pub(super) fn sync_sending(&mut self, cx: &mut Context<Self>) {
        if self.current_sending(cx) == self.sending_view.shown {
            return;
        }
        let queue = self.state.user_queue.clone();
        if let Some((mut rows, reset)) = self.pending_transcript.take() {
            rows.extend(self.sending_view.queued.iter().cloned());
            let rows = self.with_sending(rows, &queue, cx);
            self.pending_transcript = Some((rows, reset));
        } else if self.page == Page::Chat {
            let mut rows = self.transcript.read(cx).rows().to_vec();
            rows.extend(self.sending_view.queued.iter().cloned());
            let rows = self.with_sending(rows, &queue, cx);
            self.transcript
                .update(cx, |view, cx| view.replace_readonly(rows, false, cx));
        }
    }
}

#[cfg(test)]
#[path = "submit_visibility_tests.rs"]
mod tests;
