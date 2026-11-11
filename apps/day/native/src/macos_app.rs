//! Application-owned AppKit shell. Screens remain the packaged TSX entry.
//! The same owner is used by the executable and hidden native fixtures.
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

use dispatch2::DispatchQueue;
use nsh_engine::Bundle;
use nsh_platform_macos::{
    objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
        runtime::ProtocolObject, sel,
    },
    objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate,
        NSApplicationTerminateReply, NSAutoresizingMaskOptions, NSBackingStoreType, NSEvent,
        NSEventModifierFlags, NSEventType, NSMenu, NSMenuItem, NSResponder, NSView, NSWindow,
        NSWindowDelegate, NSWindowStyleMask,
    },
    objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSTimer},
};

use crate::{bridge::Bridge, host::Error, macos_host::WindowOwner};

const SAVE_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Editing,
    Saving(u32),
    Preparing(u32),
    Draining(u32),
    Closed,
    DrainFailed,
}

struct State {
    owner: WindowOwner,
    window: Retained<NSWindow>,
    phase: Phase,
    error: Option<Error>,
    stop_loop: bool,
    shield: Retained<CaptureShield>,
    deadline: Option<Retained<NSTimer>>,
    fallback_focus: Option<Retained<NSResponder>>,
    update: Option<String>,
    startup_attempted: bool,
}

thread_local! {
    // Weak, main-thread-only routing. Every asynchronous callback pins the
    // original root identity, never "the current window" or a reused pointer.
    static OWNERS: RefCell<HashMap<String, Weak<RefCell<State>>>> = RefCell::new(HashMap::new());
}

fn find(id: &str) -> Option<Rc<RefCell<State>>> {
    OWNERS.with(|owners| owners.borrow().get(id).and_then(Weak::upgrade))
}
fn wake(id: String) {
    DispatchQueue::main().exec_async(move || {
        if let Some(state) = find(&id) {
            advance(&state);
        }
    });
}

fn begin(id: &str) {
    let Some(state) = find(id) else { return };
    let main = MainThreadMarker::new().expect("AppKit main thread");
    let generation = {
        let mut state = state.borrow_mut();
        if state.phase != Phase::Editing {
            return;
        }
        state.fallback_focus = state.window.firstResponder();
        let update = state.owner.take_app_update();
        match state.owner.begin_close(main) {
            Ok(generation) => {
                let content = state.window.contentView().expect("owned content view");
                state.shield.setFrame(content.bounds());
                content.addSubview(&state.shield);
                if !state.window.makeFirstResponder(Some(&state.shield)) {
                    state.shield.removeFromSuperview();
                    let _ = state.owner.cancel_close(generation);
                    state.error = Some(Error::Unavailable);
                    return;
                }
                state.error = None;
                state.update = update;
                state.phase = Phase::Saving(generation);
                generation
            }
            Err(error) => {
                state.error = Some(error);
                return;
            }
        }
    };
    // A deadline only cancels this exact unsealed attempt. It never seals,
    // fabricates an ACK, retries a save or touches a replacement root.
    let target = Deadline::alloc(main).set_ivars(DeadlineData {
        id: id.to_owned(),
        generation,
    });
    // SAFETY: NSObject initializer and the declared one-argument timer selector.
    // The timer retains its target, and is invalidated on cancel/seal/drop.
    let target: Retained<Deadline> = unsafe { msg_send![super(target), init] };
    state.borrow_mut().deadline = Some(unsafe {
        NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
            SAVE_DEADLINE.as_secs_f64(),
            &target,
            sel!(saveDeadline:),
            None,
            false,
        )
    });
}

fn restore_focus(state: &mut State) {
    // Capture already restores an owning text field/editor and its selection.
    // Otherwise restore the old surface responder, never a shared field editor.
    if state.window.firstResponder().is_none_or(|r| {
        std::ptr::eq(&*r, &*state.shield as &NSResponder)
            || std::ptr::eq(&*r, &*state.window as &NSResponder)
    }) {
        let surface = state.owner.view();
        let old = state
            .fallback_focus
            .as_ref()
            .and_then(|r| r.downcast_ref::<NSView>())
            .filter(|v| v.isDescendantOf(&surface));
        state
            .window
            .makeFirstResponder(Some(old.unwrap_or(&surface)));
    }
    state.fallback_focus = None;
}

fn cancel(id: &str, generation: u32, error: Option<Error>) {
    let Some(state) = find(id) else { return };
    let mut state = state.borrow_mut();
    if state.phase != Phase::Saving(generation) {
        return;
    }
    if let Some(timer) = state.deadline.take() {
        timer.invalidate();
    }
    state.shield.removeFromSuperview();
    match state.owner.cancel_close(generation) {
        Ok(()) => {
            restore_focus(&mut state);
            state.phase = Phase::Editing;
            state.error = error;
        }
        Err(error) => state.error = Some(error),
    }
}

fn advance(state: &Rc<RefCell<State>>) {
    let mut s = state.borrow_mut();
    if s.phase == Phase::Editing {
        if s.owner.startup_ready() && !s.startup_attempted {
            s.startup_attempted = true;
            let result = s.owner.acknowledge_startup();
            let id = s.owner.identity().to_owned();
            if std::thread::Builder::new()
                .name("day-startup-ack".into())
                .spawn(move || {
                    let result = result.recv_blocking().unwrap_or(Err(Error::Unknown));
                    DispatchQueue::main().exec_async(move || {
                        if let Some(state) = find(&id)
                            && let Err(error) = result
                        {
                            state.borrow_mut().error = Some(error);
                        }
                    });
                })
                .is_err()
            {
                s.error = Some(Error::Unavailable);
            }
        }
        // Only a fresh app confirmation triggers capture. A consumed/cancelled
        // request is never re-created from a retained Unknown operation.
        if s.owner.app_update_requested() {
            // Put the exact intent into this attempt, not into a later root.
            // begin() performs native capture before any effect enters.
            let id = s.owner.identity().to_owned();
            drop(s);
            begin(&id);
            return;
        }
    }
    let Phase::Saving(generation) = s.phase else {
        return;
    };
    if !s.owner.ready(generation) {
        return;
    }
    let sealed = match s.owner.seal_close(generation) {
        Ok(sealed) => sealed,
        Err(Error::Busy) => return,
        Err(error) => {
            if let Some(timer) = s.deadline.take() {
                timer.invalidate();
            }
            s.shield.removeFromSuperview();
            let _ = s.owner.cancel_close(generation);
            restore_focus(&mut s);
            s.phase = Phase::Editing;
            s.error = Some(error);
            return;
        }
    };
    if let Some(timer) = s.deadline.take() {
        timer.invalidate();
    }
    if let Some(id) = s.update.take() {
        let mut sealed = sealed;
        let preparation = match s.owner.prepare_update(&mut sealed, id) {
            Ok(result) => result,
            Err(error) => {
                s.phase = Phase::DrainFailed;
                s.error = Some(error);
                return;
            }
        };
        s.phase = Phase::Preparing(generation);
        let id = s.owner.identity().to_owned();
        if std::thread::Builder::new()
            .name("day-app-handoff".into())
            .spawn(move || {
                let result = preparation.recv_blocking().unwrap_or(Err(Error::Unknown));
                DispatchQueue::main().exec_async(move || prepared(&id, generation, sealed, result));
            })
            .is_err()
        {
            s.phase = Phase::DrainFailed;
            s.error = Some(Error::Unavailable);
        }
        return;
    }
    close_sealed(&mut s, generation, sealed);
}

fn prepared(
    id: &str,
    generation: u32,
    sealed: crate::macos_host::SealedClose,
    result: Result<crate::model::IntentOutcome, Error>,
) {
    let Some(state) = find(id) else {
        return;
    };
    let mut s = state.borrow_mut();
    if s.phase != Phase::Preparing(generation) {
        return;
    }
    match result {
        Ok(outcome) if outcome.status == crate::model::OutcomeStatus::Accepted => {
            close_sealed(&mut s, generation, sealed)
        }
        result => {
            s.phase = Phase::DrainFailed;
            s.error = Some(result.err().unwrap_or(Error::Unknown));
        }
    }
}

fn close_sealed(s: &mut State, generation: u32, sealed: crate::macos_host::SealedClose) {
    let joined = match s.owner.close_sealed(sealed) {
        Ok(joined) => joined,
        Err(error) => {
            s.phase = Phase::DrainFailed;
            s.error = Some(error);
            return;
        }
    };
    s.phase = Phase::Draining(generation);
    let id = s.owner.identity().to_owned();
    let failure_id = id.clone();
    // Never block AppKit waiting for entered HTTP or the journal/worker join.
    if std::thread::Builder::new()
        .name("day-window-close".into())
        .spawn(move || {
            let result = joined.recv_blocking();
            DispatchQueue::main().exec_async(move || drained(&id, generation, result));
        })
        .is_err()
    {
        s.phase = Phase::DrainFailed;
        s.error = Some(Error::Unavailable);
        eprintln!("Day close could not join its native owner ({failure_id}).");
    }
}

fn drained(id: &str, generation: u32, result: Result<crate::macos_host::JoinedClose, Error>) {
    let Some(state) = find(id) else { return };
    let mut s = state.borrow_mut();
    if s.phase != Phase::Draining(generation) {
        return;
    }
    if let Err(error) = result.and_then(|joined| s.owner.dispose_joined(joined)) {
        s.phase = Phase::DrainFailed;
        s.error = Some(error);
        return; // keep engine/window, never report a successful close
    }
    s.phase = Phase::Closed;
    s.window.setDelegate(None);
    s.window.setContentView(None);
    s.window.close();
    if s.stop_loop {
        stop_loop();
    }
}

struct DelegateData {
    id: String,
}
struct DeadlineData {
    id: String,
    generation: u32,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DeadlineData]
    #[name = "PilotDaySaveDeadline"]
    struct Deadline;
    unsafe impl NSObjectProtocol for Deadline {}
    impl Deadline {
        #[unsafe(method(saveDeadline:))]
        fn deadline(&self, _timer: &NSTimer) {
            cancel(&self.ivars().id, self.ivars().generation, Some(Error::Unavailable));
        }
    }
);
define_class!(
    /// A temporary native input fence, not a screen. Keeping focus outside the
    /// NSH surface also fences released NSH's global shortcut monitor. The
    /// transparent sibling intercepts clicks while TSX's exact bytes save.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateData]
    #[name = "PilotDayCaptureShield"]
    struct CaptureShield;
    unsafe impl NSObjectProtocol for CaptureShield {}
    impl CaptureShield {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_focus(&self) -> bool { true }
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            if event.keyCode() == 53 { // Escape cancels only the unsealed attempt
                if let Some(state) = find(&self.ivars().id) {
                    let phase = state.borrow().phase;
                    if let Phase::Saving(generation) = phase {
                        cancel(&self.ivars().id, generation, None);
                    }
                }
            }
        }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {}
    }
);
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateData]
    #[name = "PilotDayApplicationDelegate"]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    unsafe impl NSWindowDelegate for Delegate {
        #[unsafe(method(windowShouldClose:))]
        fn should_close(&self, _window: &NSWindow) -> bool {
            begin(&self.ivars().id);
            false // AppKit must not dispose anything before the joined barrier
        }
    }
    unsafe impl NSApplicationDelegate for Delegate {
        #[unsafe(method(applicationShouldTerminate:))]
        fn should_terminate(&self, _app: &NSApplication) -> NSApplicationTerminateReply {
            begin(&self.ivars().id);
            // We own process termination after app.run returns. No AppKit
            // termination reply may bypass the capture/join lifetime.
            NSApplicationTerminateReply::TerminateCancel
        }
        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn last_window(&self, _app: &NSApplication) -> bool { false }
    }
    impl Delegate {
        #[unsafe(method(cancelClose:))]
        fn cancel_close(&self, _sender: Option<&NSObject>) {
            if let Some(state) = find(&self.ivars().id) {
                let phase = state.borrow().phase;
                if let Phase::Saving(generation) = phase {
                    cancel(&self.ivars().id, generation, None);
                }
            }
        }
    }
);

/// Retains the real delegate, window, sole AppView and sole root across close.
/// Constructed hidden; only run() orders it front. Never replace its selection
/// or load again: close it fully, then construct a new selected owner.
pub struct ApplicationOwner {
    state: Rc<RefCell<State>>,
    delegate: Retained<Delegate>,
}
impl ApplicationOwner {
    pub fn new(main: MainThreadMarker, bundle: Bundle, bridge: Bridge) -> Result<Self, Error> {
        let configuration = crate::macos_host::options(&bridge);
        Self::configured(main, bundle, bridge, configuration)
    }
    pub(crate) fn configured(
        main: MainThreadMarker,
        bundle: Bundle,
        bridge: Bridge,
        configuration: nsh_platform_macos::AppOptions,
    ) -> Result<Self, Error> {
        let mut owner = WindowOwner::configured(main, bridge, configuration);
        // SAFETY: designated AppKit initializer, main thread. We retain the
        // window throughout its delegate callbacks and disable release-on-close.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(main),
                NSRect::new(NSPoint::new(0., 0.), NSSize::new(1100., 820.)),
                NSWindowStyleMask::Titled
                    | NSWindowStyleMask::Closable
                    | NSWindowStyleMask::Miniaturizable
                    | NSWindowStyleMask::Resizable,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe {
            window.setReleasedWhenClosed(false);
        }
        window.setTitle(&NSString::from_str("Pilot Day"));
        let content = NSView::initWithFrame(NSView::alloc(main), window.frame());
        let surface = owner.view();
        surface.setFrame(content.bounds());
        surface.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content.addSubview(&surface);
        window.setContentView(Some(&content));
        if let Err(error) = owner.load(bundle) {
            // No VM form exists on a rejected bundle. Join the unopened root
            // off-thread, without entering the application event loop.
            let _ = owner.close_unloaded();
            return Err(error);
        }
        let id = owner.identity().to_owned();
        let wake_id = id.clone();
        owner.set_flush_wakeup(Arc::new(move || wake(wake_id.clone())));
        let delegate = Delegate::alloc(main).set_ivars(DelegateData { id: id.clone() });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
        let shield = CaptureShield::alloc(main).set_ivars(DelegateData { id: id.clone() });
        let shield: Retained<CaptureShield> =
            unsafe { msg_send![super(shield), initWithFrame: content.bounds()] };
        shield.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        window.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let state = Rc::new(RefCell::new(State {
            owner,
            window,
            phase: Phase::Editing,
            error: None,
            stop_loop: false,
            shield,
            deadline: None,
            fallback_focus: None,
            update: None,
            startup_attempted: false,
        }));
        OWNERS.with(|owners| {
            owners
                .borrow_mut()
                .insert(id.clone(), Rc::downgrade(&state))
        });
        // An initial receipt restore may finish before the callback was bound.
        wake(id);
        Ok(Self { state, delegate })
    }
    pub fn phase(&self) -> Phase {
        self.state.borrow().phase
    }
    pub fn error(&self) -> Option<Error> {
        self.state.borrow().error
    }
    pub fn view(&self) -> Retained<NSView> {
        self.state.borrow().owner.view()
    }
    /// The actual window delegate route, also used by hidden fixtures.
    pub fn request_close(&self) {
        let window = self.state.borrow().window.clone();
        window.performClose(None);
    }
    /// The actual application delegate route, without asking AppKit to exit.
    pub fn request_quit(&self) {
        let app = NSApplication::sharedApplication(MainThreadMarker::from(&*self.delegate));
        let _: NSApplicationTerminateReply =
            unsafe { msg_send![&*self.delegate, applicationShouldTerminate: &*app] };
    }
    pub fn cancel_close(&self) {
        let _: () = unsafe { msg_send![&*self.delegate, cancelClose: None::<&NSObject>] };
    }

    /// Production event loop. No stock run_app or immediate Quit delegate.
    pub fn run(self, main: MainThreadMarker) -> Result<(), Error> {
        let app = NSApplication::sharedApplication(main);
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        app.setDelegate(Some(ProtocolObject::from_ref(&*self.delegate)));
        app.setMainMenu(Some(&menu(main, &self.delegate)));
        {
            let mut s = self.state.borrow_mut();
            s.stop_loop = true;
            s.window.center();
            s.window.makeKeyAndOrderFront(None);
        }
        app.activate();
        // Another native caller's stop: is not permission to dispose unsaved
        // state. Only our joined close may return process ownership.
        loop {
            app.run();
            if self.phase() == Phase::Closed {
                break;
            }
        }
        app.setDelegate(None);
        app.setMainMenu(None);
        if self.phase() == Phase::Closed {
            Ok(())
        } else {
            Err(Error::Unknown)
        }
    }
}
impl Drop for ApplicationOwner {
    fn drop(&mut self) {
        if let Some(timer) = self.state.borrow_mut().deadline.take() {
            timer.invalidate();
        }
        OWNERS.with(|owners| {
            owners
                .borrow_mut()
                .remove(self.state.borrow().owner.identity())
        });
    }
}

fn stop_loop() {
    let main = MainThreadMarker::new().expect("AppKit main thread");
    let app = NSApplication::sharedApplication(main);
    app.stop(None);
    if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType::ApplicationDefined, NSPoint::new(0., 0.), NSEventModifierFlags::empty(),
        0., 0, None, 0, 0, 0) {
        app.postEvent_atStart(&event, true);
    }
}

fn menu(main: MainThreadMarker, delegate: &Delegate) -> Retained<NSMenu> {
    let bar = NSMenu::new(main);
    let item = |menu: &NSMenu, name: &str, action, key: &str| {
        // SAFETY: standard AppKit responder actions, or our explicit delegate.
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(main),
                &NSString::from_str(name),
                action,
                &NSString::from_str(key),
            )
        };
        menu.addItem(&item);
        item
    };
    let sub = |name: &str| {
        let menu = NSMenu::initWithTitle(NSMenu::alloc(main), &NSString::from_str(name));
        item(&bar, name, None, "").setSubmenu(Some(&menu));
        menu
    };
    let app = sub("Pilot Day");
    item(&app, "Hide Pilot Day", Some(sel!(hide:)), "h");
    item(&app, "Quit Pilot Day", Some(sel!(terminate:)), "q");
    let cancel = item(&app, "Cancel Close", Some(sel!(cancelClose:)), "");
    unsafe {
        cancel.setTarget(Some(delegate));
    }
    let edit = sub("Edit");
    for (name, selector, key) in [
        ("Undo", sel!(undo:), "z"),
        ("Redo", sel!(redo:), "Z"),
        ("Cut", sel!(cut:), "x"),
        ("Copy", sel!(copy:), "c"),
        ("Paste", sel!(paste:), "v"),
        ("Select All", sel!(selectAll:), "a"),
    ] {
        item(&edit, name, Some(selector), key);
    }
    let window = sub("Window");
    item(&window, "Minimize", Some(sel!(performMiniaturize:)), "m");
    item(&window, "Close", Some(sel!(performClose:)), "w");
    bar
}
