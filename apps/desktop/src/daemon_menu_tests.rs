use super::*;
use gpui_kit::{TestAppContext, WindowOptions};
use std::sync::{Mutex, atomic::AtomicUsize};

fn install(
    cx: &mut TestAppContext,
    state: State,
    result: Result<State, Failure>,
) -> (Entity<Owner>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let worker: Worker = Arc::new(move |command, _| {
        seen.fetch_add(1, Ordering::SeqCst);
        let state = if command.is_none() { Ok(state) } else { result }?;
        Ok(Report {
            state,
            available: true,
        })
    });
    let owner = cx.new(|_| Owner {
        worker,
        window: None,
        available: true,
        state: Some(state),
        message: "Last checked".into(),
        busy: false,
        command: None,
        confirming: false,
        unknown: false,
        manual: false,
        cancel: Arc::new(AtomicBool::new(false)),
        task: None,
    });
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::app_menu::init(cx);
        cx.set_global(Managed(owner.clone()));
    });
    (owner, calls)
}
fn mount(cx: &mut TestAppContext) -> gpui_kit::AnyWindowHandle {
    cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| cx.new(|_| Blank),
        )
        .unwrap()
        .0
    })
}
struct Blank;
impl gpui_kit::Render for Blank {
    fn render(
        &mut self,
        _: &mut Window,
        _: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        gpui_kit::div()
    }
}
fn enabled(cx: &TestAppContext, ix: usize) -> bool {
    cx.read(|cx| {
        let MenuItem::Submenu(menu) = menu(Some(cx)) else {
            panic!()
        };
        !menu.items[ix].is_disabled()
    })
}
fn settle(cx: &mut TestAppContext, owner: &Entity<Owner>) {
    cx.executor().allow_parking();
    for _ in 0..1000 {
        cx.run_until_parked();
        if !cx.read(|cx| owner.read(cx).busy) {
            return;
        }
        std::thread::park_timeout(std::time::Duration::from_millis(1));
    }
    panic!("fixture worker did not finish");
}
#[gpui_kit::test]
fn no_window_never_executes_and_start_is_one_action(cx: &mut TestAppContext) {
    let (owner, calls) = install(cx, State::Stopped, Ok(State::Running));
    assert!(!enabled(cx, 2));
    assert!(!enabled(cx, 3));
    assert!(!enabled(cx, 4));
    cx.update(|cx| cx.dispatch_action(&StartDaemon));
    cx.run_until_parked();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let w = mount(cx);
    cx.update_window(w, |_, w, _| w.activate_window()).unwrap();
    assert!(enabled(cx, 2));
    assert!(!enabled(cx, 3));
    assert!(!enabled(cx, 4));
    cx.update(|cx| cx.dispatch_action(&StartDaemon));
    settle(cx, &owner);
    assert!(!cx.has_pending_prompt());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!enabled(cx, 2));
}
#[gpui_kit::test]
fn confirmed_restart_dispatches_once_and_unknown_stays_inspect_only(cx: &mut TestAppContext) {
    let (owner, calls) = install(cx, State::Running, Err(Failure::Unknown));
    let w = mount(cx);
    cx.update_window(w, |_, w, _| w.activate_window()).unwrap();
    assert!(!enabled(cx, 2));
    assert!(enabled(cx, 3));
    assert!(enabled(cx, 4));
    cx.update(|cx| {
        cx.dispatch_action(&RestartDaemon);
        cx.dispatch_action(&RestartDaemon);
    });
    cx.run_until_parked();
    settle(cx, &owner);
    assert!(!cx.has_pending_prompt());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!enabled(cx, 3));
    assert!(!enabled(cx, 4));
    cx.update(|cx| cx.dispatch_action(&InspectDaemon));
    settle(cx, &owner);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(cx.read(|cx| owner.read(cx).unknown));
    assert!(!enabled(cx, 3));
    assert!(!enabled(cx, 4));
    cx.update(|cx| cx.dispatch_action(&RestartDaemon));
    cx.run_until_parked();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!cx.has_pending_prompt());
}
#[gpui_kit::test]
fn held_control_progress_cancels_without_replay_and_quit_is_independent(cx: &mut TestAppContext) {
    let (owner, _) = install(cx, State::Running, Ok(State::Stopped));
    let w = mount(cx);
    cx.update_window(w, |_, w, _| w.activate_window()).unwrap();
    let barrier = Arc::new(Mutex::new(None));
    let capture = barrier.clone();
    owner.update(cx, |o, _| {
        o.worker = Arc::new(move |command, cancel| {
            assert_eq!(command, Some(Command::Stop));
            *capture.lock().unwrap() = Some(cancel.clone());
            while !cancel.load(Ordering::Acquire) {
                std::thread::park_timeout(std::time::Duration::from_millis(1));
            }
            Err(Failure::Cancelled)
        })
    });
    cx.update(|cx| cx.dispatch_action(&StopDaemon));
    cx.run_until_parked();
    assert!(!enabled(cx, 3));
    assert!(enabled(cx, 8));
    cx.update(|cx| cx.dispatch_action(&CancelDaemonControl));
    settle(cx, &owner);
    assert!(!cx.read(|cx| owner.read(cx).unknown));
    assert!(!enabled(cx, 3));
    assert!(cx.read(|cx| owner.read(cx).message.contains("Cancelled")));
    assert!(
        !cx.read(manual),
        "cancelled intent does not change startup policy"
    );
    // Closing a window never dispatches a daemon command or changes its outcome.
    cx.update_window(w, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
    assert!(!cx.read(|cx| owner.read(cx).busy));
}
