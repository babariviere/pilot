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
    "day.today.read",
    "day.mission.read",
    "day.mission.pause",
    "day.mission.resume",
    "day.mission.check",
    "day.plan.read",
    "day.plan.snapshot",
    "day.plan.inventory",
    "day.plan.inventorySnapshot",
    "day.plan.prepare",
    "day.plan.create",
    "day.plan.save",
    "day.plan.submit",
    "day.plan.check",
    "day.plan.checkNew",
    "day.attention.read",
    "day.attention.reply",
    "day.attention.action",
    "day.attention.check",
    "day.attention.draft",
    "day.flush.ack",
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
    let grant = json!({"host":names}).to_string();
    bundle.policy.granted =
        Some(nsh_engine::parse_capabilities(&grant).map_err(|_| Error::Invalid)?);
    bundle.policy.harden = true;
    Ok(bundle)
}

#[derive(Default)]
pub(crate) struct Gate {
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
}

/// One root and one channel. Never reuse it for another window or selection.
/// The native owner stops the engine, then awaits `close` even after load failure.
pub struct Bridge {
    root: DayRoot,
    channel: HostChannel,
    window: String,
    gate: Arc<Mutex<Gate>>,
    _notice: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    window: String,
    args: Value,
}

pub(crate) enum Command {
    Today,
    Mission(String),
    Pause(crate::model::PauseIntent),
    Resume(crate::model::ResumeIntent),
    ControlCheck(String),
    Plan(String),
    PlanSnapshot(String),
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
    PlanCheck {
        mission: String,
        interview: String,
    },
    CheckNew,
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
    Flush(u32, u64),
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
        "day.today.read"
        | "day.plan.prepare"
        | "day.attention.read"
        | "day.plan.checkNew"
        | "day.plan.inventory"
        | "day.plan.inventorySnapshot" => {
            if args != json!({}) {
                return Err(Error::Invalid);
            }
            match name {
                "day.today.read" => C::Today,
                "day.plan.prepare" => C::Prepare,
                "day.plan.checkNew" => C::CheckNew,
                "day.plan.inventory" => C::PlanningInventory,
                "day.plan.inventorySnapshot" => C::PlanningInventorySnapshot,
                _ => C::Attention,
            }
        }
        "day.mission.read" | "day.mission.check" | "day.plan.read" | "day.plan.snapshot" => {
            let r: crate::model::MissionRef = decode(&args)?;
            mission(&r.mission_id)?;
            match name {
                "day.mission.read" => C::Mission(r.mission_id),
                "day.mission.check" => C::ControlCheck(r.mission_id),
                "day.plan.snapshot" => C::PlanSnapshot(r.mission_id),
                _ => C::Plan(r.mission_id),
            }
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
        "day.plan.create" => C::Create(decode(&args)?),
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
        "day.flush.ack" => C::Flush(exact::<Flush>(args)?.generation, 0),
        _ => return Err(Error::Invalid),
    })
}

impl Command {
    pub(crate) fn admit(&self, gate: &Gate) -> Result<(), Error> {
        if gate.closed || gate.sealed {
            return Err(Error::Closed);
        }
        if let Self::Flush(generation, sequence) = self {
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
                    | Self::Mission(_)
                    | Self::Plan(_)
                    | Self::PlanSnapshot(_)
                    | Self::PlanningInventory
                    | Self::PlanningInventorySnapshot
                    | Self::Attention
            )
        {
            return Err(Error::Busy);
        }
        Ok(())
    }
}

impl Bridge {
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
                    if serde_json::to_vec(&data).map_err(|_| Error::Invalid)?.len() > MAX_REQUEST {
                        return Err(Error::Invalid);
                    }
                    let e: Envelope = exact(data)?;
                    if e.version != 1 || e.window != selected {
                        return Err(Error::Identity);
                    }
                    let mut command = command(name, e.args)?;
                    let mut gate = state.lock().expect("bridge gate poisoned");
                    if let Command::Flush(_, sequence) = &mut command {
                        *sequence = gate.save_sequence;
                    }
                    command.admit(&gate)?;
                    if matches!(command, Command::Today) {
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
        Self {
            root,
            channel,
            window,
            gate,
            _notice: notice,
        }
    }

    /// The channel for exactly this window's AppOptions or isolated EngineConfig.
    /// Do not attach it to a second engine or reload it after disposal.
    pub fn channel(&self) -> HostChannel {
        self.channel.clone()
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
        })
    }

    /// Recheck the exact sealed proof before stopping this engine.
    pub fn sealed(&self, receipt: FlushReceipt) -> bool {
        let gate = self.gate.lock().expect("bridge gate poisoned");
        !gate.closed
            && gate.sealed
            && gate.generation == receipt.generation
            && gate.save_sequence == receipt.save_sequence
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

    /// Stop the engine first. Await this receiver before replacement or exit,
    /// including partial-load failure. Does not stop or resume agents.
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
        let command = Command::PlanningInventorySnapshot;
        let mut gate = Gate {
            flushing: true,
            ..Gate::default()
        };
        assert_eq!(command.admit(&gate), Ok(()));
        gate.closed = true;
        assert_eq!(command.admit(&gate), Err(Error::Closed));
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
        let ack = Command::Flush(1, 7);
        assert_eq!(ack.admit(&gate), Ok(()));
        gate.save_sequence += 1; // Another form save was enqueued behind this ACK.
        assert_eq!(ack.admit(&gate), Err(Error::Stale));
        assert_eq!(Command::Flush(1, 8).admit(&gate), Ok(()));
    }
}
