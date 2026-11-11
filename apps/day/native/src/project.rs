//! Turns the daemon's v1 reads (`DayOverview`, `MissionDetail` and control
//! receipts) into Today's read model. Pure functions: no clock, transport or
//! storage. Movement comes only from current agent reports; activity, task
//! counts and working chats never count as movement.

use std::collections::HashMap;

use crate::{
    contract as c,
    model::{
        ChatLine, ControlAsk, ControlState, ControlView, Currentness, Decision, DecisionKind,
        Delivery, Freshness, FreshnessState, MemberLine, MemberState, MissionPage, MissionRow,
        MissionState, Movement, Output, OutputKind, Progress, ReportLine, TaskLine, TaskStatus,
    },
};

/// One minute, in epoch milliseconds.
pub const MINUTE: u64 = 60_000;

/// How long ago `then` was at `now`, as the user reads it.
pub fn ago(now: u64, then: u64) -> String {
    let minutes = now.saturating_sub(then) / MINUTE;
    match minutes {
        0 => "just now".to_owned(),
        1..=59 => format!("{minutes} min ago"),
        60..=1439 => format!("{} h ago", minutes / 60),
        1440..=2879 => "yesterday".to_owned(),
        _ => format!("{} days ago", minutes / 1440),
    }
}

/// What the app knows about a mission's control beyond the read: the
/// user's own request and the last receipt it saw.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ControlLocal {
    /// Where the user's request is.
    pub delivery: Delivery,
    /// What it asks.
    pub asked: Option<ControlAsk>,
    /// The command, recorded before it is sent. Kept while its outcome is
    /// unknown, so a check can look it up. Never sent twice.
    pub command: Option<c::ControlCommand>,
    /// The last receipt the service returned for this mission.
    pub receipt: Option<c::ControlOperation>,
}

/// Everything a projection reads.
pub struct Inputs<'a> {
    /// The latest read.
    pub overview: &'a c::DayOverview,
    /// Mission details read so far.
    pub details: &'a [c::MissionDetail],
    /// Decisions waiting for the user.
    pub decisions: &'a [Decision],
    /// Local control state, by mission.
    pub local: &'a [(String, ControlLocal)],
    /// Whether the read is live. Controls need a live read.
    pub live: bool,
    /// The clock, epoch ms.
    pub now: u64,
}

/// Today's missions in their three groups.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Groups {
    /// A current report says moving.
    pub moving: Vec<MissionRow>,
    /// A current report says not moving, or paused or pausing.
    pub not_moving: Vec<MissionRow>,
    /// No current report.
    pub unreported: Vec<MissionRow>,
}

/// Reports and controls indexed by mission, built once per projection.
struct Index<'a> {
    reports: HashMap<&'a str, Vec<&'a c::ReportView>>,
    controls: HashMap<&'a str, &'a c::Control>,
}

impl<'a> Index<'a> {
    fn new(overview: &'a c::DayOverview) -> Self {
        let mut reports: HashMap<&str, Vec<&c::ReportView>> = HashMap::new();
        for view in &overview.reports {
            // Only agent reports describe movement.
            if view.provenance == c::Provenance::AgentReport {
                reports
                    .entry(view.report.mission_id.as_str())
                    .or_default()
                    .push(view);
            }
        }
        let controls = overview
            .controls
            .iter()
            .map(|control| (control.mission_id.as_str(), control))
            .collect();
        Index { reports, controls }
    }
}

fn currentness(value: c::Currentness) -> Currentness {
    match value {
        c::Currentness::Current => Currentness::Current,
        c::Currentness::Stale => Currentness::Stale,
        c::Currentness::Unavailable => Currentness::Unavailable,
    }
}

fn movement(value: c::Movement) -> Movement {
    match value {
        c::Movement::Moving => Movement::Moving,
        c::Movement::NotMoving => Movement::NotMoving,
        c::Movement::Unknown => Movement::Unknown,
    }
}

fn report_line(view: &c::ReportView, now: u64) -> ReportLine {
    let report = &view.report;
    ReportLine {
        task_id: report.write.task_id.clone(),
        currentness: currentness(view.currentness),
        movement: movement(report.write.movement),
        by_coordinator: report.coordinator_session_id.as_deref()
            == Some(report.session_id.as_str()),
        age: ago(now, report.reported_at),
        summary: report.write.summary.clone(),
        next_step: report.write.next_step.clone(),
        evidence: report.write.evidence.clone(),
    }
}

fn is_current(view: &c::ReportView) -> bool {
    view.currentness == c::Currentness::Current
}

/// The mission's movement from its current reports, if any say.
fn aggregate(reports: &[&c::ReportView]) -> Option<c::Movement> {
    let says = |movement| {
        reports
            .iter()
            .any(|v| is_current(v) && v.report.write.movement == movement)
    };
    if says(c::Movement::Moving) {
        Some(c::Movement::Moving)
    } else if says(c::Movement::NotMoving) {
        Some(c::Movement::NotMoving)
    } else {
        None
    }
}

/// The report a row shows: the newest current one that agrees with the
/// mission's movement, else the newest current one, else the newest.
fn shown<'a>(
    reports: &[&'a c::ReportView],
    agreed: Option<c::Movement>,
) -> Option<&'a c::ReportView> {
    let newest = |keep: &dyn Fn(&c::ReportView) -> bool| {
        reports
            .iter()
            .copied()
            .filter(|v| keep(v))
            .max_by_key(|v| v.report.reported_at)
    };
    newest(&|v| is_current(v) && Some(v.report.write.movement) == agreed)
        .or_else(|| newest(&is_current))
        .or_else(|| newest(&|_| true))
}

fn control_state(state: c::ControlState) -> ControlState {
    match state {
        c::ControlState::Running => ControlState::Running,
        c::ControlState::Pausing => ControlState::Pausing,
        c::ControlState::Paused => ControlState::Paused,
        c::ControlState::Resuming => ControlState::Resuming,
        c::ControlState::Unknown => ControlState::Unknown,
    }
}

fn member_state(state: c::MemberState) -> MemberState {
    match state {
        c::MemberState::Pending => MemberState::Pending,
        c::MemberState::Entered => MemberState::Entered,
        c::MemberState::Paused => MemberState::Paused,
        c::MemberState::Resumed => MemberState::Resumed,
        c::MemberState::Held => MemberState::Held,
        c::MemberState::Unknown => MemberState::Unknown,
    }
}

/// A member chat's title: its task, the coordinator, a working chat's title.
fn member_title(inputs: &Inputs, mission: &c::DashboardMission, session_id: &str) -> String {
    if mission.coordinator_session_id.as_deref() == Some(session_id) {
        return "Coordinator".to_owned();
    }
    let task = inputs
        .details
        .iter()
        .filter(|d| d.mission.id == mission.id)
        .flat_map(|d| d.tasks.iter())
        .find(|t| t.session_id.as_deref() == Some(session_id));
    if let Some(task) = task {
        return format!("#{} {}", task.number, task.title);
    }
    inputs
        .overview
        .dashboard
        .working
        .items
        .iter()
        .find(|w| w.session_id == session_id)
        .map_or_else(|| "A mission chat".to_owned(), |w| w.title.clone())
}

fn control_view(inputs: &Inputs, index: &Index, mission: &c::DashboardMission) -> ControlView {
    let local = inputs
        .local
        .iter()
        .find(|(id, _)| *id == mission.id)
        .map(|(_, local)| local);
    let control = index.controls.get(mission.id.as_str()).copied();
    let delivery = local.map_or(Delivery::Idle, |l| l.delivery);
    let mut view = ControlView {
        state: control.map_or(ControlState::Unknown, |c| control_state(c.state)),
        revision: control.map_or(0, |c| u32::try_from(c.revision).unwrap_or(u32::MAX)),
        held: control.is_some_and(|c| c.held),
        pause_operation_id: control
            .filter(|c| c.state == c::ControlState::Paused)
            .and_then(|c| c.pause_operation_id.clone()),
        delivery,
        asked: local.and_then(|l| l.asked),
        ..ControlView::default()
    };
    // A receipt describes members only while it is not older than the read.
    if let Some(receipt) = local
        .and_then(|l| l.receipt.as_ref())
        .filter(|r| control.is_none_or(|c| r.control.revision >= c.revision))
    {
        view.members = receipt
            .members
            .iter()
            .map(|m| MemberLine {
                title: member_title(inputs, mission, &m.session_id),
                state: member_state(m.state),
                reason: m.reason.clone(),
            })
            .collect();
        view.issues = receipt.issues.clone();
        view.needs_look = receipt.state != c::OperationState::Acknowledged
            || !receipt.issues.is_empty()
            || receipt
                .members
                .iter()
                .any(|m| m.state == c::MemberState::Unknown);
    }
    let idle = delivery == Delivery::Idle;
    view.can_pause = inputs.live
        && idle
        && control.is_some_and(|c| c.state == c::ControlState::Running && !c.held);
    view.can_resume = inputs.live && idle && view.pause_operation_id.is_some();
    view
}

/// The row for one dashboard mission.
fn row(
    inputs: &Inputs,
    index: &Index,
    mission: &c::DashboardMission,
) -> (MissionRow, Option<c::Movement>) {
    let none = Vec::new();
    let reports = index.reports.get(mission.id.as_str()).unwrap_or(&none);
    let agreed = aggregate(reports);
    let report = shown(reports, agreed).map(|v| report_line(v, inputs.now));
    let control = control_view(inputs, index, mission);
    let decision = inputs.decisions.iter().find(|d| d.mission_id == mission.id);
    let state = match (control.delivery, control.asked) {
        (Delivery::Sending, Some(ControlAsk::Pause)) => Some(MissionState::Pausing),
        (Delivery::Sending, Some(ControlAsk::Resume)) => Some(MissionState::Resuming),
        (Delivery::Unknown | Delivery::Checking, _) => Some(MissionState::Unconfirmed),
        _ => match control.state {
            ControlState::Pausing => Some(MissionState::Pausing),
            ControlState::Paused => Some(MissionState::Paused),
            ControlState::Resuming => Some(MissionState::Resuming),
            ControlState::Unknown => Some(MissionState::Unconfirmed),
            ControlState::Running => None,
        },
    }
    .or_else(|| {
        decision.map(|d| match d.kind {
            DecisionKind::Failure => MissionState::Stuck,
            DecisionKind::Unknown => MissionState::Unconfirmed,
            _ if d.delivery == Delivery::Unknown => MissionState::Unconfirmed,
            _ => MissionState::Waiting,
        })
    })
    .unwrap_or(match agreed {
        Some(c::Movement::Moving) => MissionState::Moving,
        Some(c::Movement::NotMoving) => MissionState::NotMoving,
        _ => MissionState::Unreported,
    });
    let stage = inputs
        .details
        .iter()
        .find(|d| d.mission.id == mission.id)
        .and_then(|d| d.mission.current_phase.as_ref())
        .map_or_else(String::new, |p| p.name.clone());
    let counted = mission.tasks_done
        + mission.tasks_in_review
        + mission.tasks_in_progress
        + mission.tasks_blocked;
    let row = MissionRow {
        id: mission.id.clone(),
        title: mission.title.clone(),
        state,
        line: report
            .as_ref()
            .map_or_else(String::new, |r| r.summary.clone()),
        decision_id: decision.map(|d| d.id.clone()),
        stage,
        progress: Progress {
            done: mission.tasks_done,
            review: mission.tasks_in_review,
            active: mission.tasks_in_progress,
            blocked: mission.tasks_blocked,
            todo: mission.tasks_total.saturating_sub(counted),
        },
        report,
        control,
        working: mission.working,
    };
    (row, agreed)
}

/// Today's missions, in the dashboard's order, in three groups.
pub fn missions(inputs: &Inputs) -> Groups {
    let index = Index::new(inputs.overview);
    let mut groups = Groups::default();
    for mission in &inputs.overview.dashboard.missions.items {
        let (row, agreed) = row(inputs, &index, mission);
        let pausing = matches!(
            row.control.state,
            ControlState::Pausing | ControlState::Paused
        ) || (row.control.delivery == Delivery::Sending
            && row.control.asked == Some(ControlAsk::Pause));
        match agreed {
            _ if pausing => groups.not_moving.push(row),
            Some(c::Movement::Moving) => groups.moving.push(row),
            Some(c::Movement::NotMoving) => groups.not_moving.push(row),
            _ => groups.unreported.push(row),
        }
    }
    groups
}

fn task_status(status: c::TaskStatus) -> Option<TaskStatus> {
    Some(match status {
        c::TaskStatus::Todo => TaskStatus::Todo,
        c::TaskStatus::InProgress => TaskStatus::InProgress,
        c::TaskStatus::Blocked => TaskStatus::Blocked,
        c::TaskStatus::InReview => TaskStatus::InReview,
        c::TaskStatus::Delegated => TaskStatus::Delegated,
        c::TaskStatus::Done => TaskStatus::Done,
        c::TaskStatus::Dropped => return None,
        c::TaskStatus::Unknown => TaskStatus::Unknown,
    })
}

fn pull_request_state(pr: Option<&c::PullRequest>, now: u64) -> String {
    let Some(pr) = pr else {
        return "Pilot has not checked it yet".to_owned();
    };
    match pr.state {
        c::PullRequestState::Draft => "Draft, not merged".to_owned(),
        c::PullRequestState::Open => "Open, not merged".to_owned(),
        c::PullRequestState::Merged => pr.merged_at.map_or_else(
            || "Merged".to_owned(),
            |at| format!("Merged {}", ago(now, at)),
        ),
        c::PullRequestState::Closed => "Closed without merging".to_owned(),
        c::PullRequestState::Unknown => "Pilot cannot tell its state".to_owned(),
    }
}

fn link_word(kind: &str) -> &'static str {
    match kind {
        "github.issue" => "GitHub issue",
        "linear.issue" => "Linear issue",
        "linear.project" => "Linear project",
        "slack.thread" => "Slack thread",
        _ => "Link",
    }
}

fn https(url: &str) -> String {
    if url.starts_with("https://") {
        url.to_owned()
    } else {
        String::new()
    }
}

/// What the mission record links to `task_id`: pull requests first, then
/// artifacts, then other links, each in the record's order.
pub fn outputs(detail: &c::MissionDetail, task_id: &str, now: u64) -> Vec<Output> {
    let mine = |t: &Option<String>| t.as_deref() == Some(task_id);
    let resources = detail.resources.iter().filter(|r| mine(&r.task_id));
    let prs = resources
        .clone()
        .filter(|r| r.kind == "github.pr")
        .map(|r| {
            let pr = r.pull_request.as_ref();
            let number = pr.map(|p| p.number).filter(|n| *n > 0);
            let title = pr
                .map(|p| p.title.as_str())
                .filter(|t| !t.is_empty())
                .or(r.title.as_deref())
                .unwrap_or_default();
            let name = number.map_or_else(
                || {
                    r.external_id
                        .clone()
                        .unwrap_or_else(|| "Pull request".to_owned())
                },
                |n| format!("PR #{n}"),
            );
            Output {
                id: r.id.clone(),
                kind: OutputKind::PullRequest,
                label: if title.is_empty() {
                    name
                } else {
                    format!("{name} · {title}")
                },
                state: pull_request_state(pr, now),
                merged: pr.is_some_and(|p| p.state == c::PullRequestState::Merged),
                link: https(&r.url),
            }
        });
    let artifacts = detail
        .artifacts
        .iter()
        .filter(|a| mine(&a.task_id))
        .map(|a| Output {
            id: a.artifact_id.clone(),
            kind: OutputKind::Artifact,
            label: if a.title.is_empty() {
                "Artifact".to_owned()
            } else {
                a.title.clone()
            },
            state: a.revision.map_or_else(
                || "Artifact, latest revision".to_owned(),
                |r| format!("Artifact, revision {r}"),
            ),
            merged: false,
            link: String::new(),
        });
    let links = resources.filter(|r| r.kind != "github.pr").map(|r| Output {
        id: r.id.clone(),
        kind: OutputKind::Link,
        label: r
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| r.external_id.clone())
            .unwrap_or_else(|| r.url.clone()),
        state: link_word(&r.kind).to_owned(),
        merged: false,
        link: https(&r.url),
    });
    prs.chain(artifacts).chain(links).collect()
}

/// The mission overview for `mission_id`, or None when it is not active
/// in the read.
pub fn page(inputs: &Inputs, mission_id: &str, freshness: Freshness) -> Option<MissionPage> {
    let index = Index::new(inputs.overview);
    let mission = inputs
        .overview
        .dashboard
        .missions
        .items
        .iter()
        .find(|m| m.id == mission_id)?;
    let (row, _) = row(inputs, &index, mission);
    let detail = inputs.details.iter().find(|d| d.mission.id == mission_id);
    let none = Vec::new();
    let reports = index.reports.get(mission_id).unwrap_or(&none);
    let mut tasks: Vec<&c::Task> = detail.map(|d| d.tasks.iter().collect()).unwrap_or_default();
    tasks.sort_by(|a, b| a.order.total_cmp(&b.order).then(a.number.cmp(&b.number)));
    let tasks = tasks
        .into_iter()
        .filter_map(|task| {
            let status = task_status(task.status)?;
            let report = reports
                .iter()
                .filter(|v| v.report.write.task_id == task.id)
                .max_by_key(|v| v.report.reported_at)
                .map(|v| report_line(v, inputs.now));
            Some(TaskLine {
                id: task.id.clone(),
                number: task.number,
                title: task.title.clone(),
                status,
                report,
                outputs: detail.map_or_else(Vec::new, |d| outputs(d, &task.id, inputs.now)),
            })
        })
        .collect();
    let chats = inputs
        .overview
        .dashboard
        .working
        .items
        .iter()
        .filter(|w| w.mission_id.as_deref() == Some(mission_id))
        .map(|w| ChatLine {
            id: w.session_id.clone(),
            title: w.title.clone(),
            since: ago(inputs.now, w.started_at),
        })
        .collect();
    Some(MissionPage {
        row,
        goal: detail.map_or_else(String::new, |d| d.mission.goal.clone()),
        tasks_known: detail.is_some(),
        tasks,
        chats,
        freshness,
    })
}

/// The freshness view for a read observed at `observed_at`, if any.
pub fn freshness(
    state: FreshnessState,
    observed_at: Option<u64>,
    reason: &str,
    now: u64,
) -> Freshness {
    Freshness {
        state,
        age: observed_at.map_or_else(String::new, |at| ago(now, at)),
        reason: if state == FreshnessState::Live {
            String::new()
        } else {
            reason.to_owned()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ages_read_naturally() {
        let now = 10 * 1440 * MINUTE;
        assert_eq!(ago(now, now), "just now");
        assert_eq!(ago(now, now - 12 * MINUTE), "12 min ago");
        assert_eq!(ago(now, now - 125 * MINUTE), "2 h ago");
        assert_eq!(ago(now, now - 1500 * MINUTE), "yesterday");
        assert_eq!(ago(now, now - 3 * 1440 * MINUTE), "3 days ago");
        assert_eq!(ago(now, now + MINUTE), "just now");
    }

    #[test]
    fn outputs_keep_merged_apart_from_released_and_belong_to_their_task() {
        let json = r#"{
            "mission": { "id": "m1", "title": "Billing", "goal": "", "coordinatorSessionId": null, "currentPhase": null },
            "tasks": [],
            "artifacts": [
                { "taskId": "t1", "artifactId": "a1", "sessionId": "s1", "title": "Before and after", "kind": "image", "revision": 2, "linkedAt": 1 },
                { "artifactId": "a2", "sessionId": "s1", "title": "Mission chart", "kind": "visual", "linkedAt": 1 }
            ],
            "resources": [
                { "id": "r3", "taskId": "t1", "url": "https://linear.app/x/issue/BIL-224", "kind": "linear.issue", "externalId": "BIL-224", "relationship": "reference", "createdAt": 1 },
                { "id": "r1", "taskId": "t1", "url": "https://github.com/x/y/pull/476", "kind": "github.pr", "relationship": "ownership", "createdAt": 1,
                  "pullRequest": { "number": 476, "url": "https://github.com/x/y/pull/476", "title": "Fix PDF footer layout", "state": "merged", "mergedAt": 1000, "checkedAt": 2000 } },
                { "id": "r2", "taskId": "t2", "url": "https://github.com/x/y/pull/479", "kind": "github.pr", "relationship": "ownership", "createdAt": 1 },
                { "id": "r4", "taskId": "t2", "url": "http://plain.example/doc", "kind": "url", "title": "Runbook", "relationship": "reference", "createdAt": 1,
                  "pullRequest": null }
            ]
        }"#;
        let detail: c::MissionDetail = serde_json::from_str(json).unwrap();
        let now = 1000 + 125 * MINUTE;
        let t1 = outputs(&detail, "t1", now);
        let shown: Vec<(&str, &str, bool)> = t1
            .iter()
            .map(|o| (o.label.as_str(), o.state.as_str(), o.merged))
            .collect();
        assert_eq!(
            shown,
            [
                ("PR #476 · Fix PDF footer layout", "Merged 2 h ago", true),
                ("Before and after", "Artifact, revision 2", false),
                ("BIL-224", "Linear issue", false),
            ]
        );
        let t2 = outputs(&detail, "t2", now);
        assert_eq!(t2[0].label, "Pull request");
        assert_eq!(t2[0].state, "Pilot has not checked it yet");
        assert!(!t2[0].merged);
        assert_eq!((t2[1].label.as_str(), t2[1].link.as_str()), ("Runbook", ""));
        assert!(outputs(&detail, "t3", now).is_empty());
    }
}
