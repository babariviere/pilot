//! Native approval owns proposal continuation; ordinary updater state stays separate.
use super::*;
use pilot_desktop_updater::coordinated::Receipt;
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};

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
    Waiting(Value, Receipt),
    Daemon(Value),
    Completed(Value),
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
                return Ok(Done::Waiting(update.clone(), evidence));
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
        if self.coordinated.busy {
            return;
        }
        let Some(options) = self.coordinated.options.clone() else {
            return;
        };
        self.coordinated.busy = true;
        self.coordinated.error = None;
        let (tx, rx) = async_channel::bounded(1);
        if std::thread::Builder::new()
            .name("coordinated-update".into())
            .spawn(move || {
                let _ = tx.send_blocking(perform(&options, job));
            })
            .is_err()
        {
            self.coordinated.busy = false;
            self.coordinated.error = Some("Update worker could not start.");
            return;
        }
        self.coordinated.task=Some(cx.spawn(async move|owner,cx|{
            let result=rx.recv().await.unwrap_or(Err("Update outcome is unconfirmed. Inspect retained state."));
            let _=owner.update(cx,|owner,cx|{
                owner.coordinated.busy=false;
                owner.coordinated.task=None;
                let advance = !matches!(&result,Ok(Done::Snapshot(_,false)));
                match result {
                    Err(error)=>owner.coordinated.error=Some(error),
                    Ok(Done::Snapshot(update,_))=>{ owner.coordinated.update=update; owner.coordinated.checked=true; },
                    Ok(Done::Accepted(update))=>{
                        owner.coordinated.update=Some(update.clone());
                        let expected=pilot_desktop_updater::iteration::ExpectedTarget::new(update["source"].as_str().unwrap_or("").into(),update["build"].as_str().unwrap_or("").into());
                        if let (Ok(expected),Some(directory),Some(controller))=(expected,update["directory"].as_str(),owner.controller.as_mut()) {
                            controller.backend_mut().supply_proposal(update["id"].as_str().unwrap_or("").into());
                            if controller.stage_local_expected(directory.into(),Some(expected),owner.epoch.elapsed()).is_ok(){ owner.local_build=true; }
                            else {owner.coordinated.error=Some("Staging could not start. Agents remain frozen; inspect or cancel the proposal.");}
                        } else { owner.coordinated.error=Some("The accepted proposal could not be staged. Agents remain frozen."); }
                    },
                    Ok(Done::Armed(update,evidence))=>{owner.coordinated.update=Some(update);owner.coordinated.evidence=Some(evidence);owner.coordinated.armed=true;cx.emit(Event::Restart);},
                    Ok(Done::Waiting(update,evidence))=>{owner.coordinated.update=Some(update);owner.coordinated.evidence=Some(evidence);owner.coordinated.error=Some("Jobs, tools or terminals still block this update. Continue after they settle.");},
                    Ok(Done::Daemon(update))=>{owner.coordinated.update=Some(update);owner.coordinated.request_daemon=true;},
                    Ok(Done::Completed(update))=>{owner.coordinated.update=Some(update);owner.coordinated.handoff=false;},
                }
                if advance { owner.advance_coordinated(cx); }
                cx.emit(Event::Changed);cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn advance_coordinated(&mut self, cx: &mut Context<Self>) {
        if self.coordinated.busy || self.coordinated.error.is_some() {
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
        if let Some(receipt) = self
            .controller
            .as_mut()
            .and_then(|c| c.backend_mut().take_proposal())
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
            self.coordinated.error = Some(
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
        if let Some(update) = &self.coordinated.update {
            if update["phase"] == "draining" && self.coordinated.evidence.is_some() {
                actions = actions.child(
                    ui::action("proposal-continue", "Continue update", Action::Primary)
                        .disabled(self.coordinated.busy)
                        .on_click(cx.listener(|owner, _, _, cx| {
                            if let (Some(update), Some(evidence)) = (
                                owner.coordinated.update.clone(),
                                owner.coordinated.evidence.clone(),
                            ) {
                                owner.run_coordinated(Job::Arm(update, Box::new(evidence)), cx);
                            }
                        })),
                );
            }
            if update["resumePending"] == true {
                actions = actions.child(
                    ui::action("proposal-resume", "Resume chats", Action::Primary)
                        .disabled(self.coordinated.busy)
                        .on_click(cx.listener(|owner, _, _, cx| {
                            if let Some(update) = owner.coordinated.update.clone() {
                                owner.run_coordinated(Job::Resume(update), cx);
                            }
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
                actions = actions.child(
                    ui::action("proposal-accept", "Accept update", Action::Primary)
                        .disabled(self.coordinated.busy || self.fenced || !can_stage(self.state()))
                        .on_click(cx.listener(|owner, _, _, cx| {
                            if let Some(update) = owner.coordinated.update.clone() {
                                owner.run_coordinated(Job::Accept(update), cx);
                            }
                        })),
                );
                view=view.child(Notice::new("Accept pauses all chats and tools, waits for jobs and terminals, then updates the app and daemon.").tone(Tone::Quiet));
            }
            if matches!(update["phase"].as_str(), Some("proposed" | "draining")) {
                actions = actions.child(
                    ui::action("proposal-cancel", "Cancel proposal", Action::Secondary)
                        .disabled(self.coordinated.busy)
                        .on_click(cx.listener(|owner, _, _, cx| {
                            if let Some(update) = owner.coordinated.update.clone() {
                                owner.run_coordinated(Job::Cancel(update), cx);
                            }
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
            Some(
                "New build ready. Reload UI saves drafts and selection first; the daemon and agents keep running."
            )
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
