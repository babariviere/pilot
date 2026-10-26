//! Bounded public SessionTodo projection, never inferred from tools or mission tasks.
//! Presentation adapted from MonoCode TaskListPreview.tsx / model/taskList.ts at
//! 26465c620977f3951d0a532a0f7db32c3c179007. MIT © 2026 Nick; licenses/MONOCODE.txt.
//! Status/assignment semantics instead follow kernel/todos.ts and Swift Todos.swift.
use crate::LocalOptions;
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

pub(crate) const COUNT_CAP: usize = 256;
pub(crate) const ROW_CAP: usize = 32;
pub(crate) const TITLE_CAP: usize = 240;

#[derive(Clone)]
pub(crate) struct Source {
    options: LocalOptions,
    chat: String,
    generation: u64,
}
impl Source {
    pub(crate) fn new(options: LocalOptions, chat: String, generation: u64) -> Self {
        Self {
            options,
            chat,
            generation,
        }
    }
    pub(crate) fn matches(
        &self,
        options: Option<&LocalOptions>,
        chat: Option<&str>,
        generation: u64,
    ) -> bool {
        self.generation == generation
            && chat == Some(self.chat.as_str())
            && options.is_some_and(|o| self.options.same_todo_source(o))
    }
    pub(crate) fn same_chat(&self, other: &Self) -> bool {
        self.chat == other.chat && self.options.same_todo_source(&other.options)
    }
    pub(crate) fn same_admission(&self, other: &Self) -> bool {
        self.generation == other.generation && self.same_chat(other)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Todo {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) working: bool,
    pub(crate) elsewhere: bool,
    pub(crate) closed: bool,
    created: String,
}
impl Todo {
    pub(crate) fn label(&self) -> &str {
        if self.closed {
            "Completed"
        } else if self.working {
            "Working"
        } else if self.elsewhere {
            "Assigned elsewhere"
        } else {
            &self.status
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) rows: Vec<Todo>,
    pub(crate) count: usize,
    pub(crate) done: usize,
    pub(crate) partial: bool,
    pub(crate) clipped: bool,
}
impl Snapshot {
    fn read(value: &Value, chat: &str) -> Result<Self, ()> {
        let values = value.as_array().ok_or(())?;
        let mut result = Self {
            partial: values.len() > COUNT_CAP,
            ..Default::default()
        };
        let mut ids = BTreeSet::new();
        for value in values.iter().take(COUNT_CAP) {
            let string =
                |name: &str, cap: usize| value[name].as_str().filter(|s| s.len() <= cap).ok_or(());
            let id = string("id", 64)?;
            if id.is_empty() || !ids.insert(id.to_owned()) {
                return Err(());
            }
            let title = string("title", 1024)?;
            let status = string("status", 64)?;
            let created = string("createdAt", 128)?;
            let assigned = match value.get("assignedToSession") {
                None => None,
                Some(value) => Some(
                    value
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 256)
                        .ok_or(())?,
                ),
            };
            // This contract accepts arbitrary statuses. In particular "completed",
            // "cancelled" and "in_progress" are NOT aliases for closed/done.
            let closed = matches!(status.to_lowercase().as_str(), "closed" | "done");
            let (title, clipped) = preview(title);
            result.clipped |= clipped;
            result.done += usize::from(closed);
            result.rows.push(Todo {
                id: id.into(),
                title,
                status: status.into(),
                closed,
                working: !closed && assigned == Some(chat),
                elsewhere: !closed && assigned.is_some_and(|id| id != chat),
                created: created.into(),
            });
        }
        result.count = result.rows.len();
        result.rows.sort_by(|a, b| {
            b.working
                .cmp(&a.working)
                .then(a.closed.cmp(&b.closed))
                .then(a.created.cmp(&b.created))
                .then(a.id.cmp(&b.id))
        });
        result.rows.truncate(ROW_CAP);
        Ok(result)
    }
    pub(crate) fn summary(&self) -> String {
        if self.count == 0 {
            return "No tasks reported".into();
        }
        format!(
            "Tasks {} of {}{}",
            self.done,
            self.count,
            if self.partial { "+" } else { "" }
        )
    }
    pub(crate) fn coverage(&self) -> Option<String> {
        (self.partial || self.count > self.rows.len() || self.clipped).then(|| {
            format!(
                "Showing {} of {}{} reported tasks{}",
                self.rows.len(),
                self.count,
                if self.partial {
                    "+ (partial count)"
                } else {
                    ""
                },
                if self.clipped {
                    "; shortened titles"
                } else {
                    ""
                }
            )
        })
    }
}
fn preview(value: &str) -> (String, bool) {
    let mut chars = value.chars();
    let mut text: String = chars
        .by_ref()
        .take(TITLE_CAP)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let clipped = chars.next().is_some();
    if clipped {
        text.push('…');
    }
    if text.trim().is_empty() {
        text = "(untitled)".into();
    }
    (text, clipped)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    #[default]
    Loading,
    Absent,
    Ready,
    Unavailable,
    Retained,
}
#[derive(Clone, Default)]
pub(crate) struct Feed {
    pub(crate) source: Option<Source>,
    pub(crate) snapshot: Option<Arc<Snapshot>>,
    pub(crate) phase: Phase,
}
impl Feed {
    pub(crate) fn new(source: Source) -> Self {
        Self {
            source: Some(source),
            ..Default::default()
        }
    }
    pub(crate) fn stale(&mut self) {
        self.phase = if self.snapshot.is_some() {
            Phase::Retained
        } else {
            Phase::Unavailable
        };
    }
    pub(crate) fn stream(&mut self) {
        // Resume has no caught-up watermark. Only a replacement todos_update
        // establishes a fresh todo projection after reconnect.
        if self.snapshot.is_some() {
            self.phase = Phase::Retained;
        } else {
            self.phase = Phase::Loading;
        }
    }
    pub(crate) fn apply(&mut self, event: &Value) {
        if event["type"] == "snapshot" && self.snapshot.is_none() {
            self.phase = Phase::Absent;
        }
        if event["type"] != "todos_update" {
            return;
        }
        let Some(source) = &self.source else {
            return;
        };
        match Snapshot::read(&event["items"], &source.chat) {
            Ok(snapshot) => {
                self.snapshot = Some(Arc::new(snapshot));
                self.phase = Phase::Ready;
            }
            Err(()) => self.stale(),
        }
    }
    pub(crate) fn visible(
        &self,
        options: Option<&LocalOptions>,
        chat: Option<&str>,
        generation: u64,
    ) -> bool {
        self.source
            .as_ref()
            .is_some_and(|s| s.matches(options, chat, generation))
            && (self.snapshot.is_some() || self.phase == Phase::Unavailable)
    }
}

#[cfg(test)]
#[path = "session_todos_tests.rs"]
mod tests;
