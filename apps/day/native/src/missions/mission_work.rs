//! Passive task activity and prerequisites. Nothing here admits or resumes work.

use std::collections::{HashMap, HashSet};

use crate::{
    contract as c,
    model::{TaskLine, TaskPrerequisite, TaskStatus, TaskWorkState},
    project::Inputs,
};

/// Index once per mission read; large plans must not rescan every session per task.
pub(crate) struct MissionWork<'a> {
    tasks: HashMap<&'a str, &'a c::Task>,
    models: HashMap<&'a str, &'a c::TaskModelRoute>,
    owners: HashMap<&'a str, &'a c::MissionAgent>,
    working: HashMap<&'a str, &'a c::WorkingItem>,
    questions: HashMap<&'a str, &'a c::NeedsYouItem>,
    phases: HashMap<&'a str, &'a str>,
    hold: &'static str,
    owners_known: bool,
}

impl<'a> MissionWork<'a> {
    pub(crate) fn new(
        inputs: &'a Inputs<'_>,
        mission_id: &str,
        detail: Option<&'a c::MissionDetail>,
    ) -> Self {
        let control = inputs
            .overview
            .controls
            .iter()
            .find(|c| c.mission_id == mission_id);
        let hold = match control {
            Some(c) if c.state == c::ControlState::Pausing => {
                "Mission is pausing; new starts are held."
            }
            Some(c) if c.state == c::ControlState::Paused => "Mission is paused.",
            Some(c) if c.state == c::ControlState::Resuming => "Mission resume is still pending.",
            Some(c) if c.held => "Mission work is held.",
            _ => "",
        };
        Self {
            phases: detail
                .into_iter()
                .flat_map(|d| &d.phases)
                .map(|p| (p.id.as_str(), p.name.as_str()))
                .collect(),
            tasks: detail
                .into_iter()
                .flat_map(|d| &d.tasks)
                .map(|t| (t.id.as_str(), t))
                .collect(),
            models: detail
                .into_iter()
                .flat_map(|d| &d.task_models)
                .map(|m| (m.task_id.as_str(), m))
                .collect(),
            owners: inputs
                .overview
                .mission_agents
                .iter()
                .flatten()
                .filter(|a| a.mission_id == mission_id)
                .map(|a| (a.session_id.as_str(), a))
                .collect(),
            working: inputs
                .overview
                .dashboard
                .working
                .items
                .iter()
                .filter(|a| a.mission_id.as_deref() == Some(mission_id))
                .map(|a| (a.session_id.as_str(), a))
                .collect(),
            questions: inputs
                .overview
                .dashboard
                .needs_you
                .iter()
                .flat_map(|s| &s.items)
                .filter(|a| {
                    a.mission_id.as_deref() == Some(mission_id)
                        && (a.kind == "question" || a.attention_reason.kind == "asks")
                })
                .filter_map(|a| a.session_id.as_deref().map(|id| (id, a)))
                .collect(),
            hold,
            owners_known: inputs.overview.mission_agents.is_some(),
        }
    }

    pub(crate) fn line(&self, task: &c::Task, status: TaskStatus) -> TaskLine {
        let owner = task
            .session_id
            .as_deref()
            .and_then(|id| self.owners.get(id))
            .copied();
        let working = task
            .session_id
            .as_deref()
            .and_then(|id| self.working.get(id))
            .copied();
        let question = task
            .session_id
            .as_deref()
            .and_then(|id| self.questions.get(id))
            .copied();
        let mut seen = HashSet::new();
        let mut prerequisites: Vec<_> = task
            .depends_on
            .iter()
            .filter(|id| seen.insert(id.as_str()))
            .filter_map(|id| {
                let prerequisite = self.tasks.get(id.as_str()).copied();
                if prerequisite.is_some_and(|t| t.status == c::TaskStatus::Done) {
                    return None;
                }
                Some(TaskPrerequisite {
                    id: id.clone(),
                    number: prerequisite.map_or(0, |t| t.number),
                    title: prerequisite
                        .map_or_else(|| "Prerequisite unavailable".into(), |t| t.title.clone()),
                    status: prerequisite
                        .and_then(|t| crate::project::task_status(t.status))
                        .unwrap_or(TaskStatus::Unknown),
                })
            })
            .collect();
        let mut reasons = Vec::new();
        if !self.hold.is_empty() {
            reasons.push(self.hold.to_owned());
        }
        if let Some(owner) = owner {
            reasons.extend(owner.holds.iter().cloned());
        }
        let held = !reasons.is_empty();
        for prerequisite in &prerequisites {
            reasons.push(if prerequisite.id == task.id {
                "This task depends on itself. The plan needs correction before it can start.".into()
            } else if self.tasks.get(prerequisite.id.as_str()).is_some_and(|t| t.status == c::TaskStatus::Dropped) {
                format!("Prerequisite #{} {} was dropped, not completed. The plan needs reconciliation.",
                    prerequisite.number, prerequisite.title)
            } else if prerequisite.number == 0 {
                format!(
                    "Prerequisite {} is unavailable; it is not known done.",
                    prerequisite.id
                )
            } else {
                format!(
                    "Waiting for #{} {}.",
                    prerequisite.number, prerequisite.title
                )
            });
        }
        if !task.blocked_by_phases.is_empty() {
            reasons.push(format!(
                "Earlier phases are incomplete: {}.",
                task.blocked_by_phases
                    .iter()
                    .map(|id| self
                        .phases
                        .get(id.as_str())
                        .copied()
                        .filter(|name| !name.is_empty())
                        .unwrap_or("phase details unavailable"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let waiting = owner.is_some_and(|o| o.waiting_for_user) || question.is_some();
        if status == TaskStatus::Blocked
            && prerequisites.is_empty()
            && task.blocked_by_phases.is_empty()
        {
            reasons.push("Marked blocked. No blocking prerequisite is recorded.".into());
        }
        if waiting {
            reasons.push(
                question
                    .and_then(|q| {
                        q.attention_reason
                            .detail
                            .clone()
                            .or_else(|| q.reason.clone())
                    })
                    .map_or_else(
                        || "The owner has a question for you.".into(),
                        |text| format!("Waiting for you: {text}"),
                    ),
            );
        }
        let state = if status == TaskStatus::Done {
            reasons.clear();
            prerequisites.clear();
            TaskWorkState::Completed
        } else if owner.is_some_and(|o| o.working) || working.is_some() {
            TaskWorkState::Working
        } else if waiting {
            TaskWorkState::WaitingForUser
        } else if status == TaskStatus::Delegated {
            reasons.push("Delegated work is not available for this mission to start.".into());
            TaskWorkState::Delegated
        } else if status == TaskStatus::InReview {
            TaskWorkState::Review
        } else if held {
            TaskWorkState::Held
        } else if !prerequisites.is_empty() || !task.blocked_by_phases.is_empty() {
            TaskWorkState::DependencyBlocked
        } else {
            match status {
                TaskStatus::Todo => {
                    reasons.push("Queued in the plan only. Start permission, capacity and other holds have not been checked.".into());
                    TaskWorkState::Queued
                }
                TaskStatus::InProgress => {
                    reasons.push("Assigned, but no owner activity is observed. This does not authorize a restart.".into());
                    TaskWorkState::Assigned
                }
                TaskStatus::Blocked => TaskWorkState::Blocked,
                TaskStatus::InReview => TaskWorkState::Review,
                _ => TaskWorkState::Unknown,
            }
        };
        if status != TaskStatus::Done && task.session_id.is_some() && owner.is_none() {
            reasons.push(
                if self.owners_known {
                    "Owner state is unavailable."
                } else {
                    "This service does not report owner holds."
                }
                .into(),
            );
        }
        TaskLine {
            id: task.id.clone(),
            number: task.number,
            title: task.title.clone(),
            status,
            session_id: task.session_id.clone(),
            work_state: state,
            work_reason: reasons.join("\n"),
            owner_title: task
                .delegated_to
                .clone()
                .or_else(|| owner.map(|o| o.title.clone()))
                .or_else(|| working.map(|o| o.title.clone()))
                .unwrap_or_default(),
            body: task.body.clone(),
            prerequisites,
            model_line: self
                .models
                .get(task.id.as_str())
                .filter(|_| status != TaskStatus::Done)
                .map(|m| model_line(m))
                .unwrap_or_default(),
            model_profile: self
                .models
                .get(task.id.as_str())
                .and_then(|m| m.profile.as_ref())
                .map(|p| p.id.clone())
                .unwrap_or_default(),
            ..TaskLine::default()
        }
    }
}

/// "Backend · large · Sol · preferred", "UI · large · Sol · Opus 5.5 was busier", "Sol · set by you" or
/// "Cyber · large · Opus 5 · after a cyber block".
pub(crate) fn model_line(route: &c::TaskModelRoute) -> String {
    let profile = route
        .profile
        .as_ref()
        .map(|p| format!("{} · {} · ", p.name, route.size))
        .unwrap_or_default();
    let model = &route.model_name;
    match route.source.as_str() {
        "user" => format!("{model} · set by you"),
        "coordinator" => format!("{model} · set by the coordinator"),
        "cyber" => format!("{profile}{model} · after a cyber block"),
        "default" if !route.reason.is_empty() => {
            format!("{profile}default {model} · {}", route.reason)
        }
        "profile" if !route.busier_name.is_empty() => {
            format!("{profile}{model} · {} was busier", route.busier_name)
        }
        "profile" if !route.reason.is_empty() => format!("{profile}{model} · {}", route.reason),
        "profile" => format!("{profile}{model} · preferred"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_lines_name_the_profile_size_model_and_why() {
        let route = |source: &str, busier: &str, reason: &str| c::TaskModelRoute {
            task_id: "t".into(),
            profile: Some(c::ProfileName {
                id: "ui".into(),
                name: "UI".into(),
            }),
            size: "large".into(),
            model_name: "Sol".into(),
            source: source.into(),
            busier_name: busier.into(),
            reason: reason.into(),
        };
        assert_eq!(model_line(&route("profile", "", "")), "UI · large · Sol · preferred");
        assert_eq!(
            model_line(&route("profile", "Opus 5.5", "")),
            "UI · large · Sol · Opus 5.5 was busier"
        );
        assert_eq!(
            model_line(&route("profile", "", "Opus 5.5 is at its limit")),
            "UI · large · Sol · Opus 5.5 is at its limit"
        );
        assert_eq!(
            model_line(&route("default", "", "no UI large model is signed in")),
            "UI · large · default Sol · no UI large model is signed in"
        );
        assert_eq!(model_line(&route("default", "", "")), "");
        assert_eq!(
            model_line(&route("cyber", "", "")),
            "UI · large · Sol · after a cyber block"
        );
        let set = c::TaskModelRoute {
            profile: None,
            ..route("user", "", "")
        };
        assert_eq!(model_line(&set), "Sol · set by you");
    }
}
