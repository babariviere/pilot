//! Pilot's service and its updates, as the Day screens see them: whether the
//! service is registered and answering, the app and service versions, an
//! offered update, and one update run with its steps and the agents it
//! paused. TSX names only what it showed (the kind and revision) and gets
//! back a one-use confirmation; Rust picks the exact target and records the
//! operation. A lost answer stays unknown and only a check reads it; nothing
//! here sends an update, a registration or a resume twice.
//!
//! The mock rules live in [`UpdateDesk`]. The trusted native adapter over the
//! existing updater (registration, signed service handoff and the app's own
//! exit guard) is a separate native seam; nothing here registers, replaces
//! or restarts anything real.

use nsh_core::prelude::*;

use crate::model::{IntentOutcome, OutcomeStatus};

/// Which mock world the update feed starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateScenario {
    /// Registered, answering and up to date.
    #[default]
    Current,
    /// An app and service update waits. Two agents work, one is paused by the
    /// user, and the run goes through: save, pause, update, restore, resume.
    Available,
    /// A service update. The first confirmation is stale (a newer version
    /// arrived), the next one's answer is lost, and Check finds it finished.
    Trouble,
    /// A service update. The first save fails; the next attempt stops because
    /// a job's processes cannot be shown to have ended.
    Refused,
    /// An app and service update that does not pass the signature check.
    Unverified,
    /// The service is not registered. The registration's answer is lost, and
    /// Check finds it registered.
    Absent,
    /// The service is not registered. macOS refuses the first registration;
    /// the second one goes through.
    Denied,
    /// Registered, but not answering.
    Offline,
    /// The service is newer than this app understands. An app update fixes it.
    Newer,
}

/// Whether Pilot's service is registered and answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    /// Registered and answering.
    #[default]
    Registered,
    /// Not registered on this Mac. Pilot registers it only when asked.
    Absent,
    /// Registered, but not answering now.
    Offline,
    /// Answering, but newer or older than this app can work with.
    Incompatible,
    /// Pilot cannot tell. Only a check reads it; nothing is resent.
    Unknown,
}

/// What an update or registration changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateKind {
    /// Registers Pilot's service, with the user's explicit consent.
    #[default]
    Register,
    /// Updates this app only. All chats pause first; the service stays installed.
    App,
    /// Updates the service only. This app keeps running.
    Service,
    /// Updates the app and the service together.
    Both,
}

/// Preservation is normal. Force requires a separate exact-update confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMode {
    /// Save state before interrupting work.
    #[default]
    Normal,
    /// Explicitly accept unsaved UI and unfinished work loss, not safety waivers.
    Force,
}

/// Where an update run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// Working through its steps.
    #[default]
    Running,
    /// Finished: the new version started and Pilot checked it.
    Done,
    /// Stopped before anything was replaced. The message says why and what to do.
    Stopped,
    /// Its answer was lost. Only a check reads what happened; nothing is resent.
    Unknown,
    /// A check is reading what happened.
    Checking,
}

/// Where one step of a run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStepState {
    /// Not started.
    #[default]
    Waiting,
    /// In progress.
    Now,
    /// Finished.
    Done,
    /// It stopped the run here.
    Failed,
    /// Pilot cannot tell whether it finished.
    Unknown,
}

/// One step of an update run.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStep {
    /// What the step does, in a few words.
    pub label: String,
    /// Where it is.
    pub state: UpdateStepState,
}

/// What an update did to an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Working. A service update pauses it at a safe point.
    #[default]
    Working,
    /// Paused at a safe point by this update. Only this update resumes it.
    Paused,
    /// Resume asked after the update, not confirmed yet.
    Resuming,
    /// Resumed after the update.
    Resumed,
    /// Paused or stopped by the user earlier. Updates leave it as it is.
    Held,
    /// Pilot cannot tell its state. It stays as it is until someone checks it.
    Unknown,
}

/// An agent an update touches, or leaves alone.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLine {
    /// The agent's chat.
    pub chat: String,
    /// The mission it works on, or empty.
    pub mission: String,
    /// What the update did to it.
    pub state: AgentState,
    /// A short note, such as a running job. Empty when there is none.
    pub note: String,
}

/// An update Pilot can install.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    /// What it updates.
    pub kind: UpdateKind,
    /// The version it installs.
    pub version: String,
    /// One line about it.
    pub note: String,
}

/// A one-use confirmation Rust prepared. It names the exact versions;
/// confirming it is the only way to start.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    /// Opaque; used once.
    pub id: String,
    /// The mode selected before this one-use confirmation was prepared.
    pub mode: Option<UpdateMode>,
    /// What it changes.
    pub kind: UpdateKind,
    /// The version running now, or empty.
    pub from: String,
    /// The version it installs.
    pub to: String,
    /// Working agents it will pause at a safe point. None when Pilot could
    /// not count them: the screen says Unknown, never zero.
    pub pauses: Option<u32>,
    /// Agents the user paused or stopped, which it leaves as they are. None
    /// when Pilot could not count them.
    pub keeps: Option<u32>,
    /// Whether this app restarts.
    pub restarts: bool,
}

/// One update or registration run.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRun {
    /// What it changes.
    pub kind: UpdateKind,
    /// The version it installs.
    pub version: String,
    /// Where it is.
    pub phase: UpdatePhase,
    /// Its steps, in order.
    pub steps: Vec<UpdateStep>,
    /// What happened, in one or two sentences. Empty while it runs.
    pub message: String,
    /// What the user can do next, when something needs them. Empty otherwise.
    pub next: String,
}

/// The screen a window showed, as the window saved it before an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaceKind {
    /// Today.
    #[default]
    Today,
    /// One mission's overview.
    Mission,
    /// New.
    New,
    /// One mission's planning.
    Plan,
    /// The list of kept changes.
    Changes,
    /// One kept change.
    Change,
}

/// Where the user was, and what they typed that has no other store.
/// Answers and drafts are saved to their own stores first; this keeps the
/// rest. Showing it again sends nothing. Every field after `questions` is
/// optional, so a view saved before it existed still reads.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[prop(exact)]
pub struct SavedView {
    /// The screen under the update page.
    pub place: PlaceKind,
    /// The mission or kept change that screen showed, or empty.
    pub id: String,
    /// Whether the update page was open.
    pub update: bool,
    /// New's unsent goal, exactly as typed.
    pub goal: String,
    /// Standalone New's project, permission and draft identity. Restoring never creates a chat.
    #[prop(default)]
    pub chat: Option<crate::new_chat::ChatChoice>,
    /// The Today item the user brought to the front, or empty.
    pub focused: String,
    /// The planning question the user was on in each interview, as "interview/question".
    pub questions: Vec<String>,
    /// The ritual on screen: "start", "end", "standup", or "standup/start"
    /// and "standup/end" for notes opened from a ritual. Empty for none.
    #[prop(default)]
    pub ritual: String,
    /// The local date the ritual was for, as Today read it. A ritual is
    /// shown again only on the same date.
    #[prop(default)]
    pub date: String,
    /// The start of day's step, from 0.
    #[prop(default)]
    pub step: u32,
    /// Open help on Today's cards, as "item/kind".
    #[prop(default)]
    pub help: Vec<String>,
    /// Interviews that showed all their questions at once.
    #[prop(default)]
    pub see_all: Vec<String>,
    /// The tab of the kept change on screen: "diff", "history" or empty.
    #[prop(default)]
    pub tab: String,
    /// Today's scroll offset, in points.
    #[prop(default)]
    pub today_y: f64,
    /// The Today row that opened the screen under the update page, which
    /// takes the keyboard focus when Today comes back. Empty for none.
    #[prop(default)]
    pub today_row: String,
    /// The scroll offset of the screen under the update page when it is
    /// not Today, in points.
    #[prop(default)]
    pub y: f64,
    /// The text field that had the keyboard focus, by the screen's own
    /// key, or empty.
    #[prop(default)]
    pub input: String,
    /// Its selection start, in UTF-16 units.
    #[prop(default)]
    pub start: u32,
    /// Its selection end, in UTF-16 units (equal to `start` for a caret).
    #[prop(default)]
    pub end: u32,
    /// The delivered result on screen, as "task/<project>/<mission>/<task>"
    /// or "chat/<project>/<session>". Empty for none. Showing it again only reads.
    #[prop(default)]
    pub delivery: String,
    /// Unsent Send back notes, exactly as typed, as "<delivered result>\n<note>".
    /// Restoring one sends nothing.
    #[prop(default)]
    pub notes: Vec<String>,
    /// Reminders ticked on delivered results, as
    /// "<delivered result>#<delivery>\n<reminder>\n...". They send nothing
    /// and are never the user's check.
    #[prop(default)]
    pub reminders: Vec<String>,
    /// The read-only Linear page on screen, as "<project>" or, with an issue
    /// open in place, "<project>/<tracked item>". Empty for none. Showing it
    /// again only reads, and shows nothing for another project.
    #[prop(default)]
    pub linear: String,
}

impl SavedView {
    /// The bytes of text it holds, counted against [`VIEW_LIMIT`].
    pub fn text_bytes(&self) -> usize {
        let lists = self
            .questions
            .iter()
            .chain(&self.help)
            .chain(&self.see_all)
            .chain(&self.notes)
            .chain(&self.reminders)
            .map(String::len)
            .sum::<usize>();
        self.goal.len()
            + self.chat.as_ref().map_or(0, |c| c.text_bytes())
            + self.id.len()
            + self.focused.len()
            + self.ritual.len()
            + self.date.len()
            + self.tab.len()
            + self.today_row.len()
            + self.input.len()
            + self.delivery.len()
            + self.linear.len()
            + lists
    }

    /// The entries in its lists, counted against [`VIEW_ENTRIES`].
    pub fn entries(&self) -> usize {
        self.questions.len()
            + self.help.len()
            + self.see_all.len()
            + self.notes.len()
            + self.reminders.len()
    }

    /// Whether its offsets are plain, non-negative numbers.
    pub fn offsets_valid(&self) -> bool {
        [self.today_y, self.y]
            .iter()
            .all(|y| y.is_finite() && *y >= 0.0 && *y <= 10_000_000.0)
            && self.start <= self.end
    }

    /// Whether `linear` is empty, or names one project and at most one issue by their IDs.
    pub fn linear_valid(&self) -> bool {
        let id = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        let mut parts = self.linear.split('/');
        self.linear.is_empty()
            || (parts.next().is_some_and(id)
                && parts.next().is_none_or(id)
                && parts.next().is_none())
    }
}

/// A saved view for a window that just started, used once.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    /// Opaque; acknowledged once.
    pub id: String,
    /// What to show again.
    pub view: SavedView,
}

/// Pilot's service, its versions and its updates now.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    /// True only when this native root can enforce a separate accepted-loss close.
    /// Omitted/false is unsupported, never permission to use the normal path.
    pub force_available: Option<bool>,
    /// Exact native operation, or empty for a read/mock without one. Check
    /// never treats another operation's success as this operation's ACK.
    pub operation: String,
    /// Changes on every publish.
    pub revision: u32,
    /// Whether the service is registered and answering.
    pub state: ServiceState,
    /// Why it is not registered, not answering or not compatible. Empty otherwise.
    pub reason: String,
    /// This app's version.
    pub app: String,
    /// The running service's version, or empty when unknown.
    pub service: String,
    /// An update Pilot can install, if any.
    pub offer: Option<UpdateOffer>,
    /// Why the offer cannot start now. Empty when it can.
    pub blocked: String,
    /// Agents an update would touch or leave alone.
    pub agents: Vec<AgentLine>,
    /// The confirmation waiting for the user, if any.
    pub pending: Option<Confirmation>,
    /// The latest run, if any.
    pub run: Option<UpdateRun>,
    /// A saved view for this window to show again, once.
    pub restore: Option<Restore>,
}

/// Prepare an update or registration, named as the screen showed it.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[prop(exact)]
pub struct PrepareIntent {
    /// The kind shown.
    pub kind: UpdateKind,
    /// The service view's revision shown.
    pub revision: u32,
    /// Omitted means normal. Never escalated by a failed save.
    pub mode: Option<UpdateMode>,
}

/// Confirm a prepared update, with where the user is.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[prop(exact)]
pub struct ConfirmIntent {
    /// The confirmation shown.
    pub confirmation: String,
    /// Where the user is, saved before anything pauses.
    pub view: SavedView,
}

/// Names a prepared confirmation or a restore, as the screen got it.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[prop(exact)]
pub struct UpdateRef {
    /// The confirmation or restore shown.
    pub id: String,
}

/// What preparing did: a confirmation to show, or why not.
#[derive(Debug, Clone, Default, PartialEq, JsObject, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// Applied, stale or refused.
    pub status: OutcomeStatus,
    /// One sentence for the user. Empty when the confirmation says enough.
    pub message: String,
    /// The confirmation, when there is one.
    pub confirmation: Option<Confirmation>,
}

/// The largest saved view Rust keeps, in bytes of text. A larger one is
/// refused, never cut.
pub const VIEW_LIMIT: usize = 64 * 1024;

/// The most list entries a saved view keeps. More are refused, never cut.
pub const VIEW_ENTRIES: usize = 1024;

/// A mock run's stages. Each moves one step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Checks the exact signed target.
    Verify,
    /// Saves where the user is (forms were saved to their stores first).
    Save,
    /// Records explicit loss acceptance instead of claiming a successful save.
    AcceptLoss,
    /// Pauses the affected agents at a safe point and proves they stopped.
    Pause,
    /// Registers the service, with the user's explicit consent.
    Register,
    /// Replaces the app or service.
    Replace,
    /// Starts the new service and checks its exact identity.
    Start,
    /// The new window shows the saved view. Waits for its acknowledgement.
    Restore,
    /// Resumes only the agents this update paused.
    Resume,
    /// The run stops here, before replacing anything.
    Stop(Stopped),
    /// The answer is lost here.
    Lose,
}

/// Why a mock run stopped before replacing anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stopped {
    /// Where the user is could not be saved.
    Save,
    /// A job's processes cannot be shown to have ended.
    Jobs,
    /// The update did not pass the signature check.
    Signature,
    /// macOS did not allow the service.
    Denied,
}

fn outcome(status: OutcomeStatus, revision: u32, message: &str) -> IntentOutcome {
    IntentOutcome {
        status,
        revision,
        message: message.into(),
    }
}

fn agent(chat: &str, mission: &str, state: AgentState, note: &str) -> AgentLine {
    AgentLine {
        chat: chat.into(),
        mission: mission.into(),
        state,
        note: note.into(),
    }
}

fn labels(kind: UpdateKind) -> &'static [&'static str] {
    match kind {
        UpdateKind::Register => &["Register Pilot's service", "Start it and check it"],
        UpdateKind::App => &[
            "Check the update",
            "Save drafts and where you are",
            "Pause all chats",
            "Update the app",
            "Start it and check it",
            "Resume only chats paused for this update",
            "Restore where you were",
        ],
        UpdateKind::Service => &[
            "Check the update",
            "Save drafts and where you are",
            "Pause agents at a safe point",
            "Update the service",
            "Start it and check it",
            "Resume the agents it paused",
        ],
        UpdateKind::Both => &[
            "Check the update",
            "Save drafts and where you are",
            "Pause agents at a safe point",
            "Update the app and the service",
            "Start them and check them",
            "Resume the agents it paused",
            "Restore where you were",
        ],
    }
}

/// The step a stage moves, for a run of `kind`.
fn step_of(kind: UpdateKind, stage: Stage) -> Option<usize> {
    use Stage::*;
    use UpdateKind as K;
    Some(match (kind, stage) {
        (K::Register, Register | Stop(Stopped::Denied)) => 0,
        (K::Register, Start) => 1,
        (_, Verify | Stop(Stopped::Signature)) => 0,
        (_, Save | AcceptLoss | Stop(Stopped::Save)) => 1,
        (K::App, Resume) => 5,
        (K::App, Restore) => 6,
        (_, Pause | Stop(Stopped::Jobs)) => 2,
        (_, Replace) => 3,
        (_, Start) => 4,
        (K::Both, Resume) => 5,
        (K::Both, Restore) => 6,
        (K::Service, Resume) => 5,
        _ => return None,
    })
}

/// The mock service and its update rules. Plain Rust, for the feed and tests.
#[derive(Debug, Clone)]
pub struct UpdateDesk {
    scenario: UpdateScenario,
    view: ServiceView,
    /// The one confirmation waiting, if any.
    prepared: Option<Confirmation>,
    attempts: u32,
    next_id: u32,
    /// Agents' states before the current run, for selective resume.
    before: Vec<AgentState>,
    /// A job's exit could not be proven: the service is not updated until checked.
    inspect: bool,
    /// The saved view, kept until the new window acknowledges it.
    saved: Option<SavedView>,
    /// Restores already acknowledged.
    restored: Vec<String>,
    /// Mock loss disposition. Native consent lives in the durable host journal.
    forced: bool,
}

impl UpdateDesk {
    /// The world for `scenario`.
    pub fn new(scenario: UpdateScenario) -> Self {
        let working = || {
            vec![
                agent(
                    "Export chats as Markdown",
                    "Chat export",
                    AgentState::Working,
                    "",
                ),
                agent("Release notes", "Spring release", AgentState::Working, ""),
                agent(
                    "Search warm-up",
                    "Faster search",
                    AgentState::Held,
                    "Paused by you",
                ),
            ]
        };
        let mut view = ServiceView {
            force_available: Some(true),
            revision: 1,
            app: "0.9.2".into(),
            service: "0.9.2".into(),
            ..ServiceView::default()
        };
        let offer = |kind, version: &str, note: &str| {
            Some(UpdateOffer {
                kind,
                version: version.into(),
                note: note.into(),
            })
        };
        match scenario {
            UpdateScenario::Current => view.agents = working(),
            UpdateScenario::Available | UpdateScenario::Unverified => {
                view.agents = working();
                view.offer = offer(
                    UpdateKind::Both,
                    "0.9.3",
                    "Faster mission reports and calmer notifications.",
                );
            }
            UpdateScenario::Trouble => {
                view.agents = working();
                view.offer = offer(UpdateKind::Service, "0.9.3", "Steadier agent pauses.");
            }
            UpdateScenario::Refused => {
                view.agents = working();
                view.agents[1].note = "A job is running".into();
                view.offer = offer(UpdateKind::Service, "0.9.3", "Steadier agent pauses.");
            }
            UpdateScenario::Absent | UpdateScenario::Denied => {
                view.state = ServiceState::Absent;
                view.service = String::new();
                view.reason =
                    "Pilot's service is not registered on this Mac, so no agent can run.".into();
                view.offer = offer(
                    UpdateKind::Register,
                    "0.9.2",
                    "Runs Pilot's agents in the background.",
                );
            }
            UpdateScenario::Offline => {
                view.state = ServiceState::Offline;
                view.reason = "Pilot's service is registered but is not answering.".into();
                view.offer = offer(UpdateKind::Service, "0.9.3", "Steadier agent pauses.");
            }
            UpdateScenario::Newer => {
                view.agents = working();
                view.state = ServiceState::Incompatible;
                view.service = "0.12.0".into();
                view.reason = "Pilot's service is newer than this app can work with. Its agents keep working.".into();
                view.offer = offer(
                    UpdateKind::App,
                    "0.12.0",
                    "Works with the service now running.",
                );
            }
        }
        let mut desk = Self {
            scenario,
            view,
            prepared: None,
            attempts: 0,
            next_id: 0,
            before: Vec::new(),
            inspect: false,
            saved: None,
            restored: Vec::new(),
            forced: false,
        };
        desk.view.blocked = desk.blocked();
        desk
    }

    /// The service view now.
    pub fn view(&self) -> &ServiceView {
        &self.view
    }

    fn bump(&mut self) {
        self.view.revision += 1;
        self.view.blocked = self.blocked();
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    /// Why the offer cannot start now, or empty.
    fn blocked(&self) -> String {
        if let Some(run) = &self.view.run {
            match run.phase {
                UpdatePhase::Running | UpdatePhase::Checking => {
                    return "An update is running.".into();
                }
                UpdatePhase::Unknown => {
                    return "Check the last update first. Nothing is sent again.".into();
                }
                _ => {}
            }
        }
        if self.inspect {
            return "Pilot will not update the service until someone checks the agent whose job may still run.".into();
        }
        match self.view.state {
            ServiceState::Offline => {
                "Pilot's service is not answering, so it cannot update now.".into()
            }
            ServiceState::Unknown => "Check whether Pilot's service is registered first.".into(),
            _ => String::new(),
        }
    }

    fn counts(&self, kind: UpdateKind) -> (Option<u32>, Option<u32>) {
        let count = |state| self.view.agents.iter().filter(|a| a.state == state).count() as u32;
        let pauses = if kind != UpdateKind::Register {
            count(AgentState::Working)
        } else {
            0
        };
        (Some(pauses), Some(count(AgentState::Held)))
    }

    /// Prepares a one-use confirmation for the kind and revision shown.
    /// Preparing changes nothing outside the screen.
    pub fn prepare(&mut self, intent: &PrepareIntent) -> Prepared {
        let refuse = |status, message: &str| Prepared {
            status,
            message: message.into(),
            confirmation: None,
        };
        if intent.revision != self.view.revision {
            return refuse(
                OutcomeStatus::Stale,
                "This changed. Read what Pilot shows now.",
            );
        }
        let blocked = self.blocked();
        if !blocked.is_empty() {
            return refuse(OutcomeStatus::Rejected, &blocked);
        }
        let Some(offer) = self.view.offer.clone() else {
            return refuse(
                OutcomeStatus::Rejected,
                "Pilot is up to date. There is nothing to install.",
            );
        };
        if offer.kind != intent.kind {
            return refuse(
                OutcomeStatus::Stale,
                "This changed. Read what Pilot shows now.",
            );
        }
        if intent.kind == UpdateKind::Register && intent.mode == Some(UpdateMode::Force) {
            return refuse(
                OutcomeStatus::Rejected,
                "Force is only available for updates, not registration.",
            );
        }
        let (pauses, keeps) = self.counts(offer.kind);
        let from = match offer.kind {
            UpdateKind::App => self.view.app.clone(),
            _ => self.view.service.clone(),
        };
        let confirmation = Confirmation {
            id: self.id("confirm"),
            mode: intent.mode,
            kind: offer.kind,
            from,
            to: offer.version,
            pauses,
            keeps,
            restarts: matches!(offer.kind, UpdateKind::App | UpdateKind::Both),
        };
        self.prepared = Some(confirmation.clone());
        self.view.pending = Some(confirmation.clone());
        self.bump();
        Prepared {
            status: OutcomeStatus::Accepted,
            message: String::new(),
            confirmation: Some(confirmation),
        }
    }

    /// Drops a prepared confirmation. Nothing was started.
    pub fn cancel(&mut self, intent: &UpdateRef) -> IntentOutcome {
        if self.prepared.as_ref().is_none_or(|c| c.id != intent.id) {
            return outcome(OutcomeStatus::Stale, self.view.revision, "");
        }
        self.prepared = None;
        self.view.pending = None;
        self.bump();
        outcome(OutcomeStatus::Accepted, self.view.revision, "")
    }

    /// Uses the confirmation once and returns the run's stages, or why not.
    /// The saved view is checked here, before anything pauses.
    pub fn begin(&mut self, intent: &ConfirmIntent) -> Result<Vec<Stage>, IntentOutcome> {
        self.begin_selected(&intent.confirmation, Some(&intent.view), false)
    }

    /// Explicitly confirms loss for a Force confirmation. No fake saved view.
    pub fn begin_force(&mut self, intent: &UpdateRef) -> Result<Vec<Stage>, IntentOutcome> {
        self.begin_selected(&intent.id, None, true)
    }

    fn begin_selected(
        &mut self,
        id: &str,
        view: Option<&SavedView>,
        forced: bool,
    ) -> Result<Vec<Stage>, IntentOutcome> {
        let Some(confirmation) = self.prepared.take() else {
            return Err(outcome(
                OutcomeStatus::Rejected,
                self.view.revision,
                "This confirmation was already used. Nothing is sent again.",
            ));
        };
        self.view.pending = None;
        if confirmation.id != id || (confirmation.mode == Some(UpdateMode::Force)) != forced {
            self.bump();
            return Err(outcome(
                OutcomeStatus::Stale,
                self.view.revision,
                "This changed. Confirm again.",
            ));
        }
        if let Some(view) = view
            && (view.text_bytes() > VIEW_LIMIT
                || view.entries() > VIEW_ENTRIES
                || !view.offsets_valid()
                || !view.linear_valid())
        {
            self.bump();
            return Err(outcome(
                OutcomeStatus::Rejected,
                self.view.revision,
                "Where you are is too large to save, so nothing was paused or updated. Shorten New's text, then try again.",
            ));
        }
        self.attempts += 1;
        let kind = confirmation.kind;
        if self.scenario == UpdateScenario::Trouble && self.attempts == 1 {
            // A newer update replaced the one confirmed: the exact target changed.
            self.view.offer = Some(UpdateOffer {
                kind,
                version: "0.9.4".into(),
                note: "Steadier agent pauses, and a fix for long reports.".into(),
            });
            self.bump();
            return Err(outcome(
                OutcomeStatus::Stale,
                self.view.revision,
                "A newer update arrived after you confirmed, so nothing was paused or updated. Read it and confirm again.",
            ));
        }
        use Stage::*;
        let mut stages = match (self.scenario, kind, self.attempts) {
            (UpdateScenario::Absent, _, _) => vec![Register, Lose],
            (UpdateScenario::Denied, _, 1) => vec![Register, Stop(Stopped::Denied)],
            (_, UpdateKind::Register, _) => vec![Register, Start],
            (UpdateScenario::Unverified, _, _) => vec![Verify, Stop(Stopped::Signature)],
            (UpdateScenario::Refused, _, 1) => vec![Verify, Save, Stop(Stopped::Save)],
            (UpdateScenario::Refused, _, _) => vec![Verify, Save, Pause, Stop(Stopped::Jobs)],
            (UpdateScenario::Trouble, _, _) => vec![Verify, Save, Pause, Replace, Lose],
            (_, UpdateKind::App, _) => vec![Verify, Save, Pause, Replace, Start, Resume, Restore],
            (_, UpdateKind::Service, _) => vec![Verify, Save, Pause, Replace, Start, Resume],
            // The service resumes the agents it paused on its own; the new
            // window's acknowledgement only says its view was shown.
            (_, UpdateKind::Both, _) => vec![Verify, Save, Pause, Replace, Start, Resume, Restore],
        };
        if forced {
            // Loss consent cannot bypass signature or process-exit failures.
            stages = if self.scenario == UpdateScenario::Refused {
                vec![Verify, AcceptLoss, Pause, Stop(Stopped::Jobs)]
            } else {
                stages
                    .into_iter()
                    .filter_map(|s| match s {
                        Save => Some(AcceptLoss),
                        Restore => None,
                        other => Some(other),
                    })
                    .collect()
            };
        }
        self.before = self.view.agents.iter().map(|a| a.state).collect();
        self.forced = forced;
        self.saved = view.cloned();
        self.view.operation = confirmation.id;
        self.view.run = Some(UpdateRun {
            kind,
            version: confirmation.to,
            phase: UpdatePhase::Running,
            steps: labels(kind)
                .iter()
                .filter(|label| !forced || **label != "Restore where you were")
                .map(|label| UpdateStep {
                    label: (if forced && *label == "Save drafts and where you are" {
                        "Record accepted state loss"
                    } else if forced && label.starts_with("Resume") {
                        "Leave interrupted work stopped"
                    } else {
                        label
                    })
                    .to_string(),
                    state: UpdateStepState::Waiting,
                })
                .collect(),
            message: String::new(),
            next: String::new(),
        });
        self.bump();
        Ok(stages)
    }

    /// Marks the steps before `at` done and `at` as `state`.
    fn mark(&mut self, at: Option<usize>, state: UpdateStepState) {
        let Some(run) = self.view.run.as_mut() else {
            return;
        };
        let Some(at) = at.or_else(|| {
            run.steps
                .iter()
                .position(|s| s.state == UpdateStepState::Now)
        }) else {
            return;
        };
        for step in run.steps.iter_mut().take(at) {
            step.state = UpdateStepState::Done;
        }
        if let Some(step) = run.steps.get_mut(at) {
            step.state = state;
        }
    }

    fn all_done(&mut self) {
        if let Some(run) = self.view.run.as_mut() {
            for step in &mut run.steps {
                step.state = UpdateStepState::Done;
            }
        }
    }

    fn finish(&mut self, phase: UpdatePhase, message: &str, next: &str) {
        if let Some(run) = self.view.run.as_mut() {
            run.phase = phase;
            run.message = message.into();
            run.next = next.into();
        }
    }

    fn version(&self) -> String {
        self.view
            .run
            .as_ref()
            .map(|r| r.version.clone())
            .unwrap_or_default()
    }

    /// Puts the agents this run paused back as they were before it.
    fn unpause(&mut self) {
        for (agent, before) in self.view.agents.iter_mut().zip(&self.before) {
            if agent.state == AgentState::Paused {
                agent.state = if self.forced {
                    AgentState::Unknown
                } else {
                    *before
                };
                if self.forced {
                    agent.note = "Interrupted by Force update; not replayed".into();
                }
            }
        }
    }

    /// Applies one stage. Returns the run's outcome when the stage ends it,
    /// or when it waits for the new window.
    pub fn apply(&mut self, stage: Stage) -> Option<IntentOutcome> {
        let kind = self.view.run.as_ref().map(|r| r.kind)?;
        let at = step_of(kind, stage);
        match stage {
            Stage::Verify | Stage::Save | Stage::AcceptLoss | Stage::Register | Stage::Replace => {
                self.mark(at, UpdateStepState::Now);
            }
            Stage::Pause => {
                self.mark(at, UpdateStepState::Now);
                for agent in &mut self.view.agents {
                    if agent.state == AgentState::Working {
                        agent.state = AgentState::Paused;
                    }
                }
            }
            Stage::Start if kind == UpdateKind::Register => {
                self.all_done();
                self.view.state = ServiceState::Registered;
                self.view.service = self.version();
                self.view.offer = None;
                self.view.reason.clear();
                let message = format!(
                    "Pilot's service is registered and answering, version {}.",
                    self.view.service
                );
                self.finish(UpdatePhase::Done, &message, "");
                self.bump();
                return Some(outcome(
                    OutcomeStatus::Accepted,
                    self.view.revision,
                    "Registered.",
                ));
            }
            Stage::Start => {
                self.mark(at, UpdateStepState::Now);
                if kind == UpdateKind::App {
                    self.view.app = self.version();
                } else {
                    self.view.service = self.version();
                }
            }
            Stage::Restore => {
                self.mark(at, UpdateStepState::Now);
                self.view.app = self.version();
                if self.view.state == ServiceState::Incompatible {
                    self.view.state = ServiceState::Registered;
                    self.view.reason.clear();
                }
                self.view.offer = None;
                let id = self.id("restore");
                self.view.restore = Some(Restore {
                    id,
                    view: self.saved.clone().unwrap_or_default(),
                });
                self.bump();
                return Some(outcome(
                    OutcomeStatus::Accepted,
                    self.view.revision,
                    "Pilot restarted with the new version. Restoring where you were.",
                ));
            }
            Stage::Resume => {
                for agent in &mut self.view.agents {
                    if agent.state == AgentState::Paused {
                        agent.state = if self.forced {
                            AgentState::Unknown
                        } else {
                            AgentState::Resumed
                        };
                        if self.forced {
                            agent.note = "Interrupted by Force update; not replayed".into();
                        }
                    }
                }
                if kind != UpdateKind::Service && !self.forced {
                    // The window still restarts; the run ends once it shows its view.
                    self.mark(at, UpdateStepState::Done);
                    self.bump();
                    return None;
                }
                self.all_done();
                self.view.offer = None;
                let message = if self.forced {
                    self.view.app = if kind == UpdateKind::Service {
                        self.view.app.clone()
                    } else {
                        self.version()
                    };
                    if self.view.state == ServiceState::Incompatible {
                        self.view.state = ServiceState::Registered;
                        self.view.reason.clear();
                    }
                    format!(
                        "Updated to {}. Force accepted loss of unsaved UI state and unfinished work. Durable history was kept. Interrupted work was not replayed.",
                        self.version()
                    )
                } else {
                    format!(
                        "Updated to {}. Pilot checked that the new version is the one running, and resumed only the agents it paused.",
                        self.version()
                    )
                };
                self.finish(UpdatePhase::Done, &message, "");
                self.saved = None;
                self.bump();
                return Some(outcome(
                    OutcomeStatus::Accepted,
                    self.view.revision,
                    "Updated.",
                ));
            }
            Stage::Stop(why) => {
                self.mark(at, UpdateStepState::Failed);
                self.unpause();
                let (message, next) = match why {
                    Stopped::Save => (
                        "Pilot could not save where you are: the disk is full. Nothing was paused or updated, and your drafts stay as they are.",
                        "Free some space, then try again.",
                    ),
                    Stopped::Signature => (
                        "This update did not pass Pilot's signature check, so nothing was paused or updated.",
                        "Nothing to do now. Pilot offers the next update when one is ready.",
                    ),
                    Stopped::Denied => (
                        "macOS did not allow Pilot's service to run in the background. Nothing was registered.",
                        "Allow Pilot in System Settings › General › Login Items, then register again.",
                    ),
                    Stopped::Jobs => {
                        if let Some(agent) = self
                            .view
                            .agents
                            .iter_mut()
                            .find(|a| !a.note.is_empty() && a.state == AgentState::Working)
                        {
                            agent.state = AgentState::Unknown;
                            agent.note = "A job may still be running".into();
                        }
                        self.inspect = true;
                        if self.forced {
                            (
                                "Not updated. Pilot cannot prove the job's processes ended. Force does not waive safe shutdown. Interrupted work stays stopped; durable history was kept.",
                                "Check the original operation. Do not replay uncertain work.",
                            )
                        } else {
                            (
                                "Not updated. A job in “Release notes” may still have processes running, and Pilot cannot prove they ended, so it stopped before replacing anything. The other paused agents went back to work.",
                                "“Release notes” stays as it is until someone checks it. Pilot will not update the service before then.",
                            )
                        }
                    }
                };
                self.finish(UpdatePhase::Stopped, message, next);
                self.saved = None;
                self.bump();
                return Some(outcome(
                    OutcomeStatus::Rejected,
                    self.view.revision,
                    message,
                ));
            }
            Stage::Lose => {
                self.mark(None, UpdateStepState::Unknown);
                let message = if kind == UpdateKind::Register {
                    self.view.state = ServiceState::Unknown;
                    "Pilot cannot tell yet whether the service was registered. Nothing will be sent again."
                } else {
                    "Pilot cannot tell yet whether the update finished. Nothing will be sent again, and paused agents stay paused until Pilot checks."
                };
                self.finish(
                    UpdatePhase::Unknown,
                    message,
                    "Check again reads what happened. It changes nothing.",
                );
                self.bump();
                return Some(outcome(OutcomeStatus::Unknown, self.view.revision, message));
            }
        }
        self.bump();
        None
    }

    /// Starts a lookup-only check. Returns whether there is a lost answer to read.
    pub fn begin_check(&mut self) -> bool {
        let unknown = self
            .view
            .run
            .as_ref()
            .is_some_and(|r| r.phase == UpdatePhase::Unknown);
        if unknown {
            self.finish(UpdatePhase::Checking, "", "");
        }
        self.bump();
        unknown
    }

    /// Settles a check by reading what the run left. Never resends.
    pub fn settle_check(&mut self, lost: bool) -> IntentOutcome {
        let revision = self.view.revision;
        if !lost {
            let message = match self.view.state {
                ServiceState::Offline => {
                    "Pilot's service is still not answering. Nothing was changed."
                }
                ServiceState::Absent => "Pilot's service is still not registered.",
                ServiceState::Incompatible => "The service still needs the app update.",
                _ if self.inspect => "“Release notes” still needs a look. Nothing was changed.",
                _ if self.view.offer.is_none() => "Pilot is up to date.",
                _ => "",
            };
            return outcome(OutcomeStatus::Accepted, revision, message);
        }
        let kind = self.view.run.as_ref().map(|r| r.kind).unwrap_or_default();
        let version = self.version();
        self.view.service = version.clone();
        self.view.offer = None;
        let message = if kind == UpdateKind::Register {
            self.view.state = ServiceState::Registered;
            self.view.reason.clear();
            self.all_done();
            format!("Pilot found the service registered and answering, version {version}.")
        } else {
            // The service finished; one resume is confirmed, the other only asked.
            let mut first = true;
            for agent in &mut self.view.agents {
                if agent.state == AgentState::Paused {
                    agent.state = if self.forced {
                        AgentState::Unknown
                    } else if first {
                        AgentState::Resumed
                    } else {
                        AgentState::Resuming
                    };
                    first = false;
                }
            }
            if let Some(run) = self.view.run.as_mut() {
                let last = run.steps.len() - 1;
                for (at, step) in run.steps.iter_mut().enumerate() {
                    step.state = if at == last {
                        UpdateStepState::Now
                    } else {
                        UpdateStepState::Done
                    };
                }
            }
            if self.forced {
                self.all_done();
                format!(
                    "Pilot found the update finished: the service running is {version}. Force accepted state loss. Interrupted work was not replayed."
                )
            } else {
                format!(
                    "Pilot found the update finished: the service running is {version}, and Pilot checked it. One paused agent's resume is asked, not confirmed yet."
                )
            }
        };
        self.finish(UpdatePhase::Done, &message, "");
        self.saved = None;
        self.bump();
        outcome(OutcomeStatus::Accepted, self.view.revision, &message)
    }

    /// The new window showed the saved view: it is used once. It only
    /// says the view was shown; it never resumes, starts or sends anything.
    pub fn restored(&mut self, intent: &UpdateRef) -> Result<(), IntentOutcome> {
        let current = self
            .view
            .restore
            .as_ref()
            .is_some_and(|r| r.id == intent.id);
        if !current {
            let status = if self.restored.contains(&intent.id) {
                OutcomeStatus::Rejected
            } else {
                OutcomeStatus::Stale
            };
            return Err(outcome(status, self.view.revision, ""));
        }
        self.restored.push(intent.id.clone());
        self.view.restore = None;
        let kind = self.view.run.as_ref().map(|r| r.kind).unwrap_or_default();
        self.all_done();
        let message = if kind == UpdateKind::App {
            format!(
                "Updated to {}. Pilot checked the app version and resumed only chats paused for this update.",
                self.view.app
            )
        } else {
            format!(
                "Updated to {}. Pilot checked that the new version is the one running, and the service resumed only the agents it paused.",
                self.view.app
            )
        };
        self.finish(UpdatePhase::Done, &message, "");
        self.saved = None;
        self.bump();
        Ok(())
    }
}
