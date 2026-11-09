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
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    /// Active missions, those needing the user first.
    pub missions: Section<DashboardMission>,
    /// Chats working now.
    pub working: Section<WorkingItem>,
}

/// A dashboard section: rows and the full count.
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
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
}

/// `DashboardWorkingItem`: a chat working now.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingItem {
    pub session_id: String,
    pub title: String,
    pub mission_id: Option<String>,
    /// Epoch ms of the latest user submission, else creation.
    pub started_at: u64,
}

/// `MissionReportView`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    pub report: Report,
    pub currentness: Currentness,
    pub provenance: Provenance,
}

/// Whether a report still describes the task's current owner and source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Currentness {
    Current,
    Stale,
    /// Also any value this build does not know.
    #[serde(other)]
    Unavailable,
}

/// Where a movement assessment came from. Only `agent_report` exists in v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    AgentReport,
    /// Not shown as movement.
    #[serde(other)]
    Unrecognized,
}

/// `MissionReport`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
}

/// An agent's movement assessment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Movement {
    Moving,
    NotMoving,
    /// Also any value this build does not know.
    #[serde(other)]
    Unknown,
}

/// `MissionControl`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Entered,
    Acknowledged,
    #[serde(other)]
    Unknown,
}

/// `MissionControlMember`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlMember {
    pub session_id: String,
    pub state: MemberState,
    pub reason: Option<String>,
}

/// One member's place in a Pause or Resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionDetail {
    pub mission: MissionHead,
    pub tasks: Vec<Task>,
}

/// The parts of `Mission` the overview reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionHead {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub goal: String,
    pub coordinator_session_id: Option<String>,
    pub current_phase: Option<Phase>,
}

/// `MissionCurrentPhase`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub name: String,
    pub done: u32,
    pub total: u32,
}

/// The parts of `MissionTask` the overview reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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
