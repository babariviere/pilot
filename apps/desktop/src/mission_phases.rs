//! Mission phases, as in Swift's MissionPhaseIndex and MissionTaskPhases:
//! the detail's ordered first-class phases, or task milestones from an older
//! daemon that sends no phases. Read-only: nothing here moves or gates tasks.
use crate::{local_model::valid_id, mission_browser::BAR_ORDER};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Group {
    /// Position in phase order; None is "No phase".
    pub(crate) phase: Option<usize>,
    pub(crate) name: String,
    /// Work-status counts in bar order, zeros omitted, dropped excluded.
    pub(crate) counts: Vec<(&'static str, usize)>,
    pub(crate) done: usize,
    pub(crate) total: usize,
    pub(crate) dropped: usize,
    /// The first phase, in order, with unfinished tasks: where the work is now.
    pub(crate) current: bool,
    /// Indices into the caller's tasks, in their order, dropped included.
    pub(crate) tasks: Vec<usize>,
}
impl Group {
    /// "3/8 done", "2 dropped" when every task was dropped, or "No tasks".
    pub(crate) fn progress(&self) -> String {
        if self.total > 0 {
            format!("{}/{} done", self.done, self.total)
        } else if self.dropped > 0 {
            format!("{} dropped", self.dropped)
        } else {
            "No tasks".into()
        }
    }
}
/// Phase names in order. Membership is by phase ID, or by milestone name when
/// the daemon sent no phases (those stand-ins appear only with tasks).
#[derive(Clone, Debug, Default)]
pub(crate) struct Index {
    phases: Vec<(String, String)>,
    first_class: bool,
}
fn milestone(m: Option<&str>) -> Option<&str> {
    m.map(str::trim).filter(|m| !m.is_empty())
}
const MALFORMED: &str = "Mission phases are malformed.";
impl Index {
    /// `phases` is the detail's `phases` field; `milestones` the tasks'
    /// milestones in display order.
    pub(crate) fn new<'a>(
        phases: &Value,
        milestones: impl Iterator<Item = Option<&'a str>>,
    ) -> Result<Self, &'static str> {
        if phases.is_null() {
            let mut names: Vec<(String, String)> = Vec::new();
            for m in milestones.filter_map(milestone) {
                if !names.iter().any(|(id, _)| id == m) {
                    names.push((m.into(), m.into()));
                }
            }
            return Ok(Self {
                phases: names,
                first_class: false,
            });
        }
        let raw = phases.as_array().ok_or(MALFORMED)?;
        let mut sorted: Vec<(f64, String, String)> = Vec::with_capacity(raw.len());
        for p in raw {
            let id = p["id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or(MALFORMED)?;
            let name = p["name"].as_str().ok_or(MALFORMED)?;
            let order = p["order"]
                .as_f64()
                .filter(|o| o.is_finite())
                .ok_or(MALFORMED)?;
            if sorted.iter().any(|(_, i, _)| i == id) {
                return Err(MALFORMED);
            }
            sorted.push((order, id.to_owned(), name.to_owned()));
        }
        sorted.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        Ok(Self {
            phases: sorted.into_iter().map(|(_, id, name)| (id, name)).collect(),
            first_class: true,
        })
    }
    /// The phase a task belongs to; None for no phase, including a phase that
    /// no longer exists.
    pub(crate) fn of(&self, phase_id: Option<&str>, milestone_name: Option<&str>) -> Option<usize> {
        let key = if self.first_class {
            phase_id
        } else {
            milestone(milestone_name)
        }?;
        self.phases.iter().position(|(id, _)| id == key)
    }
    pub(crate) fn name(&self, phase: usize) -> Option<&str> {
        self.phases.get(phase).map(|(_, name)| name.as_str())
    }
    /// Groups in phase order, then "No phase". Empty when the mission has no
    /// phase to show, so callers show one flat list and one overall bar.
    /// `tasks` is each task's phase and work status, in display order. Every
    /// task lands in exactly one group.
    pub(crate) fn groups(&self, tasks: &[(Option<usize>, &str)]) -> Vec<Group> {
        let mut groups = Vec::new();
        let mut found_current = false;
        let mut phased = false;
        for phase in (0..self.phases.len()).map(Some).chain([None]) {
            let members: Vec<usize> = (0..tasks.len()).filter(|i| tasks[*i].0 == phase).collect();
            let counts: Vec<_> = BAR_ORDER
                .iter()
                .map(|s| (*s, members.iter().filter(|i| tasks[**i].1 == *s).count()))
                .filter(|c| c.1 > 0)
                .collect();
            let total = counts.iter().map(|c| c.1).sum();
            let done = counts.iter().find(|c| c.0 == "done").map_or(0, |c| c.1);
            let dropped = members.len() - total;
            let current = !found_current && phase.is_some() && done < total;
            found_current |= current;
            // First-class phases always show; stand-ins and No phase need tasks.
            let first_class = phase.is_some() && self.first_class;
            phased |= phase.is_some() && (total > 0 || first_class);
            if members.is_empty() && !first_class {
                continue;
            }
            groups.push(Group {
                phase,
                name: phase
                    .and_then(|p| self.name(p))
                    .unwrap_or("No phase")
                    .to_owned(),
                counts,
                done,
                total,
                dropped,
                current,
                tasks: members,
            });
        }
        if !phased {
            groups.clear();
        }
        groups
    }
}

#[cfg(test)]
#[path = "mission_phases_tests.rs"]
mod tests;
