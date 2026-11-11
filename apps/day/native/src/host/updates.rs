//! Root-selected lifecycle, serialized with the existing host's journal and I/O.
//! A VM confirmation requests capture. Only the native owner can seal that
//! capture and enter the updater. Reopening/Check/restore never enters an effect.
use super::{Error, Source, journal::Journal};
use crate::{bridge::FlushReceipt, model::*, update::*};
use pilot_desktop_updater::{
    Outcome,
    app_update::{Connection, ExitGuard},
    daemon_upgrade::{self, Failure},
    lifecycle::DaemonLifecycle,
    manifest::Trust,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

/// Exact immutable inputs supplied by the trusted packaging/native owner, NOT
/// by TSX. There is deliberately no default production identity or target.
#[derive(Clone)]
pub struct Selection {
    pub connection: Connection,
    pub trust: Trust,
    pub installed: PathBuf,
    /// An already published immutable signed daemon capsule. Never a GUI root.
    pub capsule: Option<PathBuf>,
    /// Exact proposal binding already owned by the existing updater.
    pub binding: Option<Value>,
    /// Existing staged app transaction. Day does not stage or invent one.
    pub app: Option<AppTarget>,
    /// Native startup's existing updater transaction, if this is its successor.
    /// Lookup only. This never acknowledges startup or grants execution.
    pub restore_transaction: Option<PathBuf>,
}
#[derive(Clone)]
pub struct AppTarget {
    pub transaction: PathBuf,
    pub target: PathBuf,
    pub build: String,
    pub source: String,
}

struct Inspection {
    daemon: Result<bool, Failure>,
    app_ready: bool,
    app_verified: bool,
}

impl Selection {
    fn restores(&self, record: &Record) -> bool {
        if self.pin() == record.root {
            return true;
        }
        let Some(transaction) = &self.restore_transaction else {
            return false;
        };
        let mut prior_trust = record.root["trust"].clone();
        prior_trust["build"] = self.trust.current_build.clone().into();
        if record.kind != "app"
            || record.target != self.trust.current_build
            || record.root["app"]["transaction"] != json!(transaction)
            || record.root["app"]["target"] != json!(self.installed)
            || record.root["connection"] != json!(self.connection)
            || prior_trust != self.pin()["trust"]
        {
            return false;
        }
        ExitGuard::external_startup(transaction, &self.installed, &self.trust)
            .is_ok_and(|c| c.is_some())
    }
    fn matches(&self, source: &Source) -> bool {
        self.connection.location().home == source.profile
            && self.connection.location().port == source.port
            && self.connection.daemon() == source.home.daemon_id
            && self.connection.lineage() == source.home.lineage_id
    }
    fn pin(&self) -> Value {
        // The trust configuration is pinned too; it never travels to the VM.
        json!({"connection":self.connection,"installed":self.installed,
            "capsule":self.capsule,"binding":self.binding,
            "app":self.app.as_ref().map(|a|json!({"transaction":a.transaction,"target":a.target,"build":a.build,"source":a.source})),
            "trust":{"repository":self.trust.repository,"id":self.trust.application_id,
                "channel":self.trust.channel,"build":self.trust.current_build,
                "bundle":self.trust.bundle_name,"key":self.trust.public_key.to_vec(),
                "requirement":self.trust.code_requirement}})
    }
    fn verify_app(&self) -> Result<(), Failure> {
        let app = self.app.as_ref().ok_or(Failure::Unsupported)?;
        if app.target != self.installed {
            return Err(Failure::Unverified);
        }
        let expected = pilot_desktop_updater::iteration::ExpectedTarget::new(
            app.source.clone(),
            app.build.clone(),
        )
        .map_err(|_| Failure::Unverified)?;
        pilot_desktop_updater::app_update::verify_prepared_target(
            &app.transaction,
            &app.target,
            &self.trust,
            &expected,
        )
        .map_err(|_| Failure::Unverified)
    }
    fn inspect(&self) -> Inspection {
        use pilot_desktop_updater::installer::{NativePlatform, Platform};
        if self.trust.validate().is_err() {
            return Inspection {
                daemon: Err(Failure::Unverified),
                app_ready: false,
                app_verified: false,
            };
        }
        let app_ready = self.verify_app().is_ok() && self.connection.verify().is_ok();
        let app_verified = app_ready
            || NativePlatform
                .verify(
                    &self.installed,
                    &self.trust,
                    &self.trust.current_build,
                    None,
                )
                .is_ok();
        let daemon = if let Some(capsule) = &self.capsule {
            DaemonLifecycle::new(self.connection.clone()).needed(
                capsule,
                &self.trust,
                &AtomicBool::new(false),
            )
        } else {
            Err(Failure::Unsupported)
        };
        Inspection {
            daemon,
            app_ready,
            app_verified,
        }
    }
    fn enter(&self, kind: UpdateKind, cancel: &AtomicBool) -> Result<Outcome, Failure> {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        self.trust.validate().map_err(|_| Failure::Unverified)?;
        match kind {
            UpdateKind::Register => {
                daemon_upgrade::register(
                    self.connection.location().clone(),
                    &self.installed,
                    &self.trust,
                    cancel,
                )?;
                Ok(Outcome::Current)
            }
            UpdateKind::Service => {
                let capsule = self.capsule.as_ref().ok_or(Failure::Unsupported)?;
                let binding = self.binding.clone().ok_or(Failure::Unsupported)?;
                #[cfg(target_os = "macos")]
                DaemonLifecycle::new(self.connection.clone()).upgrade_coordinated(
                    capsule,
                    &self.trust,
                    cancel,
                    binding,
                )?;
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = (capsule, binding);
                    return Err(Failure::Unsupported);
                }
                Ok(Outcome::Current)
            }
            UpdateKind::App => {
                let app = self.app.as_ref().ok_or(Failure::Unsupported)?;
                self.verify_app()?;
                // App-only does not acquire a daemon reservation or pause agents.
                // READY/COMMIT and actual process exit remain with the native owner.
                let guard = ExitGuard::prepare_external(
                    self.connection.clone(),
                    &app.target,
                    &app.transaction,
                    &app.build,
                    &self.trust,
                )
                .map_err(|_| Failure::Unknown)?;
                guard.verify().map_err(|_| Failure::Unknown)?;
                Ok(Outcome::ExitPrepared)
            }
            // A pair of independent calls is NOT a joined app/daemon sequence.
            UpdateKind::Both => Err(Failure::Unsupported),
        }
    }

    fn enter_observed(
        &self,
        kind: UpdateKind,
        cancel: &AtomicBool,
    ) -> (Result<Outcome, Failure>, Option<Value>) {
        #[cfg(target_os = "macos")]
        if kind == UpdateKind::Service {
            if cancel.load(Ordering::SeqCst) {
                return (Err(Failure::Cancelled), None);
            }
            if let (Some(capsule), Some(binding)) = (&self.capsule, &self.binding) {
                let report = DaemonLifecycle::new(self.connection.clone())
                    .upgrade_coordinated_report(capsule, &self.trust, cancel, binding.clone());
                return (report.result.map(|()| Outcome::Current), report.manifest);
            }
        }
        (self.enter(kind, cancel), None)
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub order: u64,
    pub update_version: u32,
    pub id: String,
    pub source: Source,
    pub root: Value,
    pub window: String,
    pub kind: String,
    pub target: String,
    pub view: Value,
    pub auth: String,
    pub revision: u32,
    pub state: String,
    pub flush: Option<(u32, u64)>,
    pub message: String,
    pub restored: bool,
    pub manifest: Option<Value>,
}
impl Record {
    pub fn validate(&self) -> Result<(), Error> {
        if self.order == 0
            || self.update_version != 1
            || !super::valid_id(&self.id)
            || self.window.is_empty()
            || self.auth.len() != 64
            || self.revision == 0
            || !["register", "app", "service"].contains(&self.kind.as_str())
            || ![
                "capture", "entered", "done", "stopped", "unknown", "prepared",
            ]
            .contains(&self.state.as_str())
            || self.root.as_object().is_none()
            || self.message.len() > 1024
            || (self.state != "capture" && self.flush.is_none())
        {
            return Err(Error::Storage);
        }
        let saved: SavedView =
            nsh_core::element::from_json(&self.view).map_err(|_| Error::Storage)?;
        validate_view(&saved)?;
        Ok(())
    }
    pub fn follows(&self, old: &Self) -> bool {
        let mut fixed = self.clone();
        fixed.revision = old.revision;
        fixed.state.clone_from(&old.state);
        fixed.flush = old.flush;
        fixed.message.clone_from(&old.message);
        fixed.restored = old.restored;
        if old.state == "entered" {
            fixed.manifest.clone_from(&old.manifest);
        }
        if old.state == "capture" && self.state == "capture" {
            fixed.view.clone_from(&old.view);
        }
        fixed == *old
            && self.revision == old.revision + 1
            && (!old.restored || self.restored)
            && (old.flush.is_none() || self.flush == old.flush)
            && match old.state.as_str() {
                "capture" => ["capture", "entered"].contains(&self.state.as_str()),
                "entered" => ["entered", "done", "stopped", "unknown", "prepared"]
                    .contains(&self.state.as_str()),
                _ => self.state == old.state,
            }
    }
}

pub(crate) fn validate_view(view: &SavedView) -> Result<(), Error> {
    if !view.offsets_valid() {
        Err(Error::Invalid)
    } else if view.text_bytes() > VIEW_LIMIT || view.entries() > VIEW_ENTRIES {
        Err(Error::Capacity)
    } else {
        Ok(())
    }
}

pub(super) struct State {
    selection: Option<Selection>,
    view: ServiceView,
    pending: Option<(Confirmation, Value, String, String)>,
    latest: Option<Record>,
    authority: Option<(String, String)>,
    cold_restore: bool,
    restore_verified: bool,
}
impl State {
    pub fn new(selection: Option<Selection>) -> Self {
        Self {
            selection,
            pending: None,
            latest: None,
            authority: None,
            cold_restore: false,
            restore_verified: false,
            view: ServiceView {
                revision: 1,
                state: ServiceState::Unknown,
                blocked: "The native update identity and target are not configured.".into(),
                ..Default::default()
            },
        }
    }
    pub async fn restore(&mut self, journal: &Journal, source: &Source) {
        self.latest = journal
            .updates
            .values()
            .filter(|r| r.source == *source)
            .max_by_key(|r| r.order)
            .cloned();
        self.cold_restore = self.latest.is_some();
        if let Some((selection, record)) = self.selection.clone().zip(self.latest.clone()) {
            self.restore_verified =
                tokio::task::spawn_blocking(move || selection.restores(&record))
                    .await
                    .unwrap_or(false);
        }
        self.project();
    }
    fn project(&mut self) {
        self.view.pending = self.pending.as_ref().map(|p| p.0.clone());
        if let Some(r) = &self.latest {
            self.view.operation = r.id.clone();
            let phase = match r.state.as_str() {
                "done" => UpdatePhase::Done,
                "stopped" => UpdatePhase::Stopped,
                _ => UpdatePhase::Unknown,
            };
            self.view.run = Some(UpdateRun {
                kind: kind(&r.kind),
                version: r.target.clone(),
                phase,
                message: r.message.clone(),
                next: if phase == UpdatePhase::Unknown {
                    "Check only. This operation will not be sent again.".into()
                } else {
                    String::new()
                },
                steps: vec![],
            });
            self.view.agents = manifest_agents(r);
            // Restore is display-only, even across a different current selection.
            // It must still be this exact profile and updater transaction.
            if self.cold_restore && self.restore_verified && !r.restored {
                self.view.restore =
                    nsh_core::element::from_json(&r.view)
                        .ok()
                        .map(|view| Restore {
                            id: r.id.clone(),
                            view,
                        });
            } else {
                self.view.restore = None;
            }
        }
    }
    pub fn snapshot(&self) -> ServiceView {
        self.view.clone()
    }
    fn unsettled(&self) -> bool {
        self.latest
            .as_ref()
            .is_some_and(|r| !["done", "stopped"].contains(&r.state.as_str()))
    }
    pub fn save_capture(
        &mut self,
        journal: &mut Journal,
        window: &str,
        view: Option<&SavedView>,
    ) -> Result<(), Error> {
        let Some(mut record) = self
            .latest
            .clone()
            .filter(|r| r.state == "capture" && r.window == window)
        else {
            return Ok(());
        };
        if self.authority.as_ref() != Some(&(record.id.clone(), record.window.clone())) {
            return Err(Error::Unknown);
        }
        let view = view.ok_or(Error::Busy)?;
        validate_view(view)?;
        record.view = serde_json::to_value(view).map_err(|_| Error::Invalid)?;
        record.revision += 1;
        journal.save_update(record.clone())?;
        self.latest = Some(record);
        Ok(())
    }
    fn changed(&mut self) {
        self.view.revision = self.view.revision.saturating_add(1);
        self.project();
    }
}
fn kind(s: &str) -> UpdateKind {
    match s {
        "register" => UpdateKind::Register,
        "app" => UpdateKind::App,
        _ => UpdateKind::Service,
    }
}

fn manifest_agents(record: &Record) -> Vec<AgentLine> {
    let Some(manifest) = &record.manifest else {
        return vec![];
    };
    let Some(rows) = manifest["affectedSessions"]
        .as_array()
        .filter(|r| r.len() <= 4096)
    else {
        return vec![];
    };
    rows.iter()
        .filter_map(|row| {
            let id = row["sessionId"].as_str().filter(|id| super::valid_id(id))?;
            let c = &row["checkpoint"];
            let exact = c["schema"] == 1
                && c["operationId"] == manifest["operationId"]
                && c["purpose"] == "daemon-upgrade"
                && c["host"]["daemonId"] == record.source.home.daemon_id
                && c["host"]["lineageId"] == record.source.home.lineage_id
                && c["replacement"]["build"] == record.root["binding"]["build"]
                && c["replacement"]["runtimeRoot"] == record.root["binding"]["runtimeRoot"];
            Some(AgentLine {
                chat: id.into(),
                mission: String::new(),
                state: AgentState::Unknown,
                note: if exact && c["quiescent"] == true && c["childrenConfirmed"] == true {
                    "Saved checkpoint. Current resume is not observed."
                } else {
                    "Job or checkpoint exit is unconfirmed. No resume authority."
                }
                .into(),
            })
        })
        .collect()
}
fn name(kind: UpdateKind) -> &'static str {
    match kind {
        UpdateKind::Register => "register",
        UpdateKind::App => "app",
        UpdateKind::Service => "service",
        UpdateKind::Both => "both",
    }
}

pub(crate) enum Command {
    Read,
    Prepare(PrepareIntent, String),
    Confirm(ConfirmIntent, String),
    Cancel(UpdateRef),
    Check,
    Restored(UpdateRef),
    Commit(String, FlushReceipt, String),
}

fn digest(value: &impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn fresh_stamp(source: &Source) -> Result<String, Error> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(&source.profile).map_err(|_| Error::Identity)?;
    if !meta.is_dir()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || std::fs::canonicalize(&source.profile).map_err(|_| Error::Identity)? != source.profile
        || std::fs::read_dir(&source.profile)
            .map_err(|_| Error::Identity)?
            .next()
            .is_some()
    {
        return Err(Error::Unavailable);
    }
    Ok(digest(&format!(
        "{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.uid(),
        meta.mode()
    )))
}
fn authority(t: &super::Transport, kind: UpdateKind) -> Result<String, Error> {
    authority_for(&t.source, kind)
}
fn authority_for(source: &Source, kind: UpdateKind) -> Result<String, Error> {
    if kind == UpdateKind::Register {
        fresh_stamp(source)
    } else {
        Ok(digest(&super::Transport::local_for(source)?.as_bytes()))
    }
}

/// Called only on the existing serialized worker. Blocking native controllers
/// are awaited, including on close; no detached updater or mutation retry exists.
pub(super) async fn handle(
    t: &super::Transport,
    journal: &mut Journal,
    shared: &super::Shared,
    state: &mut State,
    command: Command,
) -> Result<IntentOutcome, Error> {
    shared.open()?;
    let outcome = |status, revision, message: &str| IntentOutcome {
        status,
        revision,
        message: message.into(),
    };
    match command {
        Command::Read | Command::Check => {
            if let Some(selection) = state.selection.clone() {
                if !selection.matches(&t.source) {
                    return Err(Error::Identity);
                }
                if fresh_stamp(&t.source).is_ok() {
                    selection.trust.validate().map_err(|_| Error::Unavailable)?;
                    state.view.state = ServiceState::Absent;
                    state.view.reason = "The selected profile is empty. Native registration still verifies the service and signed package.".into();
                    state.view.blocked.clear();
                    state.view.offer = Some(UpdateOffer {
                        kind: UpdateKind::Register,
                        version: String::new(),
                        note: "Register the selected native profile.".into(),
                    });
                    state.changed();
                    return Ok(outcome(OutcomeStatus::Accepted, state.view.revision, ""));
                }
                let build = selection.trust.current_build.clone();
                let result = tokio::task::spawn_blocking(move || selection.inspect())
                    .await
                    .map_err(|_| Error::Unknown)?;
                state.view.app = if result.app_verified {
                    build
                } else {
                    String::new()
                };
                match result.daemon {
                    Ok(needed) => {
                        state.view.state = ServiceState::Registered;
                        state.view.reason.clear();
                        state.view.offer = needed
                            .then(|| {
                                state
                                    .selection
                                    .as_ref()
                                    .and_then(|s| s.binding.as_ref())
                                    .and_then(|b| b["build"]["version"].as_str())
                                    .filter(|s| !s.is_empty())
                                    .map(|version| UpdateOffer {
                                        kind: UpdateKind::Service,
                                        version: version.into(),
                                        note: "A signed service update is available.".into(),
                                    })
                            })
                            .flatten();
                    }
                    Err(failure) => {
                        state.view.state = ServiceState::Unknown;
                        state.view.reason = failure_message(failure).into();
                        state.view.blocked.clone_from(&state.view.reason);
                        state.view.offer = None;
                    }
                }
                if state.view.offer.is_none()
                    && result.app_ready
                    && let Some(app) = state.selection.as_ref().and_then(|s| s.app.as_ref())
                {
                    state.view.offer = Some(UpdateOffer {
                        kind: UpdateKind::App,
                        version: app.build.clone(),
                        note: "A signed app update is available.".into(),
                    });
                }
                state.view.blocked = if state.view.offer.is_some() {
                    String::new()
                } else {
                    "No verified update target is available.".into()
                };
            }
            // Retained entered/capture records stay Unknown. A new hello or a
            // matching version is not an exact operation completion receipt.
            state.changed();
            Ok(outcome(OutcomeStatus::Accepted, state.view.revision, ""))
        }
        Command::Prepare(intent, window) => {
            if intent.revision != state.view.revision {
                return Err(Error::Stale);
            }
            if state.unsettled() {
                return Err(Error::Unknown);
            }
            let selection = state.selection.as_ref().ok_or(Error::Unavailable)?;
            if !selection.matches(&t.source) {
                return Err(Error::Identity);
            }
            if intent.kind == UpdateKind::Both {
                return Err(Error::Unavailable);
            }
            selection.trust.validate().map_err(|_| Error::Unavailable)?;
            if intent.kind == UpdateKind::Service
                && (selection.capsule.is_none() || selection.binding.is_none())
                || intent.kind == UpdateKind::App && selection.app.is_none()
            {
                return Err(Error::Unavailable);
            }
            let auth = authority(t, intent.kind)?;
            let confirmation = Confirmation {
                id: uuid::Uuid::new_v4().to_string(),
                kind: intent.kind,
                from: state.view.service.clone(),
                to: selection
                    .app
                    .as_ref()
                    .filter(|_| intent.kind == UpdateKind::App)
                    .map(|a| a.build.clone())
                    .unwrap_or_else(|| {
                        selection
                            .binding
                            .as_ref()
                            .and_then(|b| b["build"]["version"].as_str())
                            .unwrap_or("")
                            .to_owned()
                    }),
                // Native prepare does not count affected agents: Unknown,
                // never zero. App-only enters no daemon reservation and
                // pauses no agent by construction.
                pauses: (intent.kind == UpdateKind::App).then_some(0),
                keeps: None,
                restarts: intent.kind == UpdateKind::App,
            };
            state.pending = Some((confirmation, selection.pin(), auth, window));
            state.changed();
            Ok(outcome(OutcomeStatus::Accepted, state.view.revision, ""))
        }
        Command::Cancel(intent) => {
            if state.pending.as_ref().is_none_or(|p| p.0.id != intent.id) {
                return Err(Error::Stale);
            }
            state.pending = None;
            state.changed();
            Ok(outcome(OutcomeStatus::Accepted, state.view.revision, ""))
        }
        Command::Confirm(intent, window) => {
            validate_view(&intent.view)?;
            let pending = state
                .pending
                .as_ref()
                .filter(|p| p.0.id == intent.confirmation)
                .ok_or(Error::Stale)?;
            if pending.3 != window {
                return Err(Error::Identity);
            }
            if state
                .selection
                .as_ref()
                .is_none_or(|s| s.pin() != pending.1 || !s.matches(&t.source))
                || authority(t, pending.0.kind)? != pending.2
            {
                state.pending = None;
                return Err(Error::Identity);
            }
            let (c, root, auth, _) = state.pending.take().ok_or(Error::Stale)?;
            // This fsynced record consumes the one-use confirmation before any
            // native effect. Save failure never gives capture/entry authority.
            let record = Record {
                order: journal.updates.values().map(|r| r.order).max().unwrap_or(0) + 1,
                update_version: 1,
                id: c.id,
                source: t.source.clone(),
                root,
                window,
                kind: name(c.kind).into(),
                target: c.to,
                auth,
                view: serde_json::to_value(&intent.view).map_err(|_| Error::Invalid)?,
                revision: 1,
                state: "capture".into(),
                flush: None,
                message: "Waiting for native capture and durable form saves. Nothing was updated."
                    .into(),
                restored: false,
                manifest: None,
            };
            journal.save_update(record.clone())?;
            state.authority = Some((record.id.clone(), record.window.clone()));
            state.cold_restore = false;
            state.latest = Some(record);
            state.changed();
            Ok(outcome(
                OutcomeStatus::Accepted,
                state.view.revision,
                "Waiting for the native save barrier. Nothing was updated.",
            ))
        }
        Command::Commit(id, proof, window) => {
            let mut record = state
                .latest
                .clone()
                .filter(|r| r.id == id && r.state == "capture" && r.window == window)
                .ok_or(Error::Stale)?;
            if state.authority.take() != Some((id, window)) {
                return Err(Error::Unknown);
            }
            let selection = state.selection.clone().ok_or(Error::Unavailable)?;
            if selection.pin() != record.root
                || !selection.matches(&t.source)
                || authority(t, kind(&record.kind))? != record.auth
            {
                return Err(Error::Identity);
            }
            record.flush = Some(proof.parts());
            record.state = "entered".into();
            record.revision += 1;
            record.message = "Native lifecycle entered. Its outcome is not confirmed.".into();
            journal.save_update(record.clone())?;
            state.latest = Some(record.clone());
            state.changed();
            // No await between the final credential/close fence and dispatch.
            shared.open()?;
            if authority(t, kind(&record.kind))? != record.auth {
                return Err(Error::Identity);
            }
            let k = kind(&record.kind);
            let cancel = shared.closed.clone();
            let source = t.source.clone();
            let auth = record.auth.clone();
            let result = tokio::task::spawn_blocking(move || {
                // Final synchronous authority check on the actual native
                // dispatch thread, not before an await/scheduler gap.
                if !authority_for(&source, k).is_ok_and(|current| current == auth) {
                    return (Err(Failure::Unverified), None);
                }
                selection.enter_observed(k, &cancel)
            })
            .await;
            let result = match result {
                Ok((result, manifest)) => {
                    record.manifest = manifest;
                    Ok(result)
                }
                Err(error) => Err(error),
            };
            let (phase, message) = completion(result.unwrap_or(Err(Failure::Unknown)));
            record.state = phase.into();
            record.message = message.into();
            record.revision += 1;
            state.latest = Some(record.clone()); // preserve volatile exact ACK if saving fails
            journal.save_update(record)?;
            state.changed();
            Ok(outcome(
                if phase == "done" {
                    OutcomeStatus::Accepted
                } else if phase == "stopped" {
                    OutcomeStatus::Rejected
                } else {
                    OutcomeStatus::Unknown
                },
                state.view.revision,
                message,
            ))
        }
        Command::Restored(intent) => {
            if !state.cold_restore {
                return Err(Error::Stale);
            }
            let mut record = state
                .latest
                .clone()
                .filter(|r| r.id == intent.id && !r.restored)
                .ok_or(Error::Stale)?;
            // A restore ACK is display-only, NEVER permission to resume, launch,
            // register, COMMIT, or replay an interrupted operation.
            if !state.restore_verified
                || state
                    .selection
                    .as_ref()
                    .is_none_or(|s| !s.matches(&t.source))
            {
                return Err(Error::Identity);
            }
            record.restored = true;
            record.revision += 1;
            journal.save_update(record.clone())?;
            state.latest = Some(record);
            state.changed();
            Ok(outcome(
                OutcomeStatus::Accepted,
                state.view.revision,
                "View restored. No execution was resumed.",
            ))
        }
    }
}

fn completion(result: Result<Outcome, Failure>) -> (&'static str, &'static str) {
    match result {
        Ok(Outcome::Current) => (
            "done",
            "The native controller verified the service operation.",
        ),
        Ok(Outcome::ExitPrepared) => (
            "prepared",
            "The external app guard is prepared. The app has not been replaced; native handoff is still required.",
        ),
        Ok(_) | Err(Failure::Unknown) => ("unknown", failure_message(Failure::Unknown)),
        Err(f) => ("stopped", failure_message(f)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_native_prepare_ack_stays_check_only_after_durable_restart() {
        let path = std::env::temp_dir().join(format!("day-lost-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let source = Source {
            profile: path.clone(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project_id: "project".into(),
            project_path: path.display().to_string(),
        };
        let mut record = Record {
            order: 1,
            update_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            source: source.clone(),
            root: json!({}),
            window: uuid::Uuid::new_v4().to_string(),
            kind: "service".into(),
            target: "2.0".into(),
            view: serde_json::to_value(SavedView {
                goal: "exact unsent form".into(),
                ..Default::default()
            })
            .unwrap(),
            auth: "a".repeat(64),
            revision: 1,
            state: "capture".into(),
            flush: None,
            message: String::new(),
            restored: false,
            manifest: None,
        };
        let ledger = path.join("journal");
        {
            let mut journal = Journal::open(ledger.clone()).unwrap();
            journal.save_update(record.clone()).unwrap();
            record.state = "entered".into();
            record.flush = Some((7, 3));
            record.revision += 1;
            journal.save_update(record.clone()).unwrap();
            let (phase, message) = completion(Err(Failure::Unknown));
            record.state = phase.into();
            record.message = message.into();
            record.revision += 1;
            journal.save_update(record).unwrap();
            journal.finish().unwrap();
        }
        let journal = Journal::open(ledger).unwrap();
        let mut state = State::new(None);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(state.restore(&journal, &source));
        assert!(
            state.unsettled(),
            "prepare must refuse, never reconstruct the native request"
        );
        assert_eq!(state.snapshot().run.unwrap().phase, UpdatePhase::Unknown);
        assert_eq!(state.latest.as_ref().unwrap().flush, Some((7, 3)));
        assert!(
            state.authority.is_none(),
            "restart cannot restore execution authority"
        );
        assert_eq!(
            completion(Err(Failure::Busy)).0,
            "stopped",
            "a proven jobful refusal is Not updated, never success"
        );
        drop(journal);
        std::fs::remove_dir_all(path).unwrap();
    }
}

fn failure_message(failure: Failure) -> &'static str {
    match failure {
        Failure::Busy => {
            "Not updated. A checkpoint or job subtree exit could not be proven. Existing work remains held by its owner."
        }
        Failure::Unsupported => {
            "Not updated. Registration or this service target is not supported by the native controller."
        }
        Failure::Unverified => {
            "Not updated. The native identity, signature or service could not be verified."
        }
        Failure::Cancelled => "Not updated. The native controller cancelled before replacement.",
        Failure::StagingCapacity | Failure::StagingArchiveFailed => {
            "Not updated. The native staging store needs attention; existing evidence was kept."
        }
        Failure::Unknown => "The native outcome is unknown. Check only; nothing will be resent.",
    }
}
