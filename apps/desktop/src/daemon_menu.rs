//! macOS app-menu controls. The menu owns presentation, the native adapter owns
//! admission and exact service effects. No timer, Quit or updater invokes a control.
use gpui_kit::{App, AppContext, Entity, Global, Menu, MenuItem, Task, Window};
use pilot_desktop_updater::{
    coordination::Location,
    daemon_upgrade::{
        Failure,
        control::{self, Command, State},
    },
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

gpui_kit::actions!(
    daemon_menu,
    [
        StartDaemon,
        StopDaemon,
        RestartDaemon,
        ReloadPi,
        PiReloadDetails,
        InspectDaemon,
        DaemonDetails,
        CancelDaemonControl
    ]
);

struct Report {
    state: State,
    available: bool,
}
type Worker =
    Arc<dyn Fn(Option<Command>, Arc<AtomicBool>) -> Result<Report, Failure> + Send + Sync>;
struct Owner {
    worker: Worker,
    window: Option<gpui_kit::AnyWindowHandle>,
    available: bool,
    state: Option<State>,
    message: String,
    busy: bool,
    command: Option<Command>,
    confirming: bool,
    unknown: bool,
    manual: bool,
    cancel: Arc<AtomicBool>,
    task: Option<Task<()>>,
}
struct Managed(Entity<Owner>);
impl Global for Managed {}
#[derive(Clone, Copy)]
pub(crate) struct Started;
impl gpui_kit::EventEmitter<Started> for Owner {}
#[cfg(feature = "native-probes")]
#[derive(Clone, Copy)]
struct Changed;
#[cfg(feature = "native-probes")]
impl gpui_kit::EventEmitter<Changed> for Owner {}

/// Startup screen reconnects after an acknowledged Start, never by starting again.
pub(crate) fn on_started<T: 'static>(
    cx: &mut gpui_kit::Context<T>,
    callback: impl Fn(&mut T, &mut Window, &mut gpui_kit::Context<T>) + 'static,
    window: &mut Window,
) -> Option<gpui_kit::Subscription> {
    let owner = owner(cx)?;
    Some(
        cx.subscribe_in(&owner, window, move |view, _, _: &Started, w, cx| {
            callback(view, w, cx)
        }),
    )
}

pub(crate) fn init(cx: &mut App) {
    reload::init(cx);
    cx.on_action(|_: &ReloadPi, cx| reload::request(cx));
    cx.on_action(|_: &PiReloadDetails, cx| reload_details(cx));
    cx.on_action(|_: &InspectDaemon, cx| request(None, cx));
    cx.on_action(|_: &StartDaemon, cx| confirm(Command::Start, cx));
    cx.on_action(|_: &StopDaemon, cx| confirm(Command::Stop, cx));
    cx.on_action(|_: &RestartDaemon, cx| confirm(Command::Restart, cx));
    cx.on_action(|_: &DaemonDetails, cx| details(cx));
    cx.on_action(|_: &CancelDaemonControl, cx| {
        if let Some(owner) = owner(cx) {
            owner.read(cx).cancel.store(true, Ordering::Release);
        }
    });
}
fn owner(cx: &App) -> Option<Entity<Owner>> {
    cx.try_global::<Managed>().map(|m| m.0.clone())
}

/// Configure only packaged managed Local. External `--local` never calls this.
pub(crate) fn configure(location: Location, window: gpui_kit::AnyWindowHandle, cx: &mut App) {
    if owner(cx).is_some() {
        return;
    }
    let Ok(trust) = pilot_desktop_updater::helper::compiled_trust() else {
        return;
    };
    if !std::env::current_exe().is_ok_and(|exe| crate::bundled_runtime::packaged(&exe)) {
        return;
    }
    let snapshot = std::sync::Mutex::new(None);
    let worker: Worker = Arc::new(move |command, cancel| {
        let mut snapshot = snapshot.lock().map_err(|_| Failure::Unknown)?;
        if let Some(command) = command {
            let target = snapshot.as_ref().ok_or(Failure::Unverified)?;
            let state = control::execute(target, command, &trust, &cancel)?;
            // Preserve the native operation ACK even if a later read fails.
            *snapshot = control::inspect(location.clone(), &trust).ok();
            return Ok(Report {
                state,
                available: snapshot.is_some(),
            });
        }
        let target = control::inspect(location.clone(), &trust)?;
        let state = target.state();
        *snapshot = Some(target);
        Ok(Report {
            state,
            available: true,
        })
    });
    let entity = cx.new(|_| Owner {
        worker,
        window: Some(window),
        available: false,
        state: None,
        message: "Not checked".into(),
        busy: false,
        command: None,
        confirming: false,
        unknown: false,
        manual: false,
        cancel: Arc::new(AtomicBool::new(false)),
        task: None,
    });
    cx.set_global(Managed(entity));
    request(None, cx);
}

pub(crate) fn manual(cx: &App) -> bool {
    owner(cx).is_some_and(|o| o.read(cx).manual)
}
pub(crate) fn active(cx: &App) -> bool {
    owner(cx).is_some_and(|o| {
        let o = o.read(cx);
        (o.busy && o.command.is_some()) || o.confirming
    })
}

fn window(cx: &App) -> Option<gpui_kit::AnyWindowHandle> {
    cx.active_window()
        .or_else(|| crate::local_view::menu_routing::main_window(cx))
        .or_else(|| owner(cx).and_then(|o| o.read(cx).window))
        .filter(|window| {
            cx.windows()
                .iter()
                .any(|open| open.window_id() == window.window_id())
        })
}
fn permitted(owner: &Owner, command: Command, cx: &App) -> bool {
    !owner.busy
        && !owner.confirming
        && !owner.unknown
        && owner.available
        && window(cx).is_some()
        && crate::local_view::menu_routing::daemon_control_available(cx)
        && matches!(
            (owner.state, command),
            (Some(State::Stopped), Command::Start)
                | (Some(State::Running), Command::Stop | Command::Restart)
        )
}
pub(crate) fn menu(cx: Option<&App>) -> MenuItem {
    let entity = cx.and_then(owner);
    let owner = entity.as_ref().zip(cx).map(|(o, cx)| o.read(cx));
    let enabled = |command| {
        owner
            .zip(cx)
            .is_some_and(|(o, cx)| permitted(o, command, cx))
    };
    let message = owner.map_or("Available for managed Local only".into(), |o| {
        o.message.clone()
    });
    MenuItem::submenu(
        Menu::new("Daemon").items([
            MenuItem::action(message, DaemonDetails)
                .disabled(cx.is_none_or(|cx| window(cx).is_none())),
            MenuItem::separator(),
            MenuItem::action("Start…", StartDaemon).disabled(!enabled(Command::Start)),
            MenuItem::action("Stop…", StopDaemon).disabled(!enabled(Command::Stop)),
            MenuItem::action("Restart…", RestartDaemon).disabled(!enabled(Command::Restart)),
            MenuItem::action("Reload", ReloadPi).disabled(cx.is_none_or(|cx| !reload::enabled(cx))),
            MenuItem::separator(),
            MenuItem::action("Check Status", InspectDaemon)
                .disabled(owner.is_none_or(|o| (o.busy && o.command.is_some()) || o.confirming)),
            MenuItem::action("Cancel Request", CancelDaemonControl)
                .disabled(owner.is_none_or(|o| !o.busy || o.command.is_none())),
            MenuItem::action(
                cx.and_then(reload::label)
                    .unwrap_or("Reload pi extensions and MCP configuration".into()),
                PiReloadDetails,
            ),
        ]),
    )
}
fn refresh(cx: &mut App) {
    crate::app_menu::refresh(cx);
}
fn label(command: Command) -> &'static str {
    match command {
        Command::Start => "Start",
        Command::Stop => "Stop",
        Command::Restart => "Restart",
    }
}

fn confirm(command: Command, cx: &mut App) {
    let Some(owner) = owner(cx) else {
        return;
    };
    if !permitted(owner.read(cx), command, cx) {
        return;
    }
    let Some(handle) = window(cx) else {
        return;
    };
    owner.update(cx, |o, _| o.confirming = true);
    refresh(cx);
    cx.defer(move |cx| {
        let result = handle.update(cx, |_, w, cx| {
            w.prompt(gpui_kit::PromptLevel::Warning, &format!("{} Local daemon?",label(command)),
                Some(match command {
                    Command::Start => "Starts the managed service with its current runtime. Login settings are unchanged.",
                    Command::Stop => "Stops the managed service for this login session. Refused while work is active or can't be checked. Pilot Next stays open.",
                    Command::Restart => "Restarts the managed service on the same runtime; no upgrade. Refused while work is active or can't be checked.",
                }), &[label(command), "Cancel"], cx)
        });
        match result {
            Ok(answer) => { cx.spawn(async move |cx| {
                let answer = answer.await;
                cx.update(|cx| {
                    owner.update(cx, |o,_| o.confirming = false);
                    if matches!(answer, Ok(0)) { request(Some(command), cx); } else { refresh(cx); }
                });
            }).detach(); },
            Err(_) => { owner.update(cx, |o,_| o.confirming=false); refresh(cx); }
        }
    });
}
fn request(command: Option<Command>, cx: &mut App) {
    let Some(owner) = owner(cx) else {
        return;
    };
    if command.is_some_and(|command| !permitted(owner.read(cx), command, cx)) {
        return;
    }
    if owner.read(cx).busy || owner.read(cx).confirming {
        return;
    }
    let (sender, receiver) = async_channel::bounded(1);
    let (worker, cancel) = owner.update(cx, |o, _| {
        o.busy = true;
        o.command = command;
        o.cancel = Arc::new(AtomicBool::new(false));
        o.message = match command {
            None => "Checking status…",
            Some(Command::Start) => "Starting…",
            Some(Command::Stop) => "Stopping…",
            Some(Command::Restart) => "Restarting…",
        }
        .into();
        (o.worker.clone(), o.cancel.clone())
    });
    let started = std::thread::Builder::new()
        .name("managed-daemon-control".into())
        .spawn(move || {
            let _ = sender.send_blocking(worker(command, cancel));
        });
    if started.is_err() {
        owner.update(cx, |o, _| {
            o.busy = false;
            o.command = None;
            o.message = "Could not start the control worker".into();
        });
        refresh(cx);
        return;
    }
    let task = cx.spawn({
        let owner = owner.clone();
        async move |cx| {
            let result = receiver.recv().await.unwrap_or(Err(Failure::Unknown));
            cx.update(|cx| {
                owner.update(cx, |o, cx| {
                    o.busy = false;
                    o.command = None;
                    o.task = None;
                    match result {
                        Ok(report) => {
                            o.manual |= command.is_some();
                            o.state = Some(report.state);
                            o.available = report.available;
                            if o.unknown {
                                o.message = "Outcome unknown. Inspect only".into();
                            } else {
                                o.message = match (command, report.state) {
                                    (None, State::Running) => "Last checked: running",
                                    (None, State::Stopped) => "Last checked: stopped",
                                    (Some(Command::Restart), State::Running) => "Daemon restarted",
                                    (Some(_), State::Running) => "Daemon started",
                                    (Some(_), State::Stopped) => "Daemon stopped",
                                }
                                .into();
                            }
                            if command == Some(Command::Start) {
                                cx.emit(Started);
                            }
                        }
                        Err(failure) => {
                            o.available = false;
                            o.state = None;
                            o.unknown |= failure == Failure::Unknown;
                            o.manual |= command.is_some() && failure == Failure::Unknown;
                            o.message = if o.unknown {
                                "Outcome unknown. Inspect only".into()
                            } else {
                                match failure {
                                    Failure::Busy => "Work is active or cannot be inspected",
                                    Failure::Cancelled => "Cancelled before service changes",
                                    Failure::Unsupported => "Managed service unavailable",
                                    _ => "Service could not be verified",
                                }
                                .into()
                            };
                        }
                    }
                    #[cfg(feature = "native-probes")]
                    cx.emit(Changed);
                });
                refresh(cx);
            });
        }
    });
    owner.update(cx, |o, _| o.task = Some(task));
    refresh(cx);
}
fn details(cx: &mut App) {
    let message=owner(cx).map_or("Daemon controls require a packaged managed Local service.".into(),|o| {
        let o=o.read(cx);
        format!("{}.\n{}",o.message, if o.unknown { "The service may have changed. Inspect .daemon-upgrade.json and the service state. Don't retry or roll back." } else { "Controls only the managed Local service. Quit never stops it. Cancel works only before the service changes." })
    });
    cx.defer(move |cx| {
        if let Some(handle) = window(cx) {
            let _ = handle.update(cx, |_, w, cx| {
                let answer = w.prompt(
                    gpui_kit::PromptLevel::Info,
                    "Local daemon",
                    Some(&message),
                    &["OK"],
                    cx,
                );
                cx.spawn(async move |_| {
                    let _ = answer.await;
                })
                .detach();
            });
        }
    });
}

fn reload_details(cx: &mut App) {
    let status = reload::label(cx).unwrap_or("Reload pi configuration across all chats.".into());
    cx.defer(move |cx| {
        if let Some(handle) = window(cx) {
            let _ = handle.update(cx, |_, w, cx| {
                let message = format!("{status}\n\nReloads pi extensions and MCP configuration without restarting the daemon. Busy chats reload once their work, jobs and subagents finish; sleeping chats when opened. History and drafts are kept.\n\nA chat that fails to reload accepts no new work until you fix its pi configuration and Reload again.");
                let answer = w.prompt(gpui_kit::PromptLevel::Info, "Reload pi configuration", Some(&message), &["OK"], cx);
                cx.spawn(async move |_| { let _ = answer.await; }).detach();
            });
        }
    });
}

#[path = "pi_reload.rs"]
pub(crate) mod reload;

#[cfg(test)]
#[path = "daemon_menu_tests.rs"]
mod tests;

#[cfg(feature = "native-probes")]
#[path = "daemon_menu_native.rs"]
pub(crate) mod native;
