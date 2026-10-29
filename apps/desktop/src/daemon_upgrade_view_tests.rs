use super::*;
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, TestAppContext, WindowBounds, WindowOptions, px,
    size,
};
use std::sync::{Mutex, atomic::AtomicUsize};

fn synthetic() -> Target {
    Target::new(
        Location {
            home: "/nonexistent/pilot-daemon-upgrade-synthetic".into(),
            port: 1,
            policy: Default::default(),
        },
        "synthetic-daemon".into(),
        "synthetic-lineage".into(),
    )
}
fn counting(result: Result<(), Failure>) -> (Worker, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let worker: Worker = Arc::new(
        move |location: Location, daemon: String, lineage: String, _: Arc<AtomicBool>| {
            assert_eq!(location.port, 1);
            assert_eq!(
                (daemon.as_str(), lineage.as_str()),
                ("synthetic-daemon", "synthetic-lineage")
            );
            seen.fetch_add(1, Ordering::SeqCst);
            result
        },
    );
    (worker, calls)
}
fn mount(
    cx: &mut TestAppContext,
    target: Option<Target>,
    worker: Worker,
) -> (
    AnyWindowHandle,
    Entity<DaemonUpgrade>,
    Arc<Mutex<Vec<Event>>>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let (h, v) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(680.), px(600.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| cx.new(|cx| DaemonUpgrade::with_target(target, worker, cx)),
        )
        .unwrap()
    });
    let log = events.clone();
    cx.update(|cx| {
        cx.subscribe(&v, move |_, e: &Event, _| log.lock().unwrap().push(*e))
            .detach()
    });
    (h, v, events)
}
fn init(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
    });
}
fn open(cx: &mut TestAppContext, h: AnyWindowHandle, v: &Entity<DaemonUpgrade>) {
    cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.open(w, cx)))
        .unwrap();
}
fn confirm(cx: &mut TestAppContext, h: AnyWindowHandle, v: &Entity<DaemonUpgrade>) {
    cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.confirm(w, cx)))
        .unwrap();
}
fn settle(cx: &mut TestAppContext, v: &Entity<DaemonUpgrade>) {
    cx.executor().allow_parking();
    for _ in 0..2000 {
        cx.run_until_parked();
        if !cx.read(|cx| v.read(cx).active()) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    panic!("synthetic worker did not finish");
}

#[gpui_kit::test]
fn confirmation_only_requests_and_never_runs_the_worker(cx: &mut TestAppContext) {
    init(cx);
    let (worker, calls) = counting(Ok(()));
    let (h, v, events) = mount(cx, Some(synthetic()), worker);
    open(cx, h, &v);
    cx.read(|cx| assert_eq!(v.read(cx).status(), Status::Confirming));
    confirm(cx, h, &v);
    cx.run_until_parked();
    cx.read(|cx| {
        let v = v.read(cx);
        assert!(v.checkpoint_requested() && !v.active() && !v.uncertain());
        assert_eq!(v.started, 0);
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| **e == Event::Request)
            .count(),
        1
    );
    // A second confirmation without reopening is ignored.
    confirm(cx, h, &v);
    cx.run_until_parked();
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| **e == Event::Request)
            .count(),
        1
    );
}

#[gpui_kit::test]
fn refusal_and_cancel_clear_the_request(cx: &mut TestAppContext) {
    init(cx);
    let (worker, calls) = counting(Ok(()));
    let (h, v, _) = mount(cx, Some(synthetic()), worker);
    open(cx, h, &v);
    confirm(cx, h, &v);
    v.update(cx, |v, cx| {
        v.set_notice("Finish preedit before upgrading.", cx)
    });
    v.update(cx, |v, cx| {
        assert!(!v.checkpoint_requested() && !v.active());
        assert_eq!(v.notice, Some("Finish preedit before upgrading."));
        assert!(!v.begin(cx), "a refused request can never begin");
    });
    open(cx, h, &v);
    confirm(cx, h, &v);
    v.update(cx, |v, cx| {
        v.cancel(cx);
        assert!(!v.checkpoint_requested() && !v.active());
        assert!(!v.begin(cx));
    });
    open(cx, h, &v);
    v.update(cx, |v, cx| {
        assert!(!v.begin(cx), "unconfirmed never begins")
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[gpui_kit::test]
fn begin_consumes_the_request_once_and_reports_verified_success(cx: &mut TestAppContext) {
    init(cx);
    let (worker, calls) = counting(Ok(()));
    let (h, v, events) = mount(cx, Some(synthetic()), worker);
    open(cx, h, &v);
    confirm(cx, h, &v);
    v.update(cx, |v, cx| {
        assert!(v.begin(cx));
        assert!(!v.checkpoint_requested() && v.active());
        assert!(!v.begin(cx), "one worker per request");
    });
    settle(cx, &v);
    cx.read(|cx| {
        let v = v.read(cx);
        assert_eq!(v.status(), Status::Succeeded);
        assert!(!v.active() && !v.uncertain());
        assert_eq!(v.started, 1);
    });
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(events.lock().unwrap().last(), Some(&Event::Changed));
}

#[gpui_kit::test]
fn failures_are_preserved_and_unknown_blocks_retry(cx: &mut TestAppContext) {
    init(cx);
    for failure in [
        Failure::Unsupported,
        Failure::Unverified,
        Failure::Busy,
        Failure::Cancelled,
        Failure::StagingCapacity,
        Failure::StagingArchiveFailed,
        Failure::Unknown,
    ] {
        let (worker, calls) = counting(Err(failure));
        let (h, v, _) = mount(cx, Some(synthetic()), worker);
        open(cx, h, &v);
        confirm(cx, h, &v);
        v.update(cx, |v, cx| assert!(v.begin(cx)));
        settle(cx, &v);
        v.update(cx, |v, cx| v.set_notice("unrelated refusal", cx));
        cx.read(|cx| {
            assert_eq!(v.read(cx).status(), Status::Failed(failure), "{failure:?}");
            assert_eq!(v.read(cx).uncertain(), failure == Failure::Unknown);
        });
        open(cx, h, &v);
        confirm(cx, h, &v);
        let requested = cx.read(|cx| v.read(cx).checkpoint_requested());
        assert_eq!(requested, failure != Failure::Unknown, "{failure:?}");
        if requested {
            v.update(cx, |v, cx| v.cancel(cx));
        }
        v.update(cx, |v, cx| assert!(!v.begin(cx)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[gpui_kit::test]
fn panicking_worker_is_unknown(cx: &mut TestAppContext) {
    init(cx);
    let worker: Worker = Arc::new(|_: Location, _: String, _: String, _: Arc<AtomicBool>| {
        panic!("synthetic worker panic")
    });
    let (h, v, _) = mount(cx, Some(synthetic()), worker);
    open(cx, h, &v);
    confirm(cx, h, &v);
    v.update(cx, |v, cx| assert!(v.begin(cx)));
    settle(cx, &v);
    cx.read(|cx| assert!(v.read(cx).uncertain()));
}

#[gpui_kit::test]
fn running_cancel_is_cooperative(cx: &mut TestAppContext) {
    init(cx);
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let wait = Arc::new(Mutex::new(wait));
    let worker: Worker = Arc::new(
        move |_: Location, _: String, _: String, cancel: Arc<AtomicBool>| {
            let _ = wait.lock().unwrap().recv();
            if cancel.load(Ordering::Acquire) {
                Err(Failure::Cancelled)
            } else {
                Ok(())
            }
        },
    );
    let (h, v, _) = mount(cx, Some(synthetic()), worker);
    open(cx, h, &v);
    confirm(cx, h, &v);
    v.update(cx, |v, cx| {
        assert!(v.begin(cx));
        v.cancel(cx);
        assert_eq!(v.status(), Status::Cancelling);
        assert!(v.active(), "fences hold until the worker returns");
    });
    release.send(()).unwrap();
    settle(cx, &v);
    cx.read(|cx| assert_eq!(v.read(cx).status(), Status::Failed(Failure::Cancelled)));
}

#[gpui_kit::test]
fn unavailable_target_never_opens(cx: &mut TestAppContext) {
    init(cx);
    let (worker, calls) = counting(Ok(()));
    let (h, v, events) = mount(cx, None, worker);
    open(cx, h, &v);
    cx.read(|cx| assert_eq!(v.read(cx).status(), Status::Unavailable));
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[gpui_kit::test]
fn startup_checks_once_then_uses_the_same_parent_upgrade_gate(cx: &mut TestAppContext) {
    init(cx);
    for needed in [false, true] {
        let (worker, calls) = counting(Ok(()));
        let (_, view, events) = mount(cx, Some(synthetic()), worker);
        let checks = Arc::new(AtomicUsize::new(0));
        let counted = checks.clone();
        view.update(cx, |owner, cx| {
            owner.startup_check = Some(Arc::new(move |_, _, _, _| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(needed)
            }));
            owner.startup(cx);
            assert_eq!(
                owner.status(),
                Status::Idle,
                "wait for a healthy connection"
            );
            owner.connected(
                crate::local_client::ConnectedDaemon::Connected(Some("1.0.0".into())),
                cx,
            );
            owner.startup(cx);
            owner.startup(cx);
            assert_eq!(owner.status(), Status::Checking);
        });
        settle(cx, &view);
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "checks never activate the service"
        );
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| **e == Event::Request)
                .count(),
            usize::from(needed)
        );
        view.update(cx, |owner, cx| {
            assert_eq!(owner.checkpoint_requested(), needed);
            if needed {
                assert!(owner.begin(cx));
            }
        });
        settle(cx, &view);
        view.update(cx, |owner, cx| {
            owner.connected(
                crate::local_client::ConnectedDaemon::Connected(Some("2.0.0".into())),
                cx,
            );
            owner.startup(cx);
        });
        settle(cx, &view);
        assert_eq!(
            checks.load(Ordering::SeqCst),
            1,
            "reconnect never re-arms startup"
        );
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(needed));
    }
}

#[gpui_kit::test]
fn failed_startup_check_stays_visible_without_automatic_retries(cx: &mut TestAppContext) {
    init(cx);
    let (worker, calls) = counting(Ok(()));
    let (_, view, _) = mount(cx, Some(synthetic()), worker);
    view.update(cx, |owner, cx| {
        owner.startup_check = Some(Arc::new(|_, _, _, _| Err(Failure::Unverified)));
        owner.connected(crate::local_client::ConnectedDaemon::Connected(None), cx);
        owner.startup(cx);
    });
    settle(cx, &view);
    view.update(cx, |owner, cx| {
        assert_eq!(owner.status(), Status::Failed(Failure::Unverified));
        assert_eq!(
            owner.startup_notice(),
            Some("Daemon update needs attention")
        );
        owner.startup(cx);
        assert!(!owner.active());
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[gpui_kit::test]
fn cancelling_startup_check_never_requests_an_upgrade(cx: &mut TestAppContext) {
    init(cx);
    let (worker, calls) = counting(Ok(()));
    let (_, view, events) = mount(cx, Some(synthetic()), worker);
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Mutex::new(wait);
    view.update(cx, |owner, cx| {
        owner.startup_check = Some(Arc::new(move |_, _, _, _| {
            wait.lock().unwrap().recv().unwrap();
            Ok(true)
        }));
        owner.connected(crate::local_client::ConnectedDaemon::Connected(None), cx);
        owner.startup(cx);
        owner.cancel(cx);
    });
    release.send(()).unwrap();
    settle(cx, &view);
    cx.read(|cx| assert_eq!(view.read(cx).status(), Status::Failed(Failure::Cancelled)));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!events.lock().unwrap().contains(&Event::Request));
}

#[gpui_kit::test]
fn opening_never_takes_focus_from_another_owner(cx: &mut TestAppContext) {
    init(cx);
    let (worker, _) = counting(Ok(()));
    let (h, v, _) = mount(cx, Some(synthetic()), worker);
    let other = cx.update(|cx| cx.focus_handle());
    cx.update_window(h, |_, w, cx| {
        other.focus(w, cx);
        v.update(cx, |v, cx| v.open(w, cx));
        assert!(other.is_focused(w), "a composing owner keeps focus");
        assert!(!v.read(cx).confirm_focus.contains_focused(w, cx));
        assert_eq!(v.read(cx).status(), Status::Confirming);
    })
    .unwrap();
}

#[test]
fn staging_refusals_are_definite_not_unknown() {
    for (failure, tone, said) in [
        (
            Failure::StagingCapacity,
            Tone::Warning,
            "nothing was staged or stopped",
        ),
        (
            Failure::StagingArchiveFailed,
            Tone::Error,
            "nothing was installed or stopped",
        ),
    ] {
        assert_eq!(
            outcome(failure),
            ("Daemon not upgraded", tone),
            "{failure:?}"
        );
        let detail = failure.to_string();
        assert!(detail.contains(said), "{detail}");
        assert!(
            !detail.contains("unknown") && !detail.contains("handoff"),
            "{detail}"
        );
        assert_ne!(detail, Failure::Unverified.to_string());
    }
    assert!(
        Failure::StagingCapacity
            .to_string()
            .contains("Application Support/Pilot Next Runtimes")
    );
}
