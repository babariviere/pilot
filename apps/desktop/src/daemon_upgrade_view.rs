//! Daemon upgrades share one lifecycle owner. Startup checks once after the GUI
//! is durable; manual confirmation and automatic checks use the same parent gate.
use crate::{
    LocalOptions,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, Context, EventEmitter, FocusHandle, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Render, StatefulInteractiveElement, Styled, Task, TestSupportExt, Window,
    component::{ActiveTheme, Disableable, StyledExt},
    div,
};
use pilot_desktop_updater::{coordination::Location, daemon_upgrade::Failure};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Blocking native handoff. Runs on one dedicated thread per explicit attempt.
pub(crate) type Worker =
    Arc<dyn Fn(Location, String, String, Arc<AtomicBool>) -> Result<(), Failure> + Send + Sync>;
type Checker =
    Arc<dyn Fn(Location, String, String, Arc<AtomicBool>) -> Result<bool, Failure> + Send + Sync>;

/// The exact daemon the user confirmed against.
#[derive(Clone)]
pub(crate) struct Target {
    location: Location,
    daemon_id: String,
    lineage_id: String,
}
impl Target {
    pub(crate) fn new(location: Location, daemon_id: String, lineage_id: String) -> Self {
        Self {
            location,
            daemon_id,
            lineage_id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    /// The user confirmed. The parent excludes a concurrent app restart, then calls
    /// begin(), or set_notice() to refuse.
    Request,
    /// Any phase or outcome change, including worker completion.
    Changed,
    OpenBlocker,
    StopBlocker,
}

#[derive(Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Blocker {
    kind: String,
    id: String,
    session_id: Option<String>,
    title: Option<String>,
}
impl Blocker {
    fn action_id(&self, action: &str) -> gpui_kit::SharedString {
        format!(
            "{action}-blocker:{}",
            serde_json::json!([self.kind, self.id, self.session_id])
        )
        .into()
    }
    fn reason(&self) -> &'static str {
        match self.kind.as_str() {
            "active-work" => "Agent work is active",
            "automation" => "Automation is running",
            "job" => "Background job is running",
            "child-process" => "Child processes remain",
            "terminal" => "Terminal is open",
            "admission" => "A daemon operation is still settling",
            _ => "Work could not be verified as stopped",
        }
    }
    fn stoppable(&self) -> bool {
        self.session_id.is_some() && matches!(self.kind.as_str(), "active-work" | "automation")
    }
}
#[derive(Clone, serde::Deserialize)]
pub(crate) struct Blockers {
    blockers: Vec<Blocker>,
    truncated: bool,
}
impl Blockers {
    pub(crate) fn parse(value: serde_json::Value) -> Option<Self> {
        let snapshot: Self = serde_json::from_value(value).ok()?;
        (snapshot.blockers.len() <= 256
            && snapshot.blockers.iter().enumerate().all(|(index, b)| {
                !snapshot.blockers[..index].iter().any(|previous| {
                    previous.kind == b.kind
                        && previous.id == b.id
                        && previous.session_id == b.session_id
                })
            })
            && snapshot.blockers.iter().all(|b| {
                !b.id.is_empty()
                    && b.id.len() <= 512
                    && !b.kind.is_empty()
                    && b.kind.len() <= 64
                    && b.session_id
                        .as_deref()
                        .is_none_or(crate::local_model::valid_id)
                    && b.title.as_ref().is_none_or(|s| s.len() <= 1024)
            }))
        .then_some(snapshot)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Unavailable,
    Idle,
    Checking,
    Confirming,
    Requested,
    Running,
    Cancelling,
    Succeeded,
    Failed(Failure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Checking,
    Confirming,
    Requested,
    Running,
    Cancelling,
}

pub(crate) struct DaemonUpgrade {
    options: Option<LocalOptions>,
    blockers: Option<Blockers>,
    inspection: Option<Task<()>>,
    inspection_generation: u64,
    inspection_error: Option<&'static str>,
    pub(crate) selected_blocker: Option<String>,
    stop_confirmation: Option<Blocker>,
    target: Option<Target>,
    connected: crate::local_client::ConnectedDaemon,
    worker: Worker,
    coordinated_worker: Option<Worker>,
    phase: Phase,
    /// Last finished attempt. Errors stay until a newer attempt finishes.
    outcome: Option<Result<(), Failure>>,
    notice: Option<&'static str>,
    cancel: Option<Arc<AtomicBool>>,
    completion: Option<Task<()>>,
    startup_check: Option<Checker>,
    startup_worker: Option<Worker>,
    automatic: bool,
    focus: FocusHandle,
    confirm_focus: FocusHandle,
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) started: usize,
}
impl EventEmitter<Event> for DaemonUpgrade {}

/// Configured profile context only, not proof. Native preflight admits or refuses it.
fn target(options: &LocalOptions) -> Option<Target> {
    let location = options.daemon_upgrade_location()?;
    let host = options.host();
    Some(Target::new(location, host.daemon_id, host.lineage_id))
}

impl DaemonUpgrade {
    pub(crate) fn new(options: Option<LocalOptions>, cx: &mut Context<Self>) -> Self {
        let worker: Worker = Arc::new(crate::bundled_runtime::upgrade_daemon_explicit);
        let mut owner = Self::with_target(options.as_ref().and_then(target), worker, cx);
        owner.options = options.clone();
        // External connections, fixtures and unconfigured development binaries
        // never acquire service-management authority merely by opening a window.
        if cfg!(target_os = "macos")
            && options
                .as_ref()
                .and_then(LocalOptions::update_location)
                .is_some()
            && std::env::current_exe().is_ok_and(|exe| crate::bundled_runtime::packaged(&exe))
            && pilot_desktop_updater::helper::compiled_trust().is_ok()
        {
            owner.startup_check = Some(Arc::new(crate::bundled_runtime::daemon_upgrade_needed));
            owner.startup_worker =
                Some(Arc::new(crate::bundled_runtime::upgrade_daemon_on_startup));
        }
        owner
    }
    pub(crate) fn with_target(
        target: Option<Target>,
        worker: Worker,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            options: None,
            blockers: None,
            inspection: None,
            inspection_generation: 0,
            inspection_error: None,
            selected_blocker: None,
            stop_confirmation: None,
            target,
            connected: Default::default(),
            worker,
            coordinated_worker: None,
            phase: Phase::Idle,
            outcome: None,
            notice: None,
            cancel: None,
            completion: None,
            startup_check: None,
            startup_worker: None,
            automatic: false,
            focus: cx.focus_handle(),
            confirm_focus: cx.focus_handle(),
            #[cfg(any(test, feature = "native-probes"))]
            started: 0,
        }
    }

    pub(crate) fn connected(
        &mut self,
        connected: crate::local_client::ConnectedDaemon,
        cx: &mut Context<Self>,
    ) {
        if self.connected != connected {
            self.connected = connected;
            self.inspection_generation += 1;
            self.stop_confirmation = None;
            self.blockers = None;
            self.inspection_error = Some("Connection changed. Refresh blockers before acting.");
            cx.emit(Event::Changed);
            cx.notify();
        }
    }

    /// Parent calls only after startup acknowledgement and durable UI restoration.
    /// One check per app lifetime, never a polling/retry loop.
    pub(crate) fn startup(&mut self, cx: &mut Context<Self>) {
        if self.phase != Phase::Idle
            || self.outcome.is_some()
            || !matches!(
                self.connected,
                crate::local_client::ConnectedDaemon::Connected(_)
            )
        {
            return;
        }
        let Some(target) = self.target.clone() else {
            return;
        };
        let Some(checker) = self.startup_check.take() else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let (sender, receiver) = async_channel::bounded(1);
        self.automatic = true;
        if std::thread::Builder::new()
            .name("daemon-upgrade-check".into())
            .spawn(move || {
                let _ = sender.send_blocking(checker(
                    target.location,
                    target.daemon_id,
                    target.lineage_id,
                    flag,
                ));
            })
            .is_err()
        {
            self.outcome = Some(Err(Failure::Unverified));
            cx.emit(Event::Changed);
            cx.notify();
            return;
        }
        self.cancel = Some(cancel);
        self.phase = Phase::Checking;
        self.completion = Some(cx.spawn(async move |owner, cx| {
            let result = receiver.recv().await.unwrap_or(Err(Failure::Unverified));
            let _ = owner.update(cx, |owner, cx| {
                let cancelled = owner
                    .cancel
                    .as_ref()
                    .is_some_and(|c| c.load(Ordering::Acquire));
                owner.cancel = None;
                owner.completion = None;
                owner.phase = Phase::Idle;
                match result {
                    _ if cancelled => owner.outcome = Some(Err(Failure::Cancelled)),
                    Ok(true) => {
                        owner.phase = Phase::Requested;
                        cx.emit(Event::Request);
                    }
                    Ok(false) => owner.automatic = false,
                    Err(failure) => owner.outcome = Some(Err(failure)),
                }
                cx.emit(Event::Changed);
                cx.notify();
            });
        }));
        cx.emit(Event::Changed);
        cx.notify();
    }

    pub(crate) fn startup_notice(&self) -> Option<&'static str> {
        if !self.automatic {
            return None;
        }
        match self.status() {
            Status::Checking => None,
            Status::Requested | Status::Running => Some("Updating daemon…"),
            Status::Cancelling => Some("Cancelling daemon update…"),
            Status::Failed(Failure::Busy) => Some("Daemon update deferred"),
            Status::Failed(Failure::Cancelled) => None,
            Status::Failed(_) => Some("Daemon update needs attention"),
            _ => None,
        }
    }

    pub(crate) fn status(&self) -> Status {
        if self.target.is_none() {
            return Status::Unavailable;
        }
        match self.phase {
            Phase::Checking => Status::Checking,
            Phase::Idle => match self.outcome {
                None => Status::Idle,
                Some(Ok(())) => Status::Succeeded,
                Some(Err(failure)) => Status::Failed(failure),
            },
            Phase::Confirming => Status::Confirming,
            Phase::Requested => Status::Requested,
            Phase::Running => Status::Running,
            Phase::Cancelling => Status::Cancelling,
        }
    }
    /// True after explicit confirmation until begin(), set_notice() or cancel().
    pub(crate) fn checkpoint_requested(&self) -> bool {
        self.phase == Phase::Requested
    }
    /// Durable coordinated intent was acknowledged by the daemon. Never a startup retry.
    pub(crate) fn request_coordinated(
        &mut self,
        binding: serde_json::Value,
        cx: &mut Context<Self>,
    ) {
        if self.phase != Phase::Idle || self.uncertain() {
            return;
        }
        self.automatic = false;
        #[cfg(target_os = "macos")]
        {
            self.coordinated_worker = Some(Arc::new(move |location, daemon, lineage, cancel| {
                crate::bundled_runtime::upgrade_daemon_coordinated(
                    location,
                    daemon,
                    lineage,
                    cancel,
                    binding.clone(),
                )
            }));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = binding;
            return;
        }
        self.phase = Phase::Requested;
        cx.emit(Event::Request);
        cx.notify();
    }
    /// A worker is running. Only GUI exit/another activation waits for it;
    /// the editor and secondary forms remain live.
    pub(crate) fn active(&self) -> bool {
        matches!(
            self.phase,
            Phase::Checking | Phase::Running | Phase::Cancelling
        )
    }
    /// A lifecycle write may have happened. Sticky; no retry is offered.
    pub(crate) fn uncertain(&self) -> bool {
        self.outcome == Some(Err(Failure::Unknown))
    }
    fn can_open(&self) -> bool {
        self.target.is_some()
            && self.phase == Phase::Idle
            && self.inspection.is_none()
            && self.stop_confirmation.is_none()
            && !self.uncertain()
    }

    /// Consumes the request and starts the single worker. Parent-only, after its checkpoint.
    pub(crate) fn begin(&mut self, cx: &mut Context<Self>) -> bool {
        if self.phase != Phase::Requested || self.uncertain() {
            return false;
        }
        let Some(target) = self.target.clone() else {
            return false;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let worker = if let Some(worker) = self.coordinated_worker.take() {
            worker
        } else if self.automatic {
            self.startup_worker.as_ref().unwrap_or(&self.worker).clone()
        } else {
            self.worker.clone()
        };
        let (sender, receiver) = async_channel::bounded(1);
        let started = std::thread::Builder::new()
            .name("daemon-upgrade-explicit".into())
            .spawn(move || {
                let result = worker(target.location, target.daemon_id, target.lineage_id, flag);
                let _ = sender.send_blocking(result);
            });
        if started.is_err() {
            self.phase = Phase::Idle;
            self.notice = Some("The upgrade couldn't start. Nothing was stopped.");
            cx.emit(Event::Changed);
            cx.notify();
            return false;
        }
        #[cfg(any(test, feature = "native-probes"))]
        {
            self.started += 1;
        }
        self.cancel = Some(cancel);
        self.phase = Phase::Running;
        self.completion = Some(cx.spawn(async move |owner, cx| {
            // A dropped sender means the worker panicked after possibly writing.
            let result = receiver.recv().await.unwrap_or(Err(Failure::Unknown));
            let _ = owner.update(cx, |owner, cx| owner.finish(result, cx));
        }));
        cx.emit(Event::Changed);
        cx.notify();
        true
    }
    fn finish(&mut self, result: Result<(), Failure>, cx: &mut Context<Self>) {
        self.phase = Phase::Idle;
        self.cancel = None;
        self.completion = None;
        self.outcome = Some(result);
        if result == Err(Failure::Busy) {
            self.inspect(cx);
        }
        cx.emit(Event::Changed);
        cx.notify();
    }

    fn inspect(&mut self, cx: &mut Context<Self>) {
        if self.inspection.is_some()
            || self.phase != Phase::Idle
            || self.uncertain()
            || self.stop_confirmation.is_some()
        {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        let (tx, rx) = async_channel::bounded(1);
        let generation = self.inspection_generation;
        self.inspection_error = None;
        if std::thread::Builder::new()
            .name("daemon-blockers".into())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| "Cannot read daemon blockers.")
                    .and_then(|runtime| {
                        runtime.block_on(crate::local_client::daemon_update_blockers(&options))
                    });
                let _ = tx.send_blocking(result);
            })
            .is_err()
        {
            self.inspection_error = Some("Cannot read daemon blockers.");
            cx.notify();
            return;
        }
        self.inspection = Some(cx.spawn(async move |owner, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Cannot read daemon blockers."));
            let _ = owner.update(cx, |owner, cx| {
                owner.inspection = None;
                if owner.inspection_generation != generation {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(snapshot) => owner.blockers = Some(snapshot),
                    Err(error) => owner.inspection_error = Some(error),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn blocker_actions_ready(&self) -> bool {
        self.outcome == Some(Err(Failure::Busy))
            && self.phase == Phase::Idle
            && self.inspection.is_none()
            && self.inspection_error.is_none()
            && self.blockers.is_some()
            && matches!(
                self.connected,
                crate::local_client::ConnectedDaemon::Connected(_)
            )
    }

    fn choose_blocker(&mut self, blocker: &Blocker, stop: bool, cx: &mut Context<Self>) {
        if !self.blocker_actions_ready()
            || self.stop_confirmation.is_some()
            || !self
                .blockers
                .as_ref()
                .is_some_and(|snapshot| snapshot.blockers.contains(blocker))
        {
            return;
        }
        if stop {
            if blocker.stoppable() {
                self.stop_confirmation = Some(blocker.clone());
            }
        } else if blocker.session_id.is_some() {
            self.selected_blocker = blocker.session_id.clone();
            cx.emit(Event::OpenBlocker);
        }
        cx.notify();
    }

    fn confirm_stop(&mut self, cx: &mut Context<Self>) {
        if !self.blocker_actions_ready() {
            return;
        }
        if let Some(blocker) = self.stop_confirmation.take() {
            self.selected_blocker = blocker.session_id;
            cx.emit(Event::StopBlocker);
            // A Stop ACK is not exit proof. Require a new passive observation.
            self.inspection_error = Some("Stop requested. Refresh blockers before acting again.");
        }
        cx.notify();
    }

    /// A parent refusal or deferral. Clears a pending request so it cannot begin later.
    pub(crate) fn set_notice(&mut self, message: &'static str, cx: &mut Context<Self>) {
        self.notice = Some(message);
        if matches!(self.phase, Phase::Confirming | Phase::Requested) {
            self.phase = Phase::Idle;
        }
        cx.emit(Event::Changed);
        cx.notify();
    }

    /// Before begin() this withdraws the request. While running it only asks the
    /// worker to stop before shutdown; a shutdown already under way continues.
    pub(crate) fn cancel(&mut self, cx: &mut Context<Self>) {
        match self.phase {
            Phase::Confirming | Phase::Requested => self.phase = Phase::Idle,
            Phase::Checking | Phase::Running => {
                if let Some(cancel) = &self.cancel {
                    cancel.store(true, Ordering::Release);
                }
                self.phase = Phase::Cancelling;
            }
            Phase::Idle | Phase::Cancelling => return,
        }
        cx.emit(Event::Changed);
        cx.notify();
    }

    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_open() {
            return;
        }
        self.phase = Phase::Confirming;
        self.automatic = false;
        self.notice = None;
        // Kit buttons keep focus on mouse down. Never take focus from another owner,
        // which may hold IME marked text; Cancel stays reachable by pointer and Tab.
        if window.focused(cx).is_none() || self.focus.contains_focused(window, cx) {
            self.confirm_focus.focus(window, cx);
        }
        cx.emit(Event::Changed);
        cx.notify();
    }
    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != Phase::Confirming || self.uncertain() {
            return;
        }
        self.restore_focus(window, cx);
        self.phase = Phase::Requested;
        cx.emit(Event::Request);
        cx.emit(Event::Changed);
        cx.notify();
    }
    /// Probe-only stand-in for a confirmed click, for parent lifecycle checks.
    /// Same guards and events as confirm(); the standalone probe covers the real click.
    #[cfg(feature = "native-probes")]
    pub(crate) fn request_probe(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.can_open() {
            return false;
        }
        self.notice = None;
        self.phase = Phase::Requested;
        cx.emit(Event::Request);
        cx.emit(Event::Changed);
        cx.notify();
        true
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn startup_probe(&mut self, needed: bool, cx: &mut Context<Self>) {
        self.startup_check = Some(Arc::new(move |_, _, _, _| Ok(needed)));
        self.connected(
            crate::local_client::ConnectedDaemon::Connected(Some("1.0.0".into())),
            cx,
        );
        self.startup(cx);
    }
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.restore_focus(window, cx);
        self.cancel(cx);
    }
    fn restore_focus(&self, window: &mut Window, cx: &mut App) {
        if self.confirm_focus.contains_focused(window, cx) {
            self.focus.focus(window, cx);
        }
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn owns_focus(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn confirmation_focused(&self, window: &Window, cx: &App) -> bool {
        self.confirm_focus.contains_focused(window, cx)
    }
}
impl Drop for DaemonUpgrade {
    fn drop(&mut self) {
        // Losing the owner never lets an unobserved attempt proceed to shutdown.
        if let Some(cancel) = &self.cancel {
            cancel.store(true, Ordering::Release);
        }
    }
}

fn outcome(failure: Failure) -> (&'static str, Tone) {
    match failure {
        Failure::Cancelled => ("Upgrade cancelled", Tone::Quiet),
        // Definite refusals before shutdown. Capacity is the user's to act on.
        Failure::Busy | Failure::StagingCapacity => ("Daemon not upgraded", Tone::Warning),
        Failure::Unknown => ("Upgrade outcome unknown", Tone::Error),
        Failure::Unsupported | Failure::Unverified | Failure::StagingArchiveFailed => {
            ("Daemon not upgraded", Tone::Error)
        }
    }
}

impl Render for DaemonUpgrade {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut view = div()
            .id("daemon-upgrade")
            .test_support()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|v, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && v.stop_confirmation.take().is_some() {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_3()
            .child(ui::heading(
                "daemon-upgrade-heading",
                "Daemon",
                Text::Headline,
            ))
            .child(crate::running_identity::identity_row(
                "updates-current-daemon",
                "Current daemon",
                crate::running_identity::daemon_display(&self.connected),
            ));
        if self.target.is_none() {
            return view.child(
                div()
                    .id("daemon-upgrade-status")
                    .test_support()
                    .child(Notice::new("Not available for this daemon.").tone(Tone::Quiet)),
            );
        }
        let status: Option<(&'static str, Option<String>, Tone)> = match self.status() {
            Status::Checking => Some(("Checking the daemon version…", None, Tone::Normal)),
            Status::Requested => Some(("Starting the daemon upgrade…", None, Tone::Normal)),
            Status::Running => Some((
                "Upgrading the daemon…",
                Some(
                    "Running tools finish first. Cancel may not stop a shutdown already underway."
                        .into(),
                ),
                Tone::Normal,
            )),
            Status::Cancelling => Some((
                "Cancelling…",
                Some(
                    "If shutdown already began, the upgrade continues; its result appears here."
                        .into(),
                ),
                Tone::Normal,
            )),
            Status::Succeeded => Some(("Daemon is up to date.", None, Tone::Success)),
            Status::Failed(failure) => {
                let (title, tone) = outcome(failure);
                // Unknown's instruction is the caption below, beside the handoff path.
                let detail = (failure != Failure::Unknown).then(|| failure.to_string());
                Some((title, detail, tone))
            }
            Status::Idle | Status::Confirming | Status::Unavailable => None,
        };
        if let Some((title, detail, tone)) = status {
            let mut notice = Notice::new(title).tone(tone);
            if let Some(detail) = detail {
                notice = notice.detail(detail);
            }
            view = view.child(
                div()
                    .id("daemon-upgrade-status")
                    .test_support()
                    .child(notice),
            );
        }
        if self.outcome == Some(Err(Failure::Busy)) {
            let ready = self.blocker_actions_ready();
            view = view.child(ui::text(Text::Caption,
                "Stop only what you choose. Jobs, terminals and child processes may need separate attention."));
            if let Some(snapshot) = &self.blockers {
                let mut rows = div()
                    .id("daemon-blockers")
                    .test_support()
                    .v_flex()
                    .gap_3()
                    .max_h_64()
                    .flex_shrink_0()
                    .overflow_y_scroll();
                for blocker in &snapshot.blockers {
                    let row = div()
                        .v_flex()
                        .min_w_0()
                        .gap_1()
                        .child(ui::text(
                            Text::Body,
                            blocker.title.clone().unwrap_or_else(|| {
                                if blocker.session_id.is_some() {
                                    "Untitled chat".into()
                                } else {
                                    "Daemon work".into()
                                }
                            }),
                        ))
                        .child(
                            ui::text(Text::Caption, blocker.reason())
                                .text_color(cx.theme().muted_foreground),
                        );
                    let mut actions = div().h_flex().flex_wrap().gap_2();
                    if blocker.session_id.is_some() {
                        let blocker = blocker.clone();
                        actions = actions.child(
                            ui::action(blocker.action_id("open"), "Open chat", Action::Quiet)
                                .disabled(!ready || self.stop_confirmation.is_some())
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.choose_blocker(&blocker, false, cx);
                                })),
                        );
                    }
                    if blocker.stoppable() {
                        let blocker = blocker.clone();
                        actions = actions.child(
                            ui::action(blocker.action_id("stop"), "Stop work…", Action::Quiet)
                                .disabled(!ready || self.stop_confirmation.is_some())
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.choose_blocker(&blocker, true, cx);
                                })),
                        );
                    }
                    rows = rows.child(row.child(actions));
                }
                view = view.child(rows);
                if snapshot.truncated {
                    view = view.child(
                        Notice::new("More blockers remain. Refresh after resolving these.")
                            .tone(Tone::Warning),
                    );
                } else if snapshot.blockers.is_empty() {
                    view = view.child(ui::text(
                        Text::Caption,
                        "No blockers observed. This is not proof that upgrading is safe.",
                    ));
                }
            }
            if let Some(error) = self.inspection_error {
                view = view.child(
                    Notice::new(error)
                        .detail("This list may be stale. Refresh before stopping work.")
                        .tone(Tone::Warning),
                );
            }
            view = view.child(
                div().h_flex().child(
                    ui::action(
                        "daemon-blockers-refresh",
                        if self.inspection.is_some() {
                            "Reading blockers…"
                        } else {
                            "Refresh blockers"
                        },
                        Action::Secondary,
                    )
                    .disabled(
                        self.phase != Phase::Idle
                            || self.inspection.is_some()
                            || self.stop_confirmation.is_some(),
                    )
                    .on_click(cx.listener(|v, _, _, cx| v.inspect(cx))),
                ),
            );
        }
        if let Some(blocker) = self.stop_confirmation.clone() {
            view = view.child(div().v_flex().gap_2()
                .child(Notice::new(format!("Stop work in {}?", blocker.title.unwrap_or_else(|| "this chat".into())))
                    .detail("Interrupts its current work; queued text is kept for recovery. Background jobs and terminals may keep running. Doesn't upgrade the daemon.")
                    .tone(Tone::Warning))
                .child(div().h_flex().gap_2()
                    .child(ui::action("daemon-stop-cancel", "Cancel", Action::Quiet).on_click(cx.listener(|v, _, _, cx| {
                        v.stop_confirmation = None; cx.notify();
                    })))
                    .child(ui::action("daemon-stop-confirm", "Stop this chat", Action::Danger)
                        .disabled(!self.blocker_actions_ready())
                        .on_click(cx.listener(|v, _, _, cx| v.confirm_stop(cx))))));
        }
        if self.uncertain()
            && let Some(target) = &self.target
        {
            // Path only. The view never reads the journal.
            let journal = target
                .location
                .home
                .join(".daemon-upgrade.json")
                .to_string_lossy()
                .into_owned();
            let copy = journal.clone();
            view = view
                .child(ui::text(
                    Text::Caption,
                    "Do not retry. Inspect the retained handoff and daemon state before recovery.",
                ))
                .child(
                    ui::text(Text::Caption, journal)
                        .id("daemon-upgrade-journal")
                        .test_support()
                        .text_color(cx.theme().muted_foreground),
                )
                .child(
                    div().h_flex().child(
                        ui::action(
                            "daemon-upgrade-copy-journal",
                            "Copy handoff path",
                            Action::Quiet,
                        )
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(copy.clone()))
                        }),
                    ),
                );
        }
        match self.phase {
            Phase::Idle if !self.uncertain() => {
                view = view
                    .child(
                        ui::text(Text::Caption, "Restart the daemon on this app's runtime.")
                            .text_color(cx.theme().muted_foreground),
                    )
                    .child(
                        div().h_flex().child(
                            ui::action("daemon-upgrade-open", "Upgrade daemon…", Action::Secondary)
                                .disabled(!self.can_open())
                                .on_click(cx.listener(|v, _, w, cx| v.open(w, cx))),
                        ),
                    );
            }
            Phase::Confirming => {
                view = view.child(
                    div()
                        .id("daemon-upgrade-confirm")
                        .test_support()
                        .track_focus(&self.confirm_focus)
                        .v_flex()
                        .gap_3()
                        .on_key_down(cx.listener(|v, e: &KeyDownEvent, w, cx| {
                            // Escape dismisses. Plain Enter here never confirms.
                            if e.keystroke.key == "escape"
                                && !e.is_held
                                && !e.keystroke.modifiers.modified()
                                && v.phase == Phase::Confirming
                            {
                                cx.stop_propagation();
                                v.dismiss(w, cx);
                            }
                        }))
                        .child(
                            Notice::new("Upgrade the daemon now?")
                                .detail("Running tools finish first; active jobs, terminals or child work defer it. Service, profile and login settings stay. You can cancel until shutdown begins.")
                                .tone(Tone::Warning),
                        )
                        .child(
                            div()
                                .h_flex()
                                .flex_wrap()
                                .gap_2()
                                .child(
                                    ui::action("daemon-upgrade-dismiss", "Cancel", Action::Quiet)
                                        .on_click(cx.listener(|v, _, w, cx| v.dismiss(w, cx))),
                                )
                                .child(
                                    ui::action("daemon-upgrade-confirm-action", "Upgrade daemon", Action::Danger)
                                        .on_click(cx.listener(|v, _, w, cx| v.confirm(w, cx))),
                                ),
                        ),
                );
            }
            Phase::Checking | Phase::Requested | Phase::Running | Phase::Cancelling => {
                view = view.child(
                    div().h_flex().child(
                        ui::action("daemon-upgrade-cancel", "Cancel", Action::Secondary)
                            .disabled(self.phase == Phase::Cancelling)
                            .on_click(cx.listener(|v, _, w, cx| v.dismiss(w, cx))),
                    ),
                );
            }
            Phase::Idle => {}
        }
        if let Some(notice) = self.notice {
            view = view.child(
                div()
                    .id("daemon-upgrade-notice")
                    .test_support()
                    .child(Notice::new(notice).tone(Tone::Warning)),
            );
        }
        view
    }
}

#[cfg(test)]
#[path = "daemon_upgrade_view_tests.rs"]
mod tests;
