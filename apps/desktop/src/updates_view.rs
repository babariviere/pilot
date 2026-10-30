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
    Candidate, Error, Progress, Safety, State, Trigger, Updater, Work, coordination::Location,
    worker::Worker,
};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(crate) enum Event {
    Restart,
    Changed,
    UpgradeDaemon,
    DaemonChanged,
    /// Show the place named by the current install refusal.
    ShowBlocker,
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
    /// What the last install refusal named, for its Show action while that notice is shown.
    pub(crate) blocker: Option<crate::update_hold::Blocker>,
    /// The profile daemon whose exact retained runtime is verified before installing.
    location: Option<Location>,
    external: bool,
    local_build: bool,
    choosing: bool,
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
    rechecking: bool,
    startup_receipt: Option<std::path::PathBuf>,
    #[cfg(feature = "native-probes")]
    fixture_armed: bool,
    /// Probe-only injected controller state for mounted UI checks; never in production.
    #[cfg(feature = "native-probes")]
    probe_state: Option<State>,
    #[cfg(feature = "native-probes")]
    probe_target: Option<Candidate>,
    #[cfg(feature = "native-probes")]
    probe_progress: Option<Progress>,
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
            assert!(updates.notice.is_none());
            let ready = State::ReadyToRestart(pilot_desktop_updater::Candidate {
                version: "synthetic".into(),
                short_version: "0.1.1".into(),
            });
            assert!(can_install(Some(&ready), true, false, false));
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
        // Managed and local app updates have the same GUI-only authority.
        let updates = cx.new(|cx| Self::new(Some(synthetic("/synthetic-managed")), None, cx));
        updates.update(cx, |updates, cx| {
            for local in [false, true] {
                updates.local_build = local;
                updates.prepare(safety, cx);
                assert!(updates.fenced, "only GUI admissions are fenced");
                assert!(updates.notice.is_none());
                updates.defer("synthetic", cx);
                assert!(!updates.fenced);
            }
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
                short_version: "0.1.1".into(),
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
                // Fenced preparation, an open folder chooser, a failed local build and a
                // staging refusal hide the action; a deferral can be retried.
                type Case = (&'static str, fn(&mut Updates));
                let cases: [Case; 5] = [
                    ("fenced", |u| u.fenced = true),
                    ("choosing", |u| u.choosing = true),
                    ("failed", |u| {
                        u.probe_state = Some(State::Failed(Error::Version))
                    }),
                    ("capacity", |u| {
                        u.probe_state = Some(State::Failed(Error::StagingCapacity))
                    }),
                    ("deferred", |u| {
                        u.probe_state = Some(State::Deferred {
                            candidate: pilot_desktop_updater::Candidate {
                                version: "synthetic-local".into(),
                                short_version: "0.1.1".into(),
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
                        if name == "capacity" {
                            let status = updates.read(cx).status();
                            assert!(status.starts_with("The update was not staged."));
                            assert!(!status.contains("unconfirmed"), "not an uncertain install");
                            let line = w.find("updates-status").bounds();
                            assert!(line.left() >= px(0.) && line.right() <= px(width));
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
    /// Mounted Updates pane showing the checked version and download progress from
    /// injected state. No Worker, network, transaction or daemon exists.
    #[cfg(all(feature = "native-probes", target_os = "macos"))]
    pub(crate) fn probe_download_progress(
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
        let release = Candidate {
            version: "4210.1".into(),
            short_version: "1.85.0".into(),
        };
        // The longest signed short version the manifest admits.
        let long = Candidate {
            version: "999999999.999999999.999999999.999999999".into(),
            short_version: format!("1.85.0-{}", "rc.".repeat(19)),
        };
        let downloading = State::Working {
            operation: 2,
            work: Work::Downloading,
        };
        for width in [680., 1100.] {
            for dark in [false, true] {
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
                                    let mut u = Self::blank(None, true);
                                    u.inspected = true;
                                    u
                                })
                            },
                        )
                    })
                    .unwrap();
                let changes = Rc::new(Cell::new(0usize));
                let _counter = cx.update(|cx| {
                    let changes = changes.clone();
                    cx.subscribe(&updates, move |_, event: &Event, _| {
                        if matches!(event, Event::Changed) {
                            changes.set(changes.get() + 1);
                        }
                    })
                });
                let set = |cx: &mut HeadlessAppContext,
                           state: State,
                           target: Option<&Candidate>,
                           progress: Option<Progress>| {
                    cx.update(|cx| {
                        updates.update(cx, |u, cx| {
                            u.probe_state = Some(state);
                            u.probe_target = target.cloned();
                            u.probe_progress = progress;
                            cx.notify();
                        })
                    });
                    settle(cx, h);
                };
                let capture = |cx: &mut HeadlessAppContext, state: &str| {
                    if let Some(directory) = captures {
                        let name = if dark { "dark" } else { "light" };
                        cx.capture_screenshot(h)
                            .unwrap()
                            .save(
                                directory
                                    .join(format!("{}-{name}-updates-{state}.png", width as u32)),
                            )
                            .unwrap();
                    }
                };
                let inside = |bounds: Bounds<gpui_kit::Pixels>| {
                    bounds.left() >= px(0.)
                        && bounds.right() <= px(width)
                        && bounds.size.width > px(0.)
                };
                // Before download: the exact signed version, its build, and no bar.
                set(cx, State::Available(release.clone()), Some(&release), None);
                cx.update_window(h, |_, w, _| {
                    let target = w.find("updates-target");
                    assert!(target.visible() && inside(target.bounds()));
                    assert_eq!(target.label(), Some("Pilot Next 1.85.0, Build 4210.1"));
                    let app = format!(
                        "Current app: {}",
                        crate::running_identity::RunningApp::current().display()
                    );
                    let current = w.find("updates-current-app");
                    assert_eq!(current.label(), Some(app.as_str()));
                    assert!(current.bounds().bottom() <= target.bounds().top());
                    assert!(w.find("updates-download").visible());
                    // Actions hug their labels on one row instead of spanning the pane.
                    let download = w.find("updates-download").bounds();
                    let check = w.find("updates-check").bounds();
                    assert!(download.size.width < px(200.), "{download:?}");
                    assert!(check.size.width < px(200.), "{check:?}");
                    assert_eq!(download.top(), check.top());
                    assert!(download.right() <= check.left(), "next step comes first");
                    assert!(w.try_find("updates-progress").is_none());
                    assert!(w.try_find("updates-cancel").is_none());
                })
                .unwrap();
                capture(cx, "available");
                // Transfer: the same version stays named above a measured bar.
                let total = 45_600_000;
                let mut track = None;
                for (received, percent) in [(0, 0.), (18_240_000, 40.), (total, 100.)] {
                    set(
                        cx,
                        downloading.clone(),
                        Some(&release),
                        Some(Progress::Transferring { received, total }),
                    );
                    let bar = cx
                        .update_window(h, |_, w, cx| {
                            assert!(updates.read(cx).status().starts_with("Downloading"));
                            assert_eq!(
                                w.find("updates-target").label(),
                                Some("Pilot Next 1.85.0, Build 4210.1")
                            );
                            let bar = w.find("updates-progress");
                            assert!(bar.visible() && inside(bar.bounds()));
                            assert_eq!(bar.bounds().size.height, px(6.));
                            assert_eq!(
                                bar.bounds().left(),
                                w.find("updates-status").bounds().left()
                            );
                            let caption = w.find("updates-progress-caption");
                            assert!(caption.visible() && inside(caption.bounds()));
                            assert!(caption.label().unwrap().ends_with(" of 45.6 MB"));
                            assert!(w.try_find("updates-download").is_none());
                            assert!(w.try_find("updates-install").is_none());
                            bar.bounds()
                        })
                        .unwrap();
                    // Let Kit's value transition finish, then measure the painted fill.
                    for _ in 0..20 {
                        cx.advance_clock(Duration::from_millis(50));
                        settle(cx, h);
                    }
                    let image = cx.capture_screenshot(h).unwrap();
                    let scale = image.width() as f32 / width;
                    let y = ((f32::from(bar.top()) + 3.) * scale) as u32;
                    // Skip the rounded caps, whose pixels blend with the page.
                    let (left, right) = (
                        ((f32::from(bar.left()) + 4.) * scale) as u32,
                        ((f32::from(bar.right()) - 4.) * scale) as u32,
                    );
                    let track = *track.get_or_insert(image.get_pixel(right - 1, y).0);
                    let filled = (left..right)
                        .filter(|x| {
                            let pixel = image.get_pixel(*x, y).0;
                            (0..3).any(|c| pixel[c].abs_diff(track[c]) > 12)
                        })
                        .count() as f32
                        / (right - left) as f32;
                    let expected = (percent / 100. * f32::from(bar.size.width) - 4.).max(0.)
                        / (f32::from(bar.size.width) - 8.);
                    assert!(
                        (filled - expected.min(1.)).abs() < 0.03,
                        "{percent}%: painted {filled}, expected {expected}"
                    );
                    if received == 18_240_000 {
                        capture(cx, "downloading");
                    }
                }
                // Unknown and verification are indeterminate, named by their caption.
                for (progress, caption) in [
                    (None, "Starting download…"),
                    (Some(Progress::Verifying), "Verifying the download…"),
                ] {
                    set(cx, downloading.clone(), Some(&release), progress);
                    cx.update_window(h, |_, w, _| {
                        let bar = w.find("updates-progress");
                        assert!(bar.visible() && inside(bar.bounds()));
                        assert_eq!(bar.label(), Some(caption));
                        assert_eq!(w.find("updates-progress-caption").label(), Some(caption));
                        assert!(w.find("updates-cancel").visible());
                    })
                    .unwrap();
                }
                capture(cx, "verifying");
                // Cancel stays reachable by keyboard during the transfer.
                set(
                    cx,
                    downloading.clone(),
                    Some(&release),
                    Some(Progress::Transferring { received: 1, total }),
                );
                let before = changes.get();
                cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
                for _ in 0..12 {
                    if cx
                        .update_window(h, |_, w, _| {
                            w.find("updates-cancel").focused() == Some(true)
                        })
                        .unwrap()
                    {
                        break;
                    }
                    cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                }
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find("updates-cancel").focused(), Some(true));
                    w.press("enter", cx);
                })
                .unwrap();
                settle(cx, h);
                assert_eq!(changes.get(), before + 1, "one key activation, one cancel");
                // Long signed versions wrap inside the pane.
                set(cx, downloading.clone(), Some(&long), None);
                cx.update_window(h, |_, w, _| {
                    assert!(inside(w.find("updates-target").bounds()));
                })
                .unwrap();
                // Failure and no-update states name no version and show no bar.
                for state in [
                    State::Failed(Error::Signature),
                    State::Cancelled,
                    State::Current,
                ] {
                    set(cx, state, None, None);
                    cx.update_window(h, |_, w, _| {
                        assert!(w.try_find("updates-target").is_none());
                        assert!(w.try_find("updates-progress").is_none());
                    })
                    .unwrap();
                }
                // Staged: the version remains; the bar is gone.
                set(
                    cx,
                    State::ReadyToRestart(release.clone()),
                    Some(&release),
                    None,
                );
                cx.update_window(h, |_, w, _| {
                    assert!(w.find("updates-target").visible());
                    assert!(w.try_find("updates-progress").is_none());
                    assert!(w.find("updates-install").visible());
                })
                .unwrap();
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
            }
        }
    }
    /// Production pane, synthetic historical recovery only. Buttons never run a worker.
    #[cfg(all(feature = "native-probes", target_os = "macos"))]
    pub(crate) fn probe_recovery(
        cx: &mut gpui_kit::HeadlessAppContext,
        captures: Option<&std::path::Path>,
    ) {
        use gpui_kit::component::{Theme, ThemeMode};
        use gpui_kit::{Bounds, WindowBounds, WindowOptions, px, size, test::TestWindowExt};
        for width in [680., 1100.] {
            for dark in [false, true] {
                cx.update(|cx| {
                    Theme::change(
                        if dark {
                            ThemeMode::Dark
                        } else {
                            ThemeMode::Light
                        },
                        None,
                        cx,
                    )
                });
                let (h, u) = cx
                    .update(|cx| {
                        gpui_kit::open_window(
                            WindowOptions {
                                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                    Default::default(),
                                    size(px(width), px(580.)),
                                ))),
                                show: false,
                                focus: false,
                                ..Default::default()
                            },
                            cx,
                            |_, cx| {
                                cx.new(|_| {
                                    let mut u = Self::blank(None, true);
                                    u.inspected = true;
                                    u.probe_state = Some(State::Idle);
                                    u.recovery = Some(Ok(vec![(
                                        "/synthetic/retained-update".into(),
                                        pilot_desktop_updater::installer::Phase::Committed,
                                    )]));
                                    u
                                })
                            },
                        )
                    })
                    .unwrap();
                for _ in 0..4 {
                    cx.run_until_parked();
                    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
                }
                cx.update_window(h, |_, w, cx| {
                    assert_ne!(w.find("updates-check").disabled(), Some(true));
                    assert_ne!(w.find("updates-local").disabled(), Some(true));
                    assert_ne!(w.find("updates-recovery-recheck").disabled(), Some(true));
                    w.click("updates-recovery-details", cx);
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
                if let Some(directory) = captures {
                    let name = if dark { "dark" } else { "light" };
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(directory.join(format!("{width}-{name}-recovery.png")))
                        .unwrap();
                }
                cx.update(|cx| {
                    u.update(cx, |u, _| {
                        u.probe_state = Some(State::ReadyToRestart(Candidate {
                            version: "synthetic".into(),
                            short_version: "0.1.1".into(),
                        }));
                    })
                });
                cx.update_window(h, |_, w, cx| {
                    w.render_frame(cx);
                    assert!(
                        w.try_find("updates-install").is_none(),
                        "uncertainty forbids activation, not downloads"
                    );
                })
                .unwrap();
                cx.update(|cx| u.update(cx, |u, _| u.recovery = Some(Ok(vec![]))));
                cx.update_window(h, |_, w, cx| {
                    w.render_frame(cx);
                    assert_ne!(w.find("updates-install").disabled(), Some(true));
                    w.remove_window();
                })
                .unwrap();
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
    /// A controller-free UI-only reload that is ready to install. No worker, trust,
    /// transaction, daemon or profile exists, and agents are never paused for it.
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_ready_local() -> Self {
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
        u.probe_state = Some(State::ReadyToRestart(pilot_desktop_updater::Candidate {
            version: "synthetic-local".into(),
            short_version: "0.1.1".into(),
        }));
        u
    }
    /// Inject only the controller result, not an installation or helper acknowledgment.
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_exit_authorized(&mut self) {
        assert!(self.controller.is_none());
        self.probe_state = Some(State::ExitAuthorized);
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
            rechecking: false,
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
            blocker: None,
            location,
            external,
            local_build: false,
            choosing: false,
            #[cfg(feature = "native-probes")]
            probe_state: None,
            #[cfg(feature = "native-probes")]
            probe_target: None,
            #[cfg(feature = "native-probes")]
            probe_progress: None,
        }
    }
    pub(crate) fn state(&self) -> Option<&State> {
        #[cfg(feature = "native-probes")]
        if let Some(state) = &self.probe_state {
            return Some(state);
        }
        self.controller.as_ref().map(Updater::state)
    }
    /// The checked release the current state refers to, from signed metadata only.
    fn target(&self) -> Option<&Candidate> {
        #[cfg(feature = "native-probes")]
        if self.probe_state.is_some() {
            return self.probe_target.as_ref();
        }
        self.controller.as_ref().and_then(Updater::target)
    }
    /// `Some` while downloading or staging, holding the worker's latest report.
    fn transfer(&self) -> Option<Option<Progress>> {
        let Some(State::Working {
            operation,
            work: Work::Downloading,
        }) = self.state()
        else {
            return None;
        };
        #[cfg(feature = "native-probes")]
        if self.probe_state.is_some() {
            return Some(self.probe_progress);
        }
        Some(
            self.controller
                .as_ref()
                .and_then(|controller| controller.backend().progress(*operation)),
        )
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
        receipt: Option<std::path::PathBuf>,
        cx: &mut Context<Self>,
    ) {
        if self.startup_started {
            return;
        }
        self.startup_started = true;
        self.startup_receipt = receipt.clone();
        let (sender, receiver) = async_channel::bounded(1);
        let started = std::thread::Builder::new()
            .name("update-startup-recovery".into())
            .spawn(move || {
                let result = (|| {
                    let trust = pilot_desktop_updater::helper::compiled_trust()?;
                    let target = pilot_desktop_updater::layout::running_root()?;
                    let receipt = match receipt {
                        Some(receipt) => receipt,
                        None => pilot_desktop_updater::installer::startup_receipt(
                            &target,
                            &trust,
                            &pilot_desktop_updater::installer::NativePlatform,
                        )?
                        .ok_or(Error::RecoveryRequired)?,
                    };
                    pilot_desktop_updater::app_update::ExitGuard::acknowledge_startup(
                        &receipt, &target, &trust,
                    )?;
                    let canonical = receipt.canonicalize().ok();
                    Ok((receipt, canonical))
                })();
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
                if let Ok((receipt, canonical)) = &result {
                    crate::bundled_runtime::acknowledge_update_receipt(receipt);
                    owner.startup_receipt = Some(receipt.clone());
                    owner.startup_canonical.clone_from(canonical);
                }
                owner.startup = Some(result.map(|_| ()));
                // Once this receipt is acknowledged, its transaction no longer blocks
                // activation; other recovery rows still do.
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
        if !self.inspected {
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
                self.rechecking = false;
                self.recovery = Some(recovery);
                if matches!(&self.recovery, Some(Ok(rows)) if rows.is_empty())
                    && matches!(self.startup, Some(Err(_)))
                {
                    // A fresh empty scan removes an obsolete warning, not a success ACK.
                    self.startup_started = false;
                    self.startup = None;
                }
            }
            while let Some(completion) = controller.backend_mut().take_completion() {
                controller.complete(completion, self.epoch.elapsed());
            }
            if self.cancel_prepare && controller.state() == &State::ExitPrepared {
                let _ = controller.abort_retained(self.epoch.elapsed());
            }
            if self.cancel_prepare && matches!(controller.state(), State::ReadyToRestart(_)) {
                self.fenced = false;
            }
        }
        self.filter_recovery();
        self.schedule(cx);
        cx.emit(Event::Changed);
        cx.notify();
    }
    fn check(&mut self, cx: &mut Context<Self>) {
        if self.checking() || self.fenced {
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
    /// A daemon boot change must not invalidate a GUI receipt before its durable ACK.
    pub(crate) fn daemon_upgrade_ready(&self) -> bool {
        self.inspected
            && !self.recovery_blocked()
            && (!(crate::bundled_runtime::update_receipt().is_some()
                || self.startup_receipt.is_some()
                || self.has_startup_recovery()
                || self.startup_started)
                || matches!(self.startup, Some(Ok(()))))
    }
    fn checking(&self) -> bool {
        !self.inspected
            || matches!(
                self.state(),
                Some(
                    State::Working { .. }
                        | State::Cancelling { .. }
                        | State::ExitPrepared
                        | State::ExitAuthorized
                        | State::RecoveryRequired(_)
                )
            )
    }
    /// Inspection never retries installation. Only an exact existing startup receipt
    /// can be acknowledged, after the parent has loaded its durable UI state.
    pub(crate) fn has_startup_recovery(&self) -> bool {
        use pilot_desktop_updater::installer::Phase;
        self.recovery.as_ref().is_some_and(|rows| {
            rows.as_ref().is_ok_and(|rows| {
                rows.iter()
                    .any(|(_, phase)| matches!(phase, Phase::Swapped | Phase::RelaunchRequested))
            })
        })
    }
    fn recheck_recovery(&mut self, cx: &mut Context<Self>) {
        if self.rechecking || self.fenced || self.checking() {
            return;
        }
        let Some(controller) = &mut self.controller else {
            return;
        };
        match controller.backend_mut().inspect_recovery() {
            Ok(()) => {
                self.rechecking = true;
                // A retry can revalidate a previously failed startup receipt, never a swap.
                if matches!(self.startup, Some(Err(_))) {
                    self.startup_started = false;
                    self.startup = None;
                }
            }
            Err(_) => {
                self.notice =
                    Some("The update worker is busy. Recheck when its current step finishes.")
            }
        }
        cx.notify();
    }
    fn has_controller(&self) -> bool {
        #[cfg(feature = "native-probes")]
        if self.probe_state.is_some() {
            return true;
        }
        self.controller.is_some()
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
            && self.has_controller()
            && self.inspected
            && !self.fenced
            && !self.choosing
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
        let stageable = self.inspected && !self.fenced && can_stage(self.state());
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
        if self.recovery_blocked() {
            self.defer("Recheck the previous installation before restarting. Checking and downloading remain available.", cx);
            return;
        }
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
        self.blocker = None;
        self.fenced = false;
        self.cancel_prepare = false;
        cx.notify();
    }
    /// Defers with the blocker's own message and offers to show where it is.
    pub(crate) fn block(&mut self, blocker: crate::update_hold::Blocker, cx: &mut Context<Self>) {
        self.defer(blocker.message(), cx);
        self.blocker = Some(blocker);
    }
    /// The Show label, only while the blocker's notice is the one displayed.
    fn blocker_action(&self) -> Option<&'static str> {
        use crate::update_hold::Destination;
        let blocker = self.blocker.as_ref()?;
        if self.notice != Some(blocker.message()) {
            return None;
        }
        Some(match blocker.destination()? {
            Destination::ScopedModels => "Open Scoped models",
            Destination::MainWindow => "Show",
            Destination::Chat(_) => "Open chat",
            Destination::Missions => "Open Missions",
            Destination::Mission(_) => "Open mission",
        })
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
/// Buttons hug their labels in a wrapping row instead of stretching across the pane.
fn action_row() -> gpui_kit::Div {
    div().h_flex().flex_wrap().items_center().gap_2()
}
/// The signed release version, with its build number as quieter detail.
fn target_line(candidate: &Candidate, muted: gpui_kit::Hsla) -> impl IntoElement {
    let name = format!("Pilot Next {}", candidate.short_version);
    let build = format!("Build {}", candidate.version);
    let line = div()
        .id("updates-target")
        .h_flex()
        .flex_wrap()
        .items_center()
        .gap_x_2()
        .min_w_0()
        .aria_label(format!("{name}, {build}"))
        .child(ui::text(Text::Body, name).font_medium())
        .child(ui::text(Text::Caption, build).text_color(muted));
    #[cfg(feature = "native-probes")]
    let line = gpui_kit::TestSupportExt::test_support(line);
    line
}
/// Decimal units, as Finder reports file sizes.
fn size(bytes: u64) -> String {
    for (unit, name) in [(1e9, "GB"), (1e6, "MB"), (1e3, "KB")] {
        if bytes as f64 >= unit {
            return format!("{:.1} {name}", bytes as f64 / unit);
        }
    }
    format!("{bytes} bytes")
}
/// Bar percentage and caption. Only reported bytes against the signed size are
/// determinate; a complete transfer still reads as verifying, never as done.
fn transfer_text(progress: Option<Progress>, local: bool) -> (Option<f32>, Option<String>) {
    match progress {
        Some(Progress::Transferring { received, total }) if total > 0 => {
            let received = received.min(total);
            (
                Some(received as f32 * 100. / total as f32),
                Some(format!("{} of {}", size(received), size(total))),
            )
        }
        Some(Progress::Verifying) => (None, Some("Verifying the download…".into())),
        // The local build status line already says what is happening.
        _ if local => (None, None),
        _ => (None, Some("Starting download…".into())),
    }
}
fn transfer_view(
    progress: Option<Progress>,
    local: bool,
    muted: gpui_kit::Hsla,
) -> impl IntoElement {
    let (percent, caption) = transfer_text(progress, local);
    let label = caption.clone().unwrap_or_else(|| "Verifying".into());
    div()
        .v_flex()
        .gap_1()
        .min_w_0()
        .child(ui::transfer_progress("updates-progress", percent, label))
        .children(caption.map(|caption| {
            let line = div()
                .id("updates-progress-caption")
                .min_w_0()
                .aria_label(caption.clone())
                .child(ui::text(Text::Caption, caption).text_color(muted));
            #[cfg(feature = "native-probes")]
            let line = gpui_kit::TestSupportExt::test_support(line);
            line
        }))
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
fn can_install(state: Option<&State>, connected: bool, fenced: bool, choosing: bool) -> bool {
    matches!(
        state,
        Some(State::ReadyToRestart(_) | State::Deferred { .. })
    ) && connected
        && !fenced
        && !choosing
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
        // Refused before staging. Nothing was installed, so this is not recovery-uncertain.
        Error::StagingCapacity => {
            "The update was not staged. Retained update records fill the staging limit; nothing was installed. Inspect them before retrying."
        }
        Error::StagingArchiveFailed => {
            "The update was not staged. Completed update records could not be archived to make room; nothing was installed and they were kept. Retry later."
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
        let message = self.status();
        let checking = self.checking();
        let can_download = matches!(state, Some(State::Available(_)));
        let can_install = !self.recovery_blocked()
            && can_install(
                state,
                self.location.is_some() || self.external,
                self.fenced,
                self.choosing,
            );
        let can_cancel = matches!(
            state,
            Some(
                State::Working {
                    work: Work::Checking(_) | Work::Downloading | Work::PreparingExit,
                    ..
                } | State::ExitPrepared
            )
        ) || (self.fenced && matches!(state, Some(State::ReadyToRestart(_))));
        let muted = {
            use gpui_kit::component::ActiveTheme;
            cx.theme().muted_foreground
        };
        let target = self.target().map(|candidate| target_line(candidate, muted));
        let transfer = self
            .transfer()
            .map(|progress| transfer_view(progress, self.local_build, muted));
        // One compact row: the next step first, then Cancel, then routine commands.
        let mut actions = action_row().id("updates-actions");
        if can_download {
            actions = actions.child(
                ui::action("updates-download", "Download update", Action::Primary)
                    .on_click(cx.listener(|view, _, _, cx| view.download(cx))),
            );
        }
        if can_install {
            actions = actions.child(
                ui::action(
                    "updates-install",
                    install_label(self.local_build),
                    Action::Primary,
                )
                .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Restart))),
            );
        }
        if can_cancel {
            actions = actions.child(
                ui::action("updates-cancel", "Cancel", Action::Secondary)
                    .on_click(cx.listener(|view, _, _, cx| view.cancel(cx))),
            );
        }
        actions = actions.child(
            ui::action("updates-check", "Check for updates", Action::Secondary)
                .disabled(!self.has_controller() || checking || self.fenced)
                .on_click(cx.listener(|view, _, _, cx| view.check(cx))),
        );
        // Explicit local folder staging is offered only where it is natively qualified.
        if LOCAL_BUILDS && self.has_controller() {
            actions = actions.child(
                ui::action("updates-local", "Load local build…", Action::Secondary)
                    .disabled(!self.can_choose_local())
                    .on_click(cx.listener(|view, _, window, cx| view.choose_local(window, cx))),
            );
        }
        let mut view = div()
            .id("updates-controller")
            .v_flex()
            .gap_3()
            .child(crate::running_identity::identity_row(
                "updates-current-app",
                "Current app",
                crate::running_identity::RunningApp::current().display(),
            ))
            .child(status_line(message))
            .children(target)
            .children(transfer)
            .child(actions);
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
            let message = match &self.recovery {
                Some(Err(Error::Signature | Error::Identity | Error::Version)) => {
                    "The installed app could not be verified. Check or load an update, then recheck before installation."
                }
                Some(Err(_)) => {
                    "Previous update files could not be inspected. Checking and downloading are available; installation waits for a successful recheck."
                }
                _ => {
                    "A previous installation is unconfirmed. Check or load an update, or recheck the retained installation. Nothing is automatically reinstalled."
                }
            };
            view = view.child(Notice::new(message).tone(Tone::Warning)).child(
                action_row()
                    .child(
                        ui::action(
                            "updates-recovery-recheck",
                            if self.rechecking {
                                "Rechecking…"
                            } else {
                                "Recheck installation"
                            },
                            Action::Secondary,
                        )
                        .disabled(self.rechecking || checking || self.fenced)
                        .on_click(cx.listener(|u, _, _, cx| u.recheck_recovery(cx))),
                    )
                    .child(
                        ui::action(
                            "updates-recovery-details",
                            "Recovery details",
                            Action::Quiet,
                        )
                        .on_click(cx.listener(|u, _, _, cx| {
                            u.recovery_open = !u.recovery_open;
                            cx.notify();
                        })),
                    ),
            );
            if self.recovery_open {
                match &self.recovery {
                    Some(Ok(rows))=>for (ix,(path,phase)) in rows.iter().enumerate(){
                        let path=path.clone();
                        view=view.child(ui::text(Text::Caption,format!("{phase:?}. {}",path.display())))
                            .child(action_row().child(ui::action(format!("updates-recovery-copy-{ix}"),"Copy recovery path",Action::Quiet).on_click(move|_,_,cx|cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(path.to_string_lossy().into_owned())))));
                    },
                    Some(Err(error))=>view=view.child(ui::text(Text::Caption,format!("Inspection failed: {error:?}. Recheck after the current installer finishes or file access is restored. Retained files are unchanged."))),
                    _=>{},
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
                    .child(ui::text(Text::Caption,"Explicit access for the configured release repository only. Kept in memory for this app session, never saved or searched in Keychain, gh or provider accounts."));
                let mut access = action_row().child(
                    ui::action(
                        "updates-authorize",
                        "Use for this session and check",
                        Action::Primary,
                    )
                    .disabled(checking || self.fenced)
                    .on_click(cx.listener(|u, _, w, cx| u.approve_access(w, cx))),
                );
                if self.unsaved_access(cx) {
                    access = access.child(
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
                view = view.child(access);
            } else {
                view = view.child(
                    action_row().child(
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
                    ),
                );
            }
        }
        if let Some(notice) = self.notice {
            view = view.child(Notice::new(notice).tone(Tone::Warning));
        }
        if let Some(label) = self.blocker_action() {
            view = view.child(
                action_row().child(
                    ui::action("updates-show-blocker", label, Action::Secondary)
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::ShowBlocker))),
                ),
            );
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
            short_version: "0.1.1".into(),
        }
    }
    #[test]
    fn local_build_ready_affordance_is_gated() {
        let ready = State::ReadyToRestart(candidate());
        let deferred = State::Deferred {
            candidate: candidate(),
            reason: Error::ActiveWork,
        };
        assert!(can_install(Some(&ready), true, false, false));
        assert!(can_install(Some(&deferred), true, false, false));
        for (connected, fenced, choosing) in [
            (false, false, false),
            (true, true, false),
            (true, false, true),
        ] {
            assert!(!can_install(Some(&ready), connected, fenced, choosing));
        }
        assert!(!can_install(
            Some(&State::Available(candidate())),
            true,
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
    #[test]
    fn staging_refusals_are_not_reported_as_uncertain_installs() {
        let uncertain = error_text(Error::RecoveryRequired);
        let generic = error_text(Error::InstallFailed);
        for error in [Error::StagingCapacity, Error::StagingArchiveFailed] {
            let text = error_text(error);
            assert_ne!(text, uncertain, "{error:?}");
            assert_ne!(text, generic, "{error:?}");
            assert!(text.starts_with("The update was not staged."), "{text}");
            assert!(text.contains("nothing was installed"), "{text}");
            assert!(!text.contains("unconfirmed"), "{text}");
        }
        // A refused stage leaves ordinary retry and local staging available.
        assert!(can_stage(Some(&State::Failed(Error::StagingCapacity))));
        assert_eq!(
            local_text(Some(&State::Failed(Error::StagingCapacity))),
            None
        );
    }
    #[test]
    fn transfer_is_determinate_only_for_reported_bytes() {
        let at = |received, total| {
            transfer_text(Some(Progress::Transferring { received, total }), false)
        };
        assert_eq!(
            at(0, 45_600_000),
            (Some(0.), Some("0 bytes of 45.6 MB".into()))
        );
        assert_eq!(
            at(12_340_000, 45_600_000).1.as_deref(),
            Some("12.3 MB of 45.6 MB")
        );
        let percents: Vec<f32> = [0, 1, 999, 22_800_000, 45_600_000]
            .into_iter()
            .map(|received| at(received, 45_600_000).0.unwrap())
            .collect();
        assert!(percents.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(percents.last(), Some(&100.));
        assert_eq!(at(22_800_000, 45_600_000).0, Some(50.));
        // Never more than the signed size, and a zero size is not a percentage.
        assert_eq!(at(9, 4).0, Some(100.));
        assert_eq!(at(0, 0).0, None);
        // Unknown and verification stay indeterminate; a full transfer is not "done".
        assert_eq!(
            transfer_text(None, false),
            (None, Some("Starting download…".into()))
        );
        assert_eq!(transfer_text(None, true), (None, None));
        assert_eq!(
            transfer_text(Some(Progress::Verifying), true),
            (None, Some("Verifying the download…".into()))
        );
        for (bytes, text) in [
            (999, "999 bytes"),
            (1_000, "1.0 KB"),
            (2_500_000_000, "2.5 GB"),
        ] {
            assert_eq!(size(bytes), text);
        }
    }
}

#[cfg(test)]
mod recovery_usability_tests {
    use super::*;
    #[test]
    fn daemon_upgrade_waits_for_inspection_and_durable_startup_ack() {
        let mut u = Updates::blank(None, true);
        assert!(!u.daemon_upgrade_ready());
        u.inspected = true;
        u.recovery = Some(Ok(vec![]));
        assert!(u.daemon_upgrade_ready());
        u.recovery = Some(Err(Error::Signature));
        assert!(!u.daemon_upgrade_ready());
        u.recovery = Some(Ok(vec![]));
        u.startup_receipt = Some("/synthetic/receipt".into());
        assert!(!u.daemon_upgrade_ready());
        u.startup_started = true;
        assert!(!u.daemon_upgrade_ready());
        u.startup = Some(Err(Error::RecoveryRequired));
        assert!(!u.daemon_upgrade_ready());
        u.startup = Some(Ok(()));
        assert!(u.daemon_upgrade_ready());
        u.recovery = Some(Ok(vec![(
            "/synthetic/other".into(),
            pilot_desktop_updater::installer::Phase::RelaunchRequested,
        )]));
        assert!(!u.daemon_upgrade_ready());
    }
    #[test]
    fn historical_recovery_does_not_disable_check_or_load() {
        for recovery in [
            Ok(vec![(
                "/synthetic/old".into(),
                pilot_desktop_updater::installer::Phase::Committed,
            )]),
            Err(Error::Signature),
        ] {
            let mut u = Updates::blank(None, true);
            u.inspected = true;
            u.recovery = Some(recovery);
            assert!(
                !u.checking(),
                "inspection uncertainty blocks activation, not checks"
            );
            assert!(u.recovery_blocked(), "uncertain activation stays refused");
        }
    }
    #[cfg(feature = "native-probes")]
    #[test]
    fn current_uncertain_commit_still_serializes_all_new_work() {
        let mut u = Updates::blank(None, true);
        u.inspected = true;
        u.probe_state = Some(State::RecoveryRequired(Error::CommitUncertain));
        assert!(u.checking());
        assert!(!u.can_choose_local());
    }
}
