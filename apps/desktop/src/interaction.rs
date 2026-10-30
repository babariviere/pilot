//! User-driven Local courier and private draft writer. No legacy send/create POST.
//! Recovery never executes: only explicit Retry can reuse a stored immutable intent.
use crate::delivery_store::diagnostic::{Acknowledgment, Category, Diagnostic, Stage};
use crate::{
    LocalOptions,
    delivery_store::{Book, Delivery, Draft, Failure, Intent, Operation, Store, valid_key},
    local_client::gate,
};
use serde_json::Value;

#[path = "interaction_delivery.rs"]
mod delivery;
use delivery::DeliveryOwner;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Default)]
pub(crate) struct WriteState {
    pub(crate) book: Option<Arc<Book>>,
    pub(crate) error: Option<Failure>,
    pub(crate) notice: &'static str,
    pub(crate) flushed: bool,
    pub(crate) checkpoint: Option<u64>,
    pub(crate) discard: Option<(String, u64, u64, Result<(), Failure>)>,
    pub(crate) handled: BTreeMap<String, u64>,
    pub(crate) notice_key: Option<String>,
    pub(crate) delivery_notice: Option<String>,
    pub(crate) delivery_reports: BTreeMap<String, DeliveryReport>,
    pub(crate) mission: Option<crate::mission_conversion::Reply>,
    pub(crate) project: Option<crate::project_registration::Reply>,
    pub(crate) project_receipt: Option<(String, String)>,
    pub(crate) model: Option<crate::chat_models::Reply>,
    pub(crate) mission_receipts:
        Arc<std::collections::BTreeMap<String, crate::mission_conversion::Receipt>>,
}

/// Volatile observation of an exact retained operation, not another authority or store.
#[derive(Clone)]
pub(crate) struct DeliveryReport {
    pub(crate) key: String,
    pub(crate) delivery: Delivery,
    pub(crate) saved: bool,
    pub(crate) save_error: Option<Category>,
}
impl DeliveryReport {
    fn new(intent: &Intent, previous: Option<&Self>) -> Self {
        let mut delivery = Delivery::from_intent(intent);
        delivery.diagnostic = Some(Diagnostic::started(Stage::Identity));
        delivery.diagnostic.as_mut().unwrap().acknowledgment = previous
            .filter(|old| old.key == intent.key && old.delivery.matches(intent, &intent.key))
            .and_then(|old| old.delivery.diagnostic)
            .map(|d| d.acknowledgment)
            .filter(|ack| *ack != Acknowledgment::Unknown)
            .or_else(|| {
                intent
                    .diagnostic
                    .map(|d| d.acknowledgment)
                    .filter(|ack| *ack != Acknowledgment::Unknown)
            })
            .unwrap_or(if intent.state == "pending" {
                Acknowledgment::Pending
            } else {
                Acknowledgment::Unknown
            });
        Self {
            key: intent.key.clone(),
            delivery,
            saved: false,
            save_error: None,
        }
    }
    fn retained(&self, book: &Book) -> bool {
        book.pending
            .get(&self.delivery.id)
            .is_some_and(|i| self.delivery.matches(i, &self.key))
            || book
                .drafts
                .get(&self.key)
                .and_then(|d| d.last.as_ref())
                .is_some_and(|last| last.same_operation(&self.delivery))
    }
}

pub(crate) enum WriteCommand {
    RetireAnswer {
        key: String,
        revision: u64,
        identity: crate::question::ReplyIdentity,
        recover: bool,
    },
    Answer {
        key: String,
        draft: Box<Draft>,
        question: Arc<crate::question::Question>,
        request: u64,
    },
    Model {
        session: String,
        request: u64,
        action: crate::chat_models::Action,
    },
    Project {
        id: String,
        path: Option<String>,
    },
    Mission {
        target: crate::mission_conversion::Target,
        request: u64,
        action: crate::mission_conversion::Action,
    },
    Submit {
        key: String,
        draft: Box<Draft>,
        follow_up: bool,
        stop: bool,
        request: u64,
    },
    Check {
        id: String,
        retry: bool,
    },
    /// Explicit Retry of an answer, with the current projected question it
    /// still answers. Only an exact awaited question permits a working turn.
    RetryAnswer {
        id: String,
        question: Arc<crate::question::Question>,
    },
    DismissStop {
        id: String,
    },
    RetireCreated {
        key: String,
        revision: u64,
        target: String,
    },
    ClearRecovery {
        key: String,
        revision: u64,
    },
    /// The user discarded a draft. Any unresolved delivery is abandoned, never retried.
    Discard {
        key: String,
        revision: u64,
    },
    /// Delete only an ordinary local slot that has never attempted delivery.
    DiscardNew {
        key: String,
        revision: u64,
        request: u64,
    },
    RetireEmpty {
        key: String,
        revision: u64,
    },
    #[cfg(any(test, target_os = "macos", target_os = "linux"))]
    Checkpoint(u64),
    Close,
}

#[derive(Clone)]
pub(crate) struct Interaction {
    pub(crate) attachment_root: Option<PathBuf>,
    pub(crate) pasted_attachment_directory: Option<PathBuf>,
    commands: async_channel::Sender<WriteCommand>,
    edits: Arc<Mutex<BTreeMap<String, Draft>>>,
    wake: async_channel::Sender<()>,
    close: async_channel::Sender<()>,
}
impl Interaction {
    /// Withdraw every sender of an owned headless fixture after its window is
    /// removed. GPUI may retain entities until the whole test context drops.
    /// Exercise the ordinary disconnect path, never forge a durable Close ack.
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_fixture(&self) {
        self.close.close();
        self.commands.close();
        self.wake.close();
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn recording() -> (Self, async_channel::Receiver<WriteCommand>) {
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, _) = async_channel::bounded(1);
        let (close, _) = async_channel::bounded(1);
        (
            Self {
                commands,
                edits: Arc::new(Mutex::new(BTreeMap::new())),
                attachment_root: None,
                pasted_attachment_directory: None,
                wake,
                close,
            },
            receiver,
        )
    }
    #[cfg(test)]
    pub(crate) fn recording_with_close() -> (
        Self,
        async_channel::Receiver<WriteCommand>,
        async_channel::Receiver<()>,
    ) {
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, _) = async_channel::bounded(1);
        let (close, closed) = async_channel::bounded(4);
        (
            Self {
                commands,
                edits: Arc::new(Mutex::new(BTreeMap::new())),
                attachment_root: None,
                pasted_attachment_directory: None,
                wake,
                close,
            },
            receiver,
            closed,
        )
    }
    pub(crate) fn start(
        options: LocalOptions,
        path: Result<PathBuf, Failure>,
    ) -> (Self, async_channel::Receiver<WriteState>) {
        let (commands, receiver) = async_channel::bounded(8);
        let (wake, wake_receiver) = async_channel::bounded(1);
        let (close, close_receiver) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let replace = output.clone();
        let edits = Arc::new(Mutex::new(BTreeMap::new()));
        let pending = edits.clone();
        let attachment_root = path.as_ref().ok().cloned();
        std::thread::Builder::new()
            .name("local-draft-courier".into())
            .spawn(move || {
                let store = path.and_then(|path| Store::open(path, options.host()));
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                if let Ok(runtime) = runtime {
                    runtime.block_on(run(
                        options,
                        store,
                        WorkerChannels {
                            commands: receiver,
                            wake: wake_receiver,
                            edits: pending,
                            updates,
                            replace,
                            close: close_receiver,
                        },
                    ));
                }
            })
            .expect("start private draft worker");
        (
            Self {
                commands,
                edits,
                attachment_root,
                pasted_attachment_directory: crate::image_attachments::pasted_directory(),
                wake,
                close,
            },
            output,
        )
    }

    pub(crate) fn edit(&self, key: String, draft: Draft) -> bool {
        if !valid_key(&key) || draft.text.len() > crate::delivery_store::TEXT_CAP {
            return false;
        }
        let Ok(mut pending) = self.edits.lock() else {
            return false;
        };
        if pending.len() >= crate::delivery_store::DRAFT_CAP && !pending.contains_key(&key) {
            return false;
        }
        if pending
            .get(&key)
            .is_none_or(|old| old.revision < draft.revision)
        {
            pending.insert(key, draft);
        }
        let _ = self.wake.try_send(());
        true
    }
    pub(crate) fn command(&self, command: WriteCommand) -> bool {
        if matches!(command, WriteCommand::Close) {
            return !matches!(
                self.close.try_send(()),
                Err(async_channel::TrySendError::Closed(_))
            );
        }
        self.commands.try_send(command).is_ok()
    }
}

fn retain_report(status: &mut WriteState, store: &mut Store, report: Option<DeliveryReport>) {
    status.delivery_notice = report.as_ref().map(|r| r.delivery.id.clone());
    if let Some(mut report) = report {
        if let Some(d) = report.delivery.diagnostic.as_mut()
            && d.category == Category::InFlight
        {
            d.category = Category::Interrupted;
        }
        // Only AFTER settlement. Diagnostic bytes never reserve adoption space.
        match store.record_diagnostic(&report.key, &report.delivery) {
            Ok(()) => report.saved = true,
            Err(error) => report.save_error = Some(private_category(store, error)),
        }
        if report.retained(&store.book) {
            status
                .delivery_reports
                .insert(report.delivery.id.clone(), report);
        }
    }
    status
        .delivery_reports
        .retain(|_, r| r.retained(&store.book));
    debug_assert!(status.delivery_reports.len() <= crate::delivery_store::DRAFT_CAP + 32);
    if store.is_faulted() {
        status.error =
            Some("Private state write failed. Keep/copy unsaved text before restarting.");
    }
}

fn publish(
    tx: &async_channel::Sender<WriteState>,
    replace: &async_channel::Receiver<WriteState>,
    value: WriteState,
) {
    if let Err(async_channel::TrySendError::Full(value)) = tx.try_send(value) {
        let _ = replace.try_recv();
        let _ = tx.try_send(value);
    }
}

fn flush(store: &mut Store, pending: &Mutex<BTreeMap<String, Draft>>) -> Result<(), Failure> {
    if store.is_faulted() {
        return Err(
            "Private writer is fenced after an I/O failure. Keep/copy unsaved text before restart.",
        );
    }
    let batch = std::mem::take(
        &mut *pending
            .lock()
            .map_err(|_| "Draft edit queue is unavailable")?,
    );
    if batch.is_empty() {
        return Ok(());
    }
    // Never hold the UI mailbox lock during serialization or fsync.
    if let Err(error) = store.save_edits(batch.clone()) {
        let mut pending = pending
            .lock()
            .map_err(|_| "Draft edit queue is unavailable")?;
        for (key, draft) in batch {
            if pending
                .get(&key)
                .is_none_or(|old| old.revision < draft.revision)
            {
                pending.insert(key, draft);
            }
        }
        return Err(error);
    }
    Ok(())
}

struct WorkerChannels {
    commands: async_channel::Receiver<WriteCommand>,
    wake: async_channel::Receiver<()>,
    edits: Arc<Mutex<BTreeMap<String, Draft>>>,
    updates: async_channel::Sender<WriteState>,
    replace: async_channel::Receiver<WriteState>,
    close: async_channel::Receiver<()>,
}

const AUTOSAVE_IDLE: Duration = Duration::from_millis(250);
const AUTOSAVE_MAX: Duration = Duration::from_secs(1);

/// Only editable draft autosaves may wait. Keep a fixed first-edit ceiling so
/// continued typing cannot indefinitely postpone persistence. Explicit commands
/// bypass this schedule; their flush/intent/adoption acknowledgments stay durable.
#[derive(Default)]
struct Autosave {
    first_edit: Option<tokio::time::Instant>,
    deadline: Option<tokio::time::Instant>,
}
impl Autosave {
    fn edited(&mut self, now: tokio::time::Instant) {
        let first = *self.first_edit.get_or_insert(now);
        self.deadline = Some((now + AUTOSAVE_IDLE).min(first + AUTOSAVE_MAX));
    }
}
async fn run(options: LocalOptions, mut store: Result<Store, Failure>, channels: WorkerChannels) {
    let WorkerChannels {
        commands,
        wake,
        edits,
        updates,
        replace,
        close,
    } = &channels;
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .expect("Local operation client");
    let mut status = WriteState::default();
    match &store {
        Ok(store) => status.book = Some(Arc::new(store.book.clone())),
        Err(error) => status.error = Some(*error),
    }
    publish(updates, replace, status.clone());
    let mut autosave = Autosave::default();
    let mut closing = false;
    loop {
        let command = tokio::select! {
            biased;
            signal=close.recv()=>match signal {
                Ok(())=>{closing=true;Some(WriteCommand::Close)},
                Err(_)=>{
                    // The last client disappeared, not another explicit Close.
                    // A failed final save must neither acknowledge durability nor
                    // keep this permanently-ready branch spinning/starving exit.
                    if let Ok(store)=&mut store {let _=flush(store,edits);}
                    break;
                }
            },
            command=commands.recv()=>match command {Ok(command)=>Some(command),Err(_)=>{
                if let Ok(store)=&mut store {let _=flush(store,edits);}break;
            }},
            // An expired ceiling wins over even a continuously ready edit wake.
            _=tokio::time::sleep_until(autosave.deadline.unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(3600))),if autosave.deadline.is_some()=>None,
            signal=wake.recv()=>{
                if signal.is_err(){if let Ok(store)=&mut store{let _=flush(store,edits);}break;}
                autosave.edited(tokio::time::Instant::now());
                continue;
            }
        };
        // All commands force the existing flush immediately. Do not leave an
        // obsolete timer armed after their durable save/adoption.
        autosave = Autosave::default();
        // A checkpoint may overtake its edit's queued wake. An empty timer flush
        // changes nothing and must not erase that still-exact acknowledgement.
        if command.is_none() && edits.lock().is_ok_and(|pending| pending.is_empty()) {
            continue;
        }
        let handled = match &command {
            Some(WriteCommand::Submit { key, request, .. })
            | Some(WriteCommand::Answer { key, request, .. }) => Some((key.clone(), *request)),
            _ => None,
        };
        status.notice_key = match &command {
            Some(WriteCommand::Model { session, .. }) => Some(format!("chat:{session}")),
            Some(WriteCommand::Mission { target, .. }) => {
                Some(format!("mission:{}", target.source))
            }
            Some(WriteCommand::Submit { key, .. })
            | Some(WriteCommand::Answer { key, .. })
            | Some(WriteCommand::RetireCreated { key, .. })
            | Some(WriteCommand::ClearRecovery { key, .. })
            | Some(WriteCommand::RetireEmpty { key, .. }) => Some(key.clone()),
            Some(WriteCommand::RetireAnswer { key, .. }) => Some(key.clone()),
            Some(WriteCommand::Check { id, .. })
            | Some(WriteCommand::RetryAnswer { id, .. })
            | Some(WriteCommand::DismissStop { id }) => store
                .as_ref()
                .ok()
                .and_then(|s| s.book.pending.get(id))
                .map(|i| i.key.clone()),
            _ => None,
        };
        let mut delivery_report = None;
        let discard = match &command {
            Some(WriteCommand::DiscardNew {
                key,
                revision,
                request,
            }) => Some((key.clone(), *revision, *request)),
            _ => None,
        };
        status.checkpoint = None;
        let result = if let Ok(store) = &mut store {
            match flush(store, edits) {
                Err(error) => {
                    status.error = Some(error);
                    Err(error)
                }
                Ok(()) => {
                    status.error = None;
                    match command {
                        Some(WriteCommand::Model {
                            session,
                            request,
                            action,
                        }) => {
                            use crate::chat_models::{Outcome, Reply};
                            status.model = Some(Reply {
                                session: session.clone(),
                                request,
                                outcome: Outcome::Pending,
                            });
                            publish(updates, replace, status.clone());
                            let result = DeliveryOwner {
                                store,
                                status: &mut status,
                                channels: Some(&channels),
                                autosave: &mut autosave,
                                closing: &mut closing,
                            }
                            .model(&client, &options, action)
                            .await;
                            match result {
                                Ok(outcome) => {
                                    status.model = Some(Reply {
                                        session,
                                        request,
                                        outcome,
                                    });
                                    if store.is_faulted() {
                                        status.error = Some(
                                            "Private model-switch receipt could not be saved. Keep unsaved text before restarting.",
                                        );
                                    }
                                    Ok("")
                                }
                                Err(_) => Ok(
                                    "Closing. Any admitted model switch remains unconfirmed and is never resent.",
                                ),
                            }
                        }
                        Some(WriteCommand::Project { id, path: None }) => {
                            use crate::project_registration::{Outcome, Reply};
                            status.project = Some(Reply {
                                id: id.clone(),
                                result: Ok(Outcome::Pending),
                                catalog: None,
                            });
                            publish(updates, replace, status.clone());
                            let result = DeliveryOwner {
                                store,
                                status: &mut status,
                                channels: Some(&channels),
                                autosave: &mut autosave,
                                closing: &mut closing,
                            }
                            .effect(async {
                                Ok(crate::project_registration::catalog(&client, &options).await)
                            })
                            .await;
                            match result {
                                Ok(catalog) => {
                                    status.project = Some(Reply {
                                        id,
                                        result: Ok(Outcome::Read),
                                        catalog: Some(catalog),
                                    });
                                    Ok("")
                                }
                                Err(_) => {
                                    Ok("Closing. Interrupted project registration is not retried.")
                                }
                            }
                        }
                        Some(WriteCommand::Project {
                            id,
                            path: Some(path),
                        }) => {
                            use crate::project_registration::{Outcome, Reply};
                            status.project = Some(Reply {
                                id: id.clone(),
                                result: Ok(Outcome::Pending),
                                catalog: None,
                            });
                            publish(updates, replace, status.clone());
                            let mut owner = DeliveryOwner {
                                store,
                                status: &mut status,
                                channels: Some(&channels),
                                autosave: &mut autosave,
                                closing: &mut closing,
                            };
                            let result = owner.project(&client, &options, &id, &path).await;
                            if let Ok(Outcome::Created(created)) = &result {
                                owner.status.project_receipt = Some((id.clone(), created.clone()));
                            }
                            let catalog = if *owner.closing {
                                Err("Closing. Project registration was interrupted.")
                            } else {
                                owner
                                    .effect(async {
                                        Ok(crate::project_registration::catalog(&client, &options)
                                            .await)
                                    })
                                    .await
                            };
                            match catalog {
                                Ok(catalog) => {
                                    status.project = Some(Reply {
                                        id,
                                        result,
                                        catalog: Some(catalog),
                                    });
                                    if store.is_faulted() {
                                        status.error = Some(
                                            "Private state write failed; keep/copy unsaved text before restart.",
                                        );
                                    }
                                    Ok("")
                                }
                                Err(_) => {
                                    Ok("Closing. Interrupted project registration is not retried.")
                                }
                            }
                        }
                        Some(WriteCommand::Mission {
                            target,
                            request,
                            action,
                        }) => {
                            use crate::mission_conversion::{Action, Inspection, Receipt, Reply};
                            let attempt_id = match &action {
                                Action::Submit { id, .. } => Some(id.clone()),
                                _ => None,
                            };
                            status.mission = Some(Reply {
                                target: target.clone(),
                                request,
                                result: Ok(Inspection::Pending),
                            });
                            publish(updates, replace, status.clone());
                            let result = DeliveryOwner {
                                store,
                                status: &mut status,
                                channels: Some(&channels),
                                autosave: &mut autosave,
                                closing: &mut closing,
                            }
                            .mission(&client, &options, &target, action)
                            .await;
                            if let (Some(id), Ok(Inspection::Created { mission_id })) =
                                (attempt_id, &result)
                                && let Some(attempt) = store.book.missions.get(&target.source)
                                && attempt.id == id
                                && attempt.request.project_id == target.project
                            {
                                Arc::make_mut(&mut status.mission_receipts).insert(
                                    target.source.clone(),
                                    Receipt {
                                        attempt_id: id,
                                        project_id: target.project.clone(),
                                        mission_id: mission_id.clone(),
                                    },
                                );
                            }
                            status.mission = Some(Reply {
                                target,
                                request,
                                result,
                            });
                            if store.is_faulted() {
                                status.error = Some(
                                    "Private state write failed; preserve unsaved input before restarting.",
                                );
                            }
                            Ok("")
                        }
                        Some(WriteCommand::Answer {
                            key,
                            draft,
                            question,
                            request,
                        }) => {
                            if status.handled.get(&key).is_some_and(|old| *old >= request) {
                                Ok("This UI request was already handled.")
                            } else if store
                                .book
                                .drafts
                                .get(&key)
                                .is_some_and(|d| d.pending.is_some())
                            {
                                Ok("Delivery is already pending. Check its receipt.")
                            } else {
                                DeliveryOwner {
                                    store,
                                    status: &mut status,
                                    channels: Some(&channels),
                                    autosave: &mut autosave,
                                    closing: &mut closing,
                                }
                                .submit_answer(
                                    &client,
                                    &options,
                                    AnswerSubmission {
                                        key: &key,
                                        draft: &draft,
                                        question: &question,
                                    },
                                    &mut delivery_report,
                                )
                                .await
                            }
                        }
                        Some(WriteCommand::Submit {
                            key,
                            draft,
                            follow_up,
                            stop,
                            request,
                        }) => {
                            if status.handled.get(&key).is_some_and(|old| *old >= request) {
                                Ok("This UI request was already handled.")
                            } else if store
                                .book
                                .drafts
                                .get(&key)
                                .is_some_and(|d| d.pending.is_some())
                            {
                                Ok("Delivery is already pending. Check its receipt.")
                            } else {
                                DeliveryOwner {
                                    store,
                                    status: &mut status,
                                    channels: Some(&channels),
                                    autosave: &mut autosave,
                                    closing: &mut closing,
                                }
                                .submit(
                                    &client,
                                    &options,
                                    Submission {
                                        key: &key,
                                        draft: &draft,
                                        follow_up,
                                        stop,
                                    },
                                    &mut delivery_report,
                                )
                                .await
                            }
                        }
                        Some(WriteCommand::Check { id, retry }) => {
                            // A failed/capacity-refused private note may leave
                            // the only known ACK in this exact operation's
                            // worker observation, not in the durable Book.
                            delivery_report = status.delivery_reports.get(&id).cloned();
                            DeliveryOwner {
                                store,
                                status: &mut status,
                                channels: Some(&channels),
                                autosave: &mut autosave,
                                closing: &mut closing,
                            }
                            .reconcile(&client, &options, &id, retry, None, &mut delivery_report)
                            .await
                        }
                        Some(WriteCommand::RetryAnswer { id, question }) => {
                            delivery_report = status.delivery_reports.get(&id).cloned();
                            DeliveryOwner {
                                store,
                                status: &mut status,
                                channels: Some(&channels),
                                autosave: &mut autosave,
                                closing: &mut closing,
                            }
                            .reconcile(
                                &client,
                                &options,
                                &id,
                                true,
                                Some(&question),
                                &mut delivery_report,
                            )
                            .await
                        }
                        Some(WriteCommand::DismissStop { id }) => {
                            if store
                                .book
                                .pending
                                .get(&id)
                                .is_some_and(|i| i.operation.is_none())
                            {
                                store.finish(&id,"unknown",None).map(|_|"Stop uncertainty acknowledged locally; no Stop retry was sent.")
                            } else {
                                Err("Only an uncertain Stop can be acknowledged here")
                            }
                        }
                        Some(WriteCommand::RetireCreated {
                            key,
                            revision,
                            target,
                        }) => store.retire_created(&key, revision, &target).map(|_| ""),
                        Some(WriteCommand::ClearRecovery { key, revision }) => store
                            .clear_recovery(&key, revision)
                            .map(|_| "Recovered text removed locally."),
                        Some(WriteCommand::Discard { key, revision }) => {
                            store.discard_draft(&key, revision).map(|_| {
                                if key.starts_with("subagent:") {
                                    "Draft discarded locally. The earlier message may have arrived."
                                } else {
                                    "Draft discarded. Nothing was sent."
                                }
                            })
                        }
                        Some(WriteCommand::DiscardNew { key, revision, .. }) => {
                            store.discard_new_draft(&key, revision).map(|_| "")
                        }
                        Some(WriteCommand::RetireEmpty { key, revision }) => {
                            store.retire_empty(&key, revision).map(|_| "")
                        }
                        Some(WriteCommand::RetireAnswer {
                            key,
                            revision,
                            identity,
                            recover,
                        }) => store
                            .retire_answer(&key, revision, &identity, recover)
                            // Settling an accepted reply is routine and silent.
                            .map(|_| {
                                if recover {
                                    "Question reply kept in recovery."
                                } else {
                                    ""
                                }
                            }),
                        #[cfg(any(test, target_os = "macos", target_os = "linux"))]
                        Some(WriteCommand::Checkpoint(generation)) => {
                            if store.is_faulted() {
                                Err("Private state durability is unconfirmed.")
                            } else {
                                status.checkpoint = Some(generation);
                                Ok("Update checkpoint saved.")
                            }
                        }
                        Some(WriteCommand::Close) => {
                            status.flushed = true;
                            Ok("Drafts saved.")
                        }
                        None => Ok("Draft saved."),
                    }
                }
            }
        } else {
            if matches!(command, Some(WriteCommand::Close))
                && edits.lock().is_ok_and(|edits| edits.is_empty())
            {
                status.flushed = true;
            }
            Err(*store.as_ref().err().expect("failed store"))
        };
        if let Ok(store) = &mut store {
            retain_report(&mut status, store, delivery_report);
        }
        if let Some((key, revision, request)) = discard {
            status.discard = Some((key, revision, request, result.map(|_| ())));
        }
        match result {
            Ok(notice) => status.notice = notice,
            Err(error) => {
                status.notice = error;
            }
        }
        if let Some((key, request)) = handled {
            status
                .handled
                .entry(key.clone())
                .and_modify(|old| *old = (*old).max(request))
                .or_insert(request);
            if status.handled.len() > 256
                && let Some(old) = status.handled.keys().find(|old| *old != &key).cloned()
            {
                status.handled.remove(&old);
            }
        }
        if closing
            && !status.flushed
            && let Ok(store) = &mut store
        {
            match flush(store, edits) {
                Ok(()) => status.flushed = true,
                Err(error) => status.error = Some(error),
            }
        }
        if let Ok(store) = &store {
            status.book = Some(Arc::new(store.book.clone()));
        }
        publish(updates, replace, status.clone());
        if status.flushed {
            break;
        }
    }
    // `channels` otherwise drops before the earlier store argument. Release
    // the private owner before closing its update lane, so a consumer that
    // observes disconnection cannot race a still-held draft-store lock.
    drop(store);
}

async fn read_json(request: reqwest::RequestBuilder) -> Result<Value, Failure> {
    read_delivery_json(request)
        .await
        .map(|(value, _)| value)
        .map_err(|e| e.message())
}
/// The daemon answers Stop with 202 Accepted. Any other status leaves its outcome unknown.
async fn read_stop_json(request: reqwest::RequestBuilder) -> Result<Value, Failure> {
    read_json_with(request, |status| {
        matches!(
            status,
            reqwest::StatusCode::OK | reqwest::StatusCode::ACCEPTED
        )
    })
    .await
    .map(|(value, _)| value)
    .map_err(|e| e.message())
}

struct HttpFailure {
    category: Category,
    status: Option<u16>,
}
impl HttpFailure {
    fn message(&self) -> Failure {
        match self.category {
            Category::Refused => "Local request refused or unavailable; delivery is not confirmed",
            Category::ResponseInterrupted => {
                "Local response interrupted; delivery is not confirmed"
            }
            Category::TooLarge => {
                "Local response exceeds the 4 MiB bound; delivery is not confirmed"
            }
            Category::Malformed => "Invalid Local reply; delivery is not confirmed",
            _ => "Local request interrupted; delivery is not confirmed",
        }
    }
}
async fn read_delivery_json(request: reqwest::RequestBuilder) -> Result<(Value, u16), HttpFailure> {
    read_json_with(request, |status| status == reqwest::StatusCode::OK).await
}
async fn read_json_with(
    request: reqwest::RequestBuilder,
    accepted: impl Fn(reqwest::StatusCode) -> bool,
) -> Result<(Value, u16), HttpFailure> {
    let mut response = request.send().await.map_err(|_| HttpFailure {
        category: Category::Interrupted,
        status: None,
    })?;
    let http_status = response.status().as_u16();
    let status = Some(http_status);
    if !accepted(response.status()) {
        return Err(HttpFailure {
            category: Category::Refused,
            status,
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > 4 * 1024 * 1024)
    {
        return Err(HttpFailure {
            category: Category::TooLarge,
            status,
        });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| HttpFailure {
        category: Category::ResponseInterrupted,
        status,
    })? {
        if body.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(HttpFailure {
                category: Category::TooLarge,
                status,
            });
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map(|v| (v, http_status))
        .map_err(|_| HttpFailure {
            category: Category::Malformed,
            status,
        })
}

async fn writable(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &str,
) -> Result<Value, Failure> {
    if !crate::delivery_store::token(target) {
        return Err("Invalid Local chat target");
    }
    let value =
        read_json(client.get(format!("{}/api/sessions/{target}", options.loopback()))).await?;
    writable_summary(&value, target)?;
    Ok(value)
}
fn writable_summary(value: &Value, target: &str) -> Result<(), Failure> {
    if value["id"] != target || !crate::local_model::messageable_local(value) {
        return Err("This Local conversation is retained, archived, continued or not writable");
    }
    Ok(())
}

/// An ended turn takes any reply as its next message. A working turn takes
/// one only for the awaited (`blocking`) ask its run published.
fn question_turn_ready(summary: &Value, awaited: bool) -> Result<(), Failure> {
    let ready = match summary["state"].as_str() {
        Some("idle" | "parked" | "failed") => true,
        Some("working") => awaited,
        _ => false,
    };
    if !ready {
        return Err(
            "The agent turn changed or is unavailable. Question reply retained; nothing sent",
        );
    }
    Ok(())
}
struct AnswerSubmission<'a> {
    key: &'a str,
    draft: &'a Draft,
    question: &'a crate::question::Question,
}
struct Submission<'a> {
    key: &'a str,
    draft: &'a Draft,
    follow_up: bool,
    stop: bool,
}

/// Immutable preflight only. The caller owns private reservation.
async fn send_preflight(
    client: &reqwest::Client,
    options: &LocalOptions,
    request: &Submission<'_>,
    model_pending: bool,
    delivery_pending: bool,
) -> Result<(), Failure> {
    let Submission {
        key, draft, stop, ..
    } = *request;
    gate(client, options).await?;
    if let Some(target) = key.strip_prefix("chat:") {
        if !stop && model_pending {
            return Err(
                "A model switch is unconfirmed. Inspect and acknowledge it before sending; the draft is retained.",
            );
        }
        let summary = writable(client, options, target).await?;
        if !stop && !draft.attachments.is_empty() && summary["missionCoordinator"] == true {
            let directory = crate::image_attachments::pasted_directory()
                .ok_or("Attachment storage is unavailable. This draft was not sent.")?;
            if !crate::image_attachments::coordinator_readable(&draft.attachments, &directory) {
                return Err(
                    "These images are outside coordinator attachment storage. Remove and reattach them; this draft was not sent.",
                );
            }
        }
        if !stop
            && !draft.attachments.is_empty()
            && summary["missionCoordinator"] != true
            && summary["mode"] != "build"
        {
            return Err(
                "Image attachments require a Build chat. Ask cannot read this attachment store; the draft was not sent.",
            );
        }
    }
    if key.starts_with("new:") && !draft.diagnostics && !delivery_pending {
        let id = draft
            .project_id
            .as_deref()
            .ok_or("Choose a configured Local project")?;
        let value = read_json(client.get(format!("{}/api/projects", options.loopback()))).await?;
        let projects = crate::local_model::projects(&value)?;
        if !projects.iter().any(|p| p.id == id && p.path == draft.cwd) {
            return Err(
                "The selected project or folder changed. Choose the project again before creating.",
            );
        }
    }
    let child_target = crate::session_subagents::Target::from_key(key);
    if let Some(target) = &child_target {
        let summary = writable(client, options, &target.parent).await?;
        if !draft.attachments.is_empty() && summary["missionCoordinator"] == true {
            return Err(
                "Image attachments require an ordinary Build parent chat. This draft was not sent.",
            );
        }
        if !draft.attachments.is_empty() && summary["mode"] != "build" {
            return Err("Image attachments require a Build parent chat. This draft was not sent.");
        }
        let chat = crate::local_model::chat(&summary).ok_or("Subagent parent is unavailable")?;
        if target.child(&chat).is_none_or(|child| child.retired) {
            return Err("Subagent identity changed or retired. Nothing was sent.");
        }
        gate(client, options).await?;
    }
    Ok(())
}

#[cfg(test)]
async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    request: Submission<'_>,
    report: &mut Option<DeliveryReport>,
    prepared: impl FnOnce(&Store),
) -> Result<&'static str, Failure> {
    if request.stop {
        return DeliveryOwner {
            store,
            status: &mut WriteState::default(),
            channels: None,
            autosave: &mut Autosave::default(),
            closing: &mut false,
        }
        .submit(client, options, request, report)
        .await;
    }
    let Submission {
        key,
        draft,
        follow_up,
        stop,
    } = request;
    send_preflight(
        client,
        options,
        &request,
        key.strip_prefix("chat:")
            .is_some_and(|target| store.book.model_changes.contains_key(target)),
        store
            .book
            .drafts
            .get(key)
            .is_some_and(|d| d.pending.is_some()),
    )
    .await?;
    let child_target = crate::session_subagents::Target::from_key(key);
    // No mutation is possible before this durable reservation succeeds.
    let intent = store.prepare(key, draft, follow_up, stop)?;
    prepared(store);
    if let Some(target) = child_target {
        subagent_request(client, options, &target, &intent, report).await?;
        store.finish(&intent.id, "accepted", None)?;
        Ok("")
    } else {
        reconcile(client, options, store, &intent.id, true, None, report).await
    }
}

/// One-shot request ACK only, never a courier receipt or a replay permission.
async fn subagent_request(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &crate::session_subagents::Target,
    intent: &Intent,
    report: &mut Option<DeliveryReport>,
) -> Result<(), Failure> {
    let op = intent
        .operation
        .as_ref()
        .ok_or("Missing subagent message intent")?;
    let payload: Value =
        serde_json::from_str(&op.payload).map_err(|_| "Corrupt subagent message")?;
    *report = Some(DeliveryReport::new(intent, None));
    let diagnostic = report
        .as_mut()
        .unwrap()
        .delivery
        .diagnostic
        .as_mut()
        .unwrap();
    let mut url = reqwest::Url::parse(&options.loopback()).map_err(|_| "Local is unavailable")?;
    url.path_segments_mut()
        .map_err(|_| "Local is unavailable")?
        .extend([
            "api",
            "sessions",
            &target.parent,
            "subagents",
            &target.name,
            "messages",
        ]);
    diagnostic.stage = Stage::Execute;
    let response = read_json_with(client.post(url)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({"message":payload["message"], "mode":payload["mode"], "requestId":intent.id}).to_string()),|status|status==reqwest::StatusCode::ACCEPTED).await;
    let response = match response {
        Ok((body, status)) => {
            diagnostic.status = Some(status);
            body
        }
        Err(error) => {
            diagnostic.status = error.status;
            diagnostic.category = error.category;
            return Err(error.message());
        }
    };
    if diagnostic.status != Some(202) || response["ok"] != true {
        return Err("Subagent message was not confirmed. It was not retried.");
    }
    diagnostic.acknowledgment = Acknowledgment::Accepted;
    Ok(())
}

async fn operation(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
    lookup: bool,
    diagnostic: &mut Diagnostic,
) -> Result<Value, Failure> {
    let body = serde_json::to_vec(op).map_err(|_| "Cannot encode immutable operation")?;
    let path = if lookup {
        "/api/operations/receipt"
    } else {
        "/api/operations"
    };
    observe(
        options,
        diagnostic,
        if lookup {
            Stage::Lookup
        } else {
            Stage::Execute
        },
        client
            .post(format!("{}{path}", options.loopback()))
            .header("Content-Type", "application/json")
            .body(body),
    )
    .await
}

/// One request of a retained operation, keeping its stage and transport outcome.
async fn observe(
    options: &LocalOptions,
    diagnostic: &mut Diagnostic,
    stage: Stage,
    request: reqwest::RequestBuilder,
) -> Result<Value, Failure> {
    diagnostic.stage = stage;
    diagnostic.category = Category::InFlight;
    diagnostic.status = None;
    let request_id = crate::diagnostics::request_id();
    let started = std::time::Instant::now();
    let result = match read_delivery_json(request).await {
        Ok((value, status)) => {
            diagnostic.status = Some(status);
            Ok(value)
        }
        Err(error) => {
            diagnostic.category = error.category;
            diagnostic.status = error.status;
            Err(error.message())
        }
    };
    crate::diagnostics::delivery_to(
        options,
        request_id,
        diagnostic,
        started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        result.is_ok(),
    );
    result
}

/// Hello before a lookup or execute. An unreachable or refusing daemon is not an identity change.
async fn verify_local(
    client: &reqwest::Client,
    options: &LocalOptions,
    diagnostic: &mut Diagnostic,
) -> Result<(), Failure> {
    let hello = observe(
        options,
        diagnostic,
        Stage::Identity,
        client.get(format!("{}/api/hello", options.loopback())),
    )
    .await?;
    options
        .verify(&hello)
        .inspect_err(|_| diagnostic.category = Category::Identity)
}

#[cfg(test)]
async fn reconcile(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    id: &str,
    retry: bool,
    question: Option<&crate::question::Question>,
    report: &mut Option<DeliveryReport>,
) -> Result<&'static str, Failure> {
    // Direct legacy callers have no edit mailbox. Share the exact same courier.
    DeliveryOwner {
        store,
        status: &mut WriteState::default(),
        channels: None,
        autosave: &mut Autosave::default(),
        closing: &mut false,
    }
    .reconcile(client, options, id, retry, question, report)
    .await
}

/// Newer editable revisions do not invalidate the reserved immutable operation.
fn ensure_owned(store: &Store, options: &LocalOptions, intent: &Intent) -> Result<(), Failure> {
    if store.book.host != options.host()
        || store.book.pending.get(&intent.id) != Some(intent)
        || store
            .book
            .drafts
            .get(&intent.key)
            .and_then(|d| d.pending.as_deref())
            != Some(intent.id.as_str())
    {
        return Err("Delivery ownership changed. Original operation is retained.");
    }
    Ok(())
}

fn adopt_receipt(
    store: &mut Store,
    options: &LocalOptions,
    intent: &Intent,
    receipt: &Value,
    diagnostic: &mut Diagnostic,
) -> Result<&'static str, Failure> {
    let op = intent
        .operation
        .as_ref()
        .ok_or("Missing immutable operation")?;
    if receipt["state"] == "unknown" {
        diagnostic.category = Category::Unknown;
        return Ok("Couldn't confirm this was sent. Use Resolve to check or send it again.");
    }
    if receipt["operationId"] != op.operation_id
        || receipt["payloadHash"] != op.payload_hash
        || receipt["targetId"] != op.target_id
        || receipt["destination"]
            != serde_json::to_value(&op.destination).map_err(|_| "Invalid receipt destination")?
    {
        diagnostic.category = Category::ReceiptMismatch;
        return Err("Receipt identity differs. Original draft and operation are retained.");
    }
    match receipt["state"].as_str() {
        Some("pending") => {
            diagnostic.category = Category::Pending;
            diagnostic.acknowledgment = Acknowledgment::Pending;
            if let Err(error) =
                ensure_owned(store, options, intent).and_then(|()| store.pending(&intent.id))
            {
                adoption_failure(diagnostic, store, error);
                return Err(error);
            }
            Ok("Pending: daemon owns this delivery. Check later; it was not posted again.")
        }
        Some("accepted") => {
            if receipt["result"]["sessionId"] != op.target_id {
                diagnostic.category = Category::ReceiptMismatch;
                return Err("Accepted receipt target differs. Draft is retained.");
            }
            diagnostic.category = Category::Accepted;
            diagnostic.acknowledgment = Acknowledgment::Accepted;
            if let Err(error) = ensure_owned(store, options, intent)
                .and_then(|()| store.finish(&intent.id, "accepted", None))
            {
                adoption_failure(diagnostic, store, error);
                return Err(error);
            }
            Ok("Accepted by Local. A reply may still be streaming or queued.")
        }
        Some("rejected") => {
            diagnostic.category = Category::Rejected;
            diagnostic.acknowledgment = Acknowledgment::Rejected;
            if let Err(error) = ensure_owned(store, options, intent)
                .and_then(|()| store.finish(&intent.id, "rejected", None))
            {
                adoption_failure(diagnostic, store, error);
                return Err(error);
            }
            Ok("Rejected by Local. The owning draft is retained.")
        }
        _ => {
            diagnostic.category = Category::Malformed;
            Err("Unknown receipt state. Original draft and operation are retained.")
        }
    }
}

#[cfg(test)]
#[path = "session_subagents_transport_tests.rs"]
mod subagent_tests;

fn adoption_failure(diagnostic: &mut Diagnostic, store: &Store, error: Failure) {
    diagnostic.stage = Stage::Adoption;
    diagnostic.category = private_category(store, error);
}
fn private_category(store: &Store, error: Failure) -> Category {
    if store.is_faulted() {
        Category::PrivateWrite
    } else if error == "Private state is full. Nothing was discarded." {
        Category::PrivateCapacity
    } else {
        Category::PrivateState
    }
}

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
