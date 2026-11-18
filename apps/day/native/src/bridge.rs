//! Exact-name JSON boundary for one native Day window on released NSH.
//!
//! Handlers only validate and enqueue. The existing host worker owns I/O,
//! authority checks, journaling and replies. Neither a name nor a JSON field
//! can select a host, a transport destination or a credential.

use std::sync::{Arc, Mutex};

use nsh_engine::{HostCall, HostChannel};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{host::Error, root::DayRoot};

/// Maximum serialized request size, including its envelope (64 KiB).
pub const MAX_REQUEST: usize = 65_536;
/// Maximum complete response size (16 MiB); oversized reads are refused, not cut.
pub const MAX_RESPONSE: usize = 16 * 1024 * 1024;
/// The complete native method allowlist. No prefix or generic request method.
pub const METHODS: &[&str] = &[
    "day.projects.read",
    "day.projects.setup",
    "day.projects.preview",
    "day.projects.action",
    "day.projects.check",
    "day.chat.select",
    "day.chat.create",
    "day.chat.check",
    "day.chat.continue",
    "day.chat.recover",
    "day.chat.dismiss",
    "day.chat.reply",
    "day.chat.read",
    "day.chat.snapshot",
    "day.chat.close",
    "day.intake.read",
    "day.linear.read",
    "day.preferences.read",
    "day.knowledge.read",
    "day.knowledge.save",
    "day.knowledge.check",
    "day.schedules.read",
    "day.schedules.write",
    "day.schedules.check",
    "day.diagnosis.read",
    "day.diagnosis.write",
    "day.diagnosis.check",
    "day.models.read",
    "day.connections.read",
    "day.databases.read",
    "day.databases.refresh",
    "day.databases.write",
    "day.databases.check",
    "day.connections.write",
    "day.connections.check",
    "day.connections.probe",
    "day.power.read",
    "day.power.resume",
    "day.slack.read",
    "day.slack.write",
    "day.slack.check",
    "day.slack.setAside",
    "day.models.write",
    "day.models.check",
    "day.models.signIn",
    "day.models.recovery",
    "day.preferences.save",
    "day.preferences.check",
    "day.preferences.history",
    "day.feedback.image",
    "day.feedback.read",
    "day.feedback.send",
    "day.feedback.check",
    "day.feedback.step",
    "day.screen.bind",
    "day.screen.unbind",
    "day.screen.take",
    "day.screen.answer",
    "day.screen.picture",
    "day.threads.read",
    "day.threads.history",
    "day.threads.write",
    "day.threads.check",
    "day.intake.triage",
    "day.intake.start",
    "day.intake.check",
    "day.delivery.read",
    "day.delivery.list",
    "day.delivery.artifact",
    "day.delivery.saved",
    "day.delivery.open",
    "day.delivery.done",
    "day.delivery.sendBack",
    "day.delivery.reopen",
    "day.delivery.check",
    "day.delivery.work",
    "day.resultReview",
    "day.resultReview.id",
    "day.resultReview.check",
    "day.artifacts.read",
    "day.artifacts.source",
    "day.today.read",
    "day.today.refresh",
    "day.today.scope",
    "day.mission.read",
    "day.mission.pause",
    "day.mission.resume",
    "day.mission.check",
    "day.mission.stopReplanning",
    "day.mission.archive",
    "day.mission.reopen",
    "day.mission.rename",
    "day.plan.read",
    "day.plan.snapshot",
    "day.plan.source",
    "day.plan.inventory",
    "day.plan.inventorySnapshot",
    "day.plan.prepare",
    "day.plan.create",
    "day.plan.save",
    "day.plan.submit",
    "day.plan.startWork",
    "day.plan.continue",
    "day.plan.askQuestion",
    "day.plan.dropEarlierAnswers",
    "day.plan.repairStart",
    "day.plan.repairApply",
    "day.plan.revisit",
    "day.plan.confirmRevision",
    "day.plan.pauseRevision",
    "day.plan.resumeRevision",
    "day.mission.migration",
    "day.plan.checkRevision",
    "day.plan.checkWork",
    "day.plan.check",
    "day.plan.checkNew",
    "day.plan.dismissNew",
    "day.plan.chat",
    "day.plan.chatSnapshot",
    "day.plan.leave",
    "day.log.event",
    "day.attention.read",
    "day.attention.reply",
    "day.attention.action",
    "day.attention.check",
    "day.attention.draft",
    "day.flush.ack",
    "day.window.read",
    "day.update.read",
    "day.update.prepare",
    "day.update.confirm",
    "day.update.forceConfirm",
    "day.update.cancel",
    "day.update.check",
    "day.update.restored",
    "day.ritual.read",
    "day.ritual.snapshot",
    "day.ritual.results",
    "day.ritual.visit",
    "day.ritual.save",
];

/// Intersect a bundle's declaration with the native exact-name grant.
/// This never widens a deny-all declaration or grants transport/file access.
pub fn restrict(mut bundle: nsh_engine::Bundle) -> Result<nsh_engine::Bundle, Error> {
    let access = bundle.policy.access();
    let names: Vec<_> = METHODS
        .iter()
        .copied()
        .filter(|name| access.allows_host(name))
        .collect();
    let grant = json!({"host":names, "picker": access.allows_picker(), "clipboard": access.allows_clipboard()}).to_string();
    bundle.policy.granted =
        Some(nsh_engine::parse_capabilities(&grant).map_err(|_| Error::Invalid)?);
    bundle.policy.harden = true;
    Ok(bundle)
}

#[derive(Default)]
pub(crate) struct Gate {
    pub today_scope: Option<(u64, String)>,
    pub require_saved_view: bool,
    pub update_requested: Option<String>,
    pub update_app: bool,
    pub notice_pending: bool,
    pub closed: bool,
    pub generation: u32,
    pub flushing: bool,
    pub forms_saved: bool,
    pub save_sequence: u64,
    pub native_captured: bool,
    pub forms_requested: bool,
    pub sealed: bool,
    pub flush_wakeup: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// Native-only disposal proof. It grants neither an update nor daemon authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlushReceipt {
    generation: u32,
    save_sequence: u64,
    window: u128,
}
impl FlushReceipt {
    pub(crate) fn parts(self) -> (u32, u64) {
        (self.generation, self.save_sequence)
    }
}

/// One root and one channel. Never reuse it for another window or selection.
/// The native owner stops the engine, then awaits `close` even after load failure.
pub struct Bridge {
    root: DayRoot,
    channel: HostChannel,
    window: String,
    gate: Arc<Mutex<Gate>>,
    _notice: Arc<dyn Fn() + Send + Sync>,
    _screen: Arc<dyn Fn() + Send + Sync>,
}

/// Native-only capability for this window's update feed. It uses the SAME
/// gate, worker and capture notification as its released JSON channel.
/// It is not exported to the VM and cannot select a host or forge a gate.
#[derive(Clone)]
pub struct UpdateWindow {
    host: crate::host::NativeHost,
    window: String,
    gate: Arc<Mutex<Gate>>,
}
impl UpdateWindow {
    pub(crate) fn host(&self) -> crate::host::NativeHost {
        self.host.clone()
    }
    pub(crate) fn request(
        &self,
        command: Command,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        let (tx, rx) = async_channel::bounded(1);
        self.host.bridge(
            command,
            "native.request",
            self.window.clone(),
            self.gate.clone(),
            Box::new(move |result| {
                let result = result.and_then(|value| {
                    nsh_core::element::from_json(&value["outcome"]).map_err(|_| Error::Unknown)
                });
                let _ = tx.try_send(result);
            }),
        );
        rx
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    window: String,
    args: Value,
}

pub(crate) enum Command {
    TodayScope(crate::host::today_scope::Request),
    Projects,
    ProjectSetupRead,
    ProjectPreview {
        path: Option<String>,
        url: Option<String>,
        destination: Option<String>,
    },
    ProjectAction(crate::host::projects::Intent),
    ProjectCheck(String),
    ChatSelect(crate::host::new_chat::Select),
    ChatCreate(crate::host::new_chat::Create),
    ChatCheck(String),
    /// Continue one stopped or failed chat: the daemon sends its fixed words once.
    ChatContinue(String),
    ChatRecover(crate::host::new_chat::Recovery),
    /// Takes one failed chat off Needs you. Sends nothing to the chat.
    ChatDismiss(String),
    /// The user's own words to one chat waiting for a reply, sent once.
    ChatReply {
        session: String,
        message: String,
    },
    /// Opens a chat Pilot started and reads its newest rows, or older ones. Passive.
    ChatRead {
        session: String,
        older: bool,
    },
    /// The open chat as last read. No I/O.
    ChatSnapshot(String),
    /// The chat page closed. Local only: nothing is sent.
    ChatClose(String),
    IntakeRead,
    LinearRead,
    PreferencesRead,
    KnowledgeRead(crate::host::knowledge::Read),
    KnowledgeSave(crate::host::knowledge::Edit),
    KnowledgeCheck(String),
    SchedulesRead(crate::host::schedules::Read),
    SchedulesWrite(crate::host::schedules::Intent),
    SchedulesCheck(String),
    DiagnosisRead,
    DiagnosisWrite(crate::host::diagnosis::Intent),
    DiagnosisCheck(String),
    ModelsRead,
    ConnectionsRead,
    DatabasesRead,
    DatabasesRefresh,
    DatabasesWrite(crate::host::database_controls::Intent),
    DatabasesCheck(String),
    ConnectionsWrite(crate::host::connection_controls::Intent),
    ConnectionsCheck(String),
    ConnectionsProbe,
    /// Whether Pilot paused work for sleep, from the root's last power frame.
    PowerRead,
    /// The user's Resume of work Pilot paused for sleep.
    PowerResume,
    SlackRead(u32),
    SlackWrite(crate::host::slack_controls::Intent),
    SlackCheck(String),
    SlackSetAside(String),
    ModelsRecovery(String),
    ModelsWrite(crate::host::model_controls::Intent),
    ModelsCheck(String),
    ModelsSignIn(crate::host::model_controls::SignIn),
    PreferencesSave(crate::host::preferences::Intent),
    PreferencesCheck(String),
    PreferencesHistory(crate::host::preferences::History),
    FeedbackImage(crate::host::feedback::ImageUpload),
    FeedbackRead(crate::host::feedback::Read),
    FeedbackSend(crate::host::feedback::Intent),
    FeedbackCheck(String),
    FeedbackStep(crate::host::feedback::Step),
    /// Binds this window to one screen agent chat. Replaces the window's earlier binding.
    ScreenBind(String),
    /// The screen agent bar closed for good: no chat may ask this window.
    ScreenUnbind,
    /// The snapshot, query and act requests TSX must answer now. Memory only.
    ScreenTake,
    /// TSX's answer to one request, sent once.
    ScreenAnswer {
        id: String,
        answer: Value,
    },
    /// The last picture this window took for one chat. Memory only.
    ScreenPicture(String),
    ThreadsRead(String),
    ThreadsHistory(crate::host::threads::HistoryRequest),
    ThreadsWrite(crate::host::threads::Intent),
    ThreadsCheck(String),
    IntakeWrite(crate::host::intake::Intent),
    IntakeCheck(String),
    DeliveryRead(crate::host::delivery::Subject),
    DeliveryList(crate::host::delivery::List),
    DeliveryArtifact(crate::host::delivery_artifact::Request),
    ArtifactsRead(crate::host::artifacts::List),
    ArtifactSource(crate::host::artifacts::Request),
    DeliverySaved,
    DeliveryOpen(crate::host::delivery::Open),
    DeliveryWrite(crate::host::delivery::Write),
    DeliveryCheck(String),
    DeliveryWork(crate::host::delivery_work::Request),
    ResultReview(crate::host::result_review::Request),
    ResultReviewId,
    ResultReviewCheck(String),
    Today,
    /// A fresh service read of Today and what it shows. Passive: sends no intent.
    Refresh,
    Mission(String),
    Pause(crate::model::PauseIntent),
    Resume(crate::model::ResumeIntent),
    ControlCheck(String),
    StopReplanning(crate::model::StopReplanningIntent),
    Lifecycle(crate::model::LifecycleIntent, crate::model::LifecycleAction),
    Rename(crate::model::RenameIntent),
    Plan(String),
    PlanSnapshot(String),
    /// Opens a mission's planning chat and reads its newest rows, or older ones. Passive.
    PlanChat {
        mission: String,
        older: bool,
    },
    /// The open planning chat as last read. No I/O.
    PlanChatSnapshot(String),
    /// The planning page or only its chat closed. Local only: nothing is sent.
    PlanLeave {
        mission: String,
        chat_only: bool,
    },
    /// One event from the window's code for Day's log (`ui.error`, `forms.unsaved`). Local only.
    Log {
        event: String,
        message: String,
    },
    PlanSource(crate::host::plan_sources::Request),
    PlanningInventory,
    PlanningInventorySnapshot,
    Prepare,
    Create(crate::plan::NewIntent),
    Save {
        mission: String,
        intent: crate::plan::AnswerIntent,
    },
    Submit {
        mission: String,
        intent: crate::plan::SubmitIntent,
    },
    StartWork {
        mission: String,
        shown: Value,
    },
    CheckWork(String),
    /// Ask the idle planning agent to continue (plan-continue).
    Continue(crate::plan::ContinueIntent),
    /// Ask about one interview question (plan-question-ask).
    AskQuestion(crate::plan::QuestionAskIntent),
    /// Unstick's fix: remove saved answers to an earlier wording (interview-save).
    DropEarlierAnswers(String),
    /// Start Unstick's repair agent (plan-repair-start).
    RepairStart(String),
    /// Apply the repair agent's fix (plan-continue or interview-save).
    RepairApply(crate::plan::RepairApplyIntent),
    /// Ask Pilot to compare the published plan with what the user wants now (plan-revisit), or for a fresh
    /// preview of a stale proposal after Pause (revision-preview).
    Revisit(String),
    /// Apply the exact revision the user confirmed (revision-confirm).
    ConfirmRevision(crate::plan::ConfirmRevisionIntent),
    PauseRevision(crate::plan::ConfirmRevisionIntent),
    ResumeRevision(crate::plan::ResumeRevisionIntent),
    Migration(crate::host::migration::Request),
    /// Look up a Revisit write whose answer was lost. Never resends.
    CheckRevision(crate::plan::RevisionRef),
    PlanCheck {
        mission: String,
        interview: String,
    },
    CheckNew(Option<String>),
    DismissNew,
    Attention,
    Reply(crate::model::ReplyIntent),
    Action {
        action: crate::model::ActionRef,
        ask: crate::model::ActionAsk,
        text: String,
    },
    AttentionCheck {
        id: String,
        action: bool,
    },
    Draft(crate::model::DraftIntent),
    Flush(u32, u64, Option<crate::update::SavedView>),
    WindowRead,
    UpdateRead,
    UpdatePrepare(crate::update::PrepareIntent),
    UpdateConfirm(crate::update::ConfirmIntent),
    UpdateForceConfirm(crate::update::UpdateRef),
    UpdateCancel(crate::update::UpdateRef),
    UpdateCheck,
    UpdateRestored(crate::update::UpdateRef),
    /// Passive local read with a fresh native clock sample. Writes nothing.
    RitualRead,
    /// The root's last ritual read. No I/O, no clock sample, no notice.
    RitualSnapshot,
    /// Passive read of kept-change evidence for the recap.
    RitualResults,
    /// The user saw Today. Exact context and revision.
    RitualVisit(crate::ritual::RitualVisit),
    /// One explicit step, Done or Skip. Exact context and revision.
    RitualSave(crate::ritual::RitualWrite),
}

impl Command {
    /// Ritual progress is local: its refusals never mark the service read failed.
    pub(crate) fn is_ritual(&self) -> bool {
        matches!(
            self,
            Self::RitualRead
                | Self::RitualSnapshot
                | Self::RitualResults
                | Self::RitualVisit(_)
                | Self::RitualSave(_)
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PlanWrite {
    mission_id: String,
    intent: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    action: Value,
    ask: Value,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Check {
    id: String,
    action: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Flush {
    generation: u32,
    #[serde(default)]
    view: Option<Value>,
}

fn id(s: &str) -> Result<(), Error> {
    if !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}
fn mission(s: &str) -> Result<(), Error> {
    if crate::host::valid_id(s) {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}
fn decode<T: nsh_core::element::JsValue>(value: &Value) -> Result<T, Error> {
    nsh_core::element::from_json(value).map_err(|_| Error::Invalid)
}
fn exact<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|_| Error::Invalid)
}
fn command(name: &str, args: Value) -> Result<Command, Error> {
    use Command as C;
    Ok(match name {
        "day.projects.read" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::Projects
        }
        "day.chat.select" => C::ChatSelect(exact(args)?),
        "day.chat.create" => {
            let r: crate::host::new_chat::Create = exact(args)?;
            if !r.validate() {
                return Err(Error::Invalid);
            }
            C::ChatCreate(r)
        }
        "day.chat.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::ChatCheck(r.operation_id)
        }
        "day.chat.read" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Read {
                session_id: String,
                older: bool,
            }
            let r: Read = exact(args)?;
            mission(&r.session_id)?;
            C::ChatRead {
                session: r.session_id,
                older: r.older,
            }
        }
        "day.chat.recover" => {
            let r: crate::host::new_chat::Recovery = exact(args)?;
            mission(&r.session_id)?;
            if r.message.len() > crate::host::new_chat::RECOVERY_INPUT_BYTES {
                return Err(Error::Invalid);
            }
            C::ChatRecover(r)
        }
        "day.chat.continue" | "day.chat.dismiss" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Chat {
                session_id: String,
            }
            let r: Chat = exact(args)?;
            mission(&r.session_id)?;
            if name == "day.chat.dismiss" {
                C::ChatDismiss(r.session_id)
            } else {
                C::ChatContinue(r.session_id)
            }
        }
        "day.chat.reply" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Reply {
                session_id: String,
                message: String,
            }
            let r: Reply = exact(args)?;
            mission(&r.session_id)?;
            if !crate::host::new_chat::valid_reply(&r.message) {
                return Err(Error::Invalid);
            }
            C::ChatReply {
                session: r.session_id,
                message: r.message,
            }
        }
        "day.chat.snapshot" | "day.chat.close" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Chat {
                session_id: String,
            }
            let r: Chat = exact(args)?;
            mission(&r.session_id)?;
            if name == "day.chat.snapshot" {
                C::ChatSnapshot(r.session_id)
            } else {
                C::ChatClose(r.session_id)
            }
        }
        "day.projects.setup" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::ProjectSetupRead
        }
        "day.projects.preview" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Preview {
                path: Option<String>,
                url: Option<String>,
                destination: Option<String>,
            }
            let r: Preview = exact(args)?;
            if r.path.is_some() == r.url.is_some()
                || [&r.path, &r.url, &r.destination].iter().any(|s| {
                    s.as_ref()
                        .is_some_and(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
                })
            {
                return Err(Error::Invalid);
            }
            C::ProjectPreview {
                path: r.path,
                url: r.url,
                destination: r.destination,
            }
        }
        "day.projects.action" => {
            let r: crate::host::projects::Intent = exact(args)?;
            r.validate()?;
            C::ProjectAction(r)
        }
        "day.projects.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::ProjectCheck(r.operation_id)
        }
        "day.intake.read" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::IntakeRead
        }
        "day.linear.read" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::LinearRead
        }
        "day.preferences.read" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::PreferencesRead
        }
        "day.schedules.read" => {
            let r: crate::host::schedules::Read = exact(args)?;
            r.validate()?;
            C::SchedulesRead(r)
        }
        "day.schedules.write" => {
            let r: crate::host::schedules::Intent = exact(args)?;
            r.validate()?;
            C::SchedulesWrite(r)
        }
        "day.schedules.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::SchedulesCheck(r.operation_id)
        }
        "day.diagnosis.read" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::DiagnosisRead
        }
        "day.diagnosis.write" => {
            let r: crate::host::diagnosis::Intent = exact(args)?;
            r.validate()?;
            C::DiagnosisWrite(r)
        }
        "day.diagnosis.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::DiagnosisCheck(r.operation_id)
        }
        "day.models.read" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::ModelsRead
        }
        "day.slack.read" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Page {
                #[serde(default)]
                offset: u32,
            }
            let r: Page = exact(args)?;
            if r.offset > 1_000_000 {
                return Err(Error::Invalid);
            }
            C::SlackRead(r.offset)
        }
        "day.slack.write" => {
            let r: crate::host::slack_controls::Intent = exact(args)?;
            r.validate()?;
            C::SlackWrite(r)
        }
        "day.slack.check" | "day.slack.setAside" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            if name == "day.slack.check" {
                C::SlackCheck(r.operation_id)
            } else {
                C::SlackSetAside(r.operation_id)
            }
        }
        "day.databases.read" | "day.databases.refresh" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            if name == "day.databases.read" {
                C::DatabasesRead
            } else {
                C::DatabasesRefresh
            }
        }
        "day.databases.write" => {
            let r: crate::host::database_controls::Intent = exact(args)?;
            r.validate()?;
            C::DatabasesWrite(r)
        }
        "day.databases.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::DatabasesCheck(r.operation_id)
        }
        "day.connections.read" | "day.connections.probe" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            if name == "day.connections.read" {
                C::ConnectionsRead
            } else {
                C::ConnectionsProbe
            }
        }
        "day.power.read" | "day.power.resume" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            if name == "day.power.read" {
                C::PowerRead
            } else {
                C::PowerResume
            }
        }
        "day.connections.write" => {
            let r: crate::host::connection_controls::Intent = exact(args)?;
            r.validate()?;
            C::ConnectionsWrite(r)
        }
        "day.connections.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::ConnectionsCheck(r.operation_id)
        }
        "day.models.write" => {
            let r: crate::host::model_controls::Intent = exact(args)?;
            r.validate()?;
            C::ModelsWrite(r)
        }
        "day.models.signIn" => {
            let r: crate::host::model_controls::SignIn = exact(args)?;
            r.validate()?;
            C::ModelsSignIn(r)
        }
        "day.models.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::ModelsCheck(r.operation_id)
        }
        "day.models.recovery" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Request {
                session_id: String,
            }
            let r: Request = exact(args)?;
            mission(&r.session_id)?;
            C::ModelsRecovery(r.session_id)
        }
        "day.preferences.save" => {
            let r: crate::host::preferences::Intent = exact(args)?;
            r.validate()?;
            C::PreferencesSave(r)
        }
        "day.preferences.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::PreferencesCheck(r.operation_id)
        }
        "day.preferences.history" => {
            let r: crate::host::preferences::History = exact(args)?;
            r.validate()?;
            C::PreferencesHistory(r)
        }
        "day.feedback.image" => {
            let r: crate::host::feedback::ImageUpload = exact(args)?;
            r.validate()?;
            C::FeedbackImage(r)
        }
        "day.feedback.read" => {
            let r: crate::host::feedback::Read = exact(args)?;
            r.validate()?;
            C::FeedbackRead(r)
        }
        "day.feedback.send" => {
            let r: crate::host::feedback::Intent = exact(args)?;
            r.validate()?;
            C::FeedbackSend(r)
        }
        "day.feedback.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::FeedbackCheck(r.operation_id)
        }
        "day.feedback.step" => {
            let r: crate::host::feedback::Step = exact(args)?;
            r.validate()?;
            C::FeedbackStep(r)
        }
        "day.screen.bind" | "day.screen.picture" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Chat {
                session_id: String,
            }
            let r: Chat = exact(args)?;
            mission(&r.session_id)?;
            if name == "day.screen.bind" {
                C::ScreenBind(r.session_id)
            } else {
                C::ScreenPicture(r.session_id)
            }
        }
        "day.screen.unbind" | "day.screen.take" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            if name == "day.screen.take" {
                C::ScreenTake
            } else {
                C::ScreenUnbind
            }
        }
        "day.screen.answer" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Answer {
                id: String,
                answer: Value,
            }
            let r: Answer = exact(args)?;
            mission(&r.id)?;
            if !crate::host::screen::valid_answer(&r.answer) {
                return Err(Error::Invalid);
            }
            C::ScreenAnswer {
                id: r.id,
                answer: r.answer,
            }
        }
        "day.threads.read" => {
            let r: crate::host::threads::ReadRequest = exact(args)?;
            mission(&r.mission_id)?;
            C::ThreadsRead(r.mission_id)
        }
        "day.threads.history" => {
            let r: crate::host::threads::HistoryRequest = exact(args)?;
            r.validate()?;
            C::ThreadsHistory(r)
        }
        "day.threads.write" => {
            let r: crate::host::threads::Intent = exact(args)?;
            r.validate()?;
            C::ThreadsWrite(r)
        }
        "day.threads.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::ThreadsCheck(r.operation_id)
        }
        "day.delivery.list" => {
            let r: crate::host::delivery::List = exact(args)?;
            r.validate()?;
            C::DeliveryList(r)
        }
        "day.delivery.read" => {
            let s: crate::host::delivery::Subject = exact(args)?;
            s.validate()?;
            C::DeliveryRead(s)
        }
        "day.delivery.artifact" => {
            let r: crate::host::delivery_artifact::Request = exact(args)?;
            r.validate()?;
            C::DeliveryArtifact(r)
        }
        "day.artifacts.read" => {
            let r: crate::host::artifacts::List = exact(args)?;
            r.validate()?;
            C::ArtifactsRead(r)
        }
        "day.artifacts.source" => {
            let r: crate::host::artifacts::Request = exact(args)?;
            r.validate()?;
            C::ArtifactSource(r)
        }
        "day.delivery.saved" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::DeliverySaved
        }
        "day.delivery.open" => {
            let r: crate::host::delivery::Open = exact(args)?;
            r.validate()?;
            C::DeliveryOpen(r)
        }
        "day.delivery.done" | "day.delivery.sendBack" | "day.delivery.reopen" => {
            let mut r: crate::host::delivery::Write = exact(args)?;
            r.action = match name {
                "day.delivery.done" => "done",
                "day.delivery.sendBack" => "send_back",
                _ => "reopen",
            }
            .into();
            r.validate()?;
            C::DeliveryWrite(r)
        }
        "day.delivery.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::DeliveryCheck(r.operation_id)
        }
        "day.delivery.work" => {
            let r: crate::host::delivery_work::Request = exact(args)?;
            r.validate()?;
            C::DeliveryWork(r)
        }
        "day.resultReview" => {
            let r: crate::host::result_review::Request = exact(args)?;
            r.validate()?;
            C::ResultReview(r)
        }
        "day.resultReview.id" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            C::ResultReviewId
        }
        "day.resultReview.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::ResultReviewCheck(r.operation_id)
        }
        "day.intake.triage" | "day.intake.start" => {
            let r: crate::host::intake::Intent = exact(args)?;
            r.validate(name == "day.intake.start")?;
            C::IntakeWrite(r)
        }
        "day.intake.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: String,
            }
            let r: Lookup = exact(args)?;
            mission(&r.operation_id)?;
            C::IntakeCheck(r.operation_id)
        }
        "day.update.read" | "day.update.check" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            if name == "day.update.read" {
                C::UpdateRead
            } else {
                C::UpdateCheck
            }
        }
        "day.update.prepare" => C::UpdatePrepare(decode(&args)?),
        "day.update.forceConfirm" => {
            let r: crate::update::UpdateRef = decode(&args)?;
            id(&r.id)?;
            C::UpdateForceConfirm(r)
        }
        "day.update.confirm" => {
            let r: crate::update::ConfirmIntent = decode(&args)?;
            id(&r.confirmation)?;
            crate::host::updates::validate_view(&r.view)?;
            C::UpdateConfirm(r)
        }
        "day.update.cancel" | "day.update.restored" => {
            let r: crate::update::UpdateRef = decode(&args)?;
            id(&r.id)?;
            if name == "day.update.cancel" {
                C::UpdateCancel(r)
            } else {
                C::UpdateRestored(r)
            }
        }
        "day.today.scope" => {
            let r: crate::host::today_scope::Request = exact(args)?;
            r.validate()?;
            C::TodayScope(r)
        }
        "day.today.read"
        | "day.today.refresh"
        | "day.window.read"
        | "day.plan.prepare"
        | "day.attention.read"
        | "day.plan.dismissNew"
        | "day.plan.inventory"
        | "day.plan.inventorySnapshot"
        | "day.ritual.read"
        | "day.ritual.snapshot"
        | "day.ritual.results" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            match name {
                "day.today.read" => C::Today,
                "day.today.refresh" => C::Refresh,
                "day.window.read" => C::WindowRead,
                "day.plan.prepare" => C::Prepare,
                "day.plan.dismissNew" => C::DismissNew,
                "day.plan.inventory" => C::PlanningInventory,
                "day.plan.inventorySnapshot" => C::PlanningInventorySnapshot,
                "day.ritual.read" => C::RitualRead,
                "day.ritual.snapshot" => C::RitualSnapshot,
                "day.ritual.results" => C::RitualResults,
                _ => C::Attention,
            }
        }
        "day.ritual.visit" => {
            let r: crate::ritual::RitualVisit = decode(&args)?;
            id(&r.context)?;
            C::RitualVisit(r)
        }
        "day.ritual.save" => {
            let r: crate::ritual::RitualWrite = decode(&args)?;
            id(&r.context)?;
            if r.step > 32 {
                return Err(Error::Invalid);
            }
            C::RitualSave(r)
        }
        "day.plan.source" => {
            let r: crate::host::plan_sources::Request = exact(args)?;
            r.validate()?;
            C::PlanSource(r)
        }
        "day.knowledge.read" => C::KnowledgeRead(exact(args)?),
        "day.knowledge.save" => {
            let r: crate::host::knowledge::Edit = exact(args)?;
            r.validate()?;
            C::KnowledgeSave(r)
        }
        "day.knowledge.check" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Check {
                operation_id: String,
            }
            let r: Check = exact(args)?;
            id(&r.operation_id)?;
            C::KnowledgeCheck(r.operation_id)
        }
        "day.plan.chat" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Chat {
                mission_id: String,
                older: bool,
            }
            let r: Chat = exact(args)?;
            mission(&r.mission_id)?;
            C::PlanChat {
                mission: r.mission_id,
                older: r.older,
            }
        }
        "day.log.event" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Log {
                event: String,
                message: String,
            }
            let r: Log = exact(args)?;
            if !matches!(r.event.as_str(), "ui.error" | "forms.unsaved") || r.message.len() > 2000 {
                return Err(Error::Invalid);
            }
            C::Log {
                event: r.event,
                message: r.message,
            }
        }
        "day.plan.leave" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Leave {
                mission_id: String,
                chat_only: bool,
            }
            let r: Leave = exact(args)?;
            mission(&r.mission_id)?;
            C::PlanLeave {
                mission: r.mission_id,
                chat_only: r.chat_only,
            }
        }
        "day.mission.read"
        | "day.mission.check"
        | "day.plan.read"
        | "day.plan.snapshot"
        | "day.plan.checkWork"
        | "day.plan.chatSnapshot" => {
            let r: crate::model::MissionRef = decode(&args)?;
            mission(&r.mission_id)?;
            match name {
                "day.mission.read" => C::Mission(r.mission_id),
                "day.mission.check" => C::ControlCheck(r.mission_id),
                "day.plan.snapshot" => C::PlanSnapshot(r.mission_id),
                "day.plan.chatSnapshot" => C::PlanChatSnapshot(r.mission_id),
                "day.plan.checkWork" => C::CheckWork(r.mission_id),
                _ => C::Plan(r.mission_id),
            }
        }
        "day.plan.continue" => {
            let r: crate::plan::ContinueIntent = decode(&args)?;
            mission(&r.mission_id)?;
            C::Continue(r)
        }
        "day.plan.dropEarlierAnswers" => {
            let r: crate::plan::UnstickIntent = decode(&args)?;
            mission(&r.mission_id)?;
            C::DropEarlierAnswers(r.mission_id)
        }
        "day.plan.repairStart" => {
            let r: crate::plan::UnstickIntent = decode(&args)?;
            mission(&r.mission_id)?;
            C::RepairStart(r.mission_id)
        }
        "day.plan.repairApply" => {
            let r: crate::plan::RepairApplyIntent = decode(&args)?;
            mission(&r.mission_id)?;
            if r.note.len() > 8000 {
                return Err(Error::Invalid);
            }
            C::RepairApply(r)
        }
        "day.plan.askQuestion" => {
            let r: crate::plan::QuestionAskIntent = decode(&args)?;
            mission(&r.mission_id)?;
            id(&r.question_id)?;
            C::AskQuestion(r)
        }
        "day.plan.revisit" => {
            let r: crate::plan::RevisitIntent = decode(&args)?;
            mission(&r.mission_id)?;
            C::Revisit(r.mission_id)
        }
        "day.plan.confirmRevision" | "day.plan.pauseRevision" => {
            let r: crate::plan::ConfirmRevisionIntent = decode(&args)?;
            mission(&r.mission_id)?;
            id(&r.revision_id)?;
            if name == "day.plan.pauseRevision" {
                C::PauseRevision(r)
            } else {
                C::ConfirmRevision(r)
            }
        }
        "day.plan.resumeRevision" => {
            let r: crate::plan::ResumeRevisionIntent = decode(&args)?;
            mission(&r.mission_id)?;
            id(&r.pause_operation_id)?;
            C::ResumeRevision(r)
        }
        "day.mission.migration" => {
            let r: crate::host::migration::Request = exact(args)?;
            r.validate()?;
            C::Migration(r)
        }
        "day.plan.checkRevision" => {
            let r: crate::plan::RevisionRef = decode(&args)?;
            mission(&r.mission_id)?;
            C::CheckRevision(r)
        }
        "day.mission.pause" => {
            let r: crate::model::PauseIntent = decode(&args)?;
            mission(&r.mission_id)?;
            C::Pause(r)
        }
        "day.mission.resume" => {
            let r: crate::model::ResumeIntent = decode(&args)?;
            mission(&r.mission_id)?;
            mission(&r.pause_operation_id)?;
            C::Resume(r)
        }
        "day.mission.stopReplanning" => {
            let r: crate::model::StopReplanningIntent = decode(&args)?;
            mission(&r.mission_id)?;
            mission(&r.successor_id)?;
            C::StopReplanning(r)
        }
        "day.mission.archive" | "day.mission.reopen" => {
            let r: crate::model::LifecycleIntent = decode(&args)?;
            mission(&r.mission_id)?;
            let action = if name == "day.mission.archive" {
                crate::model::LifecycleAction::Archive
            } else {
                crate::model::LifecycleAction::Reopen
            };
            C::Lifecycle(r, action)
        }
        "day.mission.rename" => {
            let r: crate::model::RenameIntent = decode(&args)?;
            mission(&r.mission_id)?;
            C::Rename(r)
        }
        "day.plan.checkNew" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Lookup {
                operation_id: Option<String>,
            }
            let lookup: Lookup = exact(args)?;
            if let Some(ref operation) = lookup.operation_id {
                mission(operation)?;
            }
            C::CheckNew(lookup.operation_id)
        }
        "day.plan.create" => C::Create(decode(&args)?),
        "day.plan.startWork" => {
            let r: PlanWrite = exact(args)?;
            mission(&r.mission_id)?;
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Shown {
                revision: u64,
                digest: String,
                task_id: String,
                context: String,
            }
            let shown: Shown = exact(r.intent)?;
            C::StartWork {
                mission: r.mission_id,
                shown: serde_json::json!({"revision": shown.revision,
                "digest":shown.digest, "taskId":shown.task_id,"context":shown.context}),
            }
        }
        "day.plan.save" | "day.plan.submit" => {
            let r: PlanWrite = exact(args)?;
            mission(&r.mission_id)?;
            if name == "day.plan.save" {
                let intent: crate::plan::AnswerIntent = decode(&r.intent)?;
                id(&intent.interview_id)?;
                id(&intent.question_id)?;
                C::Save {
                    mission: r.mission_id,
                    intent,
                }
            } else {
                let intent: crate::plan::SubmitIntent = decode(&r.intent)?;
                id(&intent.interview_id)?;
                C::Submit {
                    mission: r.mission_id,
                    intent,
                }
            }
        }
        "day.plan.check" => {
            let r: PlanWrite = exact(args)?;
            mission(&r.mission_id)?;
            let intent: crate::plan::InterviewRef = decode(&r.intent)?;
            id(&intent.interview_id)?;
            C::PlanCheck {
                mission: r.mission_id,
                interview: intent.interview_id,
            }
        }
        "day.attention.reply" => {
            let r: crate::model::ReplyIntent = decode(&args)?;
            id(&r.decision_id)?;
            C::Reply(r)
        }
        "day.attention.action" => {
            let r: Action = exact(args)?;
            let action: crate::model::ActionRef = decode(&r.action)?;
            id(&action.action_id)?;
            C::Action {
                action,
                ask: decode(&r.ask)?,
                text: r.text,
            }
        }
        "day.attention.check" => {
            let r: Check = exact(args)?;
            id(&r.id)?;
            C::AttentionCheck {
                id: r.id,
                action: r.action,
            }
        }
        "day.attention.draft" => {
            let r: crate::model::DraftIntent = decode(&args)?;
            id(&r.item_id)?;
            C::Draft(r)
        }
        "day.flush.ack" => {
            let r: Flush = exact(args)?;
            C::Flush(r.generation, 0, r.view.as_ref().map(decode).transpose()?)
        }
        _ => return Err(Error::Invalid),
    })
}

impl Command {
    pub(crate) fn admit(&self, gate: &Gate) -> Result<(), Error> {
        if gate.closed || gate.sealed {
            return Err(Error::Closed);
        }
        if let Self::Flush(generation, sequence, _) = self {
            return if gate.flushing
                && gate.forms_requested
                && *generation == gate.generation
                && *sequence == gate.save_sequence
            {
                Ok(())
            } else {
                Err(Error::Stale)
            };
        }
        if gate.flushing
            && !matches!(
                self,
                Self::Save { .. }
                    | Self::Draft(_)
                    | Self::Today
                    | Self::TodayScope(_)
                    | Self::WindowRead
                    | Self::Projects
                    | Self::ChatRead { .. }
                    | Self::ChatSnapshot(_)
                    | Self::ChatClose(_)
                    | Self::IntakeRead
                    | Self::LinearRead
                    | Self::PreferencesRead
                    | Self::KnowledgeRead(_)
                    | Self::SchedulesRead(_)
                    | Self::DiagnosisRead
                    | Self::ModelsRead
                    | Self::ConnectionsRead
                    | Self::DatabasesRead
                    | Self::DatabasesRefresh
                    | Self::PowerRead
                    | Self::SlackRead(_)
                    | Self::ModelsRecovery(_)
                    | Self::PreferencesHistory(_)
                    | Self::FeedbackRead(_)
                    | Self::ScreenTake
                    | Self::ScreenPicture(_)
                    | Self::ThreadsRead(_)
                    | Self::ThreadsHistory(_)
                    | Self::DeliveryRead(_)
                    | Self::DeliveryList(_)
                    | Self::DeliverySaved
                    | Self::Mission(_)
                    | Self::Plan(_)
                    | Self::PlanSnapshot(_)
                    | Self::PlanChat { .. }
                    | Self::PlanChatSnapshot(_)
                    | Self::PlanLeave { .. }
                    | Self::Log { .. }
                    | Self::PlanningInventory
                    | Self::PlanningInventorySnapshot
                    | Self::Attention
                    | Self::RitualRead
                    | Self::RitualSnapshot
                    | Self::RitualResults
            )
        {
            return Err(Error::Busy);
        }
        Ok(())
    }
}

impl Bridge {
    pub(crate) fn require_saved_view(&self) {
        self.gate
            .lock()
            .expect("bridge gate poisoned")
            .require_saved_view = true;
    }
    /// Bind an explicitly selected native root. Creating a bridge starts no work.
    pub fn new(root: DayRoot) -> Self {
        let channel = HostChannel::new();
        let window = uuid::Uuid::new_v4().to_string();
        let gate = Arc::new(Mutex::new(Gate::default()));
        channel.set_params(
            serde_json::from_value(json!({"day":{"version":1,"window":window}}))
                .expect("static parameter object"),
        );
        for &name in METHODS {
            let host = root.host().clone();
            let selected = window.clone();
            let state = gate.clone();
            channel.handle(name, move |mut call: HostCall| {
                if call.is_post() {
                    return;
                } // Posts can never cause unacknowledged effects.
                let parsed = (|| {
                    let data = call.take_data();
                    let limit = if name == "day.feedback.image" {
                        crate::host::feedback::IMAGE_REQUEST
                    } else if name == "day.screen.answer" {
                        crate::host::screen::MAX_ANSWER + 4096
                    } else {
                        MAX_REQUEST
                    };
                    if serde_json::to_vec(&data).map_err(|_| Error::Invalid)?.len() > limit {
                        return Err(Error::Invalid);
                    }
                    let e: Envelope = exact(data)?;
                    if e.version != 1 || e.window != selected {
                        return Err(Error::Identity);
                    }
                    let mut command = command(name, e.args)?;
                    let mut gate = state.lock().expect("bridge gate poisoned");
                    if let Command::Flush(_, sequence, _) = &mut command {
                        *sequence = gate.save_sequence;
                    }
                    command.admit(&gate)?;
                    if matches!(command, Command::Today | Command::TodayScope(_)) {
                        gate.notice_pending = false;
                    }
                    if matches!(command, Command::Save { .. } | Command::Draft(_)) {
                        gate.save_sequence =
                            gate.save_sequence.checked_add(1).ok_or(Error::Capacity)?;
                        gate.forms_saved = false;
                    }
                    Ok(command)
                })();
                match parsed {
                    Ok(command) => {
                        let flush = matches!(command, Command::Flush(..));
                        let wake_gate = state.clone();
                        host.bridge(
                            command,
                            name,
                            selected.clone(),
                            state.clone(),
                            Box::new(move |result| {
                                if flush {
                                    let wake = wake_gate
                                        .lock()
                                        .expect("bridge gate poisoned")
                                        .flush_wakeup
                                        .clone();
                                    if let Some(wake) = wake {
                                        wake();
                                    }
                                }
                                let value = match result {
                                    Ok(value) => json!({"version":1,"value":value}),
                                    Err(error) => json!({"version":1,"error":code(error)}),
                                };
                                if serde_json::to_vec(&value).is_ok_and(|v| v.len() <= MAX_RESPONSE)
                                {
                                    call.resolve(value);
                                } else {
                                    call.resolve(json!({"version":1,"error":"capacity"}));
                                }
                            }),
                        )
                    }
                    Err(error) => call.resolve(json!({"version":1,"error":code(error)})),
                }
            });
        }
        let event_channel = channel.clone();
        let event_gate = gate.clone();
        let event_window = window.clone();
        let notice: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let mut gate = event_gate.lock().expect("bridge gate poisoned");
            if gate.closed || gate.notice_pending {
                return;
            }
            gate.notice_pending = true;
            drop(gate);
            let _ = event_channel.send("day.changed", json!({"version":1,"window":event_window}));
        });
        root.host().notice(&notice);
        // The screen agent's requests wait for this window. Same shape as day.changed, no data.
        let screen_channel = channel.clone();
        let screen_gate = gate.clone();
        let screen_window = window.clone();
        let screen: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if screen_gate.lock().expect("bridge gate poisoned").closed {
                return;
            }
            let _ = screen_channel.send(
                "day.screen.requested",
                json!({"version":1,"window":screen_window}),
            );
        });
        root.host().screen_notice(&screen);
        Self {
            root,
            channel,
            window,
            gate,
            _notice: notice,
            _screen: screen,
        }
    }

    /// The channel for exactly this window's AppOptions or isolated EngineConfig.
    /// Do not attach it to a second engine or reload it after disposal.
    pub fn channel(&self) -> HostChannel {
        self.channel.clone()
    }

    /// Opaque identity for a native feed attached to this same root/window.
    pub fn window_identity(&self) -> &str {
        &self.window
    }

    /// The native owner's camera for this window's screen agent pictures.
    #[cfg_attr(
        not(all(target_os = "macos", feature = "macos-host")),
        allow(dead_code)
    )]
    pub(crate) fn set_screen_picture(&self, taker: crate::host::screen::Taker) {
        self.root.host().set_screen_picture(taker);
    }

    pub(crate) fn saved_capture(&self) -> Option<crate::host::window::SavedWindow> {
        self.root.host().saved_window()
    }

    pub fn update_window(&self) -> UpdateWindow {
        UpdateWindow {
            host: self.root.host().clone(),
            window: self.window.clone(),
            gate: self.gate.clone(),
        }
    }

    /// Fence new effects and ask the still-live engine to save ALL form state.
    /// This is not an acknowledgement or a native preedit capture.
    pub fn request_flush(&self) -> Result<u32, Error> {
        let generation = self.begin_capture()?;
        self.send_form_flush(generation)?;
        Ok(generation)
    }

    /// Fence effects without notifying the engine yet. The native owner captures
    /// and freezes attached editors before requesting the all-form engine barrier.
    pub fn begin_capture(&self) -> Result<u32, Error> {
        let generation = {
            let mut gate = self.gate.lock().expect("bridge gate poisoned");
            if gate.closed || gate.sealed {
                return Err(Error::Closed);
            }
            if gate.flushing {
                return Err(Error::Busy);
            }
            gate.generation = gate.generation.checked_add(1).ok_or(Error::Capacity)?;
            gate.flushing = true;
            gate.forms_saved = false;
            gate.native_captured = false;
            gate.forms_requested = false;
            gate.generation
        };
        Ok(generation)
    }

    /// Emit the form barrier after native capture queued every input/composition
    /// event. The caller keeps native editing frozen until cancel or disposal.
    pub fn request_form_flush(&self, generation: u32) -> Result<(), Error> {
        {
            let gate = self.gate.lock().expect("bridge gate poisoned");
            if !gate.native_captured {
                return Err(Error::Busy);
            }
        }
        self.send_form_flush(generation)
    }

    fn send_form_flush(&self, generation: u32) -> Result<(), Error> {
        {
            let mut gate = self.gate.lock().expect("bridge gate poisoned");
            if gate.closed || gate.sealed || !gate.flushing || generation != gate.generation {
                return Err(Error::Stale);
            }
            if gate.forms_requested {
                return Err(Error::Busy);
            }
            gate.forms_requested = true;
        }
        self.channel
            .send(
                "day.flush",
                json!({"version":1,"window":self.window,"generation":generation}),
            )
            .map_err(|_| Error::Unavailable)?;
        Ok(())
    }

    /// Wake the native lifecycle owner on a flush reply. Schedule main-thread
    /// work only; this callback runs on the existing host worker and must not wait.
    pub fn set_flush_wakeup(&self, wake: Arc<dyn Fn() + Send + Sync>) {
        self.gate.lock().expect("bridge gate poisoned").flush_wakeup = Some(wake);
    }

    /// Confirmed operation waiting for capture, for the native lifecycle owner.
    pub fn pending_update(&self) -> Option<String> {
        self.gate
            .lock()
            .expect("bridge gate poisoned")
            .update_requested
            .clone()
    }

    pub(crate) fn take_app_update(&self) -> Option<String> {
        let mut gate = self.gate.lock().expect("bridge gate poisoned");
        if !gate.update_app {
            return None;
        }
        gate.update_requested.take()
    }
    pub(crate) fn app_update_requested(&self) -> bool {
        let gate = self.gate.lock().expect("bridge gate poisoned");
        gate.update_app && gate.update_requested.is_some()
    }
    pub(crate) fn startup_ready(&self) -> bool {
        self.root.host().startup_ready()
    }
    pub(crate) fn acknowledge_startup(
        &self,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        self.root.host().acknowledge_startup()
    }

    /// Native lifecycle owner calls this only AFTER attached inputs/preedit were
    /// captured for this generation. No released runner implements this yet.
    pub fn native_capture_finished(&self, generation: u32) -> Result<(), Error> {
        let mut gate = self.gate.lock().expect("bridge gate poisoned");
        if gate.closed || gate.sealed || !gate.flushing || generation != gate.generation {
            return Err(Error::Stale);
        }
        gate.native_captured = true;
        Ok(())
    }

    /// Both current-generation native capture and the worker's saved-form ACK.
    /// Readiness does not stop an engine, drain agents or authorize replacement.
    pub fn flush_ready(&self, generation: u32) -> bool {
        let gate = self.gate.lock().expect("bridge gate poisoned");
        !gate.closed
            && gate.flushing
            && generation == gate.generation
            && gate.forms_saved
            && gate.native_captured
            && gate.forms_requested
    }

    /// Atomically pin the last saved sequence and refuse all later calls BEFORE
    /// the native owner disposes the engine. A late save invalidates an older ACK.
    pub fn seal_flush(&self, generation: u32) -> Result<FlushReceipt, Error> {
        let mut gate = self.gate.lock().expect("bridge gate poisoned");
        if gate.closed || gate.sealed || !gate.flushing || generation != gate.generation {
            return Err(Error::Stale);
        }
        if !gate.forms_saved || !gate.native_captured || !gate.forms_requested {
            return Err(Error::Busy);
        }
        gate.sealed = true;
        Ok(FlushReceipt {
            generation,
            save_sequence: gate.save_sequence,
            window: uuid::Uuid::parse_str(&self.window)
                .expect("native window UUID")
                .as_u128(),
        })
    }

    /// Recheck the exact sealed proof before stopping this engine.
    pub fn sealed(&self, receipt: FlushReceipt) -> bool {
        let gate = self.gate.lock().expect("bridge gate poisoned");
        !gate.closed
            && gate.sealed
            && receipt.window
                == uuid::Uuid::parse_str(&self.window)
                    .expect("native window UUID")
                    .as_u128()
            && gate.generation == receipt.generation
            && gate.save_sequence == receipt.save_sequence
    }

    /// Separate native accepted-loss seal. Never creates a normal FlushReceipt,
    /// native capture or form-save ACK. All entered host work must still join.
    pub(crate) fn seal_loss(&self, loss: &crate::host::update_loss::Accepted) -> Result<(), Error> {
        if loss.window() != self.window
            || !self.root.host().loss_binding(loss.source(), loss.journal())
        {
            return Err(Error::Identity);
        }
        let mut gate = self.gate.lock().expect("bridge gate poisoned");
        if gate.closed || gate.sealed {
            return Err(Error::Closed);
        }
        gate.sealed = true;
        Ok(())
    }

    /// Native-only entry after the attached editor owner rechecked and sealed
    /// its exact capture. A VM confirmation alone cannot enter this method.
    /// Await the result, then await close before replacing the root.
    pub fn commit_update(
        &self,
        id: String,
        receipt: FlushReceipt,
    ) -> Result<async_channel::Receiver<Result<crate::model::IntentOutcome, Error>>, Error> {
        if !self.sealed(receipt) {
            return Err(Error::Stale);
        }
        Ok(self
            .root
            .host()
            .commit_update(id, receipt, self.window.clone(), self.gate.clone()))
    }

    /// Cancel this capture generation without stopping the engine or host.
    /// A later capture gets a new generation; old ACKs cannot settle it.
    pub fn cancel_flush(&self, generation: u32) -> Result<(), Error> {
        let mut gate = self.gate.lock().expect("bridge gate poisoned");
        if gate.closed || gate.sealed || !gate.flushing || generation != gate.generation {
            return Err(Error::Stale);
        }
        gate.flushing = false;
        gate.forms_saved = false;
        gate.native_captured = false;
        gate.forms_requested = false;
        Ok(())
    }

    /// Fence admission and join the root. The production owner awaits this
    /// before engine disposal/replacement/exit, including partial-load failure.
    /// Emergency engine loss does not skip the join. Never stops/resumes agents.
    pub fn close(&self) -> async_channel::Receiver<Result<(), Error>> {
        self.retire();
        self.root.close()
    }
    fn retire(&self) {
        self.gate.lock().expect("bridge gate poisoned").closed = true;
        for name in METHODS {
            self.channel.remove_handler(name);
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.retire();
    }
}

fn code(error: Error) -> &'static str {
    match error {
        Error::Identity => "identity",
        Error::Offline => "offline",
        Error::Unavailable => "unavailable",
        Error::Invalid => "invalid",
        Error::Stale => "stale",
        Error::Storage => "storage",
        Error::Unknown => "unknown",
        Error::Closed => "closed",
        Error::Busy => "busy",
        Error::Capacity => "capacity",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_snapshot_obeys_the_passive_read_close_fence() {
        for command in [
            Command::PlanningInventorySnapshot,
            Command::WindowRead,
            Command::TodayScope(crate::host::today_scope::Request {
                scope: "all".into(),
                generation: 1,
                selected_only: false,
            }),
        ] {
            let mut gate = Gate {
                flushing: true,
                ..Gate::default()
            };
            assert_eq!(command.admit(&gate), Ok(()));
            gate.sealed = true;
            assert_eq!(command.admit(&gate), Err(Error::Closed));
            gate.sealed = false;
            gate.closed = true;
            assert_eq!(command.admit(&gate), Err(Error::Closed));
        }
    }

    #[test]
    fn a_later_save_invalidates_an_ack_even_before_the_worker_enters_it() {
        let mut gate = Gate {
            generation: 1,
            flushing: true,
            save_sequence: 7,
            forms_requested: true,
            ..Gate::default()
        };
        let ack = Command::Flush(1, 7, None);
        assert_eq!(ack.admit(&gate), Ok(()));
        gate.save_sequence += 1; // Another form save was enqueued behind this ACK.
        assert_eq!(ack.admit(&gate), Err(Error::Stale));
        assert_eq!(Command::Flush(1, 8, None).admit(&gate), Ok(()));
    }

    #[test]
    fn revision_commands_reach_the_host_and_args_are_exact() {
        assert!(matches!(
            command("day.plan.revisit", json!({"missionId":"m"})),
            Ok(Command::Revisit(m)) if m == "m"
        ));
        assert!(matches!(
            command(
                "day.plan.confirmRevision",
                json!({"missionId":"m","revisionId":"r","digest":"d"})
            ),
            Ok(Command::ConfirmRevision(_))
        ));
        assert!(matches!(
            command(
                "day.plan.checkRevision",
                json!({"missionId":"m","revisionId":"r"})
            ),
            Ok(Command::CheckRevision(_))
        ));
        for name in [
            "day.plan.revisit",
            "day.plan.confirmRevision",
            "day.plan.checkRevision",
        ] {
            assert!(METHODS.contains(&name), "{name}");
        }
        assert!(
            command(
                "day.plan.confirmRevision",
                json!({"missionId":"m","revisionId":"r"})
            )
            .is_err()
        );
    }

    #[test]
    fn chat_reads_are_passive_and_args_are_exact() {
        let gate = Gate {
            flushing: true,
            ..Gate::default()
        };
        for (name, args) in [
            ("day.chat.read", json!({"sessionId":"s-1","older":false})),
            ("day.chat.snapshot", json!({"sessionId":"s-1"})),
            ("day.chat.close", json!({"sessionId":"s-1"})),
        ] {
            let read = command(name, args).unwrap();
            assert_eq!(read.admit(&gate), Ok(()), "{name}");
        }
        for (name, args) in [
            ("day.chat.read", json!({"sessionId":"s-1"})),
            ("day.chat.read", json!({"sessionId":"../s","older":true})),
            (
                "day.chat.read",
                json!({"sessionId":"s","older":false,"before":3}),
            ),
            (
                "day.chat.snapshot",
                json!({"sessionId":"s","projectId":"p"}),
            ),
        ] {
            assert!(command(name, args.clone()).is_err(), "{name} {args}");
        }
    }

    #[test]
    fn chat_continue_is_a_write_that_names_only_its_chat() {
        let flushing = Gate {
            flushing: true,
            ..Gate::default()
        };
        for name in ["day.chat.continue", "day.chat.dismiss"] {
            let go = command(name, json!({"sessionId":"s-1"})).unwrap();
            assert_eq!(go.admit(&flushing), Err(Error::Busy));
            assert_eq!(go.admit(&Gate::default()), Ok(()));
            for args in [
                json!({"sessionId":"../s"}),
                json!({"sessionId":"s","message":"words"}),
                json!({}),
            ] {
                assert!(command(name, args.clone()).is_err(), "{name} {args}");
            }
        }
        assert!(matches!(
            command("day.chat.dismiss", json!({"sessionId":"s-1"})),
            Ok(Command::ChatDismiss(s)) if s == "s-1"
        ));
        let reply = command(
            "day.chat.reply",
            json!({"sessionId":"s-1","message":"Postgres"}),
        )
        .unwrap();
        assert_eq!(reply.admit(&flushing), Err(Error::Busy));
        assert!(
            matches!(reply, Command::ChatReply { session, message } if session == "s-1" && message == "Postgres")
        );
        for args in [
            json!({"sessionId":"s-1"}),
            json!({"sessionId":"s-1","message":"  "}),
            json!({"sessionId":"../s","message":"words"}),
            json!({"sessionId":"s-1","message":"words","extra":1}),
        ] {
            assert!(command("day.chat.reply", args.clone()).is_err(), "{args}");
        }
    }

    #[test]
    fn thread_reads_pass_a_save_but_writes_wait_and_args_are_exact() {
        let gate = Gate {
            flushing: true,
            ..Gate::default()
        };
        let source = "a".repeat(64);
        let read = command("day.threads.read", json!({"missionId":"m"})).unwrap();
        assert_eq!(read.admit(&gate), Ok(()));
        let history = command(
            "day.threads.history",
            json!({"missionId":"m","topicId":"t","before":null}),
        )
        .unwrap();
        assert_eq!(history.admit(&gate), Ok(()));
        let send = command(
            "day.threads.write",
            json!({"missionId":"m","source":source,"purpose":"thread-send","topicId":"t","text":"x"}),
        )
        .unwrap();
        assert_eq!(send.admit(&gate), Err(Error::Busy));
        let check = command("day.threads.check", json!({"operationId":"op"})).unwrap();
        assert_eq!(check.admit(&gate), Err(Error::Busy));
        for (name, args) in [
            (
                "day.threads.read",
                json!({"missionId":"m","projectId":"other"}),
            ),
            ("day.threads.read", json!({"missionId":"../m"})),
            (
                "day.threads.history",
                json!({"missionId":"m","topicId":"t","before":1}),
            ),
            (
                "day.threads.write",
                json!({"missionId":"m","source":source,"purpose":"thread-send","topicId":"t","text":"x","operationId":"mine"}),
            ),
            (
                "day.threads.check",
                json!({"operationId":"op","resend":true}),
            ),
        ] {
            assert!(command(name, args.clone()).is_err(), "{name} {args}");
        }
    }
    #[test]
    fn screen_methods_are_exact_and_only_their_reads_pass_a_save() {
        let gate = Gate {
            flushing: true,
            ..Gate::default()
        };
        let answer = json!({"ok":false,"error":"Needs a person: Send."});
        for (name, args, passive) in [
            ("day.screen.bind", json!({"sessionId":"s-1"}), false),
            ("day.screen.unbind", json!({}), false),
            ("day.screen.take", json!({}), true),
            (
                "day.screen.answer",
                json!({"id":"r-1","answer":answer}),
                false,
            ),
            ("day.screen.picture", json!({"sessionId":"s-1"}), true),
        ] {
            assert!(METHODS.contains(&name), "{name}");
            let parsed = command(name, args).unwrap();
            let admitted = parsed.admit(&gate);
            assert_eq!(admitted.is_ok(), passive, "{name}");
        }
        for (name, args) in [
            ("day.screen.bind", json!({})),
            ("day.screen.bind", json!({"sessionId":"../s"})),
            ("day.screen.bind", json!({"sessionId":"s","windowId":"w"})),
            ("day.screen.unbind", json!({"sessionId":"s"})),
            ("day.screen.take", json!({"windowId":"w"})),
            ("day.screen.answer", json!({"id":"r","answer":{"ok":true}})),
            (
                "day.screen.answer",
                json!({"id":"r","answer":{"ok":true,"value":1},"x":1}),
            ),
            (
                "day.screen.answer",
                json!({"id":"r/1","answer":{"ok":true,"value":1}}),
            ),
            ("day.screen.picture", json!({"sessionId":""})),
        ] {
            assert!(command(name, args.clone()).is_err(), "{name} {args}");
        }
    }
}
