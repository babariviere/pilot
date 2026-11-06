//! Synthetic conversations only. No daemon, disk writes or model calls.

pub(crate) const REPLY: &str = "The sidebar and conversation now use native NSH views.\n\n### What stays the same\n\n- Your chats stay in a stable order.\n- Each chat keeps its own draft.\n- The conversation uses a readable column.\n\n```rust\nlet draft = signal(String::new());\n// Native editing, app-owned state.\n```\n\nYou can switch chats while this reply grows, then come back without losing your place in the draft. 日本語 · café · 👩🏽‍💻";

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Message {
    pub id: usize,
    pub mine: bool,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Transcript {
    pub messages: Vec<Message>,
    pub streaming: bool,
    tick: usize,
}

impl Transcript {
    pub fn fixture(id: usize) -> Self {
        let (question, answer) = if id == 0 {
            (
                "Can you reproduce the chat and sidebar in Native Shell?",
                "Yes. This is a separate **Rust-only NSH prototype**, using AppKit on macOS. The production app is unchanged.\n\nThe sidebar keeps Pilot’s quiet hierarchy. Chat uses native Markdown, selectable text and a native multiline composer.\n\n### Try it\n\nSwitch between chats, write a draft, or send a message to start a synthetic reply. **Stop** ends the replay. Nothing is sent to a model or daemon.",
            )
        } else {
            (
                "Keep the conversation calm and easy to scan.",
                "I’ll keep the important information visible and put the detail behind disclosure.\n\n| Surface | Purpose |\n| --- | --- |\n| Sidebar | Find your chat |\n| Conversation | Read and respond |\n| Composer | Keep your next thought |\n\nThis conversation is local sample data. 日本語、العربية、한국어 and 👩🏽‍💻 stay intact.",
            )
        };
        Self {
            messages: vec![
                Message {
                    id: 0,
                    mine: true,
                    text: question.into(),
                },
                Message {
                    id: 1,
                    mine: false,
                    text: answer.into(),
                },
            ],
            streaming: false,
            tick: 0,
        }
    }

    pub fn empty() -> Self {
        Self {
            messages: vec![],
            streaming: false,
            tick: 0,
        }
    }

    pub fn send(&mut self, draft: &str) -> bool {
        if self.streaming || draft.trim().is_empty() {
            return false;
        }
        self.messages.push(Message {
            id: self.messages.len(),
            mine: true,
            text: draft.into(),
        });
        self.messages.push(Message {
            id: self.messages.len(),
            mine: false,
            text: String::new(),
        });
        self.streaming = true;
        self.tick = 0;
        true
    }

    pub fn advance(&mut self) {
        if !self.streaming {
            return;
        }
        self.tick += 1;
        let text: String = REPLY.chars().take(self.tick * 8).collect();
        self.streaming = text.len() < REPLY.len();
        if let Some(last) = self.messages.last_mut() {
            last.text = text;
        }
    }

    pub fn stop(&mut self) {
        self.streaming = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_keeps_exact_bytes_and_rejects_duplicate_running_send() {
        let mut chat = Transcript::empty();
        assert!(!chat.send(" \n"));
        let draft = "  日本語 👩🏽‍💻 e\u{301}\n";
        assert!(chat.send(draft));
        assert_eq!(chat.messages[0].text, draft);
        assert!(!chat.send("another"));
        assert_eq!(chat.messages.len(), 2);
        for _ in 0..100 {
            chat.advance();
        }
        assert_eq!(chat.messages[1].text, REPLY);
        assert!(!chat.streaming);
    }

    #[test]
    fn stop_keeps_partial_reply_and_next_send_has_new_identity() {
        let mut chat = Transcript::empty();
        chat.send("first");
        chat.advance();
        chat.stop();
        let stopped = chat.clone();
        chat.advance();
        assert_eq!(chat, stopped);
        assert!(chat.send("second"));
        assert_eq!(
            chat.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
    }
}
