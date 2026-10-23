//! User-driven Local courier and private draft writer. No legacy send/create POST.
//! Recovery never executes: only explicit Retry can reuse a stored immutable intent.
use crate::{
    LocalOptions,
    delivery_store::{Book, Draft, Failure, Operation, Store, valid_key},
    local_client::gate,
};
use serde_json::Value;
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
    pub(crate) handled: BTreeMap<String, u64>,
    pub(crate) notice_key: Option<String>,
    pub(crate) mission: Option<crate::mission_conversion::Reply>,
    pub(crate) mission_receipts:
        Arc<std::collections::BTreeMap<String, crate::mission_conversion::Receipt>>,
}

pub(crate) enum WriteCommand {
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
    RetireEmpty {
        key: String,
        revision: u64,
    },
    Close,
}

#[derive(Clone)]
pub(crate) struct Interaction {
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
                wake,
                close,
            },
            receiver,
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
    } = channels;
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
    publish(&updates, &replace, status.clone());
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
                    if let Ok(store)=&mut store {let _=flush(store,&edits);}
                    break;
                }
            },
            command=commands.recv()=>match command {Ok(command)=>Some(command),Err(_)=>{
                if let Ok(store)=&mut store {let _=flush(store,&edits);}break;
            }},
            // An expired ceiling wins over even a continuously ready edit wake.
            _=tokio::time::sleep_until(autosave.deadline.unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(3600))),if autosave.deadline.is_some()=>None,
            signal=wake.recv()=>{
                if signal.is_err(){if let Ok(store)=&mut store{let _=flush(store,&edits);}break;}
                autosave.edited(tokio::time::Instant::now());
                continue;
            }
        };
        // All commands force the existing flush immediately. Do not leave an
        // obsolete timer armed after their durable save/adoption.
        autosave = Autosave::default();
        let handled = match &command {
            Some(WriteCommand::Submit { key, request, .. }) => Some((key.clone(), *request)),
            _ => None,
        };
        status.notice_key = match &command {
            Some(WriteCommand::Mission { target, .. }) => {
                Some(format!("mission:{}", target.source))
            }
            Some(WriteCommand::Submit { key, .. })
            | Some(WriteCommand::RetireCreated { key, .. })
            | Some(WriteCommand::ClearRecovery { key, .. })
            | Some(WriteCommand::RetireEmpty { key, .. }) => Some(key.clone()),
            Some(WriteCommand::Check { id, .. }) | Some(WriteCommand::DismissStop { id }) => store
                .as_ref()
                .ok()
                .and_then(|s| s.book.pending.get(id))
                .map(|i| i.key.clone()),
            _ => None,
        };
        let result = if let Ok(store) = &mut store {
            match flush(store, &edits) {
                Err(error) => {
                    status.error = Some(error);
                    Err(error)
                }
                Ok(()) => {
                    status.error = None;
                    match command {
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
                            publish(&updates, &replace, status.clone());
                            tokio::select! {
                                result=crate::mission_transport::execute(&client,&options,store,&target,action,|store| {
                                    status.book=Some(Arc::new(store.book.clone()));
                                    publish(&updates,&replace,status.clone());
                                })=>{
                                    if let (Some(id), Ok(Inspection::Created { mission_id })) = (attempt_id, &result)
                                        && let Some(attempt) = store.book.missions.get(&target.source)
                                        && attempt.id == id && attempt.request.project_id == target.project {
                                        Arc::make_mut(&mut status.mission_receipts).insert(target.source.clone(), Receipt {
                                            attempt_id: id, project_id: target.project.clone(), mission_id: mission_id.clone(),
                                        });
                                    }
                                    status.mission=Some(Reply {target,request,result});
                                    if store.is_faulted() {status.error=Some("Private state write failed; preserve unsaved input before restarting.");}
                                    Ok("")
                                },
                                _=close.recv()=>{closing=true;Ok("Closing. Interrupted mission conversion is not retried.")}
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
                                tokio::select! {
                                    result=submit(&client,&options,store,Submission {key:&key,draft:&draft,follow_up,stop},|store| {
                                        status.book=Some(Arc::new(store.book.clone()));status.notice="Intent saved. Waiting for Local delivery.";publish(&updates,&replace,status.clone());
                                    })=>result,
                                    _=close.recv()=>{closing=true;Ok("Closing. Any interrupted delivery remains unconfirmed.")}
                                }
                            }
                        }
                        Some(WriteCommand::Check { id, retry }) => {
                            tokio::select! {
                                result=reconcile(&client,&options,store,&id,retry)=>result,
                                _=close.recv()=>{closing=true;Ok("Closing. Interrupted lookup is not rejection.")}
                            }
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
                        Some(WriteCommand::RetireEmpty { key, revision }) => {
                            store.retire_empty(&key, revision).map(|_| "")
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
            match flush(store, &edits) {
                Ok(()) => status.flushed = true,
                Err(error) => status.error = Some(error),
            }
        }
        if let Ok(store) = &store {
            status.book = Some(Arc::new(store.book.clone()));
        }
        publish(&updates, &replace, status.clone());
        if status.flushed {
            break;
        }
    }
}

async fn read_json(request: reqwest::RequestBuilder) -> Result<Value, Failure> {
    let mut response = request
        .send()
        .await
        .map_err(|_| "Local request interrupted; delivery is not confirmed")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local request refused or unavailable; delivery is not confirmed");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local response interrupted; delivery is not confirmed")?
    {
        if body.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("Local response exceeds the 4 MiB bound; delivery is not confirmed");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid Local reply; delivery is not confirmed")
}

async fn writable(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &str,
) -> Result<(), Failure> {
    if !crate::delivery_store::token(target) {
        return Err("Invalid Local chat target");
    }
    let value =
        read_json(client.get(format!("{}/api/sessions/{target}", options.loopback()))).await?;
    if value["id"] != target || !crate::local_model::interactive_local(&value) {
        return Err("This Local conversation is retained, archived, continued or not writable");
    }
    Ok(())
}

struct Submission<'a> {
    key: &'a str,
    draft: &'a Draft,
    follow_up: bool,
    stop: bool,
}

async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    request: Submission<'_>,
    prepared: impl FnOnce(&Store),
) -> Result<&'static str, Failure> {
    let Submission {
        key,
        draft,
        follow_up,
        stop,
    } = request;
    gate(client, options).await?;
    if let Some(target) = key.strip_prefix("chat:") {
        writable(client, options, target).await?;
    }
    if key.starts_with("new:")
        && !store
            .book
            .drafts
            .get(key)
            .is_some_and(|d| d.pending.is_some())
    {
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
    // No mutation is possible before this durable reservation succeeds.
    let intent = store.prepare(key, draft, follow_up, stop)?;
    prepared(store);
    if stop {
        // Stop has no durable operation/receipt API. Never retry it automatically.
        let result = read_json(
            client
                .post(format!(
                    "{}/api/sessions/{}/stop",
                    options.loopback(),
                    intent.target
                ))
                .header("Content-Type", "application/json")
                .body("{}"),
        )
        .await;
        match result {
            Ok(value)
                if value["ok"] == true
                    && (value["draft"].is_null() || value["draft"].is_string()) =>
            {
                store.finish(
                    &intent.id,
                    "accepted",
                    value["draft"].as_str().map(String::from),
                )?;
                Ok("Stop accepted. Any withdrawn queued text is retained separately.")
            }
            _ => Ok(
                "Stop outcome is unknown. It was not retried. Inspect the chat before another action.",
            ),
        }
    } else {
        reconcile(client, options, store, &intent.id, true).await
    }
}

async fn operation(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
    lookup: bool,
) -> Result<Value, Failure> {
    let body = serde_json::to_vec(op).map_err(|_| "Cannot encode immutable operation")?;
    let path = if lookup {
        "/api/operations/receipt"
    } else {
        "/api/operations"
    };
    read_json(
        client
            .post(format!("{}{path}", options.loopback()))
            .header("Content-Type", "application/json")
            .body(body),
    )
    .await
}

async fn reconcile(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    id: &str,
    retry: bool,
) -> Result<&'static str, Failure> {
    let Some(intent) = store.book.pending.get(id).cloned() else {
        return Ok("Delivery already settled.");
    };
    let Some(op) = &intent.operation else {
        return Ok("Stop has no receipt API. Its uncertainty cannot be safely retried.");
    };
    gate(client, options).await?;
    let mut receipt = operation(client, options, op, true).await?;
    if receipt["state"] == "unknown" && retry {
        // Explicit Retry retains the same envelope/target. Pending is NEVER re-posted.
        if op.kind == "chat-send" {
            writable(client, options, &op.target_id).await?;
        }
        gate(client, options).await?;
        receipt = operation(client, options, op, false).await?;
    }
    if receipt["state"] == "unknown" {
        return Ok(
            "Delivery is unknown. Check or explicitly retry this same operation; do not create a fresh one.",
        );
    }
    if receipt["operationId"] != op.operation_id
        || receipt["payloadHash"] != op.payload_hash
        || receipt["targetId"] != op.target_id
        || receipt["destination"]
            != serde_json::to_value(&op.destination).map_err(|_| "Invalid receipt destination")?
    {
        return Err("Receipt identity differs. Original draft and operation are retained.");
    }
    match receipt["state"].as_str() {
        Some("pending") => {
            store.pending(id)?;
            Ok("Pending: daemon owns this delivery. Check later; it was not posted again.")
        }
        Some("accepted") => {
            if receipt["result"]["sessionId"] != op.target_id {
                return Err("Accepted receipt target differs. Draft is retained.");
            }
            store.finish(id, "accepted", None)?;
            Ok("Accepted by Local. A reply may still be streaming or queued.")
        }
        Some("rejected") => {
            store.finish(id, "rejected", None)?;
            Ok("Rejected by Local. The owning draft is retained.")
        }
        _ => Err("Unknown receipt state. Original draft and operation are retained."),
    }
}

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
