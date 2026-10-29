//! Bounded append-only Local timeline. IDs, not text or timestamps, order events.
use crate::{local_model::valid_id, mission_browser::Key};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const PAGE_CAP: usize = 50;
pub(crate) const ROW_CAP: usize = 250;
pub(crate) const WIRE_CAP: usize = 2 * 1024 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) id: u64,
    pub(crate) kind: String,
    pub(crate) text: String,
    pub(crate) preview: String,
    pub(crate) chat: Option<String>,
    pub(crate) task: Option<String>,
    pub(crate) health: Option<String>,
    pub(crate) at: u64,
}
impl Entry {
    pub(crate) fn source(&self) -> String {
        self.chat
            .as_ref()
            .map(|s| format!("Chat {s}"))
            .unwrap_or_else(|| "User or system (source unspecified)".into())
    }
    pub(crate) fn heading(&self) -> &'static str {
        match self.kind.as_str() {
            "handoff" => "Handoff",
            "update" => "Update",
            "created" => "Mission created",
            "status" => "Status changed",
            "brief" => "Brief revision",
            "decision" => "Decision",
            "comment" => "Comment",
            "task" => "Task changed",
            "claim" => "Task ownership",
            "artifact" => "Artifact",
            "resource" => "Resource",
            "member" => "Membership",
            "coordinator" => "Coordinator",
            "github" => "GitHub event",
            _ => "Other event",
        }
    }
}
fn optional_id(v: &Value) -> Result<Option<String>, &'static str> {
    if v.is_null() {
        return Ok(None);
    }
    v.as_str()
        .filter(|s| valid_id(s))
        .map(|s| Some(s.to_owned()))
        .ok_or("Invalid activity source identity.")
}
pub(crate) fn page(v: &Value, before: Option<u64>) -> Result<Vec<Entry>, &'static str> {
    let raw = v
        .as_array()
        .filter(|a| a.len() <= PAGE_CAP)
        .ok_or("Unsupported activity page or more than 50 events.")?;
    let mut entries = BTreeMap::new();
    for v in raw {
        let id = v["id"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= SAFE_INTEGER)
            .ok_or("Invalid canonical event ID.")?;
        if before.is_some_and(|b| id >= b) {
            return Err("Activity page crossed its earlier-event boundary.");
        }
        let text = v["text"]
            .as_str()
            .ok_or("Activity text is malformed.")?
            .to_owned();
        let kind = v["kind"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 64)
            .ok_or("Invalid activity kind.")?
            .to_owned();
        let health = match v["health"].as_str() {
            Some(s @ ("on_track" | "at_risk" | "off_track")) => Some(s.into()),
            None if v["health"].is_null() => None,
            _ => return Err("Invalid activity health."),
        };
        let entry = Entry {
            id,
            kind,
            preview: crate::mission_browser::bounded(&text.replace('\n', " "), 200),
            text,
            chat: optional_id(&v["sessionId"])?,
            task: optional_id(&v["taskId"])?,
            health,
            at: v["at"]
                .as_u64()
                .filter(|n| *n <= SAFE_INTEGER)
                .ok_or("Invalid activity time.")?,
        };
        if entries.get(&id).is_some_and(|old| old != &entry) {
            return Err("Conflicting canonical event identity.");
        }
        entries.insert(id, entry);
    }
    Ok(entries.into_values().rev().collect())
}

#[derive(Default)]
pub(crate) struct Timeline {
    pub(crate) key: Option<Key>,
    pub(crate) generation: u64,
    pub(crate) pending: Option<Option<u64>>,
    pub(crate) rows: Vec<Entry>,
    pub(crate) loaded: bool,
    pub(crate) exhausted: bool,
    pub(crate) stale: bool,
    pub(crate) error: Option<&'static str>,
}
impl Timeline {
    pub(crate) fn select(&mut self, key: Option<Key>) {
        self.generation = self.generation.saturating_add(1);
        self.pending = None;
        if self.key != key {
            self.rows.clear();
            self.loaded = false;
            self.exhausted = false;
            self.error = None;
        }
        self.key = key;
        self.stale = self.loaded;
    }
    pub(crate) fn begin(&mut self, earlier: bool) -> Option<(u64, Key, Option<u64>)> {
        if self.pending.is_some() {
            return None;
        }
        let key = self.key.clone()?;
        let before = if earlier {
            if !self.loaded || self.exhausted || self.stale || self.rows.len() >= ROW_CAP {
                return None;
            }
            Some(self.rows.last()?.id)
        } else {
            None
        };
        self.generation = self.generation.saturating_add(1);
        self.pending = Some(before);
        self.error = None;
        if !earlier {
            self.stale = self.loaded;
        }
        Some((self.generation, key, before))
    }
    pub(crate) fn accept(
        &mut self,
        generation: u64,
        key: &Key,
        before: Option<u64>,
        result: Result<Vec<Entry>, &'static str>,
    ) -> bool {
        if self.generation != generation
            || self.key.as_ref() != Some(key)
            || self.pending != Some(before)
        {
            return false;
        }
        self.pending = None;
        match result {
            Err(e) => self.error = Some(e),
            Ok(page) => {
                if page
                    .iter()
                    .any(|e| self.rows.iter().any(|old| old.id == e.id && old != e))
                {
                    self.error = Some(
                        "Conflicting canonical event identity across reads. Retained events were not replaced.",
                    );
                    return true;
                }
                if before.is_some() && self.rows.len() + page.len() > ROW_CAP {
                    self.error = Some(
                        "Activity reached the 250-event viewing limit. Refresh to return to the newest window.",
                    );
                    return true;
                }
                // Each older request is strictly below the last admitted canonical ID.
                let empty = page.is_empty();
                if before.is_none() {
                    self.rows = page;
                } else {
                    self.rows.extend(page);
                }
                self.exhausted = empty;
                self.loaded = true;
                self.stale = false;
                self.error = None;
            }
        }
        true
    }
}

#[cfg(test)]
#[path = "mission_activity_tests.rs"]
mod tests;
