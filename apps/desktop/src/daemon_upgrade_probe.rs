//! Production daemon upgrade section in hidden windows. Synthetic worker only:
//! no profile, launchctl, daemon or network is touched.
use crate::daemon_upgrade_view::{DaemonUpgrade, Event, Status, Target, Worker};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds,
    WindowOptions, px, size, test::TestWindowExt,
};
use pilot_desktop_updater::{coordination::Location, daemon_upgrade::Failure};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, f: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(cx)) {
        assert!(Instant::now() < end, "daemon upgrade timeout");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn press(cx: &mut HeadlessAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    settle(cx, h);
}
fn present(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) -> bool {
    cx.update_window(h, |_, w, _| w.try_find(id).is_some())
        .unwrap()
}
fn synthetic() -> Target {
    Target::new(
        Location {
            home: "/nonexistent/pilot-daemon-upgrade-probe".into(),
            port: 1,
            policy: Default::default(),
        },
        "probe-daemon".into(),
        "probe-lineage".into(),
    )
}
/// Blocks until the probe releases an outcome, so the running state is observable.
fn gated() -> (Worker, mpsc::Sender<Result<(), Failure>>, Arc<AtomicUsize>) {
    let (release, outcome) = mpsc::channel();
    let outcome = Mutex::new(outcome);
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let worker: Worker = Arc::new(
        move |_: Location, daemon: String, lineage: String, _: Arc<AtomicBool>| {
            assert_eq!(
                (daemon.as_str(), lineage.as_str()),
                ("probe-daemon", "probe-lineage")
            );
            seen.fetch_add(1, Ordering::SeqCst);
            outcome
                .lock()
                .unwrap()
                .recv()
                .unwrap_or(Err(Failure::Unknown))
        },
    );
    (worker, release, calls)
}
fn mount(
    cx: &mut HeadlessAppContext,
    width: f32,
    target: Option<Target>,
    worker: Worker,
) -> (
    AnyWindowHandle,
    Entity<DaemonUpgrade>,
    Arc<Mutex<Vec<Event>>>,
) {
    let (h, v) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(600.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |_, cx| cx.new(|cx| DaemonUpgrade::with_target(target, worker, cx)),
            )
        })
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let log = events.clone();
    cx.update(|cx| {
        cx.subscribe(&v, move |_, e: &Event, _| log.lock().unwrap().push(*e))
            .detach()
    });
    settle(cx, h);
    (h, v, events)
}
fn requests(events: &Mutex<Vec<Event>>) -> usize {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| **e == Event::Request)
        .count()
}

pub fn run_daemon_upgrade_probe(cx: &mut HeadlessAppContext) {
    let mut cases = 0;
    for (width, dark, result) in [
        (680., false, Ok(())),
        (1100., true, Err(Failure::Unknown)),
        (680., true, Err(Failure::Busy)),
        (1100., false, Err(Failure::Unverified)),
    ] {
        cases += 1;
        cx.update(|cx| {
            crate::appearance::commit_appearance(
                if dark {
                    crate::settings_state::AppearancePreference::Dark
                } else {
                    crate::settings_state::AppearancePreference::Light
                },
                cx,
            )
        });
        let (worker, release, calls) = gated();
        let (h, v, events) = mount(cx, width, Some(synthetic()), worker);
        assert!(present(cx, h, "daemon-upgrade-open"));
        assert!(!present(cx, h, "daemon-upgrade-confirm"));

        // Opening moves focus into the confirmation, not onto its destructive action.
        click(cx, h, "daemon-upgrade-open");
        cx.update_window(h, |_, w, cx| {
            assert!(v.read(cx).confirmation_focused(w, cx));
            assert_eq!(v.read(cx).status(), Status::Confirming);
        })
        .unwrap();
        press(cx, h, "enter");
        press(cx, h, "shift-escape");
        cx.update(|cx| assert_eq!(v.read(cx).status(), Status::Confirming));
        assert_eq!(requests(&events), 0, "plain Enter never confirms");
        press(cx, h, "escape");
        cx.update_window(h, |_, w, cx| {
            assert_eq!(v.read(cx).status(), Status::Idle);
            assert!(
                v.read(cx).owns_focus(w, cx),
                "escape restores section focus"
            );
        })
        .unwrap();
        click(cx, h, "daemon-upgrade-open");
        click(cx, h, "daemon-upgrade-dismiss");
        cx.update(|cx| assert_eq!(v.read(cx).status(), Status::Idle));

        // Confirmation only asks the parent. It never starts the worker.
        click(cx, h, "daemon-upgrade-open");
        cx.update_window(h, |_, w, _| {
            let bounds = w.find("daemon-upgrade-confirm").bounds();
            assert!(bounds.left() >= px(0.) && bounds.right() <= px(width));
            assert!(bounds.size.width > px(300.));
        })
        .unwrap();
        if let Some(dir) = std::env::var_os("PILOT_NEXT_DAEMON_UPGRADE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!(
                    "{}-{}-confirm-{}.png",
                    width as u32,
                    if dark { "dark" } else { "light" },
                    cases
                )))
                .unwrap();
        }
        click(cx, h, "daemon-upgrade-confirm-action");
        cx.update(|cx| {
            assert!(v.read(cx).checkpoint_requested());
            assert_eq!(v.read(cx).started, 0);
        });
        assert_eq!(requests(&events), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(present(cx, h, "daemon-upgrade-cancel"));

        // The parent refuses once; the request is gone and cannot begin.
        cx.update(|cx| {
            v.update(cx, |v, cx| {
                v.set_notice("Finish composing marked text before upgrading.", cx);
                assert!(!v.begin(cx));
            })
        });
        settle(cx, h);
        assert!(present(cx, h, "daemon-upgrade-notice"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        // Parent checkpoint succeeded: begin starts exactly one worker.
        click(cx, h, "daemon-upgrade-open");
        click(cx, h, "daemon-upgrade-confirm-action");
        cx.update(|cx| v.update(cx, |v, cx| assert!(v.begin(cx) && !v.begin(cx))));
        until(cx, h, |_| calls.load(Ordering::SeqCst) == 1);
        cx.update(|cx| assert_eq!(v.read(cx).status(), Status::Running));
        assert!(!present(cx, h, "daemon-upgrade-open"));
        if let Some(dir) = std::env::var_os("PILOT_NEXT_DAEMON_UPGRADE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!("{}-running-{}.png", width as u32, cases)))
                .unwrap();
        }
        release.send(result).unwrap();
        until(cx, h, |cx| !v.read(cx).active());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(present(cx, h, "daemon-upgrade-status"));
        cx.update(|cx| match result {
            Ok(()) => assert_eq!(v.read(cx).status(), Status::Succeeded),
            Err(failure) => {
                assert_eq!(v.read(cx).status(), Status::Failed(failure));
                assert_eq!(v.read(cx).uncertain(), failure == Failure::Unknown);
            }
        });
        // Unknown never offers another attempt in this app session.
        assert_eq!(
            present(cx, h, "daemon-upgrade-open"),
            result != Err(Failure::Unknown)
        );
        assert_eq!(
            present(cx, h, "daemon-upgrade-copy-journal"),
            result == Err(Failure::Unknown)
        );
        if let Some(dir) = std::env::var_os("PILOT_NEXT_DAEMON_UPGRADE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!(
                    "{}-{}-{}.png",
                    width as u32,
                    if dark { "dark" } else { "light" },
                    cases
                )))
                .unwrap();
        }
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        settle_closed(cx);
    }

    // An unsupported or unverified connection shows no upgrade action.
    let (worker, _release, calls) = gated();
    let (h, v, events) = mount(cx, 680., None, worker);
    assert!(!present(cx, h, "daemon-upgrade-open"));
    assert!(present(cx, h, "daemon-upgrade-status"));
    cx.update(|cx| assert_eq!(v.read(cx).status(), Status::Unavailable));
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    settle_closed(cx);
    eprintln!("daemon-upgrade-probe cases={} unavailable=1", cases);
}
fn settle_closed(cx: &mut HeadlessAppContext) {
    cx.run_until_parked();
}
