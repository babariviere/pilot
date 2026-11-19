//! JSON calls run on the same serialized worker as native feed requests,
//! except reads of cached projections (`cached`), which only read memory.
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
    /// The bridge method that asked, such as `day.delivery.read`: named in a failed read's log line.
    pub name: &'static str,
    pub gate: Arc<Mutex<Gate>>,
    pub host: NativeHost,
    pub reply: Box<dyn FnOnce(Result<Value, Error>) + Send>,
}
fn encode(value: impl Serialize) -> Result<Value, Error> {
    serde_json::to_value(value).map_err(|_| Error::Invalid)
}
fn today(host: &NativeHost) -> Today {
    // The project first, then the Desk: see `Shared::shown_project`.
    let project = host
        .0
        .shared
        .shown_project
        .lock()
        .expect("native shown project poisoned")
        .clone();
    let mut today = host.snapshot();
    today.project = project;
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
/// The open planning chat of `mission` as read, or null when it is not open.
fn plan_chat(host: &NativeHost, mission: &str) -> Result<Value, Error> {
    encode(
        host.planning_chat(mission)
            .map(|v| crate::plan_activity::chat(&v)),
    )
}
/// The open chat `session` as read, or null when it is not open.
fn session_chat(host: &NativeHost, session: &str) -> Value {
    host.session_chat(session).unwrap_or(Value::Null)
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
/// The read an answer, an action or a draft is built from. Each names its exact question or action
/// (event, content and authority digests, or revision and digest), checked again before it is sent,
/// so an older read still qualifies. Only the question or action must be up to date, not the mission.
fn answer_read(host: &NativeHost) -> Result<Value, Error> {
    host.attention_snapshot().ok_or(Error::Stale)
}

/// Answers a read of the root's cached projections without the worker:
/// Today, the opened planning page and the planning list. They read only
/// shared memory, so a slow service read must not hold them back. A page
/// whose read is older than the latest change says so (`fresh` is false)
/// while the worker still reads. `None` for every other command.
pub(super) fn cached(
    host: &NativeHost,
    command: &Command,
    gate: &Mutex<Gate>,
) -> Option<Result<Value, Error>> {
    if !matches!(
        command,
        Command::Today
            | Command::PlanSnapshot(_)
            | Command::PlanningInventorySnapshot
            | Command::PlanChatSnapshot(_)
            | Command::PlanLeave { .. }
            | Command::Log { .. }
            | Command::ChatSnapshot(_)
            | Command::ChatClose(_)
            | Command::PowerRead
            | Command::ScreenTake
            | Command::ScreenPicture(_)
    ) {
        return None;
    }
    let read = || {
        command.admit(&gate.lock().expect("bridge gate poisoned"))?;
        host.0.shared.open()?;
        let value = match command {
            Command::Today => encode(today(host))?,
            Command::PlanSnapshot(id) => planning(host, id)?,
            Command::PlanChatSnapshot(id) => plan_chat(host, id)?,
            Command::ChatSnapshot(id) => session_chat(host, id),
            Command::ScreenTake | Command::ScreenPicture(_) => {
                super::screen::cached(&host.0.shared, command)
            }
            Command::PowerRead => host
                .0
                .shared
                .power
                .lock()
                .expect("native power poisoned")
                .clone(),
            // Local only: the chat is no longer read or kept.
            Command::ChatClose(id) => {
                host.close_session_chat(id);
                Value::Null
            }
            Command::Log { event, message } => {
                // Local only: one line in Day's log, from the window's code. The message itself may
                // name a draft, so only a fixed cause for unsaved forms is kept.
                crate::day_log::event(
                    event,
                    json!({"message": message, "cause": crate::day_log::unsaved_cause(message)}),
                );
                Value::Null
            }
            // Local only: closes the chat, or stops reading the page on notices.
            Command::PlanLeave { mission, chat_only } => {
                if !*chat_only {
                    host.leave_planning(mission);
                } else if host.planning_chat(mission).is_some() {
                    host.close_planning_chat();
                }
                Value::Null
            }
            _ => encode(host.planning_inventory_snapshot())?,
        };
        Ok(json!({"snapshot":value,"outcome":null}))
    };
    Some(read())
}

pub(super) async fn handle(
    root: &Transport,
    t: &Transport,
    journal: &mut Journal,
    shared: &std::sync::Arc<Shared>,
    updates: &mut super::updates::State,
    day: Option<&super::ritual::DaySource>,
    epoch: u64,
    call: Call,
) {
    let sent = journal.sent_writes();
    let mut result = run(root, t, journal, shared, updates, day, epoch, &call).await;
    // A mission notice raises the read fence while agents work. A write refused only because the
    // fence moved runs again under the new one: Rust rebuilds it from the newest read, checks the
    // exact target again and journals a new operation. A refusal with the fence unchanged is a
    // real change and stays refused. A try that saved a write which may have gone out is
    // never run again, and neither is Unknown.
    let mut epoch = epoch;
    let mut attempt = 1;
    while matches!(result, Err(Error::Stale))
        && resends_when_read_moves(&call.command)
        && journal.sent_writes() == sent
    {
        let now = shared.epoch.load(Ordering::SeqCst);
        let Some(wait) = retry_after(now, epoch, attempt) else {
            break;
        };
        tokio::time::sleep(wait).await;
        attempt += 1;
        epoch = shared.epoch.load(Ordering::SeqCst);
        result = run(root, t, journal, shared, updates, day, epoch, &call).await;
    }
    // Ritual progress is local, as on the native feed: its refusals stay
    // with the ritual and never mark the service read or controls failed.
    if !call.command.is_ritual()
        && let Err(error @ (Error::Identity | Error::Offline | Error::Storage)) = result
    {
        // A bad item stays isolated; losing the source or journal invalidates
        // source-wide authority just as it does for native feed requests.
        super::fail(shared, error, call.name);
    }
    (call.reply)(result);
}

/// Writes on one exact target that Rust checks again on every try, which the read fence
/// can refuse. Answers and action reports (host/attention.rs) and every planning write,
/// Start, Revisit and plan revisions included (host.rs, plan_host::rebind), try again
/// inside their own send, so they are not run again here.
fn resends_when_read_moves(command: &Command) -> bool {
    matches!(
        command,
        Command::ThreadsWrite(_)
            | Command::Pause(_)
            | Command::Resume(_)
            | Command::StopReplanning(_)
            | Command::Lifecycle(..)
            | Command::Rename(_)
    )
}

/// The pause before running a refused write again, or None: the read fence did not move
/// (the target itself changed), or 3 tries are used. Three tries cover the notices of about a
/// second of agent work, and the user waits at most about 1 s more before Pilot says so.
fn retry_after(now: u64, shown: u64, attempt: u32) -> Option<std::time::Duration> {
    (now != shown && attempt < 3)
        .then(|| std::time::Duration::from_millis(250 * u64::from(attempt)))
}

pub(super) async fn search_read(
    root: Transport,
    shared: std::sync::Arc<Shared>,
    call: Call,
    cancel: tokio::sync::oneshot::Receiver<()>,
) {
    let read = async {
        let Command::Search(request) = &call.command else {
            return Err(Error::Invalid);
        };
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        shared.open()?;
        let snapshot = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            super::search::read(&root, request),
        )
        .await
        .map_err(|_| Error::Unavailable)??;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        Ok(json!({"snapshot":snapshot,"outcome":null}))
    };
    let result = tokio::select! {
        biased;
        _ = cancel => Err(Error::Stale),
        result = read => result,
    };
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
/// `root` is the window's own selection: saved window, updates, ritual and the
/// project scope. `t` is the project the window acts on (the root, or a
/// global window's focused project) for everything else.
#[allow(clippy::too_many_arguments)]
async fn run(
    root: &Transport,
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
    if let Command::ScopedAttention(request) = &call.command {
        let snapshot = super::attention::scoped_attention::handle(
            root,
            journal,
            shared,
            epoch,
            request,
            || {
                call.command
                    .admit(&call.gate.lock().expect("bridge gate poisoned"))
            },
        )
        .await?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if matches!(call.command, Command::NavigationProject) {
        return Ok(
            json!({"snapshot":t.source.project.as_ref().map(|p| &p.project_id),"outcome":null}),
        );
    }
    if let Command::NavigationRestore(id) = &call.command {
        let restored = match id {
            Some(id) => Some(
                super::search::project(root, id)
                    .await?
                    .source
                    .project()?
                    .clone(),
            ),
            None if root.source.project.is_none() => None,
            None => return Err(Error::Invalid),
        };
        let gate = call.gate.lock().expect("bridge gate poisoned");
        call.command.admit(&gate)?;
        shared.open()?;
        *shared.focus.lock().expect("native focus poisoned") = restored;
        return Ok(json!({"snapshot":null,"outcome":null}));
    }
    if let Command::Migration(request) = &call.command {
        let snapshot =
            super::migration::handle(t, journal, shared, epoch, request, &call.gate).await?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if let Command::TodayScope(request) = &call.command {
        let snapshot = super::today_scope::read(root, journal, shared, request, &call.gate).await?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    let search = match &call.command {
        Command::SearchOutput { project, request } => {
            let project = super::search::project(root, project).await?;
            Some(super::artifacts::source(&project, request).await?)
        }
        Command::SearchKnowledge {
            project,
            id,
            revision,
        } => {
            let project = super::search::project(root, project).await?;
            let request = super::knowledge::Read::Detail {
                id: id.clone(),
                revision: Some(*revision),
            };
            Some(super::knowledge::read(&project, &request, journal).await?)
        }
        _ => None,
    };
    if let Some(snapshot) = search {
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    // A direct result action carries its exact subject. A receipt lookup
    // carries only its operation ID and can use only the saved subject.
    // Never change the window's focus to make a scoped action work.
    let delivery_project = match &call.command {
        Command::DeliveryRead(subject) => Some(subject.project()),
        Command::DeliveryOpen(r) => Some(r.subject.project()),
        Command::DeliveryWrite(r) => Some(r.subject.project()),
        Command::DeliveryArtifact(r) => Some(r.subject.project()),
        Command::DeliveryWork(r) => Some(r.subject.project()),
        Command::ResultReview(r) => Some(r.subject.project()),
        Command::ResultReviewCheck(id) => journal
            .result_reviews
            .get(id)
            .map(|r| r.request.subject.project()),
        Command::DeliveryCheck(id) => journal
            .planning
            .get(id)
            .and_then(|r| r.source.project.as_ref())
            .map(|p| p.project_id.as_str()),
        _ => None,
    };
    let scoped = match delivery_project {
        Some(id) if t.source.project.as_ref().is_none_or(|p| p.project_id != id) => {
            Some(super::search::project(root, id).await?)
        }
        _ => None,
    };
    let t = scoped.as_ref().unwrap_or(t);
    if matches!(call.command, Command::WindowRead) {
        // One passive capture from this exact source, not an update receipt or
        // authority to replay anything. Recheck the selected home/project first.
        let saved = call.host.saved_window();
        if let Some(saved) = &saved {
            if saved.source != root.source {
                return Err(Error::Identity);
            }
            saved.validate()?;
            // A global window has no project to check, only the profile.
            if root.source.project.is_none() {
                root.profile_gate().await?;
            } else {
                root.gate(false).await?;
            }
        }
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":saved.map(|s| s.view),"outcome":null}));
    }
    if matches!(
        call.command,
        Command::ProjectSetupRead
            | Command::ProjectPreview { .. }
            | Command::ProjectAction(_)
            | Command::ProjectCheck(_)
    ) {
        return super::projects::handle(root, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::Projects
            | Command::ChatSelect(_)
            | Command::ChatCreate(_)
            | Command::ChatCheck(_)
            | Command::ChatContinue(_)
            | Command::ChatRecover(_)
            | Command::ChatHandoff(_)
            | Command::ChatDismiss(_)
            | Command::ChatReply { .. }
    ) {
        return super::new_chat::handle(t, journal, shared, epoch, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::IntakeRead
            | Command::LinearRead
            | Command::LinearManage(_)
            | Command::IntakeWrite(_)
            | Command::IntakeCheck(_)
    ) {
        return super::intake::handle(t, journal, shared, epoch, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::PreferencesRead
            | Command::PreferencesSave(_)
            | Command::PreferencesCheck(_)
            | Command::PreferencesHistory(_)
    ) {
        return super::preferences::handle(t, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(call.command, Command::PowerResume) {
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return super::power::resume(t, shared).await;
    }
    if matches!(
        call.command,
        Command::SlackRead(_)
            | Command::SlackWrite(_)
            | Command::SlackCheck(_)
            | Command::SlackSetAside(_)
    ) {
        return super::slack_controls::handle(t, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::ConnectionsRead
            | Command::ConnectionsWrite(_)
            | Command::ConnectionsCheck(_)
            | Command::ConnectionsProbe
    ) {
        return super::connection_controls::handle(t, journal, shared, &call.command, &call.gate)
            .await;
    }
    if matches!(
        call.command,
        Command::SchedulesRead(_) | Command::SchedulesWrite(_) | Command::SchedulesCheck(_)
    ) {
        return super::schedules::handle(root, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::DiagnosisRead | Command::DiagnosisWrite(_) | Command::DiagnosisCheck(_)
    ) {
        return super::diagnosis::handle(root, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::ModelsRead
            | Command::ModelsRecovery(_)
            | Command::ModelsWrite(_)
            | Command::ModelsCheck(_)
            | Command::ModelsSignIn(_)
    ) {
        return super::model_controls::handle(t, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::FeedbackImage(_)
            | Command::FeedbackRead(_)
            | Command::FeedbackSend(_)
            | Command::FeedbackCheck(_)
            | Command::FeedbackStep(_)
    ) {
        return super::feedback::handle(t, journal, shared, &call.command, &call.gate).await;
    }
    if matches!(
        call.command,
        Command::ScreenBind(_) | Command::ScreenUnbind | Command::ScreenAnswer { .. }
    ) {
        // The window's own selection: a binding names this window, not a focused project.
        return super::screen::handle(root, shared, &call.command, &call.gate, &call.window).await;
    }
    if matches!(
        call.command,
        Command::ThreadsRead(_)
            | Command::ThreadsHistory(_)
            | Command::ThreadsWrite(_)
            | Command::ThreadsCheck(_)
    ) {
        return super::threads::handle(t, journal, shared, &call.command, &call.gate).await;
    }
    if call.command.is_ritual() {
        return ritual(root, journal, shared, day, epoch, call).await;
    }
    if let Command::DeliveryArtifact(request) = &call.command {
        let snapshot = super::delivery_artifact::read(t, request).await?;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if let Command::ArtifactsRead(request) = &call.command {
        let snapshot = super::artifacts::list(t, request).await?;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if let Command::DeliveryWork(request) = &call.command {
        let snapshot = super::delivery_work::read(t, request).await?;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if matches!(call.command, Command::ResultReviewId) {
        return Ok(
            json!({"snapshot":{"operationId":uuid::Uuid::new_v4().to_string()},"outcome":null}),
        );
    }
    if matches!(
        call.command,
        Command::ResultReview(_) | Command::ResultReviewCheck(_)
    ) {
        let snapshot = match &call.command {
            Command::ResultReview(r) => {
                super::result_review::handle(t, journal, shared, r, &call.gate).await?
            }
            Command::ResultReviewCheck(id) => super::result_review::check(t, journal, id).await?,
            _ => unreachable!(),
        };
        shared.open()?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if let Command::ArtifactSource(request) = &call.command {
        let snapshot = super::artifacts::source(t, request).await?;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if matches!(
        call.command,
        Command::DeliveryRead(_)
            | Command::DeliveryList(_)
            | Command::DeliverySaved
            | Command::DeliveryOpen(_)
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
    if matches!(
        call.command,
        Command::KnowledgeRead(_) | Command::KnowledgeSave(_) | Command::KnowledgeCheck(_)
    ) {
        let snapshot = match &call.command {
            Command::KnowledgeRead(r) => super::knowledge::read(t, r, journal).await?,
            Command::KnowledgeSave(r) => super::knowledge::save(t, journal, r, &call.gate).await?,
            Command::KnowledgeCheck(id) => super::knowledge::check(t, journal, id).await?,
            _ => unreachable!(),
        };
        if matches!(call.command, Command::KnowledgeRead(_)) {
            shared.current(epoch)?;
        }
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    if let Command::PlanChat { mission, older } = &call.command {
        // Passive. A failed read keeps what shows; the chat says why.
        let _ = super::planning_chat::read(t, shared, mission, *older).await;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":plan_chat(&call.host, mission)?,"outcome":null}));
    }
    if let Command::ChatRead { session, older } = &call.command {
        // Passive. A failed read keeps what shows; the chat says why.
        let _ = super::session_chat::read(t, shared, session, *older).await;
        if let Some(chat) = shared
            .session_chat
            .lock()
            .expect("native session chat poisoned")
            .as_mut()
            .filter(|c| c.session == *session && c.reason.is_empty())
        {
            chat.pending_recovery = super::new_chat::pending_recovery(t, journal, session);
        }
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":session_chat(&call.host, session),"outcome":null}));
    }
    if let Command::ChatLiveChanges { session, workspace } = &call.command {
        let snapshot = super::session_chat::live_changes(root, shared, session, workspace).await?;
        shared.open()?;
        call.command
            .admit(&call.gate.lock().expect("bridge gate poisoned"))?;
        return Ok(json!({"snapshot":snapshot,"outcome":null}));
    }
    use super::updates::Command as U;
    if let Command::UpdateForceConfirm(request) = &call.command {
        if !super::valid_id(&request.id) {
            return Err(Error::Invalid);
        }
        // This legacy selector cannot produce a native accepted-loss close.
        // Refuse before capture, pause, cancellation or journal mutation.
        return Err(Error::Unavailable);
    }
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
        let outcome = super::updates::handle(root, journal, shared, updates, command).await?;
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
        Command::KnowledgeRead(_) | Command::KnowledgeSave(_) | Command::KnowledgeCheck(_) => {
            unreachable!("handled library command")
        }
        Command::TodayScope(_) => unreachable!("handled scoped Today read"),
        Command::Search(_) | Command::SearchOutput { .. } | Command::SearchKnowledge { .. } => {
            unreachable!("handled search read")
        }
        Command::NavigationProject | Command::NavigationRestore(_) => {
            unreachable!("handled project navigation")
        }
        Command::ScopedAttention(_) => unreachable!("handled exact cross-project attention"),
        Command::LinearPublisher(_) => unreachable!("handled on the publisher lane"),
        Command::DeliveryArtifact(_) => unreachable!("handled captured artifact read"),
        Command::DeliveryWork(_) => unreachable!("handled agent work read"),
        Command::ResultReview(_) | Command::ResultReviewCheck(_) | Command::ResultReviewId => {
            unreachable!("handled private review")
        }
        Command::ArtifactsRead(_) | Command::ArtifactSource(_) => {
            unreachable!("handled artifact read")
        }
        Command::DeliveryRead(_)
        | Command::DeliveryList(_)
        | Command::DeliverySaved
        | Command::DeliveryOpen(_)
        | Command::DeliveryWrite(_)
        | Command::DeliveryCheck(_) => {
            unreachable!("handled delivery command")
        }
        Command::ProjectSetupRead
        | Command::ProjectPreview { .. }
        | Command::ProjectAction(_)
        | Command::ProjectCheck(_) => unreachable!("handled project setup"),
        Command::Projects
        | Command::ChatSelect(_)
        | Command::ChatCreate(_)
        | Command::ChatCheck(_)
        | Command::ChatContinue(_)
        | Command::ChatRecover(_)
        | Command::ChatHandoff(_)
        | Command::ChatDismiss(_)
        | Command::ChatReply { .. } => {
            unreachable!("handled standalone chat command")
        }
        Command::IntakeRead
        | Command::LinearRead
        | Command::LinearManage(_)
        | Command::IntakeWrite(_)
        | Command::IntakeCheck(_) => {
            unreachable!("handled intake command")
        }
        Command::PreferencesRead
        | Command::PreferencesSave(_)
        | Command::PreferencesCheck(_)
        | Command::PreferencesHistory(_) => {
            unreachable!("handled preferences command")
        }
        Command::ModelsRead
        | Command::ModelsRecovery(_)
        | Command::ModelsWrite(_)
        | Command::ModelsCheck(_)
        | Command::ModelsSignIn(_) => unreachable!("handled model controls"),
        Command::FeedbackImage(_)
        | Command::FeedbackRead(_)
        | Command::FeedbackSend(_)
        | Command::FeedbackCheck(_)
        | Command::FeedbackStep(_) => unreachable!("handled feedback command"),
        Command::ScreenBind(_)
        | Command::ScreenUnbind
        | Command::ScreenTake
        | Command::ScreenAnswer { .. }
        | Command::ScreenPicture(_) => unreachable!("handled screen agent command"),
        Command::ThreadsRead(_)
        | Command::ThreadsHistory(_)
        | Command::ThreadsWrite(_)
        | Command::ThreadsCheck(_) => {
            unreachable!("handled mission thread command")
        }
        Command::Today | Command::PlanSnapshot(_) | Command::PlanningInventorySnapshot => None,
        Command::Migration(_) => unreachable!("handled migration command"),
        Command::PlanChat { .. }
        | Command::PlanChatSnapshot(_)
        | Command::PlanLeave { .. }
        | Command::Log { .. } => {
            unreachable!("handled planning chat command")
        }
        Command::ChatRead { .. }
        | Command::ChatLiveChanges { .. }
        | Command::ChatSnapshot(_)
        | Command::ChatClose(_) => {
            unreachable!("handled read-only chat command")
        }
        Command::WindowRead => unreachable!("handled saved window read"),
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
        Command::StopReplanning(r) => Some(Work::StopReplanning {
            mission: r.mission_id.clone(),
            successor: r.successor_id.clone(),
        }),
        Command::Lifecycle(r, action) => Some(Work::Lifecycle {
            mission: r.mission_id.clone(),
            action: *action,
            check: r.check,
        }),
        Command::Rename(r) => Some(Work::Rename {
            mission: r.mission_id.clone(),
            title: r.title.clone(),
            check: r.check,
        }),
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
        Command::Continue(intent) => Some(planning_request(host, &intent.mission_id, |read| {
            plan_host::continue_request(read, intent)
        })?),
        Command::AskQuestion(intent) => Some(planning_request(host, &intent.mission_id, |read| {
            plan_host::ask_request(read, intent)
        })?),
        Command::DropEarlierAnswers(mission) => Some(planning_request(host, mission, |read| {
            plan_host::drop_earlier_request(read, mission)
        })?),
        Command::RepairStart(mission) => Some(planning_request(host, mission, |read| {
            plan_host::repair_start_request(read, mission)
        })?),
        Command::RepairApply(intent) => Some(planning_request(host, &intent.mission_id, |read| {
            plan_host::repair_apply_request(read, intent)
        })?),
        Command::Revisit(mission) => Some(planning_request(host, mission, |read| {
            crate::plan_revision_host::request(read, mission)
        })?),
        Command::ConfirmRevision(intent) => {
            Some(planning_request(host, &intent.mission_id, |read| {
                crate::plan_revision_host::confirm(read, intent)
            })?)
        }
        Command::PauseRevision(intent) => {
            Some(planning_request(host, &intent.mission_id, |read| {
                crate::plan_revision_host::pause(read, intent)
            })?)
        }
        Command::ResumeRevision(intent) => {
            Some(planning_request(host, &intent.mission_id, |read| {
                crate::plan_revision_host::resume(read, intent)
            })?)
        }
        Command::CheckRevision(r) => {
            let id = host
                .planning_operations(&r.mission_id)
                .iter()
                .find(|o| {
                    matches!(
                        o["kind"].as_str(),
                        Some(
                            "plan-revisit"
                                | "revision-preview"
                                | "revision-confirm"
                                | "revision-pause"
                                | "revision-resume"
                        )
                    ) && matches!(o["state"].as_str(), Some("pending" | "unknown"))
                        && (r.revision_id.is_empty() || o["proposalId"] == r.revision_id)
                })
                .and_then(|o| o["operationId"].as_str())
                .ok_or(Error::Unknown)?
                .to_owned();
            Some(Work::CheckPlanning(id))
        }
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
        Command::CheckNew(operation) => {
            let record = host
                .planning_enrollments()
                .into_iter()
                .find(|r| {
                    matches!(r["state"].as_str(), Some("pending" | "unknown"))
                        && operation.as_ref().is_none_or(|id| r["operationId"] == *id)
                })
                .ok_or(Error::Unknown)?;
            let id = record["operationId"]
                .as_str()
                .ok_or(Error::Unknown)?
                .to_owned();
            enrollment = Some(id.clone());
            Some(Work::CheckPlanning(id))
        }
        Command::DismissNew => Some(Work::DismissNew),
        Command::Refresh => Some(Work::Refresh),
        Command::Attention => {
            shared.attention_wanted.store(true, Ordering::SeqCst);
            Some(Work::AttentionRead)
        }
        Command::Reply(r) => {
            let read = answer_read(host)?;
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
        Command::Ask(r) => {
            // A clarification names the question's exact content, as an answer does, so the read
            // need not be the newest. It keeps the question open; only an answer closes it.
            let read = answer_read(host)?;
            let view = today(host);
            let decision = view
                .decisions
                .iter()
                .find(|d| d.id == r.decision_id && d.revision == r.revision)
                .ok_or(Error::Stale)?;
            if !decision.can_clarify {
                return Err(Error::Unavailable);
            }
            if decision.answers.iter().any(|a| a.state == AnswerState::Unknown) {
                return Err(Error::Unknown);
            }
            let request = ah::help_request(&read, &r.decision_id, &r.question).map_err(|_| Error::Invalid)?;
            Some(Work::AttentionSend(request))
        }
        Command::Action { action, ask, text } => {
            // As an answer: the request names the action's exact revision and digest, checked again
            // before it is sent, so the read need not be the newest.
            let read = answer_read(host)?;
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
                // A decision's answer, else one of its clarifications named by its own operation.
                ah::pending_answer(&ops, id).or_else(|| {
                    ops.iter()
                        .find(|op| op["id"] == *id && op["state"] == "unknown" && op["request"]["clarification"] == true)
                })
            }
            .ok_or(Error::Unknown)?;
            Some(Work::AttentionCheck(
                op["id"].as_str().ok_or(Error::Unknown)?.into(),
            ))
        }
        Command::Draft(r) => {
            // A draft is saved on this Mac only, under its question's exact content digest or its
            // action's revision and digest, so an older read still names the right place. Requiring
            // a current read refused drafts while agents worked, and a close then could not save them.
            let read = answer_read(host)?;
            let key = ah::draft_key(&read, &r.item_id, r.revision).map_err(|_| Error::Stale)?;
            // A question keeps a Later saved before; only a sent answer clears it.
            let before = host.attention_draft(&key);
            let value = ah::draft_value(&ah::draft_from(&key, r, before.as_ref()));
            if serde_json::to_vec(&value)
                .map_err(|_| Error::Invalid)?
                .len()
                > ah::draft_limit(&read, &r.item_id)
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
                    source: root.source.clone(),
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
        Command::ConnectionsRead
        | Command::ConnectionsWrite(_)
        | Command::ConnectionsCheck(_)
        | Command::ConnectionsProbe => unreachable!("handled connection command"),
        Command::PowerRead | Command::PowerResume => unreachable!("handled power command"),
        Command::SlackRead(_)
        | Command::SlackWrite(_)
        | Command::SlackCheck(_)
        | Command::SlackSetAside(_) => {
            unreachable!("handled Slack command")
        }
        Command::SchedulesRead(_) | Command::SchedulesWrite(_) | Command::SchedulesCheck(_) => {
            unreachable!("handled schedule command")
        }
        Command::DiagnosisRead | Command::DiagnosisWrite(_) | Command::DiagnosisCheck(_) => {
            unreachable!("handled diagnosis command")
        }
        Command::UpdateRead
        | Command::UpdatePrepare(_)
        | Command::UpdateConfirm(_)
        | Command::UpdateForceConfirm(_)
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
        | Command::Refresh
        | Command::Attention
        | Command::Reply(_)
        | Command::Ask(_)
        | Command::Action { .. }
        | Command::AttentionCheck { .. }
        | Command::Draft(_) => value = encode(today(host))?,
        Command::Mission(id) => value = encode(host.mission(id))?,
        Command::Plan(id) | Command::PlanSnapshot(id) => value = planning(host, id)?,
        Command::Save { mission: id, .. }
        | Command::Submit { mission: id, .. }
        | Command::StartWork { mission: id, .. }
        | Command::Continue(crate::plan::ContinueIntent { mission_id: id, .. })
        | Command::AskQuestion(crate::plan::QuestionAskIntent { mission_id: id, .. })
        | Command::DropEarlierAnswers(id)
        | Command::RepairStart(id)
        | Command::RepairApply(crate::plan::RepairApplyIntent { mission_id: id, .. })
        | Command::Revisit(id)
        | Command::ConfirmRevision(crate::plan::ConfirmRevisionIntent { mission_id: id, .. })
        | Command::PauseRevision(crate::plan::ConfirmRevisionIntent { mission_id: id, .. })
        | Command::ResumeRevision(crate::plan::ResumeRevisionIntent { mission_id: id, .. })
        | Command::CheckRevision(crate::plan::RevisionRef { mission_id: id, .. })
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
        Command::Create(_) | Command::CheckNew(_) => {
            let record = host
                .planning_enrollments()
                .into_iter()
                .find(|r| match &call.command {
                    Command::Create(intent) => r["setupDigest"] == intent.setup,
                    Command::CheckNew(_) => enrollment
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
                if matches!(&call.command, Command::CheckNew(_)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_runs_again_only_when_the_read_fence_moved_and_at_most_three_times() {
        // A notice moved the fence: try again, a little later each time.
        assert_eq!(
            retry_after(4, 3, 1),
            Some(std::time::Duration::from_millis(250))
        );
        assert_eq!(
            retry_after(5, 4, 2),
            Some(std::time::Duration::from_millis(500))
        );
        // The third try was the last.
        assert_eq!(retry_after(6, 5, 3), None);
        // Same fence: the target itself changed, so it stays refused.
        assert_eq!(retry_after(3, 3, 1), None);
        // Start tries again inside its own planning write (plan_host::rebind), not here.
        assert!(!resends_when_read_moves(&Command::StartWork {
            mission: "m".into(),
            shown: Value::Null
        }));
        // An answer tries again inside its own send, so its tries stay 3 in all.
        assert!(!resends_when_read_moves(&Command::Reply(
            ReplyIntent::default()
        )));
    }
}
