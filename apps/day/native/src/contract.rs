//! Serde mirrors of the daemon's v1 Day contracts: `DayOverview`, mission
//! reports and mission controls (`packages/protocol/src/mission-reports.ts`,
//! `mission-controls.ts`) and the parts of the dashboard and mission detail
//! they embed. Only the fields Today reads are declared. Unknown fields are
//! ignored, so additive protocol changes keep reading. Unknown enum values
//! read as unknown or unavailable, never as a confident state.
//!
//! These types stay in Rust. TSX never sees them, a transport or an
//! identity it could reuse; it gets the projected read model in
//! [`crate::model`].

use serde::{Deserialize, Serialize};

/// `GET /api/projects/:projectId/day`: complete local projections.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayOverview {
    /// Only 1 is read. Another version is refused, not guessed.
    pub version: u32,
    /// The project the overview describes.
    pub project_id: String,
    /// Epoch ms when the daemon read it.
    pub observed_at: u64,
    /// Describes these local projections only, not all possible work.
    pub complete: bool,
    /// The project's dashboard, every section complete.
    pub dashboard: Dashboard,
    /// The latest saved report per reported task.
    pub reports: Vec<ReportView>,
    /// One control per mission.
    pub controls: Vec<Control>,
}

/// The parts of `ProjectDashboard` Today reads.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    /// Canonical host-owned attention, not inferred from agent reports.
    /// Missing on an older service means unknown, not an empty inbox.
    #[serde(default)]
    pub needs_you: Option<Section<NeedsYouItem>>,
    /// Active missions, those needing the user first.
    pub missions: Section<DashboardMission>,
    /// Chats working now.
    pub working: Section<WorkingItem>,
    /// One group per configured request source (Slack, Linear). Each holds
    /// only a preview of its rows; `total` counts them all.
    #[serde(default)]
    pub tracked: Vec<TrackedSource>,
}

/// The fields of `DashboardNeedsYouItem` needed for passive problem rows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYouItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub session_id: Option<String>,
    pub mission_id: Option<String>,
    pub reason: Option<String>,
    pub attention_reason: AttentionReason,
    pub counts_in_badge: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionReason {
    pub kind: String,
    pub detail: Option<String>,
}

/// `DashboardTrackedSource`: a configured request source and the rows the
/// dashboard previews. Not complete: `items` is a short preview.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedSource {
    /// "slack" or "linear". Other values are shown by their label only.
    pub source: String,
    /// The source's display name.
    pub label: String,
    /// Its health.
    pub status: SourceStatus,
    /// A short, sanitized reason when it failed.
    pub error: Option<String>,
    /// Every active row of the source, more than the preview holds.
    pub total: u32,
    /// The preview, newest first (Linear: open issues first).
    #[serde(default)]
    pub items: Vec<TrackedItem>,
    /// Linear only: finished and canceled issues, counted in `total`.
    pub done: Option<Section<TrackedItem>>,
}

/// `SourceStatus` of a request source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    NotConfigured,
    Idle,
    Ok,
    Syncing,
    SignInRequired,
    Error,
    /// Also any value this build does not know.
    #[default]
    #[serde(other)]
    Unknown,
}

/// `DashboardTrackedItem`: one request as the source and Pilot's triage
/// saw it. External text is untrusted and shown as text only.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedItem {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    /// A Linear state name, or a local Slack status.
    pub status: Option<String>,
    /// Epoch ms. Older Slack rows were saved with a fractional part
    /// (`ts * 1000`); it is dropped, so they still read.
    #[serde(default, deserialize_with = "epoch_ms")]
    pub updated_at: Option<u64>,
    pub external_id: Option<String>,
    /// Source-specific fields, such as a Slack channel name or a Linear
    /// identifier. Read by name; anything else is ignored.
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub slack: Option<SlackTriage>,
    /// The latest chat and mission started from or linked to it.
    pub session_id: Option<String>,
    pub mission_id: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub mission_ids: Vec<String>,
}

/// Epoch milliseconds, accepting the fractional values older Slack rows hold.
fn epoch_ms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let Some(value) = Option::<f64>::deserialize(d)? else {
        return Ok(None);
    };
    if !value.is_finite() || value < 0.0 || value > 9_007_199_254_740_991.0 {
        return Err(serde::de::Error::custom("invalid epoch milliseconds"));
    }
    Ok(Some(value.trunc() as u64))
}

impl TrackedItem {
    /// Whether any chat or mission was started from or linked to it.
    pub fn linked(&self) -> bool {
        self.session_id.is_some()
            || self.mission_id.is_some()
            || !self.session_ids.is_empty()
            || !self.mission_ids.is_empty()
    }

    /// A metadata field as text, when it is text and not empty.
    pub fn text(&self, key: &str) -> Option<&str> {
        self.metadata
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.trim().is_empty())
    }
}

/// `SlackTriage`: Slack's effective values after the user's overrides.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackTriage {
    #[serde(rename = "type", default)]
    pub kind: String,
    pub label: Option<String>,
    #[serde(default)]
    pub severity: String,
    /// open, in_progress, waiting, done or dismissed.
    #[serde(default)]
    pub status: String,
}

/// A dashboard section: rows and the full count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section<T> {
    /// Every matching row, not just those in `items`.
    pub total: u32,
    /// The rows. Complete in a `DayOverview`.
    pub items: Vec<T>,
}

impl<T> Default for Section<T> {
    fn default() -> Self {
        Section {
            total: 0,
            items: Vec::new(),
        }
    }
}

/// `DashboardMission`: task counts are host data, not movement.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardMission {
    pub id: String,
    pub title: String,
    pub tasks_done: u32,
    pub tasks_in_review: u32,
    pub tasks_in_progress: u32,
    pub tasks_blocked: u32,
    pub tasks_total: u32,
    /// Member chats working now. Activity, not progress.
    pub working: u32,
    pub needs_you: u32,
    pub coordinator_session_id: Option<String>,
    /// The new mission that re-plans this old one (Day overview only).
    #[serde(default)]
    pub successor: Option<SuccessorLink>,
    /// The old mission this new one re-plans (Day overview only).
    #[serde(default)]
    pub replaces: Option<SuccessorLink>,
}

/// `MissionSuccessorLink`: one side of a re-planning link. `state` is
/// "planning" while open, then "abandoned" or "finished".
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessorLink {
    pub mission_id: String,
    pub state: String,
}

impl SuccessorLink {
    /// Whether re-planning is still going on.
    pub fn open(&self) -> bool {
        self.state == "planning"
    }
}

/// `DashboardWorkingItem`: a chat working now.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingItem {
    pub session_id: String,
    pub title: String,
    pub mission_id: Option<String>,
    /// Epoch ms of the latest user submission, else creation.
    pub started_at: u64,
}

/// `MissionReportView`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    pub report: Report,
    pub currentness: Currentness,
    pub provenance: Provenance,
}

/// Whether a report still describes the task's current owner and source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Currentness {
    Current,
    Stale,
    /// Also any value this build does not know.
    #[serde(other)]
    Unavailable,
}

/// Where a movement assessment came from. Only `agent_report` exists in v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    AgentReport,
    /// Not shown as movement.
    #[serde(other)]
    Unrecognized,
}

/// `MissionReport`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub mission_id: String,
    pub project_id: String,
    /// The reporting agent's chat.
    pub session_id: String,
    pub coordinator_session_id: Option<String>,
    pub reported_at: u64,
    /// A display limit, not proof of progress before it.
    pub valid_until: u64,
    pub write: ReportWrite,
}

/// `MissionReportWrite`, without its source token and predecessor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportWrite {
    pub version: u32,
    pub report_id: String,
    pub task_id: String,
    pub movement: Movement,
    pub summary: String,
    pub next_step: String,
    /// Reported references, not host-verified proof.
    pub evidence: Vec<String>,
    /// Optional scoped worker claim. Never canonical task completion.
    pub delivery: Option<ReportDelivery>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDelivery {
    pub commit: String,
    pub checks: String,
    pub issues: String,
}

/// An agent's movement assessment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Movement {
    Moving,
    NotMoving,
    /// Also any value this build does not know.
    #[serde(other)]
    Unknown,
}

/// `MissionControl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub version: u32,
    pub mission_id: String,
    pub revision: u64,
    pub pause_generation: u64,
    pub stop_generation: u64,
    pub held: bool,
    pub state: ControlState,
    pub operation_id: Option<String>,
    pub pause_operation_id: Option<String>,
}

/// A mission's control state. Pausing is not paused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlState {
    #[default]
    Running,
    Pausing,
    Paused,
    Resuming,
    /// Also any value this build does not know.
    #[serde(other)]
    Unknown,
}

/// The home a command is pinned to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub daemon_id: String,
    pub lineage_id: String,
}

/// What a control command does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    Pause,
    Resume,
}

/// `MissionControlCommand` v1, posted by the native host only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCommand {
    pub version: u32,
    pub operation_id: String,
    pub home: Home,
    pub project_id: String,
    /// Sent as `null` when the user coordinates.
    pub coordinator_session_id: Option<String>,
    pub expected_revision: u64,
    pub action: ControlAction,
    /// Required for Resume: only this Pause's work may resume.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pause_operation_id: Option<String>,
}

/// `MissionControlOperation`: a historical receipt. Reading it never
/// executes or retries work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlOperation {
    pub version: u32,
    pub mission_id: String,
    pub command: ControlCommand,
    pub control: Control,
    pub members: Vec<ControlMember>,
    #[serde(default)]
    pub issues: Vec<String>,
    pub state: OperationState,
}

/// Where an operation is. An entered operation interrupted is Unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Entered,
    Acknowledged,
    #[serde(other)]
    Unknown,
}

/// `MissionControlMember`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlMember {
    pub session_id: String,
    pub state: MemberState,
    pub reason: Option<String>,
}

/// One member's place in a Pause or Resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberState {
    Pending,
    Entered,
    Paused,
    Resumed,
    Held,
    #[serde(other)]
    Unknown,
}

/// The parts of `MissionDetail` (`GET /api/missions/:id`) the mission
/// overview reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionDetail {
    pub mission: MissionHead,
    pub tasks: Vec<Task>,
    /// Artifacts linked to the mission or one of its tasks.
    #[serde(default)]
    pub artifacts: Vec<ArtifactLink>,
    /// Links (PRs, issues, threads, pages) on the mission or its tasks.
    #[serde(default)]
    pub resources: Vec<Resource>,
    /// The current brief. Read only to draft a re-plan of an old mission.
    #[serde(default)]
    pub brief: Option<Brief>,
    /// Every decision, replaced and withdrawn ones too.
    #[serde(default)]
    pub decisions: Vec<MissionDecision>,
}

/// `MissionBrief`: the brief's markdown.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    #[serde(default)]
    pub markdown: String,
}

/// `MissionDecision`: one numbered decision. A replacement or withdrawal
/// means it is no longer in force.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionDecision {
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub replacement: Option<serde_json::Value>,
    #[serde(default)]
    pub withdrawn: Option<serde_json::Value>,
}

/// `MissionArtifactLink`: an artifact an agent linked. Linking is not
/// acceptance.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLink {
    /// Omitted for mission-level links.
    pub task_id: Option<String>,
    pub artifact_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub kind: String,
    /// The pinned revision; omitted opens the latest.
    pub revision: Option<u32>,
}

/// `MissionResource`: a link on the mission or one task.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    /// Omitted for mission-level links.
    pub task_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    /// github.pr, github.issue, linear.issue, linear.project, slack.thread
    /// or url. Others are shown as links.
    #[serde(default)]
    pub kind: String,
    pub external_id: Option<String>,
    /// The last GitHub state Pilot saw, for pull requests.
    pub pull_request: Option<PullRequest>,
    /// "managed" when this mission manages the Linear ticket.
    #[serde(default)]
    pub linear_role: Option<String>,
    #[serde(default)]
    pub linear_key: Option<String>,
}

/// The parts of `SessionPullRequest` an output shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    #[serde(default)]
    pub title: String,
    pub state: PullRequestState,
    /// GitHub's merge time, epoch ms.
    pub merged_at: Option<u64>,
    /// Pilot's last successful look, epoch ms.
    #[serde(default)]
    pub checked_at: u64,
    pub readiness: Option<PullRequestReadiness>,
}

/// Cached health from the actual PR lookup, never completion prose.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReadiness {
    pub state: String,
    pub checked_at: u64,
    #[serde(default)]
    pub reasons: Vec<PullRequestReason>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReason {
    pub code: String,
    #[serde(default)]
    pub names: Vec<String>,
}

/// A pull request's GitHub state. Merged is not released.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestState {
    Draft,
    Open,
    Merged,
    Closed,
    /// Also any value this build does not know.
    #[default]
    #[serde(other)]
    Unknown,
}

/// The parts of `Mission` the overview reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionHead {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub goal: String,
    pub coordinator_session_id: Option<String>,
    pub current_phase: Option<Phase>,
    /// 1 for missions created through planning interviews. Absent for old
    /// missions, which cannot be revisited.
    #[serde(default)]
    pub planning_version: Option<u32>,
}

/// `MissionCurrentPhase`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub name: String,
    pub done: u32,
    pub total: u32,
}

/// The parts of `MissionTask` the overview reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub number: u32,
    pub title: String,
    pub status: TaskStatus,
    pub session_id: Option<String>,
    #[serde(default)]
    pub order: f64,
}

/// `MissionTaskStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Blocked,
    InReview,
    Delegated,
    Done,
    Dropped,
    #[serde(other)]
    Unknown,
}

/// Why a v1 read was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// The body was not the expected shape.
    Shape(String),
    /// A version this build does not read.
    Version(u32),
    /// The overview does not say it is complete.
    Incomplete,
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Shape(why) => write!(f, "unexpected shape: {why}"),
            ReadError::Version(v) => write!(f, "version {v} is not supported"),
            ReadError::Incomplete => write!(f, "the overview is not complete"),
        }
    }
}

/// Reads a `DayOverview` v1 body. Every report, control and the overview
/// itself must be version 1; nothing is partly accepted.
pub fn read_overview(json: &str) -> Result<DayOverview, ReadError> {
    let overview: DayOverview =
        serde_json::from_str(json).map_err(|e| ReadError::Shape(e.to_string()))?;
    check_overview(&overview)?;
    Ok(overview)
}

/// Checks the versions and completeness of an overview already read.
pub fn check_overview(overview: &DayOverview) -> Result<(), ReadError> {
    if overview.version != 1 {
        return Err(ReadError::Version(overview.version));
    }
    if !overview.complete {
        return Err(ReadError::Incomplete);
    }
    if let Some(v) = overview
        .controls
        .iter()
        .map(|c| c.version)
        .chain(overview.reports.iter().map(|r| r.report.version))
        .chain(overview.reports.iter().map(|r| r.report.write.version))
        .find(|v| *v != 1)
    {
        return Err(ReadError::Version(v));
    }
    Ok(())
}

/// Reads a `MissionControlOperation` v1 receipt.
pub fn read_operation(json: &str) -> Result<ControlOperation, ReadError> {
    let operation: ControlOperation =
        serde_json::from_str(json).map_err(|e| ReadError::Shape(e.to_string()))?;
    if operation.version != 1 {
        return Err(ReadError::Version(operation.version));
    }
    Ok(operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OVERVIEW: &str = r#"{
        "version": 1,
        "projectId": "p1",
        "observedAt": 1794229320000,
        "complete": true,
        "dashboard": {
            "projectId": "p1",
            "summary": { "chats": 2, "working": 1, "needsYou": 0, "openPullRequests": 0, "readyPullRequests": 0, "activeMissions": 1 },
            "needsYou": { "total": 0, "items": [] },
            "working": { "total": 1, "items": [{ "sessionId": "s1", "title": "Index", "state": "working", "mode": "build", "missionId": "m1", "startedAt": 1794229000000 }] },
            "pullRequests": { "total": 0, "items": [] },
            "missions": { "total": 1, "items": [{ "id": "m1", "title": "Faster search", "tasksDone": 7, "tasksInReview": 0, "tasksInProgress": 1, "tasksBlocked": 0, "tasksTotal": 10, "working": 1, "needsYou": 0, "coordinatorSessionId": "c1" }] },
            "scheduled": { "total": 0, "items": [] },
            "tracked": [],
            "recent": { "total": 0, "items": [] }
        },
        "reports": [{
            "report": { "version": 1, "missionId": "m1", "projectId": "p1", "sessionId": "s1", "coordinatorSessionId": "c1", "reportedAt": 1794228600000, "validUntil": 1794315000000,
                "write": { "version": 1, "reportId": "r1", "taskId": "t1", "source": "opaque", "expectedPreviousId": null, "movement": "moving", "summary": "Running tests.", "nextStep": "Fix the order.", "evidence": ["7c1e04a"] } },
            "currentness": "current",
            "provenance": "agent_report"
        }],
        "controls": [{ "version": 1, "missionId": "m1", "revision": 3, "pauseGeneration": 1, "stopGeneration": 0, "held": false, "state": "running" }]
    }"#;

    #[test]
    fn a_v1_overview_reads_with_extra_fields_ignored() {
        let overview = read_overview(OVERVIEW).unwrap();
        assert_eq!(
            overview.dashboard.missions.items[0]
                .coordinator_session_id
                .as_deref(),
            Some("c1")
        );
        assert_eq!(overview.reports[0].report.write.movement, Movement::Moving);
        assert_eq!(overview.reports[0].provenance, Provenance::AgentReport);
        assert_eq!(overview.controls[0].state, ControlState::Running);
        assert_eq!(overview.controls[0].revision, 3);
    }

    #[test]
    fn legacy_fractional_slack_times_still_read() {
        // Regression: one real project's overview failed as Invalid on these rows.
        let legacy_slack = OVERVIEW.replace(
            "\"tracked\": []",
            r#""tracked": [{ "source": "slack", "label": "Slack", "status": "ok", "total": 1,
                "items": [{ "id": "t1", "title": "Ask", "updatedAt": 1794579011204.229 }] }]"#,
        );
        let overview = read_overview(&legacy_slack).unwrap();
        assert_eq!(
            overview.dashboard.tracked[0].items[0].updated_at,
            Some(1794579011204)
        );
        for bad in ["-1", "1e300", "\"soon\""] {
            let row = legacy_slack.replace("1794579011204.229", bad);
            assert!(read_overview(&row).is_err(), "{bad}");
        }
    }

    #[test]
    fn other_versions_and_unknown_values_are_never_read_as_confident() {
        let v2 = OVERVIEW.replacen("\"version\": 1", "\"version\": 2", 1);
        assert_eq!(read_overview(&v2), Err(ReadError::Version(2)));
        let incomplete = OVERVIEW.replace("\"complete\": true", "\"complete\": false");
        assert_eq!(read_overview(&incomplete), Err(ReadError::Incomplete));
        let odd = OVERVIEW
            .replace("\"currentness\": \"current\"", "\"currentness\": \"fresh\"")
            .replace("\"movement\": \"moving\"", "\"movement\": \"sprinting\"")
            .replace("\"state\": \"running\"", "\"state\": \"draining\"");
        let overview = read_overview(&odd).unwrap();
        assert_eq!(overview.reports[0].currentness, Currentness::Unavailable);
        assert_eq!(overview.reports[0].report.write.movement, Movement::Unknown);
        assert_eq!(overview.controls[0].state, ControlState::Unknown);
    }

    #[test]
    fn a_resume_command_serializes_to_the_v1_wire_shape() {
        let command = ControlCommand {
            version: 1,
            operation_id: "op-2".into(),
            home: Home {
                daemon_id: "d".into(),
                lineage_id: "l".into(),
            },
            project_id: "p1".into(),
            coordinator_session_id: None,
            expected_revision: 4,
            action: ControlAction::Resume,
            pause_operation_id: Some("op-1".into()),
        };
        let json: serde_json::Value = serde_json::to_value(&command).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1,
                "operationId": "op-2",
                "home": { "daemonId": "d", "lineageId": "l" },
                "projectId": "p1",
                "coordinatorSessionId": null,
                "expectedRevision": 4,
                "action": "resume",
                "pauseOperationId": "op-1"
            })
        );
        let pause = ControlCommand {
            action: ControlAction::Pause,
            pause_operation_id: None,
            ..command
        };
        assert!(
            serde_json::to_value(&pause)
                .unwrap()
                .get("pauseOperationId")
                .is_none()
        );
    }
}
