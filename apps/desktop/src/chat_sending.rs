//! A sent ordinary chat message belongs to the conversation, not the composer.
//! While its delivery owns the exact draft revision, the composer shows an empty
//! editor and the conversation shows the message with its delivery state. The
//! durable draft keeps the text until Local accepts it, so refusal or an unknown
//! outcome keeps every existing recovery path.
use super::ChatEditor;
use crate::delivery_store::{Draft, Intent};

/// Presentation keys for a message being sent, one per draft revision. Disjoint
/// from entry keys (below 2^59), queued keys (2^62) and live keys (2^63 and up).
pub(crate) const SENDING_KEY: u64 = 1 << 61;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Sending {
    pub(crate) key: u64,
    pub(crate) text: String,
    pub(crate) status: &'static str,
}

impl ChatEditor {
    fn chat_send_intent(&self, key: &str, draft: &Draft) -> Option<&Intent> {
        let id = draft.pending.as_ref()?;
        self.state.book.as_ref()?.pending.get(id).filter(|intent| {
            intent.key == key
                && intent.answer.is_none()
                && intent
                    .operation
                    .as_ref()
                    .is_some_and(|op| op.kind == "chat-send")
        })
    }

    /// The exact revision the conversation shows instead of the composer.
    pub(super) fn in_conversation(&self, key: &str, draft: &Draft) -> bool {
        key.starts_with("chat:")
            && (self.sending.get(key) == Some(&draft.revision)
                || self
                    .chat_send_intent(key, draft)
                    .is_some_and(|intent| intent.revision == draft.revision))
    }

    /// Text the composer shows for a draft.
    pub(super) fn shown_text<'a>(&self, key: &str, draft: &'a Draft) -> &'a str {
        if self.in_conversation(key, draft) {
            ""
        } else {
            &draft.text
        }
    }

    /// The selected chat's unresolved ordinary message, for the conversation.
    pub(crate) fn sending(&self, chat: &str) -> Option<Sending> {
        use crate::delivery_store::diagnostic::Acknowledgment;
        let key = format!("chat:{chat}");
        let draft = self.cache.get(&key)?;
        let submitting = self.sending.contains_key(&key);
        if let Some(intent) = self.chat_send_intent(&key, draft) {
            let payload: serde_json::Value =
                serde_json::from_str(&intent.operation.as_ref()?.payload).ok()?;
            let status = if submitting || intent.state == "pending" {
                "Sending…"
            } else {
                match self
                    .delivery_observation(&key, draft)
                    .map(|(_, d, _)| d.acknowledgment)
                {
                    Some(Acknowledgment::Accepted) => "Sent",
                    Some(Acknowledgment::Pending) => "Sending…",
                    Some(Acknowledgment::Rejected) => "Not sent",
                    _ => "Not confirmed",
                }
            };
            return Some(Sending {
                key: SENDING_KEY | (intent.revision & (SENDING_KEY - 1)),
                text: payload["message"].as_str()?.to_owned(),
                status,
            });
        }
        // Before Local reserves the operation: the captured, unedited revision.
        (self.sending.get(&key) == Some(&draft.revision) && draft.pending.is_none()).then(|| {
            Sending {
                key: SENDING_KEY | (draft.revision & (SENDING_KEY - 1)),
                text: draft.text.clone(),
                status: "Sending…",
            }
        })
    }
}

#[cfg(test)]
#[path = "chat_sending_tests.rs"]
mod tests;
