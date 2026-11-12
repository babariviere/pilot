//! JSON calls run on the same serialized worker as native feed requests.
use super::{Error, Journal, NativeHost, Shared, Transport, Work};
use crate::{
    attention_host as ah,
    bridge::{Command, Gate},
    model::*,
    plan_host,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, atomic::Ordering};

pub(super) struct Call {
    pub window: String,
    pub command: Command,
    pub gate: Arc<Mutex<Gate>>,
    pub host: NativeHost,
    pub reply: Box<dyn FnOnce(Result<Value, Error>) + Send>,
}
fn encode(value: impl Serialize) -> Result<Value, Error> {
    serde_json::to_value(value).map_err(|_| Error::Invalid)
}
fn today(host: &NativeHost) -> Today {
    let mut today = host.snapshot();
    let missions = today
        .moving
        .iter()
        .chain(&today.not_moving)
        .chain(&today.unreported)
        .map(|m| (m.id.clone(), m.title.clone()))
        .collect::<Vec<_>>();
    let view = ah::project(
        host.attention_snapshot().as_ref(),
        &host.attention_operations(),
        &host.attention_drafts(),
        &missions,
        &ah::Local::default(),
    );
    today.decisions = view.decisions;
    today.actions = view.actions;
    today.attention = view.attention;
    today
}
fn planning(host: &NativeHost, mission: &str) -> Result<Value, Error> {
    let read = host.planning(mission).ok_or(Error::Stale)?;
    encode(plan_host::page(
        &read,
        &host.planning_operations(mission),
        &plan_host::Local::default(),
    ))
}
fn planning_request(
    host: &NativeHost,
    mission: &str,
    build: impl FnOnce(&Value) -> Result<(String, Value), plan_host::Refusal>,
) -> Result<Work, Error> {
    let read = host.planning(mission).ok_or(Error::Stale)?;
    let (digest, request) = build(&read).map_err(|_| Error::Stale)?;
    Ok(Work::WriteInterview {
        mission: mission.into(),
        digest,
        request,
    })
}
fn attention_read(host: &NativeHost) -> Result<Value, Error> {
    let read = host.attention_snapshot().ok_or(Error::Stale)?;
    if read["current"] != true {
        return Err(Error::Stale);
    }
    Ok(read)
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &std::sync::Arc<Shared>,
    updates: &mut super::updates::State,
    day: Option<&super::ritual::DaySource>,
    epoch: u64,
    call: Call,
) {
    let result = run(t, journal, shared, updates, day, epoch, &call).await;
    // Ritual progress is local, as on the native feed: its refusals stay
    // with the ritual and never mark the service read or controls failed.
    if !call.command.is_ritual()
        && let Err(error @ (Error::Identity | Error::Offline | Error::Storage)) = result
    {
        // A bad item stays isolated; losing the source or journal invalidates
        // source-wide authority just as it does for native feed requests.
        super::fail(shared, error);
    }
    (call.reply)(result);
}
/// Ritual calls share the native feed's rules: reads sample the root's clock
/// and write nothing, a visit or save needs the exact context and revision,
/// and an uncertain write is Unknown, never resent. The reply carries the
/// root's last confirmed ritual view.
async fn ritual(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    day: Option<&super::ritual::DaySource>,
    epoch: u64,
    call: &Call,
) -> Result<Value, Error> {
    use super::ritual::Work as R;
    let work = match &call.command {
        Command::RitualSnapshot | Command::RitualResults => None,
        Command::RitualRead => Some(R::Read),
        Command::RitualVisit(v) => Some(R::Visit(v.clone())),
        Command::RitualSave(w) => Some(R::Write(w.clone())),
        _ => return Err(Error::Invalid),
    };
    let outcome = match work {
        Some(work) => Some(super::ritual::handle(
            &t.source, day, journal, shared, work,
        )?),
        None if matches!(call.command, Command::RitualResults) => {
            Some(super::ritual::read_results(t, day, journal, shared, epoch).await?)
        }
        None => None,
    };
    let view = encode(call.host.ritual_snapshot())?;
    Ok(json!({"snapshot":view,"outcome":outcome.map(encode).transpose()?}))
}
async fn run(
    t: &Transport,
    journal: &mut Journal,
    shared: &std::sync::Arc<Shared>,
    updates: &mut super::updates::State,
    day: Option<&super::ritual::DaySource>,
    epoch: u64,
    call: &Call,
) -> Result<Value, Error> {
    call.command
        .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
    shared.open()?;
    if matches!(
        call.command,
        Command::Projects | Command::ChatSelect(_) | Command::ChatCreate(_) | Command::ChatCheck(_)
    ) {
        return super::new_chat::handle(t, journal, shared, epoch, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::IntakeRead
            | Command::LinearRead
            | Command::IntakeWrite(_)
            | Command::IntakeCheck(_)
    ) {
        return super::intake::handle(t, journal, shared, epoch, &call.command, &call.gate).await;
    }
    if call.command.is_ritual() {
        return ritual(t, journal, shared, day, epoch, call).await;
    }
    if matches!(
        call.command,
        Command::DeliveryRead(_)
            | Command::DeliverySaved
            | Command::DeliveryWrite(_)
            | Command::DeliveryCheck(_)
    ) {
        return super::delivery::handle(t, journal, shared, &call.command, &call.gate).await;
    }
    if let Command::PlanSource(request) = &call.command {
        let snapshot = super::plan_sources::read(t, request).await?;
        shared.current(epoch)?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    use super::updates::Command as U;
    let update = match &call.command {
        Command::UpdateRead => Some(U::Read),
        Command::UpdatePrepare(r) => Some(U::Prepare(r.clone(), call.window.clone())),
        Command::UpdateConfirm(r) => Some(U::Confirm(r.clone(), call.window.clone())),
        Command::UpdateCancel(r) => Some(U::Cancel(r.clone())),
        Command::UpdateCheck => Some(U::Check),
        Command::UpdateRestored(r) => Some(U::Restored(r.clone())),
        _ => None,
    };
    if let Some(command) = update {
        let outcome = super::updates::handle(t, journal, shared, updates, command).await?;
        if let Command::UpdateConfirm(r) = &call.command {
            let wake = {
                let mut gate = call.gate.lock().expect("bridge gate poisoned");
                gate.update_requested = Some(r.confirmation.clone());
                gate.update_app = updates
                    .snapshot()
                    .run
                    .as_ref()
                    .is_some_and(|r| r.kind == crate::update::UpdateKind::App);
                gate.flush_wakeup.clone()
            };
            if let Some(wake) = wake {
                wake();
            }
        }
        if matches!(&call.command, Command::UpdateRestored(_)) {
            let wake = call
                .gate
                .lock()
                .expect("bridge gate poisoned")
                .flush_wakeup
                .clone();
            if let Some(wake) = wake {
                wake();
            }
        }
        return Ok(json!({"snapshot":encode(updates.snapshot())?,"outcome":encode(outcome)?}));
    }
    let host = &call.host;
    let mut value = Value::Null;
    let mut enrollment = None;
    let work = match &call.command {
        Command::DeliveryRead(_)
        | Command::DeliverySaved
        | Command::DeliveryWrite(_)
        | Command::DeliveryCheck(_) => {
            unreachable!("handled delivery command")
        }
        Command::Projects
        | Command::ChatSelect(_)
        | Command::ChatCreate(_)
        | Command::ChatCheck(_) => {
            unreachable!("handled standalone chat command")
        }
        Command::IntakeRead
        | Command::LinearRead
        | Command::IntakeWrite(_)
        | Command::IntakeCheck(_) => {
            unreachable!("handled intake command")
        }
        Command::Today | Command::PlanSnapshot(_) | Command::PlanningInventorySnapshot => None,
        Command::PlanSource(_) => unreachable!("handled passive source read"),
        Command::Mission(id) => Some(Work::Detail(id.clone())),
        Command::Pause(r) => Some(Work::Control {
            mission: r.mission_id.clone(),
            revision: r.revision,
            action: crate::contract::ControlAction::Pause,
            pause: None,
        }),
        Command::Resume(r) => Some(Work::Control {
            mission: r.mission_id.clone(),
            revision: r.revision,
            action: crate::contract::ControlAction::Resume,
            pause: Some(r.pause_operation_id.clone()),
        }),
        Command::ControlCheck(id) => Some(Work::Check(id.clone())),
        Command::Plan(id) => Some(Work::ReadPlanning(id.clone())),
        Command::PlanningInventory => Some(Work::PlanningInventory),
        Command::Prepare => Some(Work::PreparePlanning),
        Command::Create(r) => Some(Work::EnrollPlanning(r.clone())),
        Command::Save { mission, intent } => Some(planning_request(host, mission, |read| {
            plan_host::save_request(read, intent)
        })?),
        Command::Submit { mission, intent } => Some(planning_request(host, mission, |read| {
            plan_host::submit_request(read, intent)
        })?),
        Command::StartWork { mission, shown } => Some(planning_request(host, mission, |read| {
            plan_host::start_request(read, shown)
        })?),
        Command::CheckWork(mission) => {
            let id = host
                .planning_operations(mission)
                .iter()
                .find(|r| r["kind"] == "plan-start")
                .and_then(|r| r["operationId"].as_str())
                .ok_or(Error::Unknown)?
                .to_owned();
            Some(Work::CheckPlanning(id))
        }
        Command::PlanCheck { mission, interview } => {
            let read = host.planning(mission).ok_or(Error::Stale)?;
            if plan_host::interview_id(&read).as_deref() != Some(interview) {
                return Err(Error::Stale);
            }
            let id = plan_host::unsettled_operation(&host.planning_operations(mission))
                .ok_or(Error::Unknown)?;
            Some(Work::CheckPlanning(id))
        }
        Command::CheckNew => {
            let record = host
                .planning_enrollments()
                .into_iter()
                .find(|r| matches!(r["state"].as_str(), Some("pending" | "unknown")))
                .ok_or(Error::Unknown)?;
            let id = record["operationId"]
                .as_str()
                .ok_or(Error::Unknown)?
                .to_owned();
            enrollment = Some(id.clone());
            Some(Work::CheckPlanning(id))
        }
        Command::Attention => {
            shared.attention_wanted.store(true, Ordering::SeqCst);
            Some(Work::AttentionRead)
        }
        Command::Reply(r) => {
            let read = attention_read(host)?;
            let view = today(host);
            let decision = view
                .decisions
                .iter()
                .find(|d| d.id == r.decision_id && d.revision == r.revision)
                .ok_or(Error::Stale)?;
            if decision.delivery != Delivery::Idle || decision.kind == DecisionKind::Unknown {
                return Err(Error::Unknown);
            }
            let picks: Vec<String> = r.option_id.iter().chain(&r.option_ids).cloned().collect();
            let request = ah::answer_request(&read, &r.decision_id, &picks, &r.text)
                .map_err(|_| Error::Invalid)?;
            Some(Work::AttentionSend(request))
        }
        Command::Action { action, ask, text } => {
            let read = attention_read(host)?;
            let ops = host.attention_operations();
            if ah::pending_action(&ops, &action.action_id).is_some() {
                return Err(Error::Unknown);
            }
            let request = ah::action_request(&read, &action.action_id, action.revision, *ask, text)
                .map_err(|_| Error::Stale)?;
            Some(Work::AttentionSend(request))
        }
        Command::AttentionCheck { id, action } => {
            let ops = host.attention_operations();
            let op = if *action {
                ah::pending_action(&ops, id)
            } else {
                ah::pending_answer(&ops, id)
            }
            .ok_or(Error::Unknown)?;
            Some(Work::AttentionCheck(
                op["id"].as_str().ok_or(Error::Unknown)?.into(),
            ))
        }
        Command::Draft(r) => {
            let read = attention_read(host)?;
            let key = ah::draft_key(&read, &r.item_id, r.revision).map_err(|_| Error::Stale)?;
            // A question keeps a Later saved before; only a sent answer clears it.
            let before = host.attention_draft(&key);
            let value = ah::draft_value(&ah::draft_from(&key, r, before.as_ref()));
            if serde_json::to_vec(&value)
                .map_err(|_| Error::Invalid)?
                .len()
                > ah::DRAFT_LIMIT
            {
                return Err(Error::Invalid);
            }
            Some(Work::AttentionDraft(key, value))
        }
        Command::Flush(generation, sequence, view) => {
            // FIFO barrier after the consumer awaited every form save. This
            // never proves native preedit capture or that every form registered.
            if call
                .gate
                .lock()
                .expect("bridge gate poisoned")
                .require_saved_view
                && view.is_none()
            {
                return Err(Error::Busy);
            }
            if let Some(view) = view {
                super::updates::validate_view(view)?;
                let record = super::window::SavedWindow {
                    kind: "window-capture".into(),
                    version: 1,
                    source: t.source.clone(),
                    window: call.window.clone(),
                    generation: *generation,
                    save_sequence: *sequence,
                    view: serde_json::to_value(view).map_err(|_| Error::Invalid)?,
                };
                journal.save_window(record.clone())?;
                *shared
                    .saved_window
                    .lock()
                    .expect("native saved window poisoned") = Some(record);
            }
            updates.save_capture(journal, &call.window, view.as_ref())?;
            journal.finish()?;
            let mut gate = call.gate.lock().expect("bridge gate poisoned");
            call.command.admit(&gate)?;
            gate.forms_saved = true;
            value = json!({"generation":generation});
            None
        }
        Command::UpdateRead
        | Command::UpdatePrepare(_)
        | Command::UpdateConfirm(_)
        | Command::UpdateCancel(_)
        | Command::UpdateCheck
        | Command::UpdateRestored(_) => unreachable!("handled update command"),
        Command::RitualRead
        | Command::RitualSnapshot
        | Command::RitualResults
        | Command::RitualVisit(_)
        | Command::RitualSave(_) => unreachable!("handled ritual command"),
    };
    let outcome = if let Some(work) = work {
        Some(super::handle(t, journal, shared, epoch, work).await?)
    } else {
        None
    };
    // Returned views are projections only, never raw home/profile/operation envelopes.
    match &call.command {
        Command::Today
        | Command::Attention
        | Command::Reply(_)
        | Command::Action { .. }
        | Command::AttentionCheck { .. }
        | Command::Draft(_) => value = encode(today(host))?,
        Command::Mission(id) => value = encode(host.mission(id))?,
        Command::Plan(id) | Command::PlanSnapshot(id) => value = planning(host, id)?,
        Command::Save { mission: id, .. }
        | Command::Submit { mission: id, .. }
        | Command::StartWork { mission: id, .. }
        | Command::CheckWork(id) => {
            // Losing a newer read cannot erase an entered write's exact outcome.
            value = planning(host, id).unwrap_or(Value::Null);
        }
        Command::Prepare => value = encode(host.planning_setup())?,
        Command::PlanningInventory | Command::PlanningInventorySnapshot => {
            value = encode(host.planning_inventory_snapshot())?
        }
        Command::PlanCheck { mission, .. } => {
            value = planning(host, mission).unwrap_or(Value::Null)
        }
        Command::Create(_) | Command::CheckNew => {
            let record = host
                .planning_enrollments()
                .into_iter()
                .find(|r| match &call.command {
                    Command::Create(intent) => r["setupDigest"] == intent.setup,
                    Command::CheckNew => enrollment
                        .as_ref()
                        .is_some_and(|id| r["operationId"] == *id),
                    _ => false,
                });
            // An older selected page is never the result of another creation.
            if let Some(mission) = record
                .as_ref()
                .filter(|r| r["state"] == "accepted")
                .and_then(|r| r["missionId"].as_str())
            {
                // Create already read its mission after the ACK. CheckNew
                // must select the receipt's mission, not its enrollment ID.
                // A confirmed receipt survives a failed passive refresh.
                if matches!(&call.command, Command::CheckNew) {
                    let current = shared.epoch.load(Ordering::SeqCst);
                    let _ = super::read_planning(t, shared, current, mission).await;
                }
                value = json!({"missionId":mission,"page":planning(host, mission).ok()});
            }
        }
        _ => {}
    }
    Ok(json!({"snapshot":value,"outcome":outcome.map(encode).transpose()?}))
}
