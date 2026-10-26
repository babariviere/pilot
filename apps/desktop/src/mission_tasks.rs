//! Exact task snapshot from the existing mission-detail GET. No task paging contract exists.
use crate::{local_model::valid_id, mission_browser::Key};
use serde_json::Value;
use std::{collections::HashSet, sync::Arc};

pub(crate) const WIRE_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const ROW_LIMIT: usize = 256;
pub(crate) const BODY_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct Task {
    pub(crate) id: String,
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) body: String,
    pub(crate) context: String,
    order: f64,
}
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) key: Key,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) tasks: Vec<Task>,
}
impl Snapshot {
    pub(crate) fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }
}
fn text(v: &Value, cap: usize) -> Result<String, &'static str> {
    v.as_str().filter(|s| s.len() <= cap).map(str::to_owned)
        .ok_or("Task text is missing or exceeds the viewer limit. No partial description was admitted.")
}
pub(crate) fn parse(key: &Key, v: &Value) -> Result<Snapshot, &'static str> {
    if !key.valid() || v["mission"]["id"] != key.id {
        return Err("Task snapshot belongs to a different mission.");
    }
    let raw = v["tasks"]
        .as_array()
        .filter(|a| a.len() <= ROW_LIMIT)
        .ok_or(
            "Tasks unavailable or exceed the 256-task viewer limit. No partial list was admitted.",
        )?;
    let mut ids = HashSet::new();
    let mut numbers = HashSet::new();
    let mut tasks = Vec::with_capacity(raw.len());
    for t in raw {
        let id = t["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("Invalid exact task ID.")?;
        let number = t["number"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 1_000_000_000)
            .ok_or("Invalid task number.")?;
        if !ids.insert(id) || !numbers.insert(number) {
            return Err("Duplicate task identity in snapshot.");
        }
        let order = t["order"]
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or("Invalid task order.")?;
        let mut context = vec![format!("Task ID: {id}")];
        for (field, label) in [
            ("sessionId", "Assigned chat"),
            ("milestone", "Phase"),
            ("preferredModel", "Model"),
            ("preferredThinking", "Thinking"),
            ("delegatedTo", "Delegated to"),
        ] {
            if !t[field].is_null() {
                context.push(format!("{label}: {}", text(&t[field], 1024)?));
            }
        }
        if !t["dependsOn"].is_null() {
            let deps = t["dependsOn"]
                .as_array()
                .filter(|a| a.len() <= ROW_LIMIT)
                .ok_or("Invalid task dependencies.")?;
            let mut values = Vec::with_capacity(deps.len());
            for dep in deps {
                let dep = text(dep, 128)?;
                if !valid_id(&dep) {
                    return Err("Invalid dependency ID.");
                }
                values.push(dep);
            }
            if !values.is_empty() {
                context.push(format!("Depends on IDs: {}", values.join(", ")));
            }
        }
        tasks.push(Task {
            id: id.into(),
            number,
            title: text(&t["title"], 800)?,
            status: text(&t["status"], 40)?,
            body: if t["body"].is_null() {
                String::new()
            } else {
                text(&t["body"], BODY_BYTES)?
            },
            context: context.join("\n"),
            order,
        });
    }
    tasks.sort_by(|a, b| {
        a.order
            .total_cmp(&b.order)
            .then(a.number.cmp(&b.number))
            .then(a.id.cmp(&b.id))
    });
    Ok(Snapshot {
        key: key.clone(),
        title: text(&v["mission"]["title"], 800)?,
        status: text(&v["mission"]["status"], 40)?,
        tasks,
    })
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) key: Option<Key>,
    pub(crate) generation: u64,
    pub(crate) snapshot: Option<Arc<Snapshot>>,
    pub(crate) selected: Option<String>,
    pub(crate) busy: bool,
    pub(crate) error: Option<&'static str>,
}
impl State {
    pub(crate) fn target(&mut self, key: Option<Key>) -> bool {
        if self.key == key {
            return false;
        }
        self.generation = self.generation.saturating_add(1);
        self.key = key;
        self.snapshot = None;
        self.selected = None;
        self.busy = false;
        self.error = None;
        true
    }
    pub(crate) fn begin(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.busy = true;
        self.error = None;
        self.generation
    }
    pub(crate) fn accept(
        &mut self,
        generation: u64,
        key: &Key,
        result: Result<Arc<Snapshot>, &'static str>,
    ) -> bool {
        if self.generation != generation || self.key.as_ref() != Some(key) {
            return false;
        }
        self.busy = false;
        match result {
            Ok(s) if &s.key == key => {
                if self
                    .selected
                    .as_ref()
                    .is_some_and(|id| s.task(id).is_none())
                {
                    self.selected = None;
                }
                self.snapshot = Some(s);
                self.error = None;
            }
            Ok(_) => self.error = Some("Task snapshot source differs. Refresh explicitly."),
            Err(e) => self.error = Some(e),
        }
        true
    }
}

#[cfg(test)]
#[path = "mission_tasks_tests.rs"]
mod tests;
