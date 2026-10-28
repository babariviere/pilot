//! Shared synthetic replay. No daemon, persistence, account or network.
use serde::{Deserialize, Serialize};

pub const REPLY: &str = include_str!("../../../apps/desktop/fixtures/reply.md");
pub const STREAM: &str = "## A quieter reading surface\n\nKeep the conversation readable while the response grows. 日本語の入力、中文、한국어, café, 👩🏽‍💻 and العربية stay intact.\n\n```rust\nfn follow(reader: &Reader) -> bool {\n    reader.is_at_end()\n}\n```\n\n| Case | Expected |\n| --- | --- |\n| Reading older messages | Keep the anchor |\n| Following the response | Stay at the end |\n\nThe image arrives after the text. Selection should never move to a different message when a row is reused.\n";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub mine: bool,
    pub text: String,
    pub image: bool,
    pub visual: bool,
}

#[derive(Clone, Serialize)]
pub struct Chat {
    pub id: usize,
    pub draft: String,
    pub messages: Vec<Message>,
    pub start: usize,
    pub streaming: bool,
    pub tick: usize,
}

impl Chat {
    fn new(id: usize, total: usize) -> Self {
        let messages = (0..total).map(|i| Message {
            id: format!("{id}:{i}"),
            mine: i == total - 3 || (i < total - 3 && i % 4 == 0),
            text: if i == total - 3 {
                "Can we keep the reading position while the response grows?".into()
            } else if i == total - 2 {
                "## Keep the reader in control\n\nThe conversation stays calm. Open **Source** to inspect the native visual, or **Edit mission** to try a small form.\n\n- Native text editing\n- Virtual history with stable message identities\n- A response that grows without taking the reader away".into()
            } else if i == total - 1 {
                "A synthetic replay, ready when you are.".into()
            } else if i % 13 == 0 {
                REPLY.into()
            } else if i % 7 == 0 {
                STREAM.into()
            } else {
                format!("Message {}. Keep the important information, reveal the rest. 日本語 · 👩🏽‍💻 · café · العربية", i + 1)
            },
            image: false,
            visual: i == total - 2,
        }).collect();
        Self {
            id,
            draft: String::new(),
            messages,
            start: total.saturating_sub(1000),
            streaming: false,
            tick: 0,
        }
    }

    pub fn visible(&self) -> &[Message] {
        &self.messages[self.start..]
    }

    pub fn prepend(&mut self) {
        self.start = self.start.saturating_sub(100);
    }

    pub fn begin(&mut self) {
        if self.streaming {
            return;
        }
        self.streaming = true;
        self.tick = 0;
        let id = format!("{}:{}", self.id, self.messages.len());
        self.messages.push(Message {
            id,
            mine: false,
            text: String::new(),
            image: false,
            visual: false,
        });
    }

    /// One 30 Hz replay update. Character boundaries, never partial UTF-8.
    pub fn advance(&mut self) -> Option<Message> {
        if !self.streaming {
            return None;
        }
        self.tick += 1;
        let last = self.messages.last_mut().unwrap();
        last.text = STREAM.chars().take(self.tick * 7).collect();
        last.image = self.tick >= 75;
        if self.tick >= 100 {
            self.streaming = false;
        }
        Some(last.clone())
    }
}

#[derive(Clone)]
pub struct Fixture {
    pub chats: [Chat; 2],
    pub mission_title: String,
    pub mission_goal: String,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            chats: [Chat::new(0, 10_000), Chat::new(1, 1000)],
            mission_title: "A calmer conversation".into(),
            mission_goal: "Keep reading, writing and inspecting native content predictable.".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_navigation_prepend_and_replay() {
        let mut f = Fixture::default();
        let draft = "日本語 👩🏽‍💻 e\u{301}\n".repeat(10_000);
        f.chats[0].draft = draft.clone();
        f.chats[1].draft = "other".into();
        assert_eq!(f.chats[0].draft, draft);
        let anchor = f.chats[0].visible()[0].clone();
        f.chats[0].prepend();
        assert_eq!(f.chats[0].visible()[100], anchor);
        f.chats[0].begin();
        let id = f.chats[0].messages.last().unwrap().id.clone();
        for tick in 1..=100 {
            let row = f.chats[0].advance().unwrap();
            assert_eq!(row.id, id);
            assert_eq!(row.image, tick >= 75);
        }
        assert_eq!(f.chats[0].messages.last().unwrap().text, STREAM);
        assert!(!f.chats[0].streaming);
        assert!(f.chats[0].advance().is_none());
    }
}
