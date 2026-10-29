//! Exact task snapshot from the existing mission-detail GET, which returns every task.
//! There is no task paging contract, so every received task is admitted.
use crate::{local_model::valid_id, mission_browser::Key};
use serde_json::Value;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug)]
pub(crate) struct Task {
    pub(crate) id: String,
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) status: String,
    /// Swift's workStatus: stored status when phase gating projects Blocked.
    pub(crate) work_status: String,
    pub(crate) body: String,
    pub(crate) context: String,
    order: f64,
}
/// One run of the list: a phase's tasks under its header, or the whole flat
/// list (no title) when the mission has no phases.
#[derive(Clone, Debug)]
pub(crate) struct Section {
    /// Stable across phase renames and refreshes, separate from its list index.
    pub(crate) key: String,
    pub(crate) title: Option<String>,
    /// "3/8 done", as in Swift's phase header.
    pub(crate) progress: String,
    /// Indices into `Snapshot::tasks`, in task order.
    pub(crate) tasks: Vec<usize>,
}
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) key: Key,
    pub(crate) tasks: Vec<Task>,
    /// Work-status counts in the overview's bar order, zeros omitted, dropped excluded.
    pub(crate) progress: Vec<(&'static str, usize)>,
    /// Every task exactly once: phases in order, then No phase; one untitled
    /// section without phases. Empty phases have no section.
    pub(crate) sections: Vec<Section>,
}
impl Snapshot {
    pub(crate) fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }
    /// The task at a list position.
    #[cfg(test)]
    pub(crate) fn at(&self, section: usize, row: usize) -> Option<&Task> {
        self.tasks.get(*self.sections.get(section)?.tasks.get(row)?)
    }
    /// The list position of an exact task ID.
    pub(crate) fn position(&self, id: &str) -> Option<(usize, usize)> {
        self.sections.iter().enumerate().find_map(|(s, section)| {
            section
                .tasks
                .iter()
                .position(|ix| self.tasks[*ix].id == id)
                .map(|row| (s, row))
        })
    }
}
fn text(v: &Value, cap: usize) -> Result<String, &'static str> {
    v.as_str().filter(|s| s.len() <= cap).map(str::to_owned)
        .ok_or("Task text is missing or exceeds the viewer limit. No partial description was admitted.")
}
fn content(v: &Value) -> Result<String, &'static str> {
    v.as_str()
        .map(str::to_owned)
        .ok_or("Task text is malformed.")
}
pub(crate) fn parse(key: &Key, v: &Value) -> Result<Snapshot, &'static str> {
    if !key.valid() || v["mission"]["id"] != key.id {
        return Err("Task snapshot belongs to a different mission.");
    }
    let raw = v["tasks"].as_array().ok_or("Tasks aren't available.")?;
    let mut ids = HashSet::new();
    let mut numbers = HashSet::new();
    let mut tasks = Vec::with_capacity(raw.len());
    let mut membership = Vec::with_capacity(raw.len());
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
        if !t["sessionId"].is_null() {
            context.push(format!("Assigned chat: {}", text(&t["sessionId"], 1024)?));
        }
        // The phase line follows once the phase index is known.
        let lines = context.len();
        for (field, label) in [
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
            title: content(&t["title"])?,
            status: text(&t["status"], 40)?,
            work_status: text(
                if t["storedStatus"].is_null() {
                    &t["status"]
                } else {
                    &t["storedStatus"]
                },
                40,
            )?,
            body: if t["body"].is_null() {
                String::new()
            } else {
                content(&t["body"])?
            },
            context: String::new(),
            order,
        });
        membership.push((
            t["phaseId"].as_str(),
            t["milestone"].as_str(),
            context,
            lines,
        ));
    }
    let mut tasks: Vec<_> = tasks.into_iter().zip(membership).collect();
    tasks.sort_by(|(a, _), (b, _)| {
        a.order
            .total_cmp(&b.order)
            .then(a.number.cmp(&b.number))
            .then(a.id.cmp(&b.id))
    });
    let index = crate::mission_phases::Index::new(&v["phases"], tasks.iter().map(|(_, m)| m.1))?;
    let phases: Vec<_> = tasks.iter().map(|(_, m)| index.of(m.0, m.1)).collect();
    let tasks: Vec<Task> = tasks
        .into_iter()
        .zip(&phases)
        .map(|((mut t, (_, _, mut context, at)), phase)| {
            if let Some(name) = phase.and_then(|p| index.name(p)) {
                context.insert(at, format!("Phase: {name}"));
            }
            t.context = context.join("\n");
            t
        })
        .collect();
    let groups = index.groups(
        &phases
            .iter()
            .zip(&tasks)
            .map(|(p, t)| (*p, t.work_status.as_str()))
            .collect::<Vec<_>>(),
    );
    let sections = if groups.is_empty() {
        vec![Section {
            key: "flat".into(),
            title: None,
            progress: String::new(),
            tasks: (0..tasks.len()).collect(),
        }]
    } else {
        groups
            .into_iter()
            .filter(|g| !g.tasks.is_empty())
            .map(|g| Section {
                key: g
                    .phase
                    .and_then(|p| index.id(p))
                    .map_or_else(|| "unphased".into(), |id| format!("phase:{id}")),
                progress: g.progress(),
                title: Some(g.name),
                tasks: g.tasks,
            })
            .collect()
    };
    // The mission header still validates; the overview already shows it.
    text(&v["mission"]["title"], 800)?;
    text(&v["mission"]["status"], 40)?;
    let progress = crate::mission_browser::BAR_ORDER
        .iter()
        .map(|s| (*s, tasks.iter().filter(|t| t.work_status == *s).count()))
        .filter(|c| c.1 > 0)
        .collect();
    Ok(Snapshot {
        key: key.clone(),
        tasks,
        progress,
        sections,
    })
}

/// Client-only list presentation. Neither filter nor folds change the snapshot.
#[derive(Clone, Default)]
pub(crate) struct Visibility {
    pub(crate) hide_finished: bool,
    pub(crate) collapsed: HashSet<String>,
}
impl Visibility {
    pub(crate) fn rows(&self, snapshot: &Snapshot) -> Vec<Vec<usize>> {
        snapshot
            .sections
            .iter()
            .map(|section| {
                section
                    .tasks
                    .iter()
                    .copied()
                    .filter(|i| {
                        !self.collapsed.contains(&section.key)
                            && !(self.hide_finished
                                && matches!(
                                    snapshot.tasks[*i].work_status.as_str(),
                                    "done" | "dropped"
                                ))
                    })
                    .collect()
            })
            .collect()
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) visibility: Visibility,
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
        self.visibility = Visibility::default();
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
            Ok(_) => self.error = Some("Tasks changed. Refresh to see them."),
            Err(e) => self.error = Some(e),
        }
        true
    }
}

#[cfg(test)]
#[path = "mission_tasks_tests.rs"]
mod tests;
