//! Native approval owns proposal continuation; ordinary updater state stays separate.
use super::*;
use gpui_kit::TestSupportExt;
use gpui_kit::component::{ActiveTheme, Sizable};
use pilot_desktop_updater::coordinated::Receipt;
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};
pub(crate) type ChatProposalGuard = std::rc::Rc<dyn Fn(&mut Window, &mut gpui_kit::App) -> bool>;

#[derive(Default)]
pub(super) struct State {
    options: Option<crate::LocalOptions>,
    update: Option<Value>,
    checked: bool,
    busy: bool,
    task: Option<Task<()>>,
    evidence: Option<Receipt>,
    armed: bool,
    startup_attempted: bool,
    request_daemon: bool,
    handoff: bool,
    local_ready: bool,
    error: Option<&'static str>,
    #[cfg(any(test, feature = "native-probes"))]
    probe_actions: Option<Vec<Value>>,
    pending_refresh: bool,
    startup_proposal_id: Option<String>,
    chat_connected: bool,
    blockers: Vec<&'static str>,
    mutation_unknown: bool,
    unconfirmed_at: Option<ProposalKey>,
}
impl State {
    fn active(&self) -> bool {
        self.update.as_ref().is_some_and(|u| {
            u["resumePending"] == true
                || !matches!(
                    u["phase"].as_str(),
                    Some("proposed" | "completed" | "cancelled")
                )
        })
    }
}
enum Job {
    Refresh(bool),
    Accept(Value),
    Arm(Value, Box<Receipt>),
    Startup(Option<PathBuf>),
    Complete(Value),
    Cancel(Value),
    Resume(Value),
}
enum Done {
    Snapshot(Option<Value>, bool),
    Accepted(Value),
    Armed(Value, Receipt),
    Waiting(Value, Receipt, Vec<&'static str>),
    Daemon(Value),
    Completed(Value),
}

/// Render-time identity. Old controls never retarget a replacement proposal.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ProposalKey {
    id: String,
    phase: String,
    session_id: String,
}
impl ProposalKey {
    fn from_update(update: &Value) -> Option<Self> {
        let id = update["id"].as_str().filter(|v| !v.is_empty())?;
        let phase = update["phase"].as_str().filter(|v| !v.is_empty())?;
        let session_id = update["sessionId"].as_str().filter(|v| !v.is_empty())?;
        Some(Self {
            id: id.into(),
            phase: phase.into(),
            session_id: session_id.into(),
        })
    }
}
#[derive(Clone, Copy)]
enum ProposalAction {
    Accept,
    Cancel,
    Continue,
    Resume,
}
fn chat_phase_label(phase: &str) -> &'static str {
    match phase {
        "proposed" => "Update proposed",
        "draining" => "Preparing update",
        "gui-installing" => "Restarting app",
        "gui-ready" => "App restarted",
        "daemon-installing" => "Restarting daemon",
        "resuming" => "Resuming chats",
        _ => "Update status unconfirmed",
    }
}
fn blocker_categories(progress: &Value) -> Vec<&'static str> {
    let mut categories = Vec::new();
    if let Some(blockers) = progress["blockers"].as_array() {
        for blocker in blockers.iter().take(256) {
            let category = match blocker["kind"].as_str() {
                Some("active-work" | "tool") => "Active tools",
                Some("job") => "Jobs",
                Some("terminal" | "terminal-admission") => "Terminals",
                Some("child-process" | "unknown-process") => "Unconfirmed processes",
                Some("automation") => "Automations",
                Some("transfer" | "mutation") => "Transfers and changes",
                _ => "Other unconfirmed work",
            };
            if !categories.contains(&category) {
                categories.push(category);
            }
        }
        if blockers.len() > 256 && !categories.contains(&"Other unconfirmed work") {
            categories.push("Other unconfirmed work");
        }
    }
    categories
}
#[derive(Debug, PartialEq)]
enum Continuation {
    RecordGui,
    ArmDaemon,
    CompleteOnly,
}
fn continuation(update: &Value, id: &str, target: &Value) -> Result<Continuation, &'static str> {
    if update["id"] != id
        || update["source"] != target["source"]
        || update["build"] != target["guiBuild"]
        || update["target"] != *target
    {
        return Err("The proposal and signed GUI continuation differ. Agents remain frozen.");
    }
    match update["phase"].as_str() {
        Some("gui-installing") => Ok(Continuation::RecordGui),
        Some("gui-ready") => Ok(Continuation::ArmDaemon),
        Some("daemon-installing") => Ok(Continuation::CompleteOnly),
        _ => Err("The proposal does not authorize this GUI continuation."),
    }
}

fn request(
    options: &crate::LocalOptions,
    action: Option<&str>,
    body: Option<Value>,
) -> Result<Value, &'static str> {
    // Every operation reattests the exact configured Local identity before using capability.
    options.clone().verify_running()?;
    let token = options.model_scope_capability()?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Update connection failed.")?;
    let url = format!(
        "{}/api/runtime-update{}",
        options.loopback(),
        action.map(|a| format!("/{a}")).unwrap_or_default()
    );
    let mut response = match body {
        Some(body) => client
            .post(url)
            .header("x-pilot-github-capability", token)
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&body).map_err(|_| "Update request is malformed.")?)
            .send(),
        None => client
            .get(url)
            .header("x-pilot-github-capability", token)
            .send(),
    }
    .map_err(|_| "Update response is unconfirmed. Refresh to inspect retained state.")?;
    if action.is_none() && response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(json!({"update":null}));
    }
    if !response.status().is_success() {
        return Err("The coordinated update could not advance. Refresh to inspect retained state.");
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(32769)
        .read_to_end(&mut bytes)
        .map_err(|_| "Update response is unreadable.")?;
    if bytes.len() > 32768 {
        return Err("Update response exceeds its bound.");
    }
    serde_json::from_slice(&bytes).map_err(|_| "Update response is malformed.")
}
fn transition(
    options: &crate::LocalOptions,
    update: &Value,
    action: &str,
    extra: Option<(&str, Value)>,
) -> Result<Value, &'static str> {
    let mut body = json!({"id":update["id"],"phase":update["phase"]});
    if let Some((key, value)) = extra {
        body[key] = value;
    }
    request(options, Some(action), Some(body))
}
fn perform(options: &crate::LocalOptions, job: Job) -> Result<Done, &'static str> {
    match job {
        Job::Refresh(startup) => {
            let v = request(options, None, None)?;
            Ok(Done::Snapshot(
                (!v["update"].is_null()).then(|| v["update"].clone()),
                startup,
            ))
        }
        Job::Accept(u) => Ok(Done::Accepted(transition(options, &u, "accept", None)?)),
        Job::Cancel(u) => Ok(Done::Completed(transition(options, &u, "cancel", None)?)),
        Job::Complete(u) => Ok(Done::Completed(transition(options, &u, "complete", None)?)),
        Job::Resume(u) => {
            let progress = transition(options, &u, "progress", None)?;
            Ok(Done::Completed(progress["update"].clone()))
        }
        Job::Arm(u, evidence) => {
            let evidence = *evidence;
            let progress = transition(options, &u, "progress", None)?;
            let update = &progress["update"];
            if progress["ready"] != true {
                return Ok(Done::Waiting(
                    update.clone(),
                    evidence,
                    blocker_categories(&progress),
                ));
            }
            let target = serde_json::to_value(&evidence.target)
                .map_err(|_| "Target evidence is malformed.")?;
            Ok(Done::Armed(
                transition(options, update, "arm-gui", Some(("target", target)))?,
                evidence,
            ))
        }
        Job::Startup(path) => {
            let u = request(options, None, None)?["update"].clone();
            if !matches!(
                u["phase"].as_str(),
                Some("gui-installing" | "gui-ready" | "daemon-installing")
            ) {
                return Err("The proposal does not authorize this GUI continuation.");
            }
            let trust = pilot_desktop_updater::helper::compiled_trust()
                .map_err(|_| "Updater trust is unavailable.")?;
            let installed = pilot_desktop_updater::layout::running_root()
                .map_err(|_| "Running app cannot be located.")?;
            #[cfg(target_os = "macos")]
            let path = match path {
                Some(path) => path,
                None => pilot_desktop_updater::coordinated::discover(
                    &installed,
                    &trust,
                    u["id"].as_str().ok_or("Proposal identity is missing.")?,
                )
                .map_err(|_| "Coordinated startup evidence is ambiguous or invalid.")?
                .ok_or("Coordinated startup evidence is unavailable. Agents remain frozen.")?,
            };
            #[cfg(not(target_os = "macos"))]
            let path = path.ok_or("Coordinated recovery is unavailable on this platform.")?;
            let receipt = pilot_desktop_updater::coordinated::startup(&path, &installed, &trust)
                .map_err(|_| "The exact signed GUI continuation could not be verified.")?
                .ok_or("Coordinated continuation evidence is missing.")?;
            let target = serde_json::to_value(&receipt.target)
                .map_err(|_| "Target evidence is malformed.")?;
            let next = continuation(&u, &receipt.id, &target)?;
            // Retained daemon intent is complete-only, never a lifecycle retry.
            // Completion still requires this exact signed GUI continuation above.
            if next == Continuation::CompleteOnly {
                return Ok(Done::Completed(transition(options, &u, "complete", None)?));
            }
            if next == Continuation::ArmDaemon {
                return Ok(Done::Daemon(transition(options, &u, "arm-daemon", None)?));
            }
            let mut identity = target;
            identity["boot"] = json!(uuid::Uuid::new_v4().to_string());
            let ready = transition(options, &u, "gui-ready", Some(("receipt", identity)))?;
            Ok(Done::Daemon(transition(
                options,
                &ready,
                "arm-daemon",
                None,
            )?))
        }
    }
}

impl Updates {
    fn coordinated_native_available(&self) -> bool {
        #[cfg(any(test, feature = "native-probes"))]
        if self.coordinated.probe_actions.is_some() {
            return true;
        }
        self.coordinated.options.is_some()
    }
    fn coordinated_stageable(&self) -> bool {
        #[cfg(any(test, feature = "native-probes"))]
        if self.coordinated.probe_actions.is_some() && self.controller.is_none() {
            return true;
        }
        can_stage(self.state())
    }
    fn coordinated_chat_snapshot(&self, session_id: &str) -> Option<(ProposalKey, Value)> {
        if session_id.is_empty() {
            return None;
        }
        let update = self.coordinated.update.as_ref()?;
        let key = ProposalKey::from_update(update)?;
        if key.session_id != session_id
            || matches!(key.phase.as_str(), "completed" | "cancelled")
                && update["resumePending"] != true
        {
            return None;
        }
        Some((key, update.clone()))
    }
    fn coordinated_action_update(
        &self,
        key: &ProposalKey,
        action: ProposalAction,
    ) -> Option<Value> {
        if self.coordinated.busy
            || self.coordinated.mutation_unknown
            || !self.coordinated_native_available()
        {
            return None;
        }
        let update = self.coordinated.update.as_ref()?;
        if ProposalKey::from_update(update).as_ref() != Some(key) {
            return None;
        }
        let allowed = match action {
            ProposalAction::Accept => {
                key.phase == "proposed"
                    && !self.fenced
                    && !self.choosing
                    && self.coordinated_stageable()
            }
            ProposalAction::Cancel => matches!(key.phase.as_str(), "proposed" | "draining"),
            ProposalAction::Continue => {
                key.phase == "draining"
                    && self.coordinated.evidence.as_ref().is_some_and(|receipt| {
                        receipt.id == key.id
                            && update["source"] == receipt.target.source
                            && update["build"] == receipt.target.gui_build
                    })
            }
            ProposalAction::Resume => {
                matches!(key.phase.as_str(), "completed" | "cancelled")
                    && update["resumePending"] == true
            }
        };
        allowed.then(|| update.clone())
    }
    fn activate_coordinated(
        &mut self,
        key: &ProposalKey,
        action: ProposalAction,
        cx: &mut Context<Self>,
    ) {
        let Some(update) = self.coordinated_action_update(key, action) else {
            return;
        };
        let job = match action {
            ProposalAction::Accept => Job::Accept(update),
            ProposalAction::Cancel => Job::Cancel(update),
            ProposalAction::Continue => {
                let Some(evidence) = self.coordinated.evidence.clone() else {
                    return;
                };
                Job::Arm(update, Box::new(evidence))
            }
            ProposalAction::Resume => Job::Resume(update),
        };
        self.run_coordinated(job, cx);
    }
    fn coordinated_chat_action_update(
        &self,
        key: &ProposalKey,
        action: ProposalAction,
    ) -> Option<Value> {
        self.coordinated
            .chat_connected
            .then(|| self.coordinated_action_update(key, action))
            .flatten()
    }
    fn activate_chat_coordinated(
        &mut self,
        key: &ProposalKey,
        action: ProposalAction,
        cx: &mut Context<Self>,
    ) {
        if self.coordinated_chat_action_update(key, action).is_some() {
            self.activate_coordinated(key, action, cx);
        }
    }
    /// Caller supplies observed connection state; rendering never probes Local.
    pub(crate) fn coordinated_chat_connection(&mut self, connected: bool, cx: &mut Context<Self>) {
        if self.coordinated.chat_connected != connected {
            self.coordinated.chat_connected = connected;
            cx.notify();
        }
    }

    /// The proposing chat only. Presentation shares the Settings owner and native gates.
    pub(crate) fn coordinated_chat_card(
        &self,
        session_id: &str,
        guard: ChatProposalGuard,
        cx: &mut Context<Self>,
    ) -> Option<gpui_kit::AnyElement> {
        let (key, update) = self.coordinated_chat_snapshot(session_id)?;
        let header = chat_phase_label(&key.phase);
        let mut card = ui::surface(ui::Surface::Card, cx)
            .id(format!("chat-update:{}", key.id))
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .p(gpui_kit::px(crate::appearance::Space::SIDEBAR))
            .gap(gpui_kit::px(crate::appearance::Space::META))
            .rounded(gpui_kit::px(crate::appearance::Radius::CARD))
            .border_1()
            .border_color(cx.theme().border)
            .child(
                ui::text(Text::Label, header)
                    .font_medium()
                    .id(format!("chat-update-status:{}", key.id))
                    .aria_label(header)
                    .test_support(),
            )
            .child(
                ui::text(
                    Text::Caption,
                    format!("Build {}", update["build"].as_str().unwrap_or("unknown")),
                )
                .min_w_0()
                .truncate(),
            )
            // Bound long proposals without scrolling away their decision controls.
            .child(
                div()
                    .id(format!("chat-update-summary:{}", key.id))
                    .test_support()
                    .min_w_0()
                    .max_h(gpui_kit::px(96.))
                    .overflow_y_scroll()
                    .child(ui::text(
                        Text::Body,
                        update["summary"]
                            .as_str()
                            .unwrap_or("Pilot project update")
                            .to_owned(),
                    )),
            );
        let mut actions = action_row();
        if key.phase == "proposed" {
            let accept = key.clone();
            let dismiss = key.clone();
            let accept_guard = guard.clone();
            let dismiss_guard = guard.clone();
            actions = actions
                .child(
                    ui::action(
                        format!("chat-update-accept:{}", key.id),
                        "Accept update",
                        Action::Primary,
                    )
                    .with_size(gpui_kit::component::Size::Medium)
                    .disabled(
                        self.coordinated_chat_action_update(&key, ProposalAction::Accept)
                            .is_none(),
                    )
                    .on_click(cx.listener(move |owner, _, window, cx| {
                        if accept_guard(window, cx) {
                            owner.activate_chat_coordinated(&accept, ProposalAction::Accept, cx);
                        }
                    })),
                )
                .child(
                    ui::action(
                        format!("chat-update-dismiss:{}", key.id),
                        "Dismiss",
                        Action::Secondary,
                    )
                    .with_size(gpui_kit::component::Size::Medium)
                    .disabled(
                        self.coordinated_chat_action_update(&key, ProposalAction::Cancel)
                            .is_none(),
                    )
                    .on_click(cx.listener(move |owner, _, window, cx| {
                        if dismiss_guard(window, cx) {
                            owner.activate_chat_coordinated(&dismiss, ProposalAction::Cancel, cx);
                        }
                    })),
                );
            card=card.child(ui::text(Text::Caption,"Accept pauses all chats and tools, waits for jobs and terminals, then updates the app and daemon."));
        } else if key.phase == "draining" {
            card=card.child(ui::text(Text::Caption,"New work is paused. Active tools, jobs and terminals must settle before continuing."));
            if self.coordinated.evidence.is_some() {
                let continued = key.clone();
                let continue_guard = guard.clone();
                actions = actions.child(
                    ui::action(
                        format!("chat-update-continue:{}", key.id),
                        "Continue update",
                        Action::Primary,
                    )
                    .with_size(gpui_kit::component::Size::Medium)
                    .disabled(
                        self.coordinated_chat_action_update(&key, ProposalAction::Continue)
                            .is_none(),
                    )
                    .on_click(cx.listener(move |owner, _, window, cx| {
                        if continue_guard(window, cx) {
                            owner.activate_chat_coordinated(
                                &continued,
                                ProposalAction::Continue,
                                cx,
                            );
                        }
                    })),
                );
            }
        } else {
            card=card.child(ui::text(Text::Caption,"New work remains paused until both exact builds are verified. Inspect Updates in Settings if this is unconfirmed."));
        }
        if !self.coordinated.blockers.is_empty() {
            card = card.child(ui::text(
                Text::Caption,
                format!("Waiting for: {}", self.coordinated.blockers.join(", ")),
            ));
        }
        if self.coordinated.busy {
            card = card.child(
                ui::text(Text::Caption, "Working…")
                    .id(format!("chat-update-busy:{}", key.id))
                    .aria_label("Working…")
                    .test_support(),
            );
        }
        if !self.coordinated.chat_connected {
            card = card.child(ui::text(
                Text::Caption,
                "Disconnected. Reconnect before acting on this update.",
            ));
        }
        if let Some(error) = self.coordinated.error {
            card = card.child(
                div()
                    .id(format!("chat-update-error:{}", key.id))
                    .aria_label(error)
                    .test_support()
                    .child(Notice::new(error).tone(Tone::Warning)),
            );
        }
        Some(card.child(actions).into_any_element())
    }

    /// Hidden fixture state only; records effects after the real callback/identity gate.
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn probe_coordinated_snapshot(&mut self, snapshot: Option<Value>, busy: bool) {
        self.coordinated.probe_actions.get_or_insert_with(Vec::new);
        self.coordinated.update = snapshot;
        self.coordinated.busy = busy;
        self.coordinated.chat_connected = true;
        self.coordinated.error = None;
        self.coordinated.evidence = None;
        self.coordinated.blockers.clear();
        self.coordinated.mutation_unknown = false;
        self.coordinated.unconfirmed_at = None;
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn probe_coordinated_blocked(&mut self) {
        self.coordinated.blockers = vec!["Jobs", "Terminals"];
        let Some(update) = self.coordinated.update.as_ref() else {
            return;
        };
        self.coordinated.evidence=serde_json::from_value(json!({"schema":1,"id":update["id"],
            "target":{"source":update["source"],"guiBuild":update["build"],"build":{},"runtimeRoot":"/synthetic/runtime"},
            "transaction":"/synthetic/transaction","installed":"/synthetic/app","configuration":"synthetic"})).ok();
        self.coordinated.error =
            Some("Jobs, tools or terminals still block this update. Continue after they settle.");
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn probe_coordinated_actions(&self) -> &[Value] {
        self.coordinated
            .probe_actions
            .as_deref()
            .unwrap_or_default()
    }

    /// Stream/reconnect/chat-open discovery. Coalesced, GET-only, never a lifecycle retry.
    pub(crate) fn coordinated_invalidated(&mut self, cx: &mut Context<Self>) {
        if self.coordinated.busy {
            self.coordinated.pending_refresh = true;
            return;
        }
        self.coordinated.pending_refresh = false;
        self.run_coordinated(Job::Refresh(false), cx);
    }
    fn coordinated_mutation_failed(&mut self, before: Option<ProposalKey>, error: &'static str) {
        self.coordinated.mutation_unknown = true;
        self.coordinated.unconfirmed_at = before;
        self.coordinated.error = Some(error);
        self.coordinated.startup_attempted = true;
    }
    fn coordinated_snapshot(&mut self, update: Option<Value>, startup: bool) {
        if self.coordinated.mutation_unknown
            && let (Some(before), Some(after)) = (
                self.coordinated.unconfirmed_at.as_ref(),
                update.as_ref().and_then(ProposalKey::from_update),
            )
            && (before.id != after.id || before.phase != after.phase)
            && matches!(
                after.phase.as_str(),
                "proposed"
                    | "draining"
                    | "gui-installing"
                    | "gui-ready"
                    | "daemon-installing"
                    | "resuming"
                    | "completed"
                    | "cancelled"
            )
        {
            // A recognized durable change reconciles the old request. Never replay it.
            self.coordinated.mutation_unknown = false;
            self.coordinated.unconfirmed_at = None;
            self.coordinated.error = None;
        }
        if startup {
            self.coordinated.startup_proposal_id = update
                .as_ref()
                .and_then(|u| u["id"].as_str())
                .map(str::to_owned);
        }
        self.coordinated.update = update;
        self.coordinated.checked = true;
    }
    fn drain_coordinated_refresh(&mut self, cx: &mut Context<Self>) {
        if self.coordinated.pending_refresh && !self.coordinated.busy {
            self.coordinated_invalidated(cx);
        }
    }
    #[cfg(test)]
    pub(crate) fn probe_coordinated_finished(&mut self, cx: &mut Context<Self>) {
        self.coordinated.busy = false;
        self.drain_coordinated_refresh(cx);
        cx.notify();
    }

    pub(crate) fn coordinated_loaded(&mut self, cx: &mut Context<Self>) {
        self.coordinated.local_ready = true;
        self.advance_coordinated(cx);
    }
    pub(crate) fn configure_coordinated(
        &mut self,
        options: Option<crate::LocalOptions>,
        cx: &mut Context<Self>,
    ) {
        // No local proposal authority for external connections or non-macOS builds.
        if !cfg!(target_os = "macos") || self.location.is_none() {
            self.coordinated.checked = true;
            return;
        }
        self.coordinated.options = options;
        if self.coordinated.options.is_some() {
            self.run_coordinated(Job::Refresh(true), cx);
        } else {
            self.coordinated.checked = true;
        }
    }
    fn run_coordinated(&mut self, job: Job, cx: &mut Context<Self>) {
        if self.coordinated.busy
            || self.coordinated.mutation_unknown && !matches!(&job, Job::Refresh(_))
        {
            return;
        }
        #[cfg(any(test, feature = "native-probes"))]
        if let Some(actions) = self.coordinated.probe_actions.as_mut() {
            let (action, update) = match &job {
                Job::Accept(u) => ("accept", Some(u)),
                Job::Cancel(u) => ("cancel", Some(u)),
                Job::Arm(u, _) => ("arm-gui", Some(u)),
                Job::Complete(u) => ("complete", Some(u)),
                Job::Resume(u) => ("progress", Some(u)),
                Job::Startup(_) => ("startup", None),
                Job::Refresh(_) => ("refresh", None),
            };
            actions.push(json!({"action":action,"id":update.map(|u|u["id"].clone()),"phase":update.map(|u|u["phase"].clone())}));
            self.coordinated.busy = true;
            cx.notify();
            return;
        }
        let Some(options) = self.coordinated.options.clone() else {
            return;
        };
        let passive = matches!(&job, Job::Refresh(_));
        let before = self
            .coordinated
            .update
            .as_ref()
            .and_then(ProposalKey::from_update);
        self.coordinated.busy = true;
        if !passive {
            self.coordinated.error = None;
        }
        let (tx, rx) = async_channel::bounded(1);
        if std::thread::Builder::new()
            .name("coordinated-update".into())
            .spawn(move || {
                let _ = tx.send_blocking(perform(&options, job));
            })
            .is_err()
        {
            self.coordinated.busy = false;
            if passive {
                self.coordinated
                    .error
                    .get_or_insert("Update worker could not start.");
            } else {
                self.coordinated.error = Some("Update worker could not start.");
            }
            return;
        }
        self.coordinated.task=Some(cx.spawn(async move|owner,cx|{
            let result=rx.recv().await.unwrap_or(Err("Update outcome is unconfirmed. Inspect retained state."));
            let _=owner.update(cx,|owner,cx|{
                owner.coordinated.busy=false;
                owner.coordinated.task=None;
                let advance = !matches!(&result,Ok(Done::Snapshot(_,false)));
                match result {
                    Err(error)=>{if passive {owner.coordinated.error.get_or_insert(error);}else{owner.coordinated_mutation_failed(before,error);}},
                    Ok(Done::Snapshot(update,startup))=>{
                        owner.coordinated_snapshot(update,startup);
                    },
                    Ok(Done::Accepted(update))=>{
                        owner.coordinated.blockers.clear();
                        owner.coordinated.update=Some(update.clone());
                        let expected=pilot_desktop_updater::iteration::ExpectedTarget::new(update["source"].as_str().unwrap_or("").into(),update["build"].as_str().unwrap_or("").into());
                        if let (Ok(expected),Some(directory),Some(controller))=(expected,update["directory"].as_str(),owner.controller.as_mut()) {
                            controller.backend_mut().supply_proposal(update["id"].as_str().unwrap_or("").into());
                            if controller.stage_local_expected(directory.into(),Some(expected),owner.epoch.elapsed()).is_ok(){ owner.local_build=true; }
                            else {owner.coordinated.error=Some("Staging could not start. Agents remain frozen; inspect or cancel the proposal.");}
                        } else { owner.coordinated.error=Some("The accepted proposal could not be staged. Agents remain frozen."); }
                    },
                    Ok(Done::Armed(update,evidence))=>{owner.coordinated.blockers.clear();owner.coordinated.update=Some(update);owner.coordinated.evidence=Some(evidence);owner.coordinated.armed=true;cx.emit(Event::Restart);},
                    Ok(Done::Waiting(update,evidence,blockers))=>{owner.coordinated.blockers=blockers;owner.coordinated.update=Some(update);owner.coordinated.evidence=Some(evidence);owner.coordinated.error=Some("Jobs, tools or terminals still block this update. Continue after they settle.");},
                    Ok(Done::Daemon(update))=>{owner.coordinated.blockers.clear();owner.coordinated.update=Some(update);owner.coordinated.request_daemon=true;},
                    Ok(Done::Completed(update))=>{owner.coordinated.blockers.clear();owner.coordinated.update=Some(update);owner.coordinated.handoff=false;},
                }
                if advance { owner.advance_coordinated(cx); }
                owner.drain_coordinated_refresh(cx);
                cx.emit(Event::Changed);cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn advance_coordinated(&mut self, cx: &mut Context<Self>) {
        let staged = self
            .controller
            .as_mut()
            .and_then(|c| c.backend_mut().take_proposal());
        if let Some(receipt) = &staged {
            self.coordinated.evidence = Some(receipt.clone());
        }
        if self.coordinated.busy
            || self.coordinated.mutation_unknown
            || self.coordinated.error.is_some()
        {
            return;
        }
        if let Some(update) = self
            .coordinated
            .update
            .clone()
            .filter(|u| u["resumePending"] == true)
        {
            self.run_coordinated(Job::Resume(update), cx);
            return;
        }
        if let Some(receipt) = staged
            && let Some(update) = self.coordinated.update.clone()
        {
            self.run_coordinated(Job::Arm(update, Box::new(receipt)), cx);
            return;
        }
        if self.coordinated.checked
            && self.coordinated.active()
            && self.coordinated.local_ready
            && self.inspected
            && (matches!(self.startup, Some(Ok(())))
                || !self.startup_started
                    && !self.has_startup_recovery()
                    && crate::bundled_runtime::update_receipt().is_none())
            && !self.coordinated.startup_attempted
            && self.coordinated.startup_proposal_id.as_deref()
                == self
                    .coordinated
                    .update
                    .as_ref()
                    .and_then(|u| u["id"].as_str())
            && self.coordinated.startup_proposal_id.is_some()
        {
            self.coordinated.startup_attempted = true;
            self.run_coordinated(Job::Startup(self.startup_receipt.clone()), cx);
        }
    }
    pub(crate) fn coordinated_daemon_ready(&self) -> bool {
        self.coordinated.options.is_none() || self.coordinated.checked && !self.coordinated.active()
    }
    pub(crate) fn coordinated_restart_allowed(&self) -> bool {
        !self.coordinated.active() || self.coordinated.armed
    }
    pub(super) fn coordinated_ready_text(
        &self,
        state: Option<&pilot_desktop_updater::State>,
    ) -> Option<&'static str> {
        (self.coordinated.active() && matches!(state,Some(pilot_desktop_updater::State::ReadyToRestart(_))))
            .then_some("New tool calls are paused. Waiting for jobs and terminals before updating the app and daemon.")
    }
    pub(crate) fn coordinated_manual_daemon_allowed(&self) -> bool {
        !self.coordinated.active() || self.coordinated.handoff
    }
    pub(crate) fn take_coordinated_daemon_request(&mut self) -> Option<Value> {
        if !self.coordinated.request_daemon {
            return None;
        }
        self.coordinated.request_daemon = false;
        self.coordinated.handoff = true;
        let update = self.coordinated.update.as_ref()?;
        Some(
            json!({"id":update["id"],"source":update["target"]["source"],"guiBuild":update["target"]["guiBuild"],"build":update["target"]["build"],"runtimeRoot":update["target"]["runtimeRoot"]}),
        )
    }
    pub(crate) fn coordinated_daemon_finished(&mut self, success: bool, cx: &mut Context<Self>) {
        if !self.coordinated.handoff {
            return;
        }
        self.coordinated.handoff = false;
        if success && let Some(update) = self.coordinated.update.clone() {
            self.run_coordinated(Job::Complete(update), cx);
        } else if !success {
            self.coordinated_mutation_failed(
                self.coordinated
                    .update
                    .as_ref()
                    .and_then(ProposalKey::from_update),
                "Daemon handoff is unconfirmed. Agents remain frozen; inspect retained evidence.",
            );
        }
    }
    pub(super) fn coordinated_panel(
        &self,
        mut view: gpui_kit::Stateful<gpui_kit::Div>,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        if self.coordinated.options.is_none() {
            return view;
        }
        let mut actions = action_row().child(
            ui::action("proposal-refresh", "Refresh", Action::Secondary)
                .disabled(self.coordinated.busy)
                .on_click(cx.listener(|owner, _, _, cx| {
                    owner.run_coordinated(Job::Refresh(false), cx);
                })),
        );
        if let Some(update) = &self.coordinated.update
            && let Some(key) = ProposalKey::from_update(update)
        {
            if update["phase"] == "draining" && self.coordinated.evidence.is_some() {
                let continued = key.clone();
                actions = actions.child(
                    ui::action("proposal-continue", "Continue update", Action::Primary)
                        .disabled(
                            self.coordinated_action_update(&key, ProposalAction::Continue)
                                .is_none(),
                        )
                        .on_click(cx.listener(move |owner, _, _, cx| {
                            owner.activate_coordinated(&continued, ProposalAction::Continue, cx)
                        })),
                );
            }
            if update["resumePending"] == true {
                let resume = key.clone();
                actions = actions.child(
                    ui::action("proposal-resume", "Resume chats", Action::Primary)
                        .disabled(
                            self.coordinated_action_update(&key, ProposalAction::Resume)
                                .is_none(),
                        )
                        .on_click(cx.listener(move |owner, _, _, cx| {
                            owner.activate_coordinated(&resume, ProposalAction::Resume, cx)
                        })),
                );
            }
            view = view
                .child(ui::text(
                    Text::Body,
                    update["summary"]
                        .as_str()
                        .unwrap_or("Pilot project update")
                        .to_owned(),
                ))
                .child(ui::text(
                    Text::Caption,
                    format!(
                        "Build {}. {}",
                        update["build"].as_str().unwrap_or("unknown"),
                        update["phase"].as_str().unwrap_or("unknown")
                    ),
                ));
            if update["phase"] == "proposed" {
                let accept = key.clone();
                actions = actions.child(
                    ui::action("proposal-accept", "Accept update", Action::Primary)
                        .disabled(
                            self.coordinated_action_update(&key, ProposalAction::Accept)
                                .is_none(),
                        )
                        .on_click(cx.listener(move |owner, _, _, cx| {
                            owner.activate_coordinated(&accept, ProposalAction::Accept, cx)
                        })),
                );
                view=view.child(Notice::new("Accept pauses all chats and tools, waits for jobs and terminals, then updates the app and daemon.").tone(Tone::Quiet));
            }
            if matches!(update["phase"].as_str(), Some("proposed" | "draining")) {
                let cancel = key.clone();
                actions = actions.child(
                    ui::action("proposal-cancel", "Cancel proposal", Action::Secondary)
                        .disabled(
                            self.coordinated_action_update(&key, ProposalAction::Cancel)
                                .is_none(),
                        )
                        .on_click(cx.listener(move |owner, _, _, cx| {
                            owner.activate_coordinated(&cancel, ProposalAction::Cancel, cx)
                        })),
                );
            }
        }
        if let Some(error) = self.coordinated.error {
            view = view.child(Notice::new(error).tone(Tone::Warning));
        }
        view.child(actions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_unknown_mutation_requires_changed_verified_snapshot_not_retry() {
        let mut u = Updates::blank(None, false);
        let proposed = chat_update("A", "proposed");
        u.probe_coordinated_snapshot(Some(proposed.clone()), false);
        let key = ProposalKey::from_update(&proposed).unwrap();
        u.coordinated_mutation_failed(Some(key.clone()), "Mutation response is unconfirmed.");
        for action in [
            ProposalAction::Accept,
            ProposalAction::Cancel,
            ProposalAction::Continue,
        ] {
            assert!(u.coordinated_action_update(&key, action).is_none());
        }
        u.coordinated_snapshot(Some(proposed), false);
        assert!(
            u.coordinated.mutation_unknown,
            "unchanged phase is still ambiguous"
        );
        assert_eq!(
            u.coordinated.error,
            Some("Mutation response is unconfirmed.")
        );
        u.coordinated_snapshot(None, false);
        assert!(
            u.coordinated.mutation_unknown,
            "missing evidence is not reconciliation"
        );
        u.coordinated_snapshot(Some(chat_update("A", "unknown")), false);
        assert!(u.coordinated.mutation_unknown);
        u.coordinated_snapshot(Some(chat_update("A", "draining")), false);
        assert!(!u.coordinated.mutation_unknown);
        assert!(
            u.coordinated.startup_attempted,
            "GET must not restart lifecycle recovery"
        );
        assert!(u.coordinated.error.is_none());
        assert!(
            u.probe_coordinated_actions().is_empty(),
            "GET reconciles without replaying the mutation"
        );
        assert!(
            u.coordinated_action_update(&key, ProposalAction::Accept)
                .is_none()
        );
    }
    #[test]
    fn chat_measured_blockers_allow_continue_but_unknown_transport_does_not() {
        let mut u = Updates::blank(None, false);
        let draining = chat_update("A", "draining");
        u.probe_coordinated_snapshot(Some(draining.clone()), false);
        u.probe_coordinated_blocked();
        let key = ProposalKey::from_update(&draining).unwrap();
        assert!(
            u.coordinated_action_update(&key, ProposalAction::Continue)
                .is_some()
        );
        u.coordinated_mutation_failed(Some(key.clone()), "Mutation response is unconfirmed.");
        assert!(
            u.coordinated_action_update(&key, ProposalAction::Continue)
                .is_none()
        );
        u.coordinated_snapshot(Some(draining), false);
        assert!(
            u.coordinated_action_update(&key, ProposalAction::Continue)
                .is_none()
        );
        u.coordinated_snapshot(Some(chat_update("B", "proposed")), false);
        assert!(
            !u.coordinated.mutation_unknown,
            "new durable proposal supersedes the old outcome"
        );
        assert!(
            u.coordinated_action_update(&key, ProposalAction::Continue)
                .is_none(),
            "old controls never retarget B"
        );
    }
    #[test]
    fn chat_progress_copy_reports_phase_not_completed_quiescence() {
        for (phase, label) in [
            ("draining", "Preparing update"),
            ("gui-installing", "Restarting app"),
            ("gui-ready", "App restarted"),
            ("daemon-installing", "Restarting daemon"),
            ("resuming", "Resuming chats"),
            ("unknown", "Update status unconfirmed"),
        ] {
            assert_eq!(chat_phase_label(phase), label);
        }
        let blockers = blocker_categories(
            &json!({"blockers":[{"kind":"job","id":"/private/job"},{"kind":"job"},{"kind":"terminal","sessionId":"private-chat"},{"kind":"new-kind","id":"secret"}]}),
        );
        assert_eq!(
            blockers,
            vec!["Jobs", "Terminals", "Other unconfirmed work"]
        );
        assert!(!blockers.join(", ").contains("private"));
        assert!(blocker_categories(&json!({"blockers":null})).is_empty());
    }
    #[gpui_kit::test]
    fn chat_invalidation_coalesces_during_post_and_preserves_unknown(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        let owner = cx.new(|_| Updates::blank(None, false));
        owner.update(cx, |u, cx| {
            u.probe_coordinated_snapshot(Some(chat_update("A", "proposed")), true);
            u.coordinated.error = Some("Outcome unknown; retained evidence requires inspection.");
            for _ in 0..8 {
                u.coordinated_invalidated(cx);
            }
            assert!(u.coordinated.pending_refresh);
            assert!(u.probe_coordinated_actions().is_empty());
            u.probe_coordinated_finished(cx);
            assert_eq!(
                u.probe_coordinated_actions(),
                &[json!({"action":"refresh","id":null,"phase":null})]
            );
            assert!(!u.coordinated.pending_refresh);
            assert_eq!(
                u.coordinated.error,
                Some("Outcome unknown; retained evidence requires inspection.")
            );
            u.probe_coordinated_finished(cx);
            assert_eq!(
                u.probe_coordinated_actions().len(),
                1,
                "no polling or automatic lifecycle advance"
            );
        });
    }
    fn chat_update(id: &str, phase: &str) -> Value {
        let mut u = update(phase);
        u["id"] = json!(id);
        u["sessionId"] = json!("proposing-chat");
        u["summary"] = json!("A proposed Pilot update");
        u
    }
    #[test]
    fn chat_card_matches_only_nonempty_exact_proposing_session() {
        let mut u = Updates::blank(None, false);
        u.probe_coordinated_snapshot(None, false);
        assert!(u.coordinated_chat_snapshot("proposing-chat").is_none());
        u.probe_coordinated_snapshot(Some(chat_update("A", "proposed")), false);
        assert!(u.coordinated_chat_snapshot("proposing-chat").is_some());
        for session in ["", "other-chat", "PROPOSING-CHAT"] {
            assert!(u.coordinated_chat_snapshot(session).is_none());
        }
        for phase in ["completed", "cancelled"] {
            u.probe_coordinated_snapshot(Some(chat_update("A", phase)), false);
            assert!(u.coordinated_chat_snapshot("proposing-chat").is_none());
        }
    }
    #[test]
    fn chat_actions_recheck_busy_offline_and_exact_render_snapshot() {
        let mut u = Updates::blank(None, false);
        u.probe_coordinated_snapshot(Some(chat_update("A", "proposed")), false);
        let key = ProposalKey::from_update(u.coordinated.update.as_ref().unwrap()).unwrap();
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Accept)
                .is_some()
        );
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Cancel)
                .is_some()
        );
        u.coordinated.busy = true;
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Accept)
                .is_none()
        );
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Cancel)
                .is_none()
        );
        u.coordinated.busy = false;
        u.coordinated.chat_connected = false;
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Accept)
                .is_none()
        );
        assert!(
            u.coordinated_action_update(&key, ProposalAction::Cancel)
                .is_some(),
            "Settings keeps its independent native fallback"
        );
        for (id, phase) in [("B", "proposed"), ("A", "draining")] {
            u.probe_coordinated_snapshot(Some(chat_update(id, phase)), false);
            assert!(
                u.coordinated_chat_action_update(&key, ProposalAction::Accept)
                    .is_none()
            );
            assert!(
                u.coordinated_action_update(&key, ProposalAction::Cancel)
                    .is_none()
            );
        }
        let mut moved = chat_update("A", "proposed");
        moved["sessionId"] = json!("another-chat");
        u.probe_coordinated_snapshot(Some(moved), false);
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Accept)
                .is_none()
        );
    }
    #[test]
    fn chat_unknown_has_no_lifecycle_action_and_continue_requires_exact_evidence() {
        let mut u = Updates::blank(None, false);
        u.probe_coordinated_snapshot(Some(chat_update("A", "unknown")), false);
        let key = ProposalKey::from_update(u.coordinated.update.as_ref().unwrap()).unwrap();
        assert!(u.coordinated_chat_snapshot("proposing-chat").is_some());
        for action in [
            ProposalAction::Accept,
            ProposalAction::Cancel,
            ProposalAction::Continue,
            ProposalAction::Resume,
        ] {
            assert!(u.coordinated_chat_action_update(&key, action).is_none());
        }
        u.probe_coordinated_snapshot(Some(chat_update("A", "draining")), false);
        let key = ProposalKey::from_update(u.coordinated.update.as_ref().unwrap()).unwrap();
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Continue)
                .is_none()
        );
        u.probe_coordinated_blocked();
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Continue)
                .is_some()
        );
        u.coordinated.evidence.as_mut().unwrap().id = "B".into();
        assert!(
            u.coordinated_chat_action_update(&key, ProposalAction::Continue)
                .is_none()
        );
    }
    #[gpui_kit::test]
    fn chat_probe_records_after_real_gate_without_local_authority(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        let owner = cx.new(|_| Updates::blank(None, false));
        owner.update(cx, |u, cx| {
            u.probe_coordinated_snapshot(Some(chat_update("A", "proposed")), false);
            assert!(u.coordinated.options.is_none());
            assert!(u.controller.is_none());
            let key = ProposalKey::from_update(u.coordinated.update.as_ref().unwrap()).unwrap();
            u.activate_chat_coordinated(&key, ProposalAction::Accept, cx);
            assert_eq!(
                u.probe_coordinated_actions(),
                &[json!({"action":"accept","id":"A","phase":"proposed"})]
            );
            u.activate_chat_coordinated(&key, ProposalAction::Cancel, cx);
            assert_eq!(
                u.probe_coordinated_actions().len(),
                1,
                "busy recheck rejects a second effect"
            );
            u.probe_coordinated_snapshot(Some(chat_update("B", "proposed")), false);
            u.activate_chat_coordinated(&key, ProposalAction::Cancel, cx);
            assert_eq!(
                u.probe_coordinated_actions().len(),
                1,
                "stale A never cancels B"
            );
            let b = ProposalKey::from_update(u.coordinated.update.as_ref().unwrap()).unwrap();
            u.activate_chat_coordinated(&b, ProposalAction::Cancel, cx);
            assert_eq!(
                u.probe_coordinated_actions()[1],
                json!({"action":"cancel","id":"B","phase":"proposed"})
            );
        });
    }
    fn target() -> Value {
        json!({"source":"a".repeat(40),"guiBuild":"101.1","build":{"source":"a".repeat(40)},"runtimeRoot":"/immutable/runtime"})
    }
    fn update(phase: &str) -> Value {
        json!({"id":"proposal","phase":phase,"source":"a".repeat(40),"build":"101.1","target":target()})
    }
    #[test]
    fn signed_continuation_exact_target_and_no_unknown_replay() {
        assert_eq!(
            continuation(&update("gui-installing"), "proposal", &target()),
            Ok(Continuation::RecordGui)
        );
        assert_eq!(
            continuation(&update("gui-ready"), "proposal", &target()),
            Ok(Continuation::ArmDaemon)
        );
        assert_eq!(
            continuation(&update("daemon-installing"), "proposal", &target()),
            Ok(Continuation::CompleteOnly)
        );
        for phase in ["proposed", "draining", "unknown", "completed", "cancelled"] {
            assert!(continuation(&update(phase), "proposal", &target()).is_err());
        }
    }
    #[test]
    fn old_or_unrelated_gui_cannot_complete_daemon_intent() {
        let u = update("daemon-installing");
        for field in ["source", "guiBuild", "build", "runtimeRoot"] {
            let mut wrong = target();
            wrong[field] = json!("wrong");
            assert!(continuation(&u, "proposal", &wrong).is_err(), "{field}");
        }
        assert!(continuation(&u, "ordinary-update", &target()).is_err());
    }
    #[test]
    fn startup_ack_alone_never_authorizes_handoff() {
        let mut u = Updates::blank(None, false);
        u.coordinated.options = Some(crate::LocalOptions::synthetic(1));
        u.startup = Some(Ok(()));
        assert!(!u.coordinated_daemon_ready());
        u.coordinated.checked = true;
        for phase in [
            "draining",
            "gui-installing",
            "gui-ready",
            "daemon-installing",
        ] {
            u.coordinated.update = Some(update(phase));
            assert!(!u.coordinated_daemon_ready());
            assert!(u.take_coordinated_daemon_request().is_none());
        }
        u.coordinated.request_daemon = true;
        assert_eq!(
            u.take_coordinated_daemon_request().unwrap()["guiBuild"],
            "101.1"
        );
        assert!(u.take_coordinated_daemon_request().is_none());
    }
    #[test]
    fn ordinary_updates_remain_uncoordinated_and_resume_pending_stays_frozen() {
        let mut u = Updates::blank(None, false);
        assert!(u.coordinated_daemon_ready());
        assert!(u.coordinated_restart_allowed());
        u.coordinated.update = Some(json!({"phase":"completed","resumePending":true}));
        assert!(u.coordinated.active());
        assert!(!u.coordinated_restart_allowed());
    }
    #[test]
    fn coordinated_ready_copy_preserves_ordinary_local_status() {
        let mut u = Updates::blank(None, false);
        let state = pilot_desktop_updater::State::ReadyToRestart(Candidate {
            version: "101.1".into(),
            short_version: "0.1.1".into(),
        });
        assert_eq!(u.coordinated_ready_text(Some(&state)), None);
        assert_eq!(
            local_text(Some(&state)),
            Some("New build ready. Reload UI keeps drafts; the daemon and agents keep running.")
        );
        u.coordinated.update = Some(update("draining"));
        assert_eq!(
            u.coordinated_ready_text(Some(&state)),
            Some(
                "New tool calls are paused. Waiting for jobs and terminals before updating the app and daemon."
            )
        );
        u.coordinated.update = None;
        assert_eq!(u.coordinated_ready_text(Some(&state)), None);
    }
}
