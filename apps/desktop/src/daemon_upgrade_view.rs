//! Daemon upgrades share one lifecycle owner. Startup checks once after the GUI
//! is durable; manual confirmation and automatic checks use the same parent gate.
use crate::{
    LocalOptions,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, Context, EventEmitter, FocusHandle, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Render, Styled, Task, TestSupportExt, Window,
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
    target: Option<Target>,
    connected: crate::local_client::ConnectedDaemon,
    worker: Worker,
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
            target,
            connected: Default::default(),
            worker,
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
        self.target.is_some() && self.phase == Phase::Idle && !self.uncertain()
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
        let worker = if self.automatic {
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
        cx.emit(Event::Changed);
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
                Some("Running tools finish first, then the daemon restarts. Cancelling may not stop a shutdown that already started.".into()),
                Tone::Normal,
            )),
            Status::Cancelling => Some((
                "Cancelling…",
                Some("If the daemon was already stopping, the upgrade continues and its result appears here.".into()),
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
                                .detail("Running tools finish first. Active jobs, terminals or child work defer the upgrade. The existing service, profile and login settings stay in place. Cancel before shutdown begins.")
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
