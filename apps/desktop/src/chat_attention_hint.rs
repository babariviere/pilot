//! Quiet public attention above the ordinary composer. Exact questions own their own hint.
use super::*;
use gpui_kit::StatefulInteractiveElement as _;

/// Public attention supplies words, never an invented approval or navigation target.
fn attention_hint(chat: &Chat, fresh: bool, question_visible: bool) -> Option<&str> {
    use crate::{attention::Kind, state_mark::Signal};
    if !fresh
        || chat.archived
        || chat.local_draft
        || question_visible
        || chat.signal != Some(Signal::NeedsYou)
    {
        return None;
    }
    let reason = chat.attention.as_ref()?;
    Some(match reason.kind {
        Kind::Question => "Waiting for your answer",
        Kind::Other if reason.label != "Needs you" && !reason.label.is_empty() => &reason.label,
        _ => "Your input is needed to continue",
    })
}

#[cfg(test)]
mod attention_hint_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hint_uses_public_reason_without_inventing_requests() {
        for (summary, expected) in [
            (json!({"outcome":"question"}), "Waiting for your answer"),
            (json!({"unpublishedWork":true}), "No PR created"),
            (
                json!({"working":true,"state":"working","attentionReason":{"kind":"mcp","detail":"Sign in"}}),
                "MCP: Sign in",
            ),
            (
                json!({"working":true,"attentionReason":{"kind":"tool_stall"}}),
                "Tool may be stalled: No useful progress has been observed",
            ),
        ] {
            let mut value = json!({"id":"a","state":"idle"});
            value
                .as_object_mut()
                .unwrap()
                .extend(summary.as_object().unwrap().clone());
            let chat = crate::local_model::chat(&value).unwrap();
            assert_eq!(
                attention_hint(&chat, true, false),
                Some(expected),
                "{summary}"
            );
            assert_eq!(attention_hint(&chat, false, false), None, "Stale source");
            assert_eq!(
                attention_hint(&chat, true, true),
                None,
                "Question panel owns its reason"
            );
        }
        for extra in [
            json!({}),
            json!({"pendingApprovals":[{"id":"fake"}]}),
            json!({"outcome":"failed"}),
            json!({"outcome":"done"}),
            json!({"subscriptionPause":{"provider":"anthropic","resetAt":123}}),
            json!({"archivedAt":123,"outcome":"question"}),
        ] {
            let mut value = json!({"id":"a","state":"idle"});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_eq!(
                attention_hint(&crate::local_model::chat(&value).unwrap(), true, false),
                None,
                "{extra}"
            );
        }
        let mut global_only = crate::local_model::chat(&json!({"id":"a","state":"idle"})).unwrap();
        global_only.signal = Some(crate::state_mark::Signal::NeedsYou);
        assert_eq!(
            attention_hint(&global_only, true, false),
            None,
            "A status word alone supplies no reason evidence"
        );
        global_only.attention = Some(crate::attention::Attention {
            kind: crate::attention::Kind::Other,
            label: "Needs you".into(),
        });
        assert_eq!(
            attention_hint(&global_only, true, false),
            Some("Your input is needed to continue")
        );
    }
}

impl LocalViewer {
    pub(super) fn attention_composer(&self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let hint = self
            .selected
            .as_deref()
            .and_then(|id| self.state.chats.iter().find(|chat| chat.id == id))
            .and_then(|chat| {
                attention_hint(
                    chat,
                    self.state.generation == self.generation
                        && self.state.loaded
                        && self.state.summary_fresh
                        && !self.state.chat_issue
                        && !self.refreshing
                        && self.subagent.is_none()
                        && self.client.as_ref().is_some_and(|c| {
                            matches!(
                                c.daemon(),
                                crate::local_client::ConnectedDaemon::Connected(_)
                            )
                        }),
                    self.editor.read(cx).question_hint_covered(),
                )
            });
        let Some(label) = hint else {
            return self.editor.clone().into_any_element();
        };
        div()
            .v_flex()
            .min_w_0()
            .child(
                crate::ui::text(crate::ui::Text::Caption, label.to_owned())
                    .id("chat-attention-hint")
                    .test_support()
                    .aria_label(label.to_owned())
                    .mx_3()
                    .px(px(10.))
                    .text_color(crate::appearance::attention_text(cx)),
            )
            .child(self.editor.clone())
            .into_any_element()
    }
}
