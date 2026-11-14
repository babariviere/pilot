//! Trusted native Today host. Owns sockets, journal and admission outside the VM.
//! Selection is explicit and immutable. Retire and join this host before replacing
//! a profile/project; old replies can never populate the replacement's Desk.
pub(crate) mod artifacts;
pub mod attention;
mod bridge;
mod changes;
pub(crate) mod delivery;
pub(crate) mod delivery_artifact;
pub(crate) mod delivery_work;
mod enrollment;
pub(crate) mod feedback;
pub(crate) mod intake;
mod inventory;
mod journal;
#[cfg(target_os = "macos")]
mod native_clock;
pub(crate) mod navigation;
pub(crate) mod new_chat;
pub mod official_root;
mod official_startup;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub mod official_update;
pub(crate) mod plan_sources;
mod planning;
pub(crate) mod preferences;
pub mod ritual;
pub(crate) mod threads;
pub(crate) mod today_scope;
mod transport;
pub mod update_loss;
pub mod updates;

use crate::{
    contract::{self as c, ControlAction, ControlCommand},
    desk::Desk,
    model::{Delivery, FreshnessState, IntentOutcome, MissionPage, OutcomeStatus, Today},
};
use async_channel::{Receiver, Sender};
use futures_util::StreamExt;
use journal::{Cache, Journal, Record};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use transport::Transport;
pub mod window;

/// Native selection captured by the app, never inferred from a cached mission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub profile: PathBuf,
    pub port: u16,
    pub home: c::Home,
    #[serde(flatten)]
    pub project: Option<Project>,
}

/// Legacy project-bound windows keep their exact serialized source identity.
/// A profile-only dashboard has no project, not an arbitrary placeholder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub project_id: String,
    pub project_path: String,
}

impl Source {
    pub(crate) fn project(&self) -> Result<&Project, Error> {
        self.project.as_ref().ok_or(Error::Unavailable)
    }
}

/// Optional native root bindings. They share one journal and one close drain.
#[derive(Default)]
pub struct Options {
    pub updates: Option<updates::Selection>,
    pub planning_model: Option<String>,
    pub url_opener: Option<attention::UrlOpener>,
    pub day: Option<ritual::DaySource>,
}

/// Sanitized host failures. Raw paths, payloads and credentials never reach TSX.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Identity,
    Offline,
    Unavailable,
    Invalid,
    Stale,
    Storage,
    Unknown,
    Closed,
    Busy,
    Capacity,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if *self == Self::Capacity {
            return write!(
                f,
                "Attention record capacity reached (4096); no records were evicted"
            );
        }
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

pub(crate) fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

struct Shared {
    saved_window: Mutex<Option<window::SavedWindow>>,
    chat_choice: Mutex<Option<crate::new_chat::ChatChoice>>,
    updates: Mutex<crate::update::ServiceView>,
    // Held by the root after the worker joins, through process exit. Dropping
    // a COMMIT-uncertain controller never grants a second launch or send.
    app_controller: Mutex<Option<crate::handoff::Controller>>,
    startup_ready: AtomicBool,
    notices: Mutex<Vec<std::sync::Weak<dyn Fn() + Send + Sync>>>,
    ritual: Mutex<ritual::State>,
    changes: Mutex<changes::State>,
    desk: Mutex<Desk>,
    epoch: AtomicU64,
    closed: Arc<AtomicBool>,
    connected: AtomicBool,
    listeners: Mutex<Vec<Sender<()>>>,
    detail: Mutex<Option<String>>,
    planning: Mutex<std::collections::BTreeMap<String, (u64, serde_json::Value)>>,
    planning_mission: Mutex<Option<String>>,
    /// A global window's current project: chosen in Today's header or by
    /// opening one of its missions. Never set for a project-bound window.
    focus: Mutex<Option<Project>>,
    planning_inventory: Mutex<Option<(u64, serde_json::Value, Option<Error>)>>,
    planning_inventory_wanted: AtomicBool,
    planning_operations: Mutex<std::collections::BTreeMap<String, serde_json::Value>>,
    enrollment: Mutex<Option<enrollment::Selection>>,
    attention: Mutex<Option<serde_json::Value>>,
    attention_operations: Mutex<std::collections::BTreeMap<String, serde_json::Value>>,
    attention_drafts: Mutex<std::collections::BTreeMap<String, serde_json::Value>>,
    url_opener: Option<attention::UrlOpener>,
    /// Set once a screen asks for attention. Later authoritative refreshes
    /// read it again; a WS frame never supplies its content.
    attention_wanted: AtomicBool,
}
impl Shared {
    fn change<R>(&self, f: impl FnOnce(&mut Desk) -> R) -> R {
        let result = f(&mut self.desk.lock().expect("native Desk poisoned"));
        let mut listeners = self.listeners.lock().expect("native listeners poisoned");
        listeners.retain(|tx| !tx.is_closed());
        for tx in listeners.iter() {
            let _ = tx.try_send(());
        }
        drop(listeners);
        let live = {
            let mut notices = self.notices.lock().expect("native notices poisoned");
            let live: Vec<_> = notices
                .iter()
                .filter_map(std::sync::Weak::upgrade)
                .collect();
            notices.retain(|notice| notice.strong_count() != 0);
            live
        };
        for notice in live {
            notice();
        }
        result
    }
    fn invalidate(&self, state: FreshnessState) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.change(|desk| desk.lose_read(state, "Read changed. Refresh before acting."));
    }
    fn current(&self, epoch: u64) -> Result<(), Error> {
        self.open()?;
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err(Error::Stale);
        }
        Ok(())
    }
    fn open(&self) -> Result<(), Error> {
        if self.closed.load(Ordering::SeqCst) {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }
    fn outcome(&self, status: OutcomeStatus, message: &str) -> IntentOutcome {
        self.desk
            .lock()
            .expect("native Desk poisoned")
            .native_outcome(status, message)
    }
}

enum Work {
    AcceptUpdateLoss(update_loss::Record),
    UpdateStartup,
    UpdateCommit {
        id: String,
        proof: crate::bridge::FlushReceipt,
        window: String,
        gate: Arc<Mutex<crate::bridge::Gate>>,
    },
    Bridge(bridge::Call),
    Ritual(ritual::Work),
    RitualResults,
    AttentionRead,
    AttentionSend(serde_json::Value),
    AttentionCheck(String),
    AttentionDraft(attention::DraftKey, serde_json::Value),
    Changes(changes::Work),
    Refresh,
    Detail(String),
    Control {
        mission: String,
        revision: u32,
        action: ControlAction,
        pause: Option<String>,
    },
    Check(String),
    ReadPlanning(String),
    PlanningInventory,
    WriteInterview {
        mission: String,
        digest: String,
        request: serde_json::Value,
    },
    CheckPlanning(String),
    PreparePlanning,
    EnrollPlanning(crate::plan::NewIntent),
    StopReplanning {
        mission: String,
        successor: String,
    },
    Lifecycle {
        mission: String,
        action: crate::model::LifecycleAction,
        check: bool,
    },
    Rename {
        mission: String,
        title: String,
        check: bool,
    },
}
struct Request {
    epoch: u64,
    work: Work,
    reply: Sender<Result<IntentOutcome, Error>>,
}

/// One native worker. Clone handles share admission and the same exact journal.
#[derive(Clone)]
pub struct NativeHost(Arc<Handle>);
struct Handle {
    source: Source,
    ledger: PathBuf,
    shared: Arc<Shared>,
    requests: Sender<Request>,
    worker: Mutex<Worker>,
}
struct Worker {
    thread: Option<JoinHandle<Result<(), Error>>>,
    result: Option<Result<(), Error>>,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.requests.close();
        // No blocking UI destructor. An entered POST finishes on the worker;
        // its durable record survives even process termination. Native close joins.
    }
}

impl NativeHost {
    pub(crate) fn loss_binding(&self, source: &Source, ledger: &std::path::Path) -> bool {
        self.0.source == *source && self.0.ledger == ledger
    }
    fn accept_update_loss(
        &self,
        record: update_loss::Record,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::AcceptUpdateLoss(record))
    }
    /// Passive exact-source capture, including New's unsent text. Reading it
    /// restores, acknowledges, replays and resumes nothing.
    pub fn saved_window(&self) -> Option<window::SavedWindow> {
        self.0
            .shared
            .saved_window
            .lock()
            .expect("native saved window poisoned")
            .clone()
    }
    pub(crate) fn notice(&self, notice: &Arc<dyn Fn() + Send + Sync>) {
        self.0
            .shared
            .notices
            .lock()
            .expect("native notices poisoned")
            .push(Arc::downgrade(notice));
    }
    pub(crate) fn bridge(
        &self,
        command: crate::bridge::Command,
        window: String,
        gate: Arc<Mutex<crate::bridge::Gate>>,
        reply: Box<dyn FnOnce(Result<serde_json::Value, Error>) + Send>,
    ) {
        if let crate::bridge::Command::TodayScope(request) = &command {
            let selection = {
                let mut gate = gate.lock().expect("bridge gate poisoned");
                command.admit(&gate).and_then(|_| request.select(&mut gate))
            };
            if let Err(error) = selection {
                reply(Err(error));
                return;
            }
        }
        let call = bridge::Call {
            command,
            window,
            gate,
            host: self.clone(),
            reply,
        };
        let epoch = self.0.shared.epoch.load(Ordering::SeqCst);
        let (tx, _rx) = async_channel::bounded(1);
        let request = Request {
            epoch,
            work: Work::Bridge(call),
            reply: tx,
        };
        if let Err(e) = self.0.requests.try_send(request)
            && let Work::Bridge(call) = e.into_inner().work
        {
            (call.reply)(Err(if self.0.shared.open().is_err() {
                Error::Closed
            } else {
                Error::Busy
            }));
        }
    }
    /// Start only for an explicit native selection. No environment or home fallback.
    /// File/network work runs off the UI thread. The default mock app never calls this.
    pub fn open(source: Source, ledger: PathBuf) -> Result<Self, Error> {
        Self::open_selected(source, ledger, None, None, None, None)
    }

    /// Native root supplies explicit URL navigation authority, never the screen VM.
    pub fn open_with_navigation(
        source: Source,
        ledger: PathBuf,
        opener: attention::UrlOpener,
    ) -> Result<Self, Error> {
        Self::open_selected(source, ledger, None, Some(opener), None, None)
    }

    /// Native-only selection of a model for new planning. No live profile is enabled.
    /// The owner must close and join this host before replacing its selection.
    pub fn open_planning(source: Source, ledger: PathBuf, model: String) -> Result<Self, Error> {
        if model.trim().is_empty() || model.len() > 256 {
            return Err(Error::Invalid);
        }
        Self::open_selected(source, ledger, Some(model), None, None, None)
    }

    /// Native root selects a current clock and the exact OS user. No live activation.
    pub fn open_day(
        source: Source,
        ledger: PathBuf,
        day: ritual::DaySource,
    ) -> Result<Self, Error> {
        Self::open_selected(source, ledger, None, None, Some(day), None)
    }

    /// Compose native bindings without opening competing hosts on one ledger.
    /// This is not exported to TSX and starts no model or ritual.
    pub fn open_with_options(
        source: Source,
        ledger: PathBuf,
        options: Options,
    ) -> Result<Self, Error> {
        if options
            .planning_model
            .as_ref()
            .is_some_and(|m| m.trim().is_empty() || m.len() > 256)
        {
            return Err(Error::Invalid);
        }
        Self::open_selected(
            source,
            ledger,
            options.planning_model,
            options.url_opener,
            options.day,
            options.updates,
        )
    }

    fn open_selected(
        source: Source,
        ledger: PathBuf,
        model: Option<String>,
        url_opener: Option<attention::UrlOpener>,
        day: Option<ritual::DaySource>,
        updates: Option<updates::Selection>,
    ) -> Result<Self, Error> {
        if source.port == 0
            || !source.profile.is_absolute()
            || !ledger.is_absolute()
            || !valid_id(&source.home.daemon_id)
            || !valid_id(&source.home.lineage_id)
            || source.project.as_ref().is_some_and(|p| {
                !valid_id(&p.project_id) || !std::path::Path::new(&p.project_path).is_absolute()
            })
        {
            return Err(Error::Identity);
        }
        let shared = Arc::new(Shared {
            saved_window: Mutex::new(None),
            chat_choice: Mutex::new(None),
            updates: Mutex::new(updates::State::new(None).snapshot()),
            app_controller: Mutex::new(None),
            startup_ready: AtomicBool::new(false),
            notices: Mutex::default(),
            ritual: Mutex::new(ritual::State::default()),
            changes: Mutex::new(changes::State::default()),
            desk: Mutex::new(Desk::native()),
            epoch: AtomicU64::new(0),
            closed: Arc::new(AtomicBool::new(false)),
            connected: AtomicBool::new(false),
            listeners: Mutex::new(Vec::new()),
            detail: Mutex::new(None),
            planning: Mutex::new(std::collections::BTreeMap::new()),
            planning_mission: Mutex::new(None),
            focus: Mutex::new(None),
            planning_inventory: Mutex::new(None),
            planning_inventory_wanted: AtomicBool::new(false),
            planning_operations: Mutex::new(std::collections::BTreeMap::new()),
            enrollment: Mutex::new(None),
            attention: Mutex::new(None),
            attention_operations: Mutex::new(std::collections::BTreeMap::new()),
            attention_drafts: Mutex::new(std::collections::BTreeMap::new()),
            url_opener,
            attention_wanted: AtomicBool::new(false),
        });
        let (requests, rx) = async_channel::bounded(16);
        let owner_source = source.clone();
        let owner_ledger = ledger.clone();
        let state = shared.clone();
        let worker = std::thread::Builder::new()
            .name("day-host".into())
            .spawn(move || {
                let result = (|| {
                    let journal = Journal::open(ledger)?;
                    let mut transport = Transport::new(source)?;
                    transport.planning_model = model;
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| Error::Unavailable)?;
                    rt.block_on(run(transport, journal, state.clone(), rx, day, updates))
                })();
                if let Err(e) = result {
                    fail(&state, e);
                }
                result
            })
            .map_err(|_| Error::Unavailable)?;
        Ok(Self(Arc::new(Handle {
            source: owner_source,
            ledger: owner_ledger,
            shared,
            requests,
            worker: Mutex::new(Worker {
                thread: Some(worker),
                result: None,
            }),
        })))
    }

    pub(crate) fn commit_update(
        &self,
        id: String,
        proof: crate::bridge::FlushReceipt,
        window: String,
        gate: Arc<Mutex<crate::bridge::Gate>>,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::UpdateCommit {
            id,
            proof,
            window,
            gate,
        })
    }

    pub(crate) fn startup_ready(&self) -> bool {
        self.0.shared.startup_ready.load(Ordering::SeqCst)
    }
    pub(crate) fn acknowledge_startup(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::UpdateStartup)
    }

    /// Current native projection. No transport or authority leaves Rust.
    pub fn snapshot(&self) -> Today {
        let mut today = self
            .0
            .shared
            .desk
            .lock()
            .expect("native Desk poisoned")
            .today()
            .clone();
        let ritual = self.ritual_snapshot();
        if ritual.availability == crate::ritual::RitualAvailability::Available {
            today.date = ritual.date;
            today.date_line = format!("{} ({})", today.date, ritual.time_zone);
            today.part = ritual.part;
            today.visit = ritual.visit;
            if !ritual.last_looked_at.is_empty()
                && let Ok(at) = ritual.last_looked_at.parse()
            {
                today.last_looked = crate::changes_project::date_time(at);
            }
        }
        today
    }

    pub fn update_snapshot(&self) -> crate::update::ServiceView {
        self.0
            .shared
            .updates
            .lock()
            .expect("native updates poisoned")
            .clone()
    }
    /// Exact mission projection, if already read. `read_mission` fetches it.
    pub fn mission(&self, id: &str) -> Option<MissionPage> {
        self.0
            .shared
            .desk
            .lock()
            .expect("native Desk poisoned")
            .mission(id)
    }
    /// Coalesced notifications only. A consumer reads the latest snapshot.
    pub fn changes(&self) -> Receiver<()> {
        let (tx, rx) = async_channel::bounded(1);
        self.0
            .shared
            .listeners
            .lock()
            .expect("native listeners poisoned")
            .push(tx);
        rx
    }
    fn request(&self, work: Work) -> Receiver<Result<IntentOutcome, Error>> {
        let (tx, rx) = async_channel::bounded(1);
        let epoch = self.0.shared.epoch.load(Ordering::SeqCst);
        let request = Request {
            epoch,
            work,
            reply: tx,
        };
        if let Err(e) = if matches!(&request.work, Work::Ritual(_)) {
            self.0.shared.open()
        } else {
            self.0.shared.current(epoch)
        } {
            let _ = request.reply.try_send(Err(e));
        } else if let Err(e) = self.0.requests.try_send(request) {
            let _ = e.into_inner().reply.try_send(Err(Error::Busy));
        }
        rx
    }
    /// Fresh authoritative reads. Never sends a control.
    pub fn refresh(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Refresh)
    }
    /// Fetch exact detail, not a catalog/WS body.
    pub fn read_mission(&self, id: String) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Detail(id))
    }
    /// Explicit new user intent, bound to the displayed control revision.
    pub fn pause(&self, id: String, revision: u32) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Control {
            mission: id,
            revision,
            action: ControlAction::Pause,
            pause: None,
        })
    }
    /// Resume only the named Pause. The daemon preserves later Stop/other holds.
    pub fn resume(
        &self,
        id: String,
        revision: u32,
        pause: String,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Control {
            mission: id,
            revision,
            action: ControlAction::Resume,
            pause: Some(pause),
        })
    }
    /// Exact saved-operation GET only. Missing records stay Unknown.
    pub fn check(&self, id: String) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Check(id))
    }
    /// Explicit user intent naming the new mission the page showed.
    pub fn stop_replanning(
        &self,
        intent: crate::model::StopReplanningIntent,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::StopReplanning {
            mission: intent.mission_id,
            successor: intent.successor_id,
        })
    }
    /// Archive or reopen once, or with `check` only read the status again.
    pub fn lifecycle(
        &self,
        intent: crate::model::LifecycleIntent,
        action: crate::model::LifecycleAction,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Lifecycle {
            mission: intent.mission_id,
            action,
            check: intent.check,
        })
    }
    /// Rename once, or with `check` only read the title again.
    pub fn rename(
        &self,
        intent: crate::model::RenameIntent,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::Rename {
            mission: intent.mission_id,
            title: intent.title,
            check: intent.check,
        })
    }
    /// Read the complete saved interview and planning proposal. Never starts a worker.
    pub fn read_planning(&self, mission: String) -> Receiver<Result<IntentOutcome, Error>> {
        if valid_id(&mission) && self.0.shared.open().is_ok() {
            *self
                .0
                .shared
                .planning_mission
                .lock()
                .expect("native planning selection poisoned") = Some(mission.clone());
        }
        self.request(Work::ReadPlanning(mission))
    }
    /// Full existing protocol records. The native feed maps them to its typed UI model.
    pub fn planning(&self, mission: &str) -> Option<serde_json::Value> {
        self.0
            .shared
            .planning
            .lock()
            .expect("native planning poisoned")
            .get(mission)
            .map(|(epoch, v)| {
                let mut v = v.clone();
                v["fresh"] = serde_json::Value::Bool(
                    !self.0.shared.closed.load(Ordering::SeqCst)
                        && *epoch == self.0.shared.epoch.load(Ordering::SeqCst),
                );
                v
            })
    }
    /// Exact saved-operation summaries, not transport envelopes or credentials.
    pub fn planning_operations(&self, mission: &str) -> Vec<serde_json::Value> {
        self.0
            .shared
            .planning_operations
            .lock()
            .expect("native planning receipts poisoned")
            .values()
            .filter(|r| r["missionId"] == mission)
            .cloned()
            .collect()
    }
    /// Explicit human save or complete submission, bound to the displayed context and CAS.
    pub fn write_interview(
        &self,
        mission: String,
        digest: String,
        request: serde_json::Value,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::WriteInterview {
            mission,
            digest,
            request,
        })
    }
    /// Passive lookup of one retained exact operation. Never resends a human action.
    pub fn check_planning(&self, operation_id: String) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::CheckPlanning(operation_id))
    }
    /// Passive authenticated profile discovery for a fresh New screen. No enrollment.
    /// Refuses to replace an uncertain intent; recovery uses only `check_planning`.
    pub fn prepare_planning(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::PreparePlanning)
    }
    /// Display-only selection. No home, profile, owner or transport crosses the VM.
    pub fn planning_setup(&self) -> Option<crate::plan::Setup> {
        let shared = &self.0.shared;
        let choice = shared
            .chat_choice
            .lock()
            .expect("native chat choice poisoned")
            .clone();
        let selection = shared
            .enrollment
            .lock()
            .expect("native enrollment poisoned");
        selection
            .as_ref()
            .filter(|s| {
                !s.used
                    && s.prepared.choice == choice
                    && s.epoch.is_some_and(|e| shared.current(e).is_ok())
            })
            .map(|s| s.prepared.setup.clone())
    }
    /// Creation summaries, including pending intents restored on cold open.
    pub fn planning_enrollments(&self) -> Vec<serde_json::Value> {
        self.0
            .shared
            .planning_operations
            .lock()
            .expect("native planning receipts poisoned")
            .values()
            .filter(|r| r["kind"] == "planning-enroll")
            .cloned()
            .collect()
    }
    /// Explicit human New intent. All identities come from the native prepared selection.
    pub fn enroll_planning(
        &self,
        intent: crate::plan::NewIntent,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(Work::EnrollPlanning(intent))
    }
    /// Fence immediately, then join entered HTTP, WS, journal and worker off-thread.
    /// Closing never stops/resumes daemon agents or replays a historical command.
    pub fn close(&self) -> Receiver<Result<(), Error>> {
        self.0.shared.closed.store(true, Ordering::SeqCst);
        self.0.requests.close();
        let host = self.clone();
        let (tx, rx) = async_channel::bounded(1);
        let failed = tx.clone();
        if std::thread::Builder::new()
            .name("day-host-close".into())
            .spawn(move || {
                let mut worker = host.0.worker.lock().expect("native worker poisoned");
                let result = match worker.thread.take() {
                    Some(w) => w.join().map_err(|_| Error::Unavailable).and_then(|r| r),
                    None => worker.result.unwrap_or(Err(Error::Unknown)),
                };
                worker.result = Some(result);
                let _ = tx.send_blocking(result);
            })
            .is_err()
        {
            let _ = failed.try_send(Err(Error::Unavailable));
        }
        rx
    }
}

fn publish_planning(shared: &Shared, record: &planning::PlanningRecord) {
    if matches!(
        record.operation["kind"].as_str(),
        Some(
            "native-chat-create"
                | "user-verification"
                | "project-preferences-update"
                | "user-feedback"
        )
    ) || record.operation["kind"]
        .as_str()
        .is_some_and(threads::is_thread_kind)
    {
        return;
    }
    shared
        .planning_operations
        .lock()
        .expect("native planning receipts poisoned")
        .insert(record.id().to_owned(), record.summary());
    shared.change(|_| ());
}
fn planning_status(record: &planning::PlanningRecord) -> OutcomeStatus {
    match record.receipt.as_ref().and_then(|r| r["state"].as_str()) {
        Some("accepted") => OutcomeStatus::Accepted,
        Some("rejected") => OutcomeStatus::Rejected,
        _ => OutcomeStatus::Unknown,
    }
}
async fn read_planning(
    t: &Transport,
    shared: &Shared,
    epoch: u64,
    mission: &str,
) -> Result<serde_json::Value, Error> {
    if !valid_id(mission) {
        return Err(Error::Invalid);
    }
    *shared
        .planning_mission
        .lock()
        .expect("native planning selection poisoned") = Some(mission.into());
    let selected = t.mission_planning_transport(mission).await?;
    let t = selected.as_ref().unwrap_or(t);
    t.gate(false).await?;
    let view = t.planning(mission).await?;
    t.gate(false).await?;
    shared.current(epoch)?;
    {
        let mut reads = shared.planning.lock().expect("native planning poisoned");
        // The daemon owns saved drafts. Keep just the selected complete read in native memory.
        reads.clear();
        reads.insert(mission.to_owned(), (epoch, view.clone()));
    }
    shared.change(|_| ());
    Ok(view)
}
async fn qualify_planning(
    t: &Transport,
    shared: &Shared,
    epoch: u64,
    mission: &str,
    digest: &str,
    request: &serde_json::Value,
) -> Result<(), Error> {
    let read = read_planning(t, shared, epoch, mission).await?;
    if request["purpose"] == "plan-revisit" {
        if read["revisit"]["available"] != true
            || read["revisit"]["contextDigest"] != digest
            || request["source"] != read["revisit"]["source"]
        {
            return Err(Error::Stale);
        }
        return Ok(());
    }
    if matches!(
        request["purpose"].as_str(),
        Some("revision-preview" | "revision-confirm")
    ) {
        let revision = &read["revision"];
        let pending = &revision["pending"]["proposal"];
        if revision["source"] != digest
            || request["source"] != digest
            || pending["id"] != request["proposalId"]
            || pending["digest"] != request["digest"]
            || (request["purpose"] == "revision-confirm" && revision["pending"]["current"] != true)
        {
            return Err(Error::Stale);
        }
        return Ok(());
    }
    if request["purpose"] == "plan-start" {
        let start = &read["start"];
        if start["available"] != true
            || read["capabilities"]["admission"] != 1
            || start["contextDigest"] != digest
            || start["revision"] != request["expectedRevision"]
            || start["digest"] != request["planDigest"]
            || start["taskId"] != request["taskId"]
        {
            return Err(Error::Stale);
        }
        return Ok(());
    }
    let interview = &read["view"]["interview"];
    if read["contextDigest"] != digest
        || request["expected"]["fence"] != interview["fence"]
        || request["expected"]["revision"] != interview["revision"]
        || read["capabilities"]["answers"] != 1
    {
        return Err(Error::Stale);
    }
    Ok(())
}

/// The mission a request opens, if any. Only reading a mission moves focus.
fn opened_mission(work: &Work) -> Option<String> {
    match work {
        Work::Detail(id) => Some(id.clone()),
        Work::Bridge(call) => match &call.command {
            crate::bridge::Command::Mission(id) => Some(id.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Moves a global window to its newly focused project. The previous project's
/// projections are dropped (its saved records stay in the journal) and this
/// project's saved records are shown again. Nothing is sent. Returns whether
/// the focus changed.
fn sync_focus(
    root: &Transport,
    focused: &mut Option<Transport>,
    journal: &Journal,
    shared: &Shared,
) -> Result<bool, Error> {
    let want = shared.focus.lock().expect("native focus poisoned").clone();
    let Some(project) = want else {
        return Ok(false);
    };
    if root.source.project.is_some()
        || focused
            .as_ref()
            .is_some_and(|t| t.source.project.as_ref() == Some(&project))
    {
        return Ok(false);
    }
    crate::day_log::event(
        "focus.changed",
        serde_json::json!({"project":project.project_id}),
    );
    let t = root.focus(project);
    shared.epoch.fetch_add(1, Ordering::SeqCst);
    *shared.attention.lock().expect("attention read poisoned") = None;
    shared
        .attention_operations
        .lock()
        .expect("attention operations poisoned")
        .clear();
    shared
        .attention_drafts
        .lock()
        .expect("attention drafts poisoned")
        .clear();
    *shared.changes.lock().expect("native Changes poisoned") = changes::State::default();
    *shared
        .planning_inventory
        .lock()
        .expect("planning inventory poisoned") = None;
    *shared.detail.lock().expect("native detail poisoned") = None;
    *shared.desk.lock().expect("native Desk poisoned") = Desk::native();
    restore_project(journal, shared, &t.source)?;
    *focused = Some(t);
    Ok(true)
}

/// Shows one project's saved records: attention, drafts, Changes, the cached
/// read and control history. Restores uncertainty, never executes it.
fn restore_project(journal: &Journal, shared: &Shared, source: &Source) -> Result<(), Error> {
    for record in journal.attention.values().filter(|r| r.source == *source) {
        attention::publish(shared, record);
    }
    for draft in journal
        .attention_drafts
        .values()
        .filter(|r| r.source == *source)
    {
        shared
            .attention_drafts
            .lock()
            .expect("attention drafts poisoned")
            .insert(
                serde_json::to_string(&draft.key).map_err(|_| Error::Storage)?,
                draft.value.clone(),
            );
    }
    changes::restore(journal, source, shared);
    if let Some(cache) = journal.cached(source) {
        shared.change(|desk| {
            desk.native_read(cache.overview, cache.details);
            desk.lose_read(
                FreshnessState::Cached,
                "Saved read. Not checked with the daemon yet.",
            );
        });
    }
    // Even a crash before POST is lookup-only.
    let mut history: Vec<_> = journal
        .records
        .values()
        .filter(|r| r.source == *source && !r.not_sent)
        .collect();
    history.sort_by_key(|r| r.command.expected_revision);
    for r in history {
        shared.change(|desk| {
            if let Some(receipt) = &r.receipt {
                desk.native_receipt(receipt.clone());
            } else {
                desk.native_pending(&r.mission, &r.command, Delivery::Unknown);
            }
        });
    }
    shared.change(|_| ());
    Ok(())
}

fn fail(shared: &Shared, error: Error) {
    if error != Error::Stale {
        crate::day_log::event(
            "read.failed",
            serde_json::json!({"error":error.to_string()}),
        );
    }
    // Failed authoritative reads age all projections, not just missions.
    // A notice race has already advanced this fence.
    if error != Error::Stale {
        shared.epoch.fetch_add(1, Ordering::SeqCst);
    }
    if error == Error::Identity {
        *shared.attention.lock().expect("attention read poisoned") = None;
        *shared
            .planning_inventory
            .lock()
            .expect("planning inventory poisoned") = None;
    }
    if let Some(s) = shared
        .enrollment
        .lock()
        .expect("native enrollment poisoned")
        .as_mut()
    {
        s.epoch = None;
    }
    shared.change(|desk| {
        desk.lose_read(
            match error {
                Error::Offline => FreshnessState::Offline,
                Error::Stale => FreshnessState::Stale,
                _ => FreshnessState::Unavailable,
            },
            if error == Error::Stale {
                "Read changed. Refresh before acting."
            } else {
                "Daemon read is unavailable. Saved operations are never resent."
            },
        )
    });
}

async fn run(
    root: Transport,
    mut journal: Journal,
    shared: Arc<Shared>,
    requests: Receiver<Request>,
    day: Option<ritual::DaySource>,
    selection: Option<updates::Selection>,
) -> Result<(), Error> {
    let t = &root;
    crate::day_log::event(
        "host.open",
        serde_json::json!({"profile":t.source.profile,"port":t.source.port,
            "project":t.source.project.as_ref().map(|p| &p.project_id),"version":env!("CARGO_PKG_VERSION")}),
    );
    let mut updates = updates::State::new(selection);
    *shared
        .saved_window
        .lock()
        .expect("native saved window poisoned") = journal
        .windows
        .get(&window::SavedWindow::key(&t.source)?)
        .cloned();
    updates.restore(&journal, &t.source).await;
    *shared
        .chat_choice
        .lock()
        .expect("native chat choice poisoned") = shared
        .saved_window
        .lock()
        .expect("native saved window poisoned")
        .as_ref()
        // Only the user's own choice comes back. An older view's choice may
        // be New's former default project, which the user never chose.
        .filter(|w| w.view["chatChosen"] == true)
        .and_then(|w| serde_json::from_value(w.view["chat"].clone()).ok());
    shared
        .startup_ready
        .store(updates.startup_ready(), Ordering::SeqCst);
    *shared.updates.lock().expect("native updates poisoned") = updates.snapshot();
    restore_project(&journal, &shared, &t.source)?;
    for record in journal
        .planning
        .values()
        .filter(|r| planning::in_scope(&r.source, &t.source))
    {
        publish_planning(&shared, record);
    }
    let (invalidated, events) = async_channel::bounded(1);
    let ws = tokio::spawn(watch(t.source.clone(), shared.clone(), invalidated));
    let mut events_open = true;
    // A global window's focused project. Its transport carries that project's
    // checks; the root keeps the window, update, ritual and scope reads.
    let mut focused: Option<Transport> = None;
    // Local clock refresh only. No daemon GET, visit, mark or automatic ritual.
    // An overdue tick runs after wake; missed ticks never build up a queue.
    let mut clock = tokio::time::interval(Duration::from_secs(30));
    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            request = requests.recv() => {
                let Ok(request) = request else { break; };
                // Opening a mission in a global window acts in its project.
                if root.source.project.is_none()
                    && let Some(mission) = opened_mission(&request.work)
                    && let Ok(Some(pt)) = root.mission_planning_transport(&mission).await
                {
                    *shared.focus.lock().expect("native focus poisoned") = pt.source.project.clone();
                }
                sync_focus(&root, &mut focused, &journal, &shared)?;
                let t = focused.as_ref().unwrap_or(&root);
                let preparing = matches!(&request.work, Work::PreparePlanning);
                let inventory = matches!(&request.work, Work::PlanningInventory);
                let local_ritual = matches!(&request.work, Work::Ritual(_) | Work::RitualResults);
                let attention = matches!(
                    &request.work,
                    Work::AttentionRead | Work::AttentionSend(_) | Work::AttentionCheck(_) | Work::AttentionDraft(_, _)
                );
                let result = match request.work {
                    Work::Bridge(call) => {
                        // JSON failures are isolated from unrelated Today/control reads.
                        bridge::handle(&root, t, &mut journal, &shared, &mut updates, day.as_ref(), request.epoch, call).await;
                        Ok(shared.outcome(OutcomeStatus::Accepted, ""))
                    }
                    Work::Ritual(work) => ritual::handle(&root.source, day.as_ref(), &mut journal, &shared, work),
                    Work::UpdateCommit { id, proof, window, gate } => {
                        let valid = {
                            let g = gate.lock().expect("bridge gate poisoned");
                            let (generation, sequence) = proof.parts();
                            !g.closed && g.sealed && g.forms_saved && g.native_captured
                                && g.generation == generation && g.save_sequence == sequence
                        };
                        if valid { updates::handle(&root, &mut journal, &shared, &mut updates, updates::Command::Commit(id, proof, window, gate)).await }
                        else { Err(Error::Stale) }
                    }
                    Work::UpdateStartup => updates::handle(&root, &mut journal, &shared, &mut updates, updates::Command::Startup).await,
                    Work::RitualResults => ritual::read_results(&root, day.as_ref(), &mut journal, &shared, request.epoch).await,
                    Work::AcceptUpdateLoss(record) => handle(&root, &mut journal, &shared, request.epoch, Work::AcceptUpdateLoss(record)).await,
                    work => handle(t, &mut journal, &shared, request.epoch, work).await,
                };
                if local_ritual || (preparing && matches!(result, Err(Error::Unavailable))) {
                    // Unsupported New configuration must not disable existing Today reads.
                    shared.change(|_| ());
                } else if (attention || inventory)
                    && matches!(result, Err(Error::Stale | Error::Invalid | Error::Unavailable | Error::Capacity))
                {
                    // A changed card or an unsupported attention read must not
                    // mark the missions' read or its controls stale.
                } else if let Err(e) = result && !matches!(e, Error::Unknown | Error::Busy | Error::Closed) { fail(&shared, e); }
                let changed = {
                    let mut view = shared.updates.lock().expect("native updates poisoned");
                    let next = updates.snapshot();
                    let changed = view.revision != next.revision;
                    *view = next;
                    changed
                };
                if changed { shared.change(|_| ()); }
                let _ = request.reply.try_send(result);
                // A scope read may have chosen another project: show it now.
                if sync_focus(&root, &mut focused, &journal, &shared)?
                    && let Some(t) = &focused
                {
                    let epoch = shared.epoch.load(Ordering::SeqCst);
                    if let Err(e) = refresh(t, &journal, &shared, epoch, None).await { fail(&shared, e); }
                }
                // The update projection is a passive snapshot. This does not
                // trigger another service read on a change notification.
            }
            event = events.recv(), if events_open => {
                if event.is_err() { events_open = false; continue; }
                if shared.closed.load(Ordering::SeqCst) { break; }
                let epoch = shared.epoch.load(Ordering::SeqCst);
                let t = focused.as_ref().unwrap_or(&root);
                if shared.connected.load(Ordering::SeqCst) && let Err(e) = refresh(t, &journal, &shared, epoch, None).await {
                    if e != Error::Stale { crate::day_log::event("refresh.failed", serde_json::json!({"trigger":"daemon-event","error":e.to_string()})); }
                    fail(&shared, e);
                }
            }
            _ = clock.tick(), if day.is_some() => {
                if shared.closed.load(Ordering::SeqCst) { break; }
                ritual::refresh_clock(&root.source, day.as_ref().expect("clock is bound"), &mut journal, &shared);
            }
        }
    }
    ws.abort();
    let _ = ws.await;
    // Worker exit occurs only after journal and all entered request futures return.
    shared.change(|desk| desk.lose_read(FreshnessState::Stale, "Native host closed."));
    shared
        .listeners
        .lock()
        .expect("native listeners poisoned")
        .clear();
    journal.finish()
}

async fn refresh(
    t: &Transport,
    journal: &Journal,
    shared: &Shared,
    epoch: u64,
    detail: Option<&str>,
) -> Result<(), Error> {
    if t.source.project.is_none() {
        // The global dashboard reads project sections through TodayScope.
        // Keep the profile stream and invalidations independent of any project.
        t.profile_gate().await?;
        shared.current(epoch)?;
        let mission = shared
            .planning_mission
            .lock()
            .expect("native planning selection poisoned")
            .clone();
        if let Some(mission) = mission {
            let _ = read_planning(t, shared, epoch, &mission).await;
        }
        shared.change(|_| ());
        return Ok(());
    }
    let selected = detail.map(str::to_owned).or_else(|| {
        shared
            .detail
            .lock()
            .expect("native detail poisoned")
            .clone()
    });
    t.gate(false).await?;
    let overview = t.overview().await?;
    if detail.is_some_and(|id| {
        !valid_id(id) || !overview.dashboard.missions.items.iter().any(|m| m.id == id)
    }) {
        return Err(Error::Stale);
    }
    let mut details = Vec::new();
    if let Some(id) = selected.as_deref().filter(|id| {
        overview
            .dashboard
            .missions
            .items
            .iter()
            .any(|m| m.id == *id)
    }) {
        if !valid_id(id) || !overview.dashboard.missions.items.iter().any(|m| m.id == id) {
            return Err(Error::Stale);
        }
        let detail = t.detail(id).await?;
        if overview
            .dashboard
            .missions
            .items
            .iter()
            .find(|m| m.id == id)
            .is_none_or(|m| m.coordinator_session_id != detail.mission.coordinator_session_id)
        {
            return Err(Error::Stale);
        }
        details.push(detail);
    }
    t.gate(false).await?;
    shared.current(epoch)?;
    journal.cache(Cache {
        version: 1,
        source: t.source.clone(),
        overview: overview.clone(),
        details: details.clone(),
    })?;
    shared.current(epoch)?;
    shared.change(|desk| {
        desk.native_capability(t.controls.load(Ordering::SeqCst));
        desk.native_replanning(t.replanning.load(Ordering::SeqCst));
        desk.set_now(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
        );
        desk.native_read(overview, details);
        if !shared.connected.load(Ordering::SeqCst) {
            desk.lose_read(
                FreshnessState::Stale,
                "Daemon read received. Update stream is disconnected.",
            );
        }
    });
    let planning = shared
        .planning_mission
        .lock()
        .expect("native planning selection poisoned")
        .clone();
    if let Some(mission) = planning {
        // WS only invalidates. A fresh authenticated GET, never the event body,
        // advances a preparing bootstrap to the coordinator's complete round.
        let _ = read_planning(t, shared, epoch, &mission).await;
    }
    if shared.planning_inventory_wanted.load(Ordering::SeqCst) {
        let _ = inventory::read(t, shared, epoch).await;
    }
    if shared.attention_wanted.load(Ordering::SeqCst) {
        // Same rule for attention: a failed read leaves the last one stale,
        // never a successful empty list.
        let _ = attention::read(t, shared, epoch).await;
    }
    Ok(())
}

async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    work: Work,
) -> Result<IntentOutcome, Error> {
    // A queued passive detail read carries no displayed action authority.
    // Start from the latest epoch; every GET and the final publication still requalify it.
    let epoch = if matches!(&work, Work::Detail(_) | Work::PlanningInventory) {
        shared.open()?;
        shared.epoch.load(Ordering::SeqCst)
    } else {
        epoch
    };
    // Historical exact receipt lookup is independent of WS invalidations.
    // Immutable source, local identity and project are still requalified below.
    // A draft queued before close is local only and is written during the
    // joined drain, so a safe close keeps the user's last words.
    if matches!(&work, Work::AttentionDraft(_, _)) {
    } else if matches!(
        &work,
        Work::Check(_)
            | Work::CheckPlanning(_)
            | Work::EnrollPlanning(_)
            | Work::PreparePlanning
            | Work::AttentionCheck(_)
            | Work::Changes(changes::Work::Check(_))
    ) {
        shared.open()?;
    } else {
        shared.current(epoch)?;
    }
    match work {
        Work::AcceptUpdateLoss(record) => {
            if record.source != t.source {
                return Err(Error::Identity);
            }
            update_loss::save(journal, record)?;
        }
        Work::Bridge(_) => return Err(Error::Invalid),
        Work::UpdateCommit { .. } | Work::UpdateStartup => return Err(Error::Invalid),
        Work::Ritual(_) => return Err(Error::Invalid),
        Work::RitualResults => return Err(Error::Invalid),
        work @ (Work::AttentionRead
        | Work::AttentionSend(_)
        | Work::AttentionCheck(_)
        | Work::AttentionDraft(_, _)) => {
            return attention::handle(t, journal, shared, epoch, work).await;
        }
        Work::Changes(work) => return changes::handle(t, journal, shared, epoch, work).await,
        Work::PreparePlanning => return enrollment::prepare(t, journal, shared, epoch).await,
        Work::PlanningInventory => {
            shared
                .planning_inventory_wanted
                .store(true, Ordering::SeqCst);
            inventory::read(t, shared, epoch).await?;
        }
        Work::EnrollPlanning(intent) => {
            return enrollment::send(t, journal, shared, epoch, intent).await;
        }
        Work::ReadPlanning(mission) => {
            let result = read_planning(t, shared, epoch, &mission).await;
            let current = shared.epoch.load(Ordering::SeqCst);
            if matches!(result, Err(Error::Stale))
                && current != epoch
                && shared.connected.load(Ordering::SeqCst)
            {
                // As with mission detail: retry one raced passive read, never a write.
                read_planning(t, shared, current, &mission).await?;
            } else {
                result?;
            }
        }
        Work::WriteInterview {
            mission,
            digest,
            request,
        } => {
            if journal.planning.values().any(|r| {
                planning::in_scope(&r.source, &t.source) && r.mission() == mission && r.pending()
            }) {
                return Err(Error::Unknown);
            }
            let mut record =
                planning::record(&t.source, mission.clone(), digest.clone(), request.clone())?;
            qualify_planning(t, shared, epoch, &mission, &digest, &request).await?;
            journal.save_planning(record.clone())?;
            publish_planning(shared, &record);
            if let Err(e) = qualify_planning(t, shared, epoch, &mission, &digest, &request).await {
                record.not_sent = true;
                journal.save_planning(record.clone())?;
                publish_planning(shared, &record);
                return Err(e);
            }
            shared.current(epoch)?;
            match t.planning_operation(&record.operation, false).await {
                Ok(receipt) => {
                    record.receipt = Some(receipt);
                    // Preserve an exact volatile ACK even when local receipt saving fails.
                    if journal.save_planning(record.clone()).is_err() {
                        journal.poison();
                        publish_planning(shared, &record);
                        return Ok(shared.outcome(
                            OutcomeStatus::Unknown,
                            "Receipt saving failed. Check the saved operation; do not resend.",
                        ));
                    }
                    publish_planning(shared, &record);
                    let status = planning_status(&record);
                    // Re-read saved progress without marking unrelated Today data offline/stale.
                    // A raced/closed read leaves the prior planning snapshot explicitly stale.
                    let next = shared.epoch.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
                    if shared.open().is_ok() {
                        let _ = read_planning(t, shared, next, &mission).await;
                    }
                    return Ok(shared.outcome(status, if request["purpose"] == "plan-start" {
                        "Start recorded. Admission is separate from progress; read the agent report."
                    } else { "Saved planning action. This does not start work." }));
                }
                Err(_) => {
                    return Ok(shared.outcome(
                        OutcomeStatus::Unknown,
                        "No exact acknowledgement. Check the saved operation; do not resend.",
                    ));
                }
            }
        }
        Work::CheckPlanning(id) => {
            let mut record = journal
                .planning
                .get(&id)
                .filter(|r| planning::in_scope(&r.source, &t.source))
                .cloned()
                .ok_or(Error::Unknown)?;
            if t.source.project.is_none() {
                t.profile_gate().await?;
            } else {
                t.gate(false).await?;
            }
            shared.open()?;
            // A matched terminal ACK cannot be erased by a later failed lookup.
            if record.pending() {
                record.receipt = Some(t.planning_operation(&record.operation, true).await?);
                journal.save_planning(record.clone())?;
                publish_planning(shared, &record);
            }
            let next = shared.epoch.load(Ordering::SeqCst);
            if shared.open().is_ok() {
                let _ = read_planning(t, shared, next, record.mission()).await;
            }
            return Ok(shared.outcome(
                planning_status(&record),
                "Exact saved operation lookup only.",
            ));
        }
        Work::Refresh => refresh(t, journal, shared, epoch, None).await?,
        Work::Lifecycle {
            mission,
            action,
            check,
        } => return lifecycle(t, journal, shared, epoch, &mission, action, check).await,
        Work::Rename {
            mission,
            title,
            check,
        } => return rename(t, journal, shared, epoch, &mission, &title, check).await,
        Work::StopReplanning { mission, successor } => {
            if !valid_id(&mission) || !valid_id(&successor) {
                return Err(Error::Invalid);
            }
            let open = {
                let desk = shared.desk.lock().expect("native Desk poisoned");
                desk.today().freshness.state == FreshnessState::Live
                    && desk.native_overview().is_some_and(|o| {
                        o.dashboard.missions.items.iter().any(|m| {
                            m.id == mission
                                && m.successor
                                    .as_ref()
                                    .is_some_and(|l| l.open() && l.mission_id == successor)
                        })
                    })
            };
            if !open {
                return Ok(shared.outcome(
                    OutcomeStatus::Stale,
                    "Re-planning changed since you looked. Nothing was stopped.",
                ));
            }
            t.gate(false).await?;
            shared.current(epoch)?;
            let sent = t.stop_replanning(&mission, &successor).await;
            // Read again either way: the mission page shows whether it stopped.
            let next = shared.epoch.load(Ordering::SeqCst);
            let _ = refresh(t, journal, shared, next, Some(&mission)).await;
            return Ok(match sent {
                Ok(()) => shared.outcome(OutcomeStatus::Accepted, ""),
                Err(Error::Stale) => shared.outcome(
                    OutcomeStatus::Stale,
                    "Re-planning changed since you looked. Nothing was stopped.",
                ),
                Err(_) => shared.outcome(
                    OutcomeStatus::Unknown,
                    "Stop re-planning is not confirmed. The next read shows whether it stopped; nothing was sent again.",
                ),
            });
        }
        Work::Detail(id) => {
            let result = refresh(t, journal, shared, epoch, Some(&id)).await;
            let current = shared.epoch.load(Ordering::SeqCst);
            if matches!(result, Err(Error::Stale))
                && current != epoch
                && shared.connected.load(Ordering::SeqCst)
            {
                // One fresh passive read after a concurrent invalidation, never a write retry.
                // Further changes still fail closed. Project/owner checks are not skipped.
                refresh(t, journal, shared, current, Some(&id)).await?;
            } else {
                result?;
            }
            *shared.detail.lock().expect("native detail poisoned") = Some(id);
        }
        Work::Control {
            mission,
            revision,
            action,
            pause,
        } => {
            if !valid_id(&mission) || pause.as_deref().is_some_and(|p| !valid_id(p)) {
                return Err(Error::Invalid);
            }
            if journal
                .records
                .values()
                .any(|r| r.source == t.source && r.mission == mission && r.pending())
            {
                return Err(Error::Unknown);
            }
            let (coordinator, before) = {
                let desk = shared.desk.lock().expect("native Desk poisoned");
                if desk.today().freshness.state != FreshnessState::Live {
                    return Err(Error::Stale);
                }
                let overview = desk.native_overview().ok_or(Error::Stale)?;
                let m = overview
                    .dashboard
                    .missions
                    .items
                    .iter()
                    .find(|m| m.id == mission)
                    .ok_or(Error::Stale)?;
                let c = overview
                    .controls
                    .iter()
                    .find(|c| c.mission_id == mission)
                    .ok_or(Error::Stale)?;
                if c.revision != u64::from(revision) {
                    return Err(Error::Stale);
                }
                (m.coordinator_session_id.clone(), c.clone())
            };
            let command = ControlCommand {
                version: 1,
                operation_id: uuid::Uuid::new_v4().to_string(),
                home: t.source.home.clone(),
                project_id: t.source.project()?.project_id.clone(),
                coordinator_session_id: coordinator,
                expected_revision: before.revision,
                action,
                pause_operation_id: pause,
            };
            validate_action(&before, &command)?;
            qualify(t, shared, epoch, &mission, &command, &before).await?;
            let mut record = Record {
                version: 1,
                source: t.source.clone(),
                mission: mission.clone(),
                command,
                receipt: None,
                not_sent: false,
            };
            journal.save(record.clone())?; // sync_all before any POST admission
            shared.change(|desk| desk.native_pending(&mission, &record.command, Delivery::Sending));
            if let Err(e) = qualify(t, shared, epoch, &mission, &record.command, &before).await {
                record.not_sent = true;
                journal.save(record)?;
                shared.change(|desk| desk.native_cancel(&mission));
                return Err(e);
            }
            shared.current(epoch)?;
            let result = t.post(&mission, &record.command).await;
            // Never lose a matched ACK merely because a later Stop/event arrived.
            // It is historical. A fresh read, not that receipt, governs new controls.
            if let Ok(receipt) = result {
                record.receipt = Some(receipt.clone());
                if journal.save(record.clone()).is_err() {
                    journal.poison();
                    shared.change(|desk| {
                        desk.native_receipt(receipt);
                        desk.native_pending(&mission, &record.command, Delivery::Unknown);
                    });
                    fail(shared, Error::Storage);
                    return Ok(shared.outcome(OutcomeStatus::Unknown, "The daemon answered, but its receipt could not be saved. Keep this operation; do not resend."));
                }
                shared.change(|desk| {
                    desk.native_receipt(receipt);
                });
            } else {
                shared.change(|desk| {
                    desk.native_pending(&mission, &record.command, Delivery::Unknown)
                });
                return Ok(shared.outcome(
                    OutcomeStatus::Unknown,
                    "No exact acknowledgement. Check this operation; never resend.",
                ));
            }
            // Re-read authoritative state even when WS has not arrived yet.
            shared.invalidate(FreshnessState::Stale);
            let next = shared.epoch.load(Ordering::SeqCst);
            if let Err(e) = refresh(t, journal, shared, next, Some(&mission)).await {
                fail(shared, e);
            }
            return Ok(shared.outcome(
                if journal
                    .records
                    .values()
                    .any(|r| r.mission == mission && r.pending())
                {
                    OutcomeStatus::Unknown
                } else {
                    OutcomeStatus::Accepted
                },
                "",
            ));
        }
        Work::Check(mission) => {
            let mut record = journal
                .records
                .values()
                .find(|r| r.source == t.source && r.mission == mission && r.pending())
                .cloned()
                .ok_or(Error::Unknown)?;
            t.gate(true).await?;
            shared.open()?;
            shared
                .change(|desk| desk.native_pending(&mission, &record.command, Delivery::Checking));
            // Exact operation lookup only. No current controls/overview can settle it.
            let result = async {
                let receipt = t.lookup(&mission, &record.command).await?;
                t.gate(true).await?;
                shared.open()?;
                Ok::<_, Error>(receipt)
            }
            .await;
            if let Ok(receipt) = result {
                record.receipt = Some(receipt.clone());
                if journal.save(record.clone()).is_err() {
                    journal.poison();
                    shared.change(|desk| {
                        desk.native_receipt(receipt);
                        desk.native_pending(&mission, &record.command, Delivery::Unknown);
                    });
                    fail(shared, Error::Storage);
                    return Ok(shared.outcome(
                        OutcomeStatus::Unknown,
                        "The exact receipt could not be saved. Nothing will be resent.",
                    ));
                }
                return Ok(shared.change(|desk| desk.native_receipt(receipt)));
            } else {
                shared.change(|desk| {
                    desk.native_pending(&mission, &record.command, Delivery::Unknown)
                });
                return Ok(shared.outcome(
                    OutcomeStatus::Unknown,
                    "No exact receipt. The outcome is still unknown.",
                ));
            }
        }
    }
    Ok(shared.outcome(OutcomeStatus::Accepted, ""))
}

/// Archive or reopen a mission once, or only read its status after a lost
/// answer. The daemon's refusal is shown as it said it; nothing is resent.
async fn lifecycle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    mission: &str,
    action: crate::model::LifecycleAction,
    check: bool,
) -> Result<IntentOutcome, Error> {
    use crate::model::LifecycleAction as A;
    if !valid_id(mission) {
        return Err(Error::Invalid);
    }
    let applied = match action {
        A::Archive => "Archived. Today drops it on its next read.",
        A::Reopen => "Reopened. It is active again.",
    };
    let status = if check {
        // Exact status read only. Never sends the change again.
        let read = async {
            t.gate(false).await?;
            t.mission_status(mission).await
        }
        .await;
        match read {
            Ok(status) => status,
            Err(_) => {
                return Ok(shared.outcome(
                    OutcomeStatus::Unknown,
                    "Pilot could not read the mission's status. The outcome is still unknown.",
                ));
            }
        }
    } else {
        if action == A::Archive {
            let listed = {
                let desk = shared.desk.lock().expect("native Desk poisoned");
                desk.today().freshness.state == FreshnessState::Live
                    && desk
                        .native_overview()
                        .is_some_and(|o| o.dashboard.missions.items.iter().any(|m| m.id == mission))
            };
            if !listed {
                return Ok(shared.outcome(
                    OutcomeStatus::Stale,
                    "This mission changed since you looked. Nothing was sent.",
                ));
            }
        }
        t.gate(false).await?;
        shared.current(epoch)?;
        match t.lifecycle(mission, action).await {
            Ok(Ok(())) => action.target().to_owned(),
            Ok(Err(message)) => return Ok(shared.outcome(OutcomeStatus::Rejected, &message)),
            Err(_) => {
                return Ok(shared.outcome(
                    OutcomeStatus::Unknown,
                    "The answer was lost. Check reads the mission again; nothing is sent again.",
                ));
            }
        }
    };
    // Read again: Today drops an archived mission and lists a reopened one.
    let next = shared.epoch.load(Ordering::SeqCst);
    let _ = refresh(
        t,
        journal,
        shared,
        next,
        (status == "active").then_some(mission),
    )
    .await;
    Ok(if status == action.target() {
        shared.outcome(OutcomeStatus::Accepted, applied)
    } else if status == action.expected() {
        shared.outcome(
            OutcomeStatus::Rejected,
            match action {
                A::Archive => "Not archived: the mission is still active. Nothing was sent again.",
                A::Reopen => "Not reopened: the mission is still archived. Nothing was sent again.",
            },
        )
    } else {
        shared.outcome(
            OutcomeStatus::Rejected,
            &format!("The mission is now {status}. Nothing was sent again."),
        )
    })
}

/// Rename a mission once, or only read its title after a lost answer. The
/// daemon's refusal is shown as it said it; nothing is resent.
async fn rename(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    mission: &str,
    title: &str,
    check: bool,
) -> Result<IntentOutcome, Error> {
    if !valid_id(mission) {
        return Err(Error::Invalid);
    }
    let title = match crate::model::mission_title(title) {
        Ok(title) => title,
        Err(message) => return Ok(shared.outcome(OutcomeStatus::Rejected, message)),
    };
    let now = if check {
        // Exact title read only. Never sends the rename again.
        let read = async {
            t.gate(false).await?;
            t.mission_title(mission).await
        }
        .await;
        match read {
            Ok(now) => now,
            Err(_) => {
                return Ok(shared.outcome(
                    OutcomeStatus::Unknown,
                    "Pilot could not read the mission's title. The outcome is still unknown.",
                ));
            }
        }
    } else {
        let listed = {
            let desk = shared.desk.lock().expect("native Desk poisoned");
            desk.today().freshness.state == FreshnessState::Live
                && desk
                    .native_overview()
                    .is_some_and(|o| o.dashboard.missions.items.iter().any(|m| m.id == mission))
        };
        if !listed {
            return Ok(shared.outcome(
                OutcomeStatus::Stale,
                "This mission changed since you looked. Nothing was sent.",
            ));
        }
        t.gate(false).await?;
        shared.current(epoch)?;
        match t.rename(mission, title).await {
            Ok(Ok(())) => title.to_owned(),
            Ok(Err(message)) => return Ok(shared.outcome(OutcomeStatus::Rejected, &message)),
            Err(_) => {
                return Ok(shared.outcome(
                    OutcomeStatus::Unknown,
                    "The answer was lost, so the new title is not confirmed. Check reads the mission again; nothing is sent again.",
                ));
            }
        }
    };
    // Read again: the page and Today show the title the service holds.
    let next = shared.epoch.load(Ordering::SeqCst);
    let _ = refresh(t, journal, shared, next, Some(mission)).await;
    Ok(if now == title {
        shared.outcome(OutcomeStatus::Accepted, "")
    } else {
        shared.outcome(
            OutcomeStatus::Rejected,
            "Not renamed: the mission keeps its title. Nothing was sent again.",
        )
    })
}

fn validate_action(before: &c::Control, command: &ControlCommand) -> Result<(), Error> {
    match command.action {
        ControlAction::Pause
            if before.state == c::ControlState::Running
                && !before.held
                && command.pause_operation_id.is_none() =>
        {
            Ok(())
        }
        ControlAction::Resume
            if before.state == c::ControlState::Paused
                && command.pause_operation_id.is_some()
                && command.pause_operation_id == before.pause_operation_id =>
        {
            Ok(())
        }
        _ => Err(Error::Stale),
    }
}

async fn qualify(
    t: &Transport,
    shared: &Shared,
    epoch: u64,
    mission: &str,
    command: &ControlCommand,
    before: &c::Control,
) -> Result<(), Error> {
    t.gate(true).await?;
    let detail = t.detail(mission).await?;
    if detail.mission.coordinator_session_id != command.coordinator_session_id {
        return Err(Error::Stale);
    }
    let current = t.control(mission).await?;
    if current != *before {
        return Err(Error::Stale);
    }
    t.gate(true).await?;
    shared.current(epoch)?;
    t.local()?;
    Ok(())
}

async fn watch(source: Source, shared: Arc<Shared>, invalidated: Sender<()>) {
    // Reconnects with backoff while the window is open, so a daemon restart
    // (an update, a crash, launchd) does not leave the window offline. Only
    // the first loss is shown; retries do not repaint the window.
    let mut delay = Duration::from_secs(1);
    let mut shown_offline = false;
    loop {
        let result = watch_once(&source, &shared, &invalidated).await;
        let was = shared.connected.swap(false, Ordering::SeqCst);
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
        if was || !shown_offline {
            crate::day_log::event(
                "connection.lost",
                serde_json::json!({"wasConnected":was,"error":result.err().map(|e| e.to_string())}),
            );
            shared.invalidate(FreshnessState::Offline);
            if let Err(e) = result {
                fail(&shared, e);
            }
            let _ = invalidated.try_send(());
            shown_offline = true;
        }
        if was {
            delay = Duration::from_secs(1);
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(30));
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
    }
}

async fn watch_once(
    source: &Source,
    shared: &Arc<Shared>,
    invalidated: &Sender<()>,
) -> Result<(), Error> {
    // No mutation frames, session subscriptions, focus or worker admission.
    let t = Transport::new(source.clone())?;
    t.profile_gate().await?;
    let stream = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(("127.0.0.1", t.source.port)),
    )
    .await
    .map_err(|_| Error::Offline)?
    .map_err(|_| Error::Offline)?;
    let url = format!("ws://127.0.0.1:{}/api/ws", t.source.port);
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(transport::MAX_BODY))
        .max_frame_size(Some(transport::MAX_BODY));
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::client_async_with_config(url, stream, Some(config)),
    )
    .await
    .map_err(|_| Error::Offline)?
    .map_err(|_| Error::Offline)?;
    let hello = t.profile_hello().await?;
    crate::day_log::event(
        "connection.open",
        serde_json::json!({"port":t.source.port,"daemonVersion":hello["daemonVersion"],
            "protocol":hello["protocolVersion"]}),
    );
    shared.connected.store(true, Ordering::SeqCst);
    shared.invalidate(FreshnessState::Stale);
    let _ = invalidated.try_send(());
    while let Some(frame) = ws.next().await {
        let frame = frame.map_err(|_| Error::Offline)?;
        if let tokio_tungstenite::tungstenite::Message::Text(body) = frame {
            let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| Error::Invalid)?;
            match v["type"].as_str() {
                // Structural changes fence actions bound to the shown read.
                Some("mission-catalog.changed" | "missions" | "mission" | "projects") => {
                    shared.epoch.fetch_add(1, Ordering::SeqCst);
                    let _ = invalidated.try_send(());
                }
                // Frequent while agents work. Read again without marking the
                // shown read stale first: that repainted the window each time.
                // The channel holds one wakeup, so bursts cost one read.
                Some("session" | "sessions" | "dashboard") => {
                    let _ = invalidated.try_send(());
                }
                _ => {}
            }
        } else if frame.is_close() {
            break;
        }
    }
    Ok(())
}
