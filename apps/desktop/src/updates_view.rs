//! One app-lifetime update controller. Blocking I/O remains in the concrete
//! updater worker. Preference changes only take effect after Settings ACK.
use crate::ui::{self, Action, Notice, Text, Tone};
use gpui_kit::component::{
    Disableable, StyledExt,
    input::{Input, InputState},
};
use gpui_kit::{
    AppContext, Context, Entity, EntityInputHandler, EventEmitter, InteractiveElement, IntoElement,
    ParentElement, Render, StatefulInteractiveElement, Styled, Task, Window, div,
};
use pilot_desktop_updater::{
    Error, Safety, State, Trigger, Updater, Work, coordination::Location, worker::Worker,
};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(crate) enum Event {
    Restart,
    Changed,
    UpgradeDaemon,
    DaemonChanged,
}
pub(crate) struct Updates {
    controller: Option<Updater<Worker>>,
    unavailable: Option<Error>,
    epoch: Instant,
    timer: Option<Task<()>>,
    wake: Option<Task<()>>,
    pub(crate) fenced: bool,
    cancel_prepare: bool,
    pub(crate) notice: Option<&'static str>,
    /// The profile daemon whose agents pause before installing, as in the Swift app.
    location: Option<Location>,
    external: bool,
    local_build: bool,
    choosing: bool,
    /// Renews the daemon's 30 second pause lease until the install ends or is cancelled.
    pausing: Option<Task<()>>,
    agents_paused: bool,
    startup_started: bool,
    startup: Option<Result<(), Error>>,
    startup_task: Option<Task<()>>,
    /// Canonical receipt path, so recovery rows match however the helper spelled it.
    startup_canonical: Option<std::path::PathBuf>,
    access: Option<String>,
    access_input: Option<Entity<InputState>>,
    inspected: bool,
    recovery: Option<pilot_desktop_updater::worker::Recovery>,
    recovery_open: bool,
    startup_receipt: Option<std::path::PathBuf>,
    #[cfg(feature = "native-probes")]
    fixture_armed: bool,
    /// Probe-only injected controller state for mounted UI checks; never in production.
    #[cfg(feature = "native-probes")]
    probe_state: Option<State>,
}
impl EventEmitter<Event> for Updates {}
impl Updates {
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_external_guards(cx: &mut gpui_kit::App) {
        let flush = pilot_desktop_updater::Flush {
            requested: 1,
            acknowledged: Some(1),
            failed: false,
        };
        let safety = Safety {
            drafts: flush,
            deliveries: flush,
            settings: flush,
            has_preedit: false,
            active_work: false,
            runtime: pilot_desktop_updater::Runtime::Unknown,
            admissions_fenced: true,
        };
        let synthetic = |home: &str| Location {
            home: home.into(),
            port: 1,
            policy: Default::default(),
        };
        // Neither a managed profile nor a pinned external connection: still refused.
        let updates = cx.new(|cx| Self::new(None, None, cx));
        updates.update(cx, |updates, cx| {
            assert!(!updates.ensure_agents_paused(cx));
            assert!(updates.pausing.is_none());
            assert!(!updates.agents_paused);
            updates.prepare(safety, cx);
            updates.commit(safety, cx);
            assert!(!updates.fenced);
            assert!(updates.notice.unwrap().contains("Externally managed"));
        });
        // A pinned external connection updates only the app. It never pauses or reserves
        // the daemon (no pause lease task), and normal verified installs stay enabled.
        let connection = pilot_desktop_updater::app_update::Connection::new(
            synthetic("/synthetic-external"),
            "Synthetic-Daemon".into(),
            "Synthetic-Lineage".into(),
        );
        let updates = cx.new(|cx| Self::new(None, Some(connection), cx));
        updates.update(cx, |updates, cx| {
            assert!(updates.ensure_agents_paused(cx));
            assert!(updates.pausing.is_none() && !updates.agents_paused);
            assert!(updates.notice.is_none());
            let ready = State::ReadyToRestart(pilot_desktop_updater::Candidate {
                version: "synthetic".into(),
            });
            assert!(can_install(Some(&ready), true, false, false, false));
            assert_eq!(install_label(false), "Install and restart…");
            updates.prepare(safety, cx);
            assert!(
                updates.fenced,
                "external install proceeds to guarded preparation"
            );
            assert!(updates.notice.is_none());
            updates.defer("synthetic", cx);
            assert!(!updates.fenced);
        });
        // A managed profile pauses agents for a normal update, but a UI-only local
        // build reload leaves the daemon and its agents running.
        let updates = cx.new(|cx| Self::new(Some(synthetic("/synthetic-managed")), None, cx));
        updates.update(cx, |updates, cx| {
            updates.local_build = true;
            assert!(updates.ensure_agents_paused(cx));
            assert!(updates.pausing.is_none());
            updates.local_build = false;
            assert!(!updates.ensure_agents_paused(cx));
            assert!(
                updates.pausing.is_some(),
                "normal managed install pauses agents first"
            );
            // Drop the unpolled lease task before any synthetic request can be sent.
            updates.release_agents();
            assert!(updates.pausing.is_none());
            updates.choosing = true;
            assert!(updates.choosing_local());
            updates.choosing = false;
        });
    }
    /// Mounted Updates pane with an injected ready local build. No Worker, trust,
    /// transaction, daemon or profile exists; the real install path is proven by the
    /// separate helper lifecycle fixture.
    #[cfg(all(feature = "native-probes", target_os = "macos"))]
    pub(crate) fn probe_ready_reload(
        cx: &mut gpui_kit::HeadlessAppContext,
        captures: Option<&std::path::Path>,
    ) {
        use gpui_kit::{
            AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
            component::{Theme, ThemeMode},
            px, size,
            test::TestWindowExt,
        };
        use std::{cell::Cell, rc::Rc};
        fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
            for _ in 0..4 {
                cx.run_until_parked();
                cx.advance_clock(Duration::from_millis(16));
                cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
            }
        }
        let ready = || {
            State::ReadyToRestart(pilot_desktop_updater::Candidate {
                version: "synthetic-local".into(),
            })
        };
        for width in [680., 1100.] {
            for dark in [false, true] {
                // The same direct theme switch the Settings probe uses; no preference is committed.
                let mode = if dark {
                    ThemeMode::Dark
                } else {
                    ThemeMode::Light
                };
                cx.update(|cx| Theme::change(mode, None, cx));
                let (h, updates) = cx
                    .update(|cx| {
                        gpui_kit::open_window(
                            WindowOptions {
                                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                    Default::default(),
                                    size(px(width), px(520.)),
                                ))),
                                show: false,
                                focus: false,
                                ..Default::default()
                            },
                            cx,
                            |_, cx| {
                                cx.new(|_| {
                                    let mut u = Self::blank(
                                        Some(Location {
                                            home: "/synthetic-managed".into(),
                                            port: 1,
                                            policy: Default::default(),
                                        }),
                                        false,
                                    );
                                    u.inspected = true;
                                    u.local_build = true;
                                    u.probe_state = Some(ready());
                                    u
                                })
                            },
                        )
                    })
                    .unwrap();
                let restarts = Rc::new(Cell::new(0usize));
                let _counter = cx.update(|cx| {
                    let restarts = restarts.clone();
                    cx.subscribe(&updates, move |_, event: &Event, _| {
                        if matches!(event, Event::Restart) {
                            restarts.set(restarts.get() + 1);
                        }
                    })
                });
                settle(cx, h);
                assert_eq!(restarts.get(), 0, "mounting never requests a restart");
                cx.update_window(h, |_, w, cx| {
                    assert!(updates.read(cx).status().starts_with("New build ready."));
                    assert_eq!(
                        w.find("updates-status").label(),
                        Some(updates.read(cx).status())
                    );
                    assert!(w.find("updates-status").visible());
                    let install = w.find("updates-install");
                    assert!(install.visible());
                    assert_eq!(install.label(), Some("Reload UI"));
                    assert_ne!(install.disabled(), Some(true));
                })
                .unwrap();
                if let Some(directory) = captures {
                    let name = if dark { "dark" } else { "light" };
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(directory.join(format!("{}-{name}-updates-reload.png", width as u32)))
                        .unwrap();
                }
                // One pointer activation is exactly one intent.
                cx.update_window(h, |_, w, cx| w.click("updates-install", cx))
                    .unwrap();
                settle(cx, h);
                assert_eq!(restarts.get(), 1, "one click, one restart intent");
                // Keyboard: Tab reaches Reload UI and Enter activates it once.
                cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
                for _ in 0..12 {
                    if cx
                        .update_window(h, |_, w, _| {
                            w.find("updates-install").focused() == Some(true)
                        })
                        .unwrap()
                    {
                        break;
                    }
                    cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                }
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find("updates-install").focused(), Some(true));
                    w.press("enter", cx);
                })
                .unwrap();
                settle(cx, h);
                assert_eq!(restarts.get(), 2, "one key activation, one restart intent");
                // Fenced preparation, an open folder chooser and a failed local build
                // hide the action; a deferral can be retried.
                type Case = (&'static str, fn(&mut Updates));
                let cases: [Case; 4] = [
                    ("fenced", |u| u.fenced = true),
                    ("choosing", |u| u.choosing = true),
                    ("failed", |u| {
                        u.probe_state = Some(State::Failed(Error::Version))
                    }),
                    ("deferred", |u| {
                        u.probe_state = Some(State::Deferred {
                            candidate: pilot_desktop_updater::Candidate {
                                version: "synthetic-local".into(),
                            },
                            reason: Error::ActiveWork,
                        })
                    }),
                ];
                for (name, apply) in cases {
                    cx.update(|cx| {
                        updates.update(cx, |u, cx| {
                            u.fenced = false;
                            u.choosing = false;
                            u.probe_state = Some(ready());
                            apply(u);
                            cx.notify();
                        })
                    });
                    settle(cx, h);
                    cx.update_window(h, |_, w, cx| {
                        let shown = w.try_find("updates-install").is_some();
                        assert_eq!(shown, name == "deferred", "{name}: install action");
                        if name == "failed" {
                            assert!(
                                updates
                                    .read(cx)
                                    .status()
                                    .starts_with("This local build is not newer")
                            );
                        }
                        if name == "fenced" {
                            assert!(w.find("updates-cancel").visible());
                        }
                    })
                    .unwrap();
                }
                assert_eq!(restarts.get(), 2, "state changes never request a restart");
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
            }
        }
    }
    pub(crate) fn new(
        location: Option<Location>,
        connection: Option<pilot_desktop_updater::app_update::Connection>,
        cx: &mut Context<Self>,
    ) -> Self {
        let (sender, receiver) = async_channel::bounded(1);
        let worker = Worker::for_running_app(move || {
            let _ = sender.try_send(());
        });
        let mut result = Self::blank(location.clone(), connection.is_some());
        match worker {
            Ok(mut worker) => {
                if let Some(location) = location {
                    worker.supply_runtime(location);
                }
                if let Some(connection) = connection {
                    worker.supply_external(connection);
                }
                result.controller = Some(Updater::new(worker, false, Duration::ZERO));
                result.wake = Some(cx.spawn(async move |owner, cx| {
                    while receiver.recv().await.is_ok() {
                        if owner.update(cx, |owner, cx| owner.drain(cx)).is_err() {
                            break;
                        }
                    }
                }));
            }
            Err(error) => result.unavailable = Some(error),
        }
        result
    }
    /// Controller-free state; `new` attaches the worker.
    fn blank(location: Option<Location>, external: bool) -> Self {
        Self {
            startup_started: false,
            startup: None,
            startup_task: None,
            access: None,
            access_input: None,
            inspected: false,
            recovery: None,
            recovery_open: false,
            startup_receipt: None,
            startup_canonical: None,
            #[cfg(feature = "native-probes")]
            fixture_armed: false,
            controller: None,
            unavailable: None,
            epoch: Instant::now(),
            timer: None,
            wake: None,
            fenced: false,
            cancel_prepare: false,
            notice: None,
            location,
            external,
            local_build: false,
            choosing: false,
            pausing: None,
            agents_paused: false,
            #[cfg(feature = "native-probes")]
            probe_state: None,
        }
    }
    pub(crate) fn state(&self) -> Option<&State> {
        #[cfg(feature = "native-probes")]
        if let Some(state) = &self.probe_state {
            return Some(state);
        }
        self.controller.as_ref().map(Updater::state)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn drive_fixture(&mut self, draft_ready: bool, cx: &mut Context<Self>) -> bool {
        if pilot_desktop_updater::fixture::enabled() && self.inspected {
            eprintln!("fixture-updater-state={:?}", self.state());
        }
        if !pilot_desktop_updater::fixture::enabled()
            || !self.inspected
            || self.recovery_blocked()
            || self.fixture_armed
        {
            return false;
        }
        match self.state().cloned() {
            Some(State::Idle) => self.check(cx),
            Some(State::Available(_)) => self.download(cx),
            Some(State::ReadyToRestart(_)) if draft_ready => {
                self.fixture_armed = true;
                return true;
            }
            _ => {}
        }
        false
    }
    pub(crate) fn acknowledge_startup(
        &mut self,
        receipt: std::path::PathBuf,
        cx: &mut Context<Self>,
    ) {
        if self.startup_started {
            return;
        }
        self.startup_started = true;
        self.startup_receipt = Some(receipt.clone());
        let (sender, receiver) = async_channel::bounded(1);
        let started = std::thread::Builder::new()
            .name("update-startup-recovery".into())
            .spawn(move || {
                let result = (|| {
                    let trust = pilot_desktop_updater::helper::compiled_trust()?;
                    let target = pilot_desktop_updater::layout::running_root()?;
                    pilot_desktop_updater::app_update::ExitGuard::acknowledge_startup(
                        &receipt, &target, &trust,
                    )
                })()
                .map(|_| receipt.canonicalize().ok());
                let _ = sender.send_blocking(result);
            });
        if started.is_err() {
            self.startup = Some(Err(Error::Native));
            cx.notify();
            return;
        }
        self.startup_task = Some(cx.spawn(async move |owner, cx| {
            let result = receiver
                .recv()
                .await
                .unwrap_or(Err(Error::RecoveryRequired));
            let _ = owner.update(cx, |owner, cx| {
                if let Ok(canonical) = &result {
                    owner.startup_canonical.clone_from(canonical);
                }
                owner.startup = Some(result.map(|_| ()));
                // Once this receipt is acknowledged, its transaction no longer blocks
                // ordinary checks; other recovery rows still do.
                owner.filter_recovery();
                owner.schedule(cx);
                cx.emit(Event::Changed);
                cx.notify();
            });
        }));
    }
    pub(crate) fn automatic(&mut self, value: bool, cx: &mut Context<Self>) {
        if let Some(controller) = self.controller.as_mut() {
            controller.set_automatic(value);
        }
        self.schedule(cx);
    }
    fn schedule(&mut self, cx: &mut Context<Self>) {
        self.timer = None;
        if !self.inspected || self.recovery_blocked() {
            return;
        }
        let Some(deadline) = self.controller.as_ref().and_then(Updater::next_deadline) else {
            return;
        };
        let delay = deadline.saturating_sub(self.epoch.elapsed());
        self.timer = Some(cx.spawn(async move |owner, cx| {
            cx.background_executor().timer(delay).await;
            let _ = owner.update(cx, |owner, cx| {
                owner.supply_access();
                let now = owner.epoch.elapsed();
                // A started automatic check replaces any local candidate label.
                if let Some(controller) = &mut owner.controller
                    && matches!(controller.tick(now), Ok(true))
                {
                    owner.local_build = false;
                }
                owner.schedule(cx);
                cx.emit(Event::Changed);
                cx.notify();
            });
        }));
    }
    fn drain(&mut self, cx: &mut Context<Self>) {
        if let Some(controller) = &mut self.controller {
            if let Some(recovery) = controller.backend_mut().take_recovery() {
                self.inspected = true;
                self.recovery = Some(recovery);
            }
            while let Some(completion) = controller.backend_mut().take_completion() {
                controller.complete(completion, self.epoch.elapsed());
            }
            if self.cancel_prepare && controller.state() == &State::ExitPrepared {
                let _ = controller.abort_retained(self.epoch.elapsed());
            }
            if self.cancel_prepare && matches!(controller.state(), State::ReadyToRestart(_)) {
                self.fenced = false;
                // A cancelled install releases the agents too.
                self.pausing = None;
                self.agents_paused = false;
            }
        }
        self.filter_recovery();
        self.schedule(cx);
        cx.emit(Event::Changed);
        cx.notify();
    }
    fn check(&mut self, cx: &mut Context<Self>) {
        if !self.inspected || self.recovery_blocked() {
            return;
        }
        self.notice = None;
        self.local_build = false;
        self.supply_access();
        if let Some(controller) = &mut self.controller {
            let _ = controller.check(Trigger::Manual, self.epoch.elapsed());
        }
        self.schedule(cx);
        cx.notify();
    }
    fn recovery_blocked(&self) -> bool {
        match &self.recovery {
            Some(Ok(rows)) => !rows.is_empty(),
            Some(Err(_)) => true,
            None => false,
        }
    }
    fn filter_recovery(&mut self) {
        if matches!(self.startup, Some(Ok(())))
            && let (Some(Ok(rows)), Some(receipt)) = (&mut self.recovery, &self.startup_receipt)
        {
            let canonical = self.startup_canonical.as_ref();
            rows.retain(|(path, _)| path != receipt && Some(path) != canonical);
        }
    }
    fn download(&mut self, cx: &mut Context<Self>) {
        self.local_build = false;
        self.supply_access();
        if let Some(controller) = &mut self.controller {
            let _ = controller.download(self.epoch.elapsed());
        }
        self.schedule(cx);
        cx.notify();
    }
    pub(crate) fn navigation(&mut self, value: serde_json::Value) {
        if let Some(controller) = &mut self.controller {
            controller.backend_mut().supply_navigation(value);
        }
    }
    /// A pending folder prompt vetoes restart and close; its result would otherwise
    /// arrive after the checkpoint.
    pub(crate) fn choosing_local(&self) -> bool {
        self.choosing
    }
    fn can_choose_local(&self) -> bool {
        LOCAL_BUILDS
            && self.controller.is_some()
            && self.inspected
            && !self.recovery_blocked()
            && !self.fenced
            && !self.choosing
            && self.pausing.is_none()
            && can_stage(self.state())
    }
    fn choose_local(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_choose_local() {
            return;
        }
        self.choosing = true;
        self.notice = None;
        let response = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose local build folder".into()),
        });
        cx.spawn_in(window, async move |owner, cx| {
            let result = response.await;
            let _ = owner.update(cx, |owner, cx| {
                owner.choosing = false;
                match result {
                    Ok(Ok(Some(mut paths))) if paths.len() == 1 => {
                        owner.stage_local(paths.remove(0), cx)
                    }
                    Ok(Ok(None)) => {}
                    _ => owner.notice = Some("Folder selection failed. Nothing was staged."),
                }
                cx.emit(Event::Changed);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    /// Stages only from a state with no staged or armed transaction. A refused request
    /// leaves the current candidate and its label unchanged.
    fn stage_local(&mut self, directory: std::path::PathBuf, cx: &mut Context<Self>) {
        let stageable = self.inspected
            && !self.recovery_blocked()
            && !self.fenced
            && self.pausing.is_none()
            && can_stage(self.state());
        let Some(controller) = self.controller.as_mut().filter(|_| stageable) else {
            self.notice = Some("Another update step is active. The local build was not staged.");
            return;
        };
        match controller.stage_local(directory, self.epoch.elapsed()) {
            Ok(()) => self.local_build = true,
            Err(Error::Busy) => {
                self.notice = Some("Another update step is active. The local build was not staged.")
            }
            // A synchronous failure is shown by the controller state.
            Err(_) => {}
        }
        self.schedule(cx);
    }
    fn supply_access(&mut self) {
        if let (Some(controller), Some(token)) = (&mut self.controller, &self.access)
            && let Ok(access) =
                pilot_desktop_updater::transport::Access::from_approved_provider(token.clone())
        {
            controller.backend_mut().supply_access(access);
        }
    }
    pub(crate) fn unsaved_access(&self, cx: &gpui_kit::App) -> bool {
        self.access_input
            .as_ref()
            .is_some_and(|i| !i.read(cx).value().is_empty())
    }
    pub(crate) fn marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.access_input
            .as_ref()
            .is_some_and(|i| i.update(cx, |i, cx| i.marked_text_range(window, cx).is_some()))
    }
    fn approve_access(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.fenced || self.marked(window, cx) {
            return;
        }
        let Some(input) = self.access_input.clone() else {
            return;
        };
        let token = input.read(cx).value().to_string();
        if pilot_desktop_updater::transport::Access::from_approved_provider(token.clone()).is_err()
        {
            self.notice = Some(error_text(Error::Authentication));
            cx.notify();
            return;
        }
        self.access = Some(token);
        input.update(cx, |i, cx| i.set_value("", window, cx));
        self.check(cx);
    }
    pub(crate) fn prepare(&mut self, safety: Safety, cx: &mut Context<Self>) {
        if self.location.is_none() && !self.external {
            self.defer(
                "Externally managed daemon. App installation is unavailable in this session.",
                cx,
            );
            return;
        }
        self.fenced = true;
        self.cancel_prepare = false;
        self.notice = None;
        if let Some(controller) = &mut self.controller {
            controller.backend_mut().ui_only(self.local_build);
            let _ = controller.prepare_retained(safety, self.epoch.elapsed());
        }
        self.schedule(cx);
        cx.emit(Event::Changed);
        cx.notify();
    }
    pub(crate) fn commit(&mut self, safety: Safety, cx: &mut Context<Self>) {
        if self.location.is_none() && !self.external {
            return;
        }
        if self.cancel_prepare {
            return;
        }
        if let Some(controller) = &mut self.controller {
            let _ = controller.commit_retained(safety, self.epoch.elapsed());
        }
        cx.emit(Event::Changed);
        cx.notify();
    }
    pub(crate) fn defer(&mut self, message: &'static str, cx: &mut Context<Self>) {
        self.notice = Some(message);
        self.fenced = false;
        self.cancel_prepare = false;
        self.stop_pausing();
        cx.notify();
    }
    /// Pauses agents once their current tool calls finish before installing. Returns true
    /// once they are paused (or there is no daemon to pause). Until then the lease is
    /// renewed off the UI thread, and `Event::Restart` is emitted again when ready.
    pub(crate) fn ensure_agents_paused(&mut self, cx: &mut Context<Self>) -> bool {
        if self.location.is_none() && !self.external {
            self.defer(
                "Externally managed daemon. App installation is unavailable in this session.",
                cx,
            );
            return false;
        }
        // A pinned external connection and a UI-only reload never pause or reserve
        // the daemon; only the app is replaced and agents keep running.
        if self.external || self.local_build {
            return true;
        }
        let Some(location) = self.location.clone() else {
            return false;
        };
        if self.agents_paused {
            return true;
        }
        if self.pausing.is_none() {
            self.notice = None;
            self.pausing = Some(cx.spawn(async move |owner, cx| {
                loop {
                    let target = location.clone();
                    let result =
                        cx.background_executor()
                            .spawn(async move {
                                pilot_desktop_updater::coordination::pause_agents(&target)
                            })
                            .await;
                    let Ok(Some(interval)) = owner.update(cx, |u, cx| u.paused(result, cx)) else {
                        break;
                    };
                    cx.background_executor().timer(interval).await;
                }
            }));
            cx.notify();
        }
        false
    }
    /// Next renewal interval, or None to stop. Renewals stay well inside the 30 second lease.
    fn paused(&mut self, result: Result<bool, Error>, cx: &mut Context<Self>) -> Option<Duration> {
        self.pausing.as_ref()?;
        match result {
            Ok(true) => {
                if !self.agents_paused {
                    self.agents_paused = true;
                    cx.emit(Event::Restart);
                }
                cx.notify();
                Some(Duration::from_secs(5))
            }
            Ok(false) => {
                self.agents_paused = false;
                Some(Duration::from_secs(1))
            }
            Err(_) => {
                self.stop_pausing();
                self.notice = Some(
                    "Agents could not be paused for the update. Installation is deferred and agents resume on their own.",
                );
                cx.notify();
                None
            }
        }
    }
    pub(crate) fn release_agents(&mut self) {
        self.stop_pausing();
    }
    /// Agents resume on their own once the daemon's pause lease lapses.
    fn stop_pausing(&mut self) {
        self.pausing = None;
        self.agents_paused = false;
    }
    fn waiting_for_agents(&self) -> bool {
        self.pausing.is_some() && !self.agents_paused
    }
    pub(crate) fn cancel_prepared(&mut self, message: &'static str, cx: &mut Context<Self>) {
        #[cfg(feature = "native-probes")]
        if pilot_desktop_updater::fixture::enabled() {
            eprintln!("fixture-cancel-prepared={message}");
        }
        self.notice = Some(message);
        self.cancel_prepare = true;
        if let Some(controller) = &mut self.controller {
            let _ = controller.abort_retained(self.epoch.elapsed());
        }
        cx.notify();
    }
    /// The single status line, shared by the view and its mounted probe.
    pub(crate) fn status(&self) -> &'static str {
        let state = self.state();
        let local = self.local_build.then(|| local_text(state)).flatten();
        match state {
            _ if self.waiting_for_agents() => {
                "Pausing agents after their current tool calls finish. Installation continues once they pause."
            }
            _ if local.is_some() => local.unwrap_or_default(),
            None => error_text(self.unavailable.unwrap_or(Error::Unconfigured)),
            Some(State::Idle) => "No update check has completed.",
            Some(State::Current) => "Pilot Next is up to date.",
            Some(State::Available(_)) => {
                "An authenticated update is available. Downloading does not install it."
            }
            Some(State::ReadyToRestart(_)) => {
                "The complete update bundle is verified. Install requires acknowledged safe preparation."
            }
            Some(State::Working {
                work: Work::Checking(_),
                ..
            }) => "Checking for updates…",
            Some(State::Working {
                work: Work::Downloading,
                ..
            }) => "Downloading and verifying the complete app…",
            Some(State::Working {
                work: Work::PreparingExit,
                ..
            }) => "Preparing a safe restart. Input is fenced; no tool call is interrupted.",
            Some(State::Working {
                work: Work::CommittingExit,
                ..
            }) => "Confirming explicit installation. Keep this app open until acknowledged.",
            Some(State::ExitPrepared) => {
                "Safe preparation is ready. Rechecking current durability before COMMIT."
            }
            Some(State::ExitAuthorized) => {
                "Install intent was acknowledged. Waiting for clean app exit; startup is not yet confirmed."
            }
            Some(State::Cancelling { .. }) => {
                "Cancelling. Waiting for the worker to become quiescent…"
            }
            Some(State::Deferred { reason, .. })
            | Some(State::Failed(reason))
            | Some(State::RecoveryRequired(reason)) => error_text(*reason),
            Some(State::Cancelled) => "Cancelled. No update is armed for ordinary Quit.",
            Some(State::Stopped) => "Update checks are stopped.",
        }
    }
    fn cancel(&mut self, cx: &mut Context<Self>) {
        if self.pausing.is_some() && !self.fenced {
            // Nothing is armed yet. The downloaded update stays ready to install.
            self.stop_pausing();
            self.notice = Some("Install cancelled. Agents resume within 30 seconds.");
            cx.emit(Event::Changed);
            cx.notify();
            return;
        }
        if let Some(controller) = &mut self.controller {
            match controller.state() {
                State::Working {
                    work: Work::PreparingExit,
                    ..
                } => self.cancel_prepare = true,
                State::ExitPrepared => {
                    self.cancel_prepare = true;
                    let _ = controller.abort_retained(self.epoch.elapsed());
                }
                _ => {
                    let _ = controller.cancel(self.epoch.elapsed());
                }
            }
        }
        self.schedule(cx);
        cx.emit(Event::Changed);
        cx.notify();
    }
}
/// Status with a stable test ID and accessible name, so its text is observable.
fn status_line(message: &'static str) -> impl IntoElement {
    let line = div()
        .id("updates-status")
        .min_w_0()
        .aria_label(message)
        .child(Notice::new(message).tone(Tone::Quiet));
    #[cfg(feature = "native-probes")]
    let line = gpui_kit::TestSupportExt::test_support(line);
    line
}
/// Local folder staging is macOS-only until Linux is natively qualified.
const LOCAL_BUILDS: bool = cfg!(target_os = "macos");
/// Staging never replaces a staged (ready/deferred) or armed transaction.
fn can_stage(state: Option<&State>) -> bool {
    matches!(
        state,
        Some(
            State::Idle
                | State::Current
                | State::Failed(_)
                | State::Cancelled
                | State::Available(_)
        )
    )
}
fn can_install(
    state: Option<&State>,
    connected: bool,
    fenced: bool,
    choosing: bool,
    pausing: bool,
) -> bool {
    matches!(
        state,
        Some(State::ReadyToRestart(_) | State::Deferred { .. })
    ) && connected
        && !fenced
        && !choosing
        && !pausing
}
fn install_label(local: bool) -> &'static str {
    if local {
        "Reload UI"
    } else {
        "Install and restart…"
    }
}
/// Status for an accepted local build. Other states use the ordinary text.
fn local_text(state: Option<&State>) -> Option<&'static str> {
    Some(match state? {
        State::Working {
            work: Work::Downloading,
            ..
        } => "Verifying the local build…",
        State::ReadyToRestart(_) => {
            "New build ready. Reload UI saves drafts and selection first; the daemon and agents keep running."
        }
        State::Failed(Error::Version) => {
            "This local build is not newer than the running app. Nothing was staged."
        }
        State::Failed(Error::Filesystem | Error::Archive | Error::Identity | Error::Signature) => {
            "This folder is not a complete, signed local build for this app. Nothing was staged."
        }
        _ => return None,
    })
}
fn error_text(error: Error) -> &'static str {
    match error {
        Error::Unconfigured => {
            "Updates are not configured in this development build. No feed or trust key is inferred."
        }
        Error::Authentication => {
            "GitHub refused the update request, usually a rate limit. Retry later, or use an access token for this session."
        }
        Error::ActiveWork | Error::Busy => {
            "Installation is deferred while work or another operation is active. Nothing was stopped."
        }
        Error::Preedit => "Finish composing marked text before installing.",
        Error::PersistenceFailed | Error::PersistencePending => {
            "Draft, outbox or preferences durability is not confirmed. Preserve your text and resolve the save first."
        }
        Error::RuntimeUnverified | Error::Version => {
            "The running daemon or retained runtime is not proven compatible. Installation is deferred; the daemon was left untouched."
        }
        Error::CommitUncertain | Error::RecoveryRequired => {
            "Update recovery is required. The install result is unconfirmed; retained bundles and transaction evidence were preserved."
        }
        Error::Signature | Error::Identity | Error::Archive | Error::RedirectDenied => {
            "The update failed authenticity, identity or archive policy. It was not accepted for installation."
        }
        Error::Offline => "The update service could not be reached. Retry when connected.",
        Error::Cancelled => "The update operation was cancelled. Ordinary Quit does not install.",
        _ => {
            "Update preparation failed. No successful installation is confirmed. Retained evidence was preserved."
        }
    }
}
impl Render for Updates {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.controller.is_some() && self.access_input.is_none() {
            self.access_input = Some(cx.new(|cx| {
                InputState::new(window, cx)
                    .masked(true)
                    .placeholder("Update release access token (session only)")
                    .validate(|v, _| v.len() <= 65_536)
            }));
        }
        let state = self.state();
        let waiting_for_agents = self.waiting_for_agents();
        let message = self.status();
        let checking = !self.inspected
            || self.recovery_blocked()
            || matches!(
                state,
                Some(
                    State::Working { .. }
                        | State::Cancelling { .. }
                        | State::ExitPrepared
                        | State::ExitAuthorized
                        | State::RecoveryRequired(_)
                )
            );
        let can_download = matches!(state, Some(State::Available(_)));
        let can_install = can_install(
            state,
            self.location.is_some() || self.external,
            self.fenced,
            self.choosing,
            self.pausing.is_some(),
        );
        let can_cancel = matches!(
            state,
            Some(
                State::Working {
                    work: Work::Checking(_) | Work::Downloading | Work::PreparingExit,
                    ..
                } | State::ExitPrepared
            )
        ) || (self.fenced && matches!(state, Some(State::ReadyToRestart(_))))
            || waiting_for_agents;
        let mut view = div()
            .id("updates-controller")
            .v_flex()
            .gap_3()
            .child(status_line(message))
            .child(
                ui::action("updates-check", "Check for updates", Action::Secondary)
                    .disabled(self.controller.is_none() || checking || self.fenced)
                    .on_click(cx.listener(|view, _, _, cx| view.check(cx))),
            );
        if self.external {
            view = view.child(
                Notice::new("Connected to an existing daemon. Updates replace only this app; the daemon keeps running.")
                    .tone(Tone::Quiet),
            );
        }
        if self.startup_started {
            let status = match self.startup {
                Some(Ok(())) => "App startup was acknowledged. The daemon kept running.",
                Some(Err(_)) => {
                    "App startup acknowledgement failed. Recovery evidence and retained bundles were preserved; no rollback or cleanup was attempted."
                }
                None => "Confirming durable app startup and the unchanged retained runtime…",
            };
            view = view.child(
                Notice::new(status).tone(if matches!(self.startup, Some(Err(_))) {
                    Tone::Warning
                } else {
                    Tone::Quiet
                }),
            );
        }
        if self.controller.is_some() && !self.inspected {
            view =
                view.child(Notice::new("Inspecting previous update receipts…").tone(Tone::Quiet));
        }
        if self.recovery_blocked() {
            view=view.child(Notice::new("A previous update needs recovery inspection. Nothing was retried, rolled back or deleted.").tone(Tone::Warning))
                .child(ui::action("updates-recovery-details","Recovery details",Action::Secondary).on_click(cx.listener(|u,_,_,cx|{u.recovery_open = !u.recovery_open;cx.notify();})));
            if self.recovery_open {
                match &self.recovery {
                    Some(Ok(rows))=>for (ix,(path,phase)) in rows.iter().enumerate(){
                        let path=path.clone();
                        view=view.child(ui::text(Text::Caption,format!("{phase:?}. {}",path.display())))
                            .child(ui::action(format!("updates-recovery-copy-{ix}"),"Copy recovery path",Action::Quiet).on_click(move|_,_,cx|cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(path.to_string_lossy().into_owned()))));
                    },
                    _=>view=view.child(ui::text(Text::Caption,"Recovery metadata could not be safely read. Preserve retained files and inspect them before attempting another installation.")),
                }
            }
        }
        // Public releases need no token. Offer one only after GitHub refuses a request.
        let wants_access = self.access.is_some()
            || self.unsaved_access(cx)
            || matches!(state, Some(State::Failed(Error::Authentication)));
        if let Some(input) = self.access_input.clone().filter(|_| wants_access) {
            if self.access.is_none() {
                view=view.child(Input::new(&input).disabled(checking || self.fenced))
                    .child(ui::text(Text::Caption,"Explicit access for the configured release repository only. Kept in memory for this app session, never saved or searched in Keychain, gh or provider accounts."))
                    .child(ui::action("updates-authorize","Use for this session and check",Action::Primary).disabled(checking || self.fenced).on_click(cx.listener(|u,_,w,cx|u.approve_access(w,cx))));
                if self.unsaved_access(cx) {
                    view = view.child(
                        ui::action("updates-clear-field", "Clear access field", Action::Quiet)
                            .disabled(checking || self.fenced)
                            .on_click(cx.listener(|u, _, w, cx| {
                                if !u.marked(w, cx)
                                    && let Some(input) = u.access_input.clone()
                                {
                                    input.update(cx, |i, cx| i.set_value("", w, cx));
                                    cx.notify();
                                }
                            })),
                    );
                }
            } else {
                view = view.child(
                    ui::action(
                        "updates-clear-access",
                        "Clear session access",
                        Action::Quiet,
                    )
                    .disabled(checking || self.fenced)
                    .on_click(cx.listener(|u, _, _, cx| {
                        u.access = None;
                        if let Some(controller) = &mut u.controller {
                            controller.backend_mut().clear_access();
                        }
                        cx.notify();
                    })),
                );
            }
        }
        // Explicit local folder staging is offered only where it is natively qualified.
        if LOCAL_BUILDS && self.controller.is_some() {
            view = view.child(
                ui::action("updates-local", "Load local build…", Action::Secondary)
                    .disabled(!self.can_choose_local())
                    .on_click(cx.listener(|view, _, window, cx| view.choose_local(window, cx))),
            );
        }
        if can_download {
            view = view.child(
                ui::action("updates-download", "Download update", Action::Primary)
                    .on_click(cx.listener(|view, _, _, cx| view.download(cx))),
            );
        }
        if can_install {
            view = view.child(
                ui::action(
                    "updates-install",
                    install_label(self.local_build),
                    Action::Primary,
                )
                .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Restart))),
            );
        }
        if can_cancel {
            view = view.child(
                ui::action("updates-cancel", "Cancel", Action::Secondary)
                    .on_click(cx.listener(|view, _, _, cx| view.cancel(cx))),
            );
        }
        if let Some(notice) = self.notice {
            view = view.child(Notice::new(notice).tone(Tone::Warning));
        }
        view.child(ui::text(
            Text::Caption,
            "Automatic checks never authorize silent installation. Quit never installs an update.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pilot_desktop_updater::Candidate;
    fn candidate() -> Candidate {
        Candidate {
            version: "synthetic".into(),
        }
    }
    #[test]
    fn local_build_ready_affordance_is_gated() {
        let ready = State::ReadyToRestart(candidate());
        let deferred = State::Deferred {
            candidate: candidate(),
            reason: Error::ActiveWork,
        };
        assert!(can_install(Some(&ready), true, false, false, false));
        assert!(can_install(Some(&deferred), true, false, false, false));
        for (connected, fenced, choosing, pausing) in [
            (false, false, false, false),
            (true, true, false, false),
            (true, false, true, false),
            (true, false, false, true),
        ] {
            assert!(!can_install(
                Some(&ready),
                connected,
                fenced,
                choosing,
                pausing
            ));
        }
        assert!(!can_install(
            Some(&State::Available(candidate())),
            true,
            false,
            false,
            false
        ));
        assert_eq!(install_label(true), "Reload UI");
        assert_eq!(install_label(false), "Install and restart…");
        assert!(
            local_text(Some(&ready))
                .unwrap()
                .starts_with("New build ready.")
        );
        assert!(local_text(Some(&State::Failed(Error::Version))).is_some());
        assert_eq!(local_text(Some(&State::Failed(Error::Offline))), None);
        assert_eq!(local_text(None), None);
    }
    #[test]
    fn local_staging_never_replaces_a_staged_or_armed_transaction() {
        for state in [
            State::Idle,
            State::Current,
            State::Failed(Error::Offline),
            State::Cancelled,
            State::Available(candidate()),
        ] {
            assert!(can_stage(Some(&state)), "{state:?}");
        }
        for state in [
            State::ReadyToRestart(candidate()),
            State::Deferred {
                candidate: candidate(),
                reason: Error::ActiveWork,
            },
            State::ExitPrepared,
            State::ExitAuthorized,
            State::Working {
                operation: 1,
                work: Work::Downloading,
            },
            State::Cancelling { operation: 1 },
            State::RecoveryRequired(Error::RecoveryRequired),
            State::Stopped,
        ] {
            assert!(!can_stage(Some(&state)), "{state:?}");
        }
        assert!(!can_stage(None));
    }
}
