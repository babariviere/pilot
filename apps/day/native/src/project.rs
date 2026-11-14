//! Turns the daemon's v1 reads (`DayOverview`, `MissionDetail` and control
//! receipts) into Today's read model. Pure functions: no clock, transport or
//! storage. Movement comes only from current agent reports; activity, task
//! counts and working chats never count as movement.

use std::collections::HashMap;

use crate::{
    contract as c,
    model::{
        ChatLine, ControlAsk, ControlState, ControlView, Currentness, Decision, DecisionKind,
        Delivery, Freshness, FreshnessState, MemberLine, MemberState, MissionLink, MissionPage,
        MissionRow, MissionState, Movement, Output, OutputKind, Problem, Progress, ReportLine,
        ReportedDelivery, TaskLine, TaskStatus,
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
        delivery: report.write.delivery.as_ref().map(|d| ReportedDelivery {
            commit: d.commit.clone(),
            checks: d.checks.clone(),
            issues: d.issues.clone(),
        }),
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

/// Only the host's unresolved human-needed rows. Recoverable worker failures
/// absent from this read remain coordinator-owned; report prose cannot create
/// or clear a problem. Unread results belong to delivery discovery, not here.
pub fn problems(overview: &c::DayOverview) -> Vec<Problem> {
    overview.dashboard.needs_you.as_ref().map_or_else(Vec::new, |section| {
        section.items.iter().filter(|item| item.kind != "unread" && item.counts_in_badge != Some(false)).map(|item| {
            let reason = &item.attention_reason;
            let cause = reason.detail.as_ref().filter(|s| !s.trim().is_empty()).or(item.reason.as_ref().filter(|s| !s.trim().is_empty())).cloned();
            let standalone = item.session_id.is_some() && item.mission_id.is_none();
            let next_step = match reason.kind.as_str() {
                "mcp" => "Sign in to the service named above, then check the originating work.",
                "limit" => "Check the usage limit before choosing whether to continue.",
                "mission" if cause.as_deref().is_some_and(|c| c.starts_with("Blocked:")) => "A task is blocked. See its work in the mission.",
                "mission" => "Open the mission and resolve its blocked work or question.",
                "asks" => "Read the originating question and answer it explicitly.",
                "pr_stuck" => "Inspect the pull request and its checks before choosing a next step.",
                "automation" => "Inspect the permission request. Continuing needs explicit permission.",
                "tool_stall" | "long_job" => "Inspect the running work before stopping or continuing it.",
                "no_pr" if standalone => "Its chat finished with changes but no pull request. See the work, then mark it done or send it back.",
                "no_pr" => "Its task finished with changes but no pull request. Open the mission to see the work.",
                _ => "Inspect the originating work before choosing how to continue. Nothing is retried here.",
            };
            Problem {
                id: item.id.clone(),
                title: item.title.clone(),
                cause,
                next_step: next_step.to_owned(),
                mission_id: item.mission_id.clone(),
                project_id: overview.project_id.clone(),
                session_id: item.session_id.clone(),
                task_id: None,
            }
        }).collect()
    })
}

/// On a mission page, names each row's task so its work can open: the task
/// with the row's title (or the blocked task its cause names), else the only
/// task of its chat. Ambiguous rows stay without a task.
fn with_tasks(mut rows: Vec<Problem>, detail: Option<&c::MissionDetail>) -> Vec<Problem> {
    let Some(detail) = detail else { return rows };
    for row in &mut rows {
        let blocked = row
            .cause
            .as_deref()
            .and_then(|c| c.strip_prefix("Blocked: "));
        let by_title: Vec<_> = detail
            .tasks
            .iter()
            .filter(|t| t.title == row.title || Some(t.title.as_str()) == blocked)
            .collect();
        let by_chat: Vec<_> = detail
            .tasks
            .iter()
            .filter(|t| t.session_id.is_some() && t.session_id == row.session_id)
            .collect();
        let task = match (by_title.as_slice(), by_chat.as_slice()) {
            ([t], _) | ([], [t]) => Some(t),
            _ => None,
        };
        row.task_id = task.map(|t| t.id.clone());
        if row.task_id.is_some() && row.next_step.starts_with("Its task finished") {
            row.next_step =
                "Its task finished with changes but no pull request. See the work, then mark it done or send it back."
                    .into();
        }
    }
    rows
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
    let state = match pr.state {
        c::PullRequestState::Draft => "Draft, not merged".to_owned(),
        c::PullRequestState::Open => "Open, not merged".to_owned(),
        c::PullRequestState::Merged => pr.merged_at.map_or_else(
            || "Merged".to_owned(),
            |at| format!("Merged {}", ago(now, at)),
        ),
        c::PullRequestState::Closed => "Closed without merging".to_owned(),
        c::PullRequestState::Unknown => "Pilot cannot tell its state".to_owned(),
    };
    let observed = if pr.checked_at == 0 {
        "state observation time unknown".to_owned()
    } else {
        format!("state last checked {}", ago(now, pr.checked_at))
    };
    let checks = match &pr.readiness {
        Some(r) if r.checked_at > 0 => {
            let failed = r
                .reasons
                .iter()
                .find(|reason| reason.code == "failing_checks");
            let health = if let Some(failed) = failed {
                if failed.names.is_empty() {
                    "Checks failed".to_owned()
                } else {
                    format!("Checks failed: {}", failed.names.join(", "))
                }
            } else {
                match r.state.as_str() {
                    "ready" => "Readiness reported ready".to_owned(),
                    "blocked" => "Readiness blocked".to_owned(),
                    "pending" => "Readiness pending".to_owned(),
                    _ => "Readiness unknown".to_owned(),
                }
            };
            format!("{health}, last checked {}", ago(now, r.checked_at))
        }
        _ => "Checks not observed".to_owned(),
    };
    format!("{state}. {observed}. {checks}.")
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
    let problems = with_tasks(
        problems(inputs.overview)
            .into_iter()
            .filter(|p| p.mission_id.as_deref() == Some(mission_id))
            .collect(),
        detail,
    );
    let replan_draft = detail
        .filter(|d| d.mission.planning_version.is_none())
        .map_or_else(String::new, |d| replan_draft(d, &problems));
    let link = |l: &c::SuccessorLink| MissionLink {
        mission_id: l.mission_id.clone(),
        title: inputs
            .overview
            .dashboard
            .missions
            .items
            .iter()
            .find(|m| m.id == l.mission_id)
            .map_or_else(String::new, |m| m.title.clone()),
    };
    let replanning_as = mission.successor.as_ref().filter(|l| l.open()).map(link);
    let replaces = mission.replaces.as_ref().filter(|l| l.open()).map(link);
    Some(MissionPage {
        row,
        goal: detail.map_or_else(String::new, |d| d.mission.goal.clone()),
        tasks_known: detail.is_some(),
        tasks,
        chats,
        freshness,
        problems,
        can_replan: !replan_draft.is_empty() && replanning_as.is_none(),
        replan_draft,
        replanning_as,
        replaces,
    })
}

/// New's goal limit, in characters (plan_desk::MAX_TEXT).
const REPLAN_MAX: usize = crate::plan_desk::MAX_TEXT;

/// The goal New gets to re-plan an old mission: its goal, then as much of
/// the brief, decisions in force, open tasks, unfinished work and Linear
/// ticket as fits. The user edits it before planning; nothing is sent here.
pub fn replan_draft(detail: &c::MissionDetail, problems: &[Problem]) -> String {
    fn section(out: &mut String, title: &str, lines: impl Iterator<Item = String>, cap: usize) {
        let mut body = String::new();
        for line in lines {
            if body.chars().count() + line.chars().count() + 1 > cap {
                body.push_str("- …\n");
                break;
            }
            body.push_str(&line);
            body.push('\n');
        }
        if !body.is_empty() {
            out.push_str(&format!("\n{title}\n{body}"));
        }
    }
    let cut = |text: &str, n: usize| -> String {
        let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if one.chars().count() <= n {
            one
        } else {
            format!("{}…", one.chars().take(n - 1).collect::<String>())
        }
    };
    let mission = &detail.mission;
    // The first line is the new mission's title, so a re-plan keeps its name.
    let mut out = format!(
        "{}\n\nRe-plan the old mission “{}” as a new mission. Keep what still matters and drop the rest.\n\nGoal: {}\n",
        cut(&mission.title, 80),
        mission.title,
        cut(&mission.goal, 600)
    );
    let brief = detail
        .brief
        .as_ref()
        .map(|b| b.markdown.as_str())
        .unwrap_or("");
    section(
        &mut out,
        "Brief (start):",
        brief
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("# "))
            .map(|l| cut(l, 300)),
        1000,
    );
    section(
        &mut out,
        "Decisions still in force:",
        detail
            .decisions
            .iter()
            .filter(|d| d.replacement.is_none() && d.withdrawn.is_none())
            .map(|d| format!("- D{}: {}", d.number, cut(&d.text, 160))),
        1100,
    );
    let mut open: Vec<_> = detail
        .tasks
        .iter()
        .filter(|t| !matches!(t.status, c::TaskStatus::Done | c::TaskStatus::Dropped))
        .collect();
    open.sort_by(|a, b| a.order.total_cmp(&b.order).then(a.number.cmp(&b.number)));
    section(
        &mut out,
        "Open tasks:",
        open.iter().map(|t| {
            let status = serde_json::to_value(t.status)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.replace('_', " ")))
                .unwrap_or_default();
            format!("- #{} {} ({status})", t.number, cut(&t.title, 100))
        }),
        800,
    );
    section(
        &mut out,
        "Saved work without a pull request:",
        problems
            .iter()
            .filter(|p| p.task_id.is_some() && p.next_step.contains("no pull request"))
            .map(|p| format!("- {}", cut(&p.title, 100))),
        400,
    );
    section(
        &mut out,
        "Linear ticket:",
        detail
            .resources
            .iter()
            .filter(|r| r.linear_role.as_deref() == Some("managed"))
            .map(|r| {
                format!(
                    "- {}",
                    r.linear_key
                        .clone()
                        .or_else(|| r.title.clone())
                        .unwrap_or_else(|| r.url.clone())
                )
            }),
        200,
    );
    if out.chars().count() > REPLAN_MAX {
        out = out.chars().take(REPLAN_MAX - 1).collect::<String>() + "…";
    }
    out
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
                (
                    "PR #476 · Fix PDF footer layout",
                    "Merged 2 h ago. state last checked 2 h ago. Checks not observed.",
                    true
                ),
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

    #[test]
    fn old_missions_get_a_replan_draft_within_new_limit() {
        use serde_json::json;
        let tasks: Vec<_> = (1..=300)
            .map(|n| {
                json!({"id":format!("t{n}"),"number":n,"order":n,
                    "title":format!("Task {n} with a title long enough to fill the draft quickly"),
                    "status": if n % 3 == 0 { "done" } else { "blocked" }})
            })
            .collect();
        let detail: c::MissionDetail = serde_json::from_value(json!({
            "mission": {"id":"m","title":"Old","goal":"Ship it","coordinatorSessionId":"c"},
            "tasks": tasks,
            "brief": {"markdown":"# Old\n\n## Goal\nShip it soon.\n"},
            "decisions": [{"number":1,"text":"Keep this"},
                {"number":2,"text":"Replaced","replacement":{"id":"x"}},
                {"number":3,"text":"Withdrawn","withdrawn":{"at":1}}],
            "resources": [{"id":"r","url":"https://linear.app/x","kind":"linear.issue",
                "linearRole":"managed","linearKey":"stoik/HS-1314"}]
        }))
        .unwrap();
        assert_eq!(detail.mission.planning_version, None, "old mission");
        let unpublished = Problem {
            title: "Drafts".into(),
            task_id: Some("t1".into()),
            next_step: "Its task finished with changes but no pull request. See the work.".into(),
            ..Problem::default()
        };
        let draft = replan_draft(&detail, &[unpublished]);
        assert!(draft.chars().count() <= crate::plan_desk::MAX_TEXT);
        assert_eq!(
            draft.lines().next(),
            Some("Old"),
            "the title line comes first"
        );
        for kept in [
            "“Old”",
            "Goal: Ship it",
            "Ship it soon.",
            "D1: Keep this",
            "#1 Task 1",
            "(blocked)",
            "- Drafts",
            "stoik/HS-1314",
            "- …",
        ] {
            assert!(draft.contains(kept), "{kept} missing from {draft}");
        }
        for gone in ["D2:", "D3:", "#3 Task", "# Old"] {
            assert!(!draft.contains(gone), "{gone} in {draft}");
        }
        let planned: c::MissionHead =
            serde_json::from_value(json!({"id":"m","title":"t","planningVersion":1})).unwrap();
        assert_eq!(planned.planning_version, Some(1));
    }

    /// Regression: a task chat with no pull request could not open its work.
    #[test]
    fn mission_page_rows_name_their_task_by_title_then_only_chat() {
        let task = |id: &str, title: &str, chat: Option<&str>| c::Task {
            id: id.into(),
            number: 1,
            title: title.into(),
            status: c::TaskStatus::Blocked,
            session_id: chat.map(str::to_owned),
            order: 0.0,
        };
        let detail: c::MissionDetail = serde_json::from_value(serde_json::json!({
            "mission": {"id":"m","projectId":"p","title":"M","goal":"","status":"active"},
            "tasks": []
        }))
        .unwrap_or_else(|e| panic!("{e}"));
        let detail = c::MissionDetail {
            tasks: vec![
                task("t46", "Connect", Some("shared")),
                task("t59", "Follow-up", Some("shared")),
                task("t53", "Drafts", Some("own")),
                task("t87", "Sub-issues", None),
            ],
            ..detail
        };
        let row = |title: &str, chat: Option<&str>| {
            Problem {
            title: title.into(),
            next_step: "Its task finished with changes but no pull request. Open the mission to see the work.".into(),
            session_id: chat.map(str::to_owned),
            ..Problem::default()
        }
        };
        let rows = with_tasks(
            vec![
                row("Connect", Some("shared")),
                row("Other", Some("own")),
                row("Sub-issues", Some("gone")),
                row("Unknown", Some("shared")),
                Problem {
                    cause: Some("Blocked: Drafts".into()),
                    ..row("Pilot Day Redesign", None)
                },
            ],
            Some(&detail),
        );
        let ids: Vec<_> = rows.iter().map(|r| r.task_id.as_deref()).collect();
        assert_eq!(
            ids,
            [Some("t46"), Some("t53"), Some("t87"), None, Some("t53")]
        );
        assert!(rows[0].next_step.contains("See the work"));
        assert!(rows[3].next_step.contains("Open the mission"));
        assert!(
            with_tasks(vec![row("Connect", None)], None)[0]
                .task_id
                .is_none()
        );
    }

    #[test]
    fn host_problems_survive_offline_and_reopen_without_inventing_recovery() {
        use crate::{desk::Desk, fixture, model::Scenario};
        let mut world = fixture::world(Scenario::Decisions);
        let overview = world.overview.as_mut().unwrap();
        let row = |id: &str, kind: &str, reason: &str| c::NeedsYouItem {
            id: id.to_owned(),
            kind: kind.to_owned(),
            title: id.to_owned(),
            session_id: Some(format!("chat-{id}")),
            mission_id: Some("native".into()),
            reason: None,
            counts_in_badge: None,
            attention_reason: c::AttentionReason {
                kind: reason.into(),
                detail: Some(format!("Cause {id}")),
            },
        };
        overview.dashboard.needs_you = Some(c::Section {
            total: 4,
            items: vec![
                row("failed-worker", "failed", "failed"),
                row("blocked-coordinator", "question", "mission"),
                row("permission", "automation", "automation"),
                row("unread-result", "unread", "not_reviewed"),
            ],
        });
        let mut desk = Desk::from_world(world);
        assert!(desk.today().problems_known);
        assert_eq!(desk.today().problems.len(), 3);
        assert_eq!(
            desk.today().problems[0].cause.as_deref(),
            Some("Cause failed-worker")
        );
        // Today has no task details, so a task chat's row names no task.
        assert!(desk.today().problems[0].session_id.is_some());
        assert_eq!(desk.today().problems[0].task_id, None);
        assert!(
            desk.today().problems[2]
                .next_step
                .contains("explicit permission")
        );
        assert_eq!(
            desk.mission("native").unwrap().problems,
            desk.today().problems
        );
        desk.lose_read(FreshnessState::Offline, "Service unavailable");
        let reopened = desk.restart();
        assert_eq!(reopened.today().problems, desk.today().problems);
        assert_eq!(reopened.today().freshness.state, FreshnessState::Offline);
        // A complete empty read, not a local dismiss or report claim, clears them.
        let mut next = fixture::world(Scenario::Decisions).overview.unwrap();
        next.dashboard.needs_you = Some(c::Section::default());
        desk.apply_overview(next).unwrap();
        assert!(desk.today().problems.is_empty());
        assert!(desk.today().problems_known);
    }

    #[test]
    fn problems_offer_only_readable_chat_results_and_no_filler() {
        let mut overview = crate::fixture::world(crate::model::Scenario::Decisions)
            .overview
            .unwrap();
        let row =
            |id: &str, kind: &str, mission: Option<&str>, detail: Option<&str>| c::NeedsYouItem {
                id: id.to_owned(),
                kind: kind.to_owned(),
                title: id.to_owned(),
                session_id: (kind == "no_pr").then(|| format!("chat-{id}")),
                mission_id: mission.map(str::to_owned),
                reason: None,
                counts_in_badge: None,
                attention_reason: c::AttentionReason {
                    kind: kind.into(),
                    detail: detail.map(str::to_owned),
                },
            };
        overview.dashboard.needs_you = Some(c::Section {
            total: 4,
            items: vec![
                row("standalone", "no_pr", None, None),
                row("task-chat", "no_pr", Some("m1"), None),
                row("blocked", "mission", Some("m1"), Some("Blocked: Ship it")),
                row(
                    "question",
                    "mission",
                    Some("m1"),
                    Some("A question is waiting"),
                ),
            ],
        });
        let p = problems(&overview);
        assert_eq!(p[0].cause, None);
        assert_eq!(p[0].project_id, overview.project_id);
        assert_eq!(p[0].session_id.as_deref(), Some("chat-standalone"));
        assert!(p[0].next_step.contains("See the work"));
        assert_eq!(p[1].session_id.as_deref(), Some("chat-task-chat"));
        assert_eq!(p[1].task_id, None);
        assert!(p[1].next_step.contains("Open the mission to see the work"));
        assert_eq!(p[2].session_id, None);
        assert_eq!(
            p[2].next_step,
            "A task is blocked. See its work in the mission."
        );
        assert!(p[3].next_step.starts_with("Open the mission and resolve"));
    }

    #[test]
    fn missing_or_incomplete_attention_is_unknown_and_reports_cannot_clear_it() {
        use crate::{desk::Desk, fixture, model::Scenario};
        let mut world = fixture::world(Scenario::Decisions);
        world.overview.as_mut().unwrap().dashboard.needs_you = None;
        let mut desk = Desk::from_world(world.clone());
        assert!(!desk.today().problems_known);
        let overview = world.overview.as_mut().unwrap();
        overview.dashboard.needs_you = Some(c::Section {
            total: 3,
            items: vec![],
        });
        overview.reports[0].report.write.summary = "All deployed and accepted".into();
        overview.reports[0].currentness = c::Currentness::Stale;
        desk.apply_overview(overview.clone()).unwrap();
        assert!(!desk.today().problems_known);
        let page = desk
            .mission(&overview.reports[0].report.mission_id)
            .unwrap();
        assert_eq!(
            page.tasks
                .iter()
                .filter_map(|t| t.report.as_ref())
                .find(|r| r.summary == "All deployed and accepted")
                .unwrap()
                .currentness,
            Currentness::Stale
        );
    }

    #[test]
    fn pr_failures_are_observations_not_completion_or_release_claims() {
        let pr: c::PullRequest = serde_json::from_value(serde_json::json!({
            "number": 3, "title": "Fixture", "state": "open", "checkedAt": 1,
            "readiness": { "state": "blocked", "checkedAt": 2,
                "reasons": [{"code":"failing_checks", "names":["unit", "native"]}] }
        }))
        .unwrap();
        let state = pull_request_state(Some(&pr), 60 * MINUTE);
        assert!(state.contains("Open, not merged"));
        assert!(state.contains("Checks failed: unit, native, last checked 59 min ago"));
        assert!(!state.contains("released"));
        assert_eq!(pull_request_state(None, 0), "Pilot has not checked it yet");
    }

    #[test]
    fn worker_delivery_remains_a_report_and_quiet_notices_do_not_interrupt() {
        use crate::{desk::Desk, fixture, model::Scenario};
        let mut world = fixture::world(Scenario::Decisions);
        let overview = world.overview.as_mut().unwrap();
        let report = &mut overview.reports[0];
        let mission = report.report.mission_id.clone();
        let task = report.report.write.task_id.clone();
        report.currentness = c::Currentness::Stale;
        report.report.write.delivery = Some(c::ReportDelivery {
            commit: "a".repeat(40),
            checks: "Agent claims deployed".into(),
            issues: "Not verified".into(),
        });
        overview.dashboard.needs_you = Some(c::Section {
            total: 1,
            items: vec![c::NeedsYouItem {
                id: "late-success".into(),
                kind: "scheduled_notice".into(),
                counts_in_badge: Some(false),
                ..Default::default()
            }],
        });
        let desk = Desk::from_world(world);
        assert!(desk.today().problems_known);
        assert!(desk.today().problems.is_empty());
        let page = desk.mission(&mission).unwrap();
        let t = page.tasks.iter().find(|t| t.id == task).unwrap();
        let report = t.report.as_ref().unwrap();
        assert_eq!(report.currentness, Currentness::Stale);
        assert_eq!(
            report.delivery.as_ref().unwrap().checks,
            "Agent claims deployed"
        );
        // The report does not create a PR, release, user check or task transition.
        assert_eq!(t.status, TaskStatus::InProgress);
        assert!(t.outputs.is_empty());
    }
}
