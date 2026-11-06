//! Thin AppKit embedding boundary. NSH remains unmodified.
//! AppKit Close/Quit waits for native input capture and courier Close/Flushed.
use nsh_platform_macos::{
    self as platform,
    objc2::{
        self, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
        runtime::ProtocolObject,
    },
    objc2_app_kit::*,
    objc2_foundation::*,
};
use pilot_nsh::{CloseInput, Config};
use std::path::PathBuf;

struct NativeState {
    close: async_channel::Sender<CloseInput>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NativeState]
    #[name = "PilotNshChatDelegate"]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    impl Delegate {
        #[unsafe(method(undo:))]
        fn undo(&self,_sender:Option<&objc2::runtime::AnyObject>) {native_undo(false);}
        #[unsafe(method(redo:))]
        fn redo(&self,_sender:Option<&objc2::runtime::AnyObject>) {native_undo(true);}
    }
    unsafe impl NSWindowDelegate for Delegate {
        #[unsafe(method(windowShouldClose:))]
        fn should_close(&self, window: &NSWindow) -> bool {
            request_close(window, &self.ivars().close);
            false
        }
    }
    unsafe impl NSApplicationDelegate for Delegate {
        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn terminate_after_close(&self, _app: &NSApplication) -> bool {
            false
        }
        #[unsafe(method(applicationShouldTerminate:))]
        fn should_terminate(&self, app: &NSApplication) -> NSApplicationTerminateReply {
            if let Some(window) = app.windows().firstObject() {
                request_close(&window, &self.ivars().close);
            }
            // Our caller ends only after the exact FIFO close acknowledgment.
            NSApplicationTerminateReply::TerminateCancel
        }
    }
);

fn descendants(view: &NSView) -> Vec<Retained<NSView>> {
    let mut out = Vec::new();
    for child in view.subviews() {
        out.push(child.clone());
        out.extend(descendants(&child));
    }
    out
}
// The upstream menu roles send standard responder actions. This embedding host
// supplies their target; AppKit owns the stack and NSH receives its normal edit.
fn native_undo(redo: bool) {
    let app =
        NSApplication::sharedApplication(MainThreadMarker::new().expect("main-thread edit action"));
    let Some(window) = app.windows().firstObject() else {
        return;
    };
    let Some(input) = window
        .firstResponder()
        .and_then(|r| r.downcast::<NSTextView>().ok())
    else {
        return;
    };
    if NSTextInputClient::hasMarkedText(&*input) {
        return;
    }
    let Some(manager) = input.undoManager() else {
        return;
    };
    if redo {
        if !manager.canRedo() {
            return;
        }
        manager.redo();
    } else {
        if !manager.canUndo() {
            return;
        }
        manager.undo();
    }
    input.didChangeText();
}
fn editor(window: &NSWindow) -> Option<Retained<NSTextView>> {
    descendants(&*window.contentView()?)
        .into_iter()
        .filter_map(|view| view.downcast::<NSTextView>().ok())
        .find(|view| input_label(view).is_some_and(|label| label.starts_with("Message in ")))
}
fn input_label(input: &NSTextView) -> Option<String> {
    // SAFETY: inspect a live native input's main-thread parent chain.
    let mut view = unsafe { input.superview() };
    while let Some(current) = view {
        if let Some(label) = NSAccessibility::accessibilityLabel(&*current)
            && (label.to_string().starts_with("Message in ")
                || label.to_string().starts_with("Reply in "))
        {
            return Some(label.to_string());
        }
        // SAFETY: walk the live input's main-thread AppKit parent chain.
        view = unsafe { current.superview() };
    }
    None
}
fn request_close(window: &NSWindow, close: &async_channel::Sender<CloseInput>) {
    let input = editor(window);
    let inputs = window
        .contentView()
        .map(|view| descendants(&view))
        .unwrap_or_default();
    let reply = inputs
        .iter()
        .filter_map(|v| v.downcast_ref::<NSTextView>())
        .find(|v| input_label(v).is_some_and(|l| l.starts_with("Reply in ")));
    let request = CloseInput {
        session: input
            .as_ref()
            .and_then(|i| input_label(i))
            .and_then(|l| l.strip_prefix("Message in ").map(str::to_owned)),
        text: input.as_ref().map(|i| i.string().to_string()),
        reply: reply.and_then(|i| {
            input_label(i).and_then(|l| {
                l.strip_prefix("Reply in ")
                    .map(|key| (key.to_owned(), i.string().to_string()))
            })
        }),
        composing: inputs
            .iter()
            .filter_map(|v| v.downcast_ref::<NSTextView>())
            .any(NSTextInputClient::hasMarkedText),
    };
    if request.composing {
        return;
    }
    // Release native input before asking for the FIFO boundary. A failed save
    // leaves the window open, rather than treating a timeout as permission.
    window.makeFirstResponder(None);
    let _ = close.try_send(request);
}
fn stop(app: &NSApplication, window: &NSWindow) {
    app.stop(None);
    let event=NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType::ApplicationDefined,NSPoint::new(0.,0.),NSEventModifierFlags::empty(),0.,window.windowNumber(),None,0,0,0).expect("stop wake event");
    app.postEvent_atStart(&event, false);
}

pub(super) struct Probes {
    pub restart: bool,
    pub prompts: bool,
    #[cfg(feature = "native-probes")]
    pub work: Option<std::sync::Arc<pilot_nsh::fixture::Fixture>>,
    #[cfg(feature = "native-probes")]
    pub history: Option<std::sync::Arc<pilot_nsh::fixture::Fixture>>,
}
pub(super) fn run(
    options: platform::AppOptions,
    config: Config,
    close: async_channel::Sender<CloseInput>,
    closed: async_channel::Receiver<()>,
    capture: Option<PathBuf>,
    probes: Probes,
) -> std::process::ExitCode {
    let mtm = MainThreadMarker::new().expect("native main thread");
    let app = NSApplication::sharedApplication(mtm);
    let hidden = capture.is_some();
    app.setActivationPolicy(if hidden {
        NSApplicationActivationPolicy::Prohibited
    } else {
        NSApplicationActivationPolicy::Regular
    });
    // SAFETY: native objects are created and kept on this main thread.
    let delegate: Retained<Delegate> = unsafe {
        msg_send![
            super(Delegate::alloc(mtm).set_ivars(NativeState { close })),
            init
        ]
    };
    app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // SAFETY: the retained window outlives AppView and its event loop.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(
                NSPoint::new(0., 0.),
                NSSize::new(options.size.0.into(), options.size.1.into()),
            ),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Resizable | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: Rust owns the retained window, not an autorelease-on-close path.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str(&options.title));
    window.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    let view = platform::AppView::new(mtm, options);
    window.setContentView(Some(&view.view()));
    view.load(pilot_nsh::root(config).into());
    if !hidden {
        window.center();
        window.makeKeyAndOrderFront(None);
        app.activate();
    }
    std::thread::spawn(move || {
        if closed.recv_blocking().is_ok() {
            dispatch2::DispatchQueue::main().exec_async(|| {
                let app =
                    NSApplication::sharedApplication(MainThreadMarker::new().expect("main queue"));
                if let Some(window) = app.windows().firstObject() {
                    stop(&app, &window);
                }
            });
        }
    });
    #[cfg(feature = "native-probes")]
    if let Some(path) = capture {
        if let Some(fixture) = probes.history {
            probe::history_start(path, fixture);
        } else if let Some(fixture) = probes.work {
            probe::work_start(path, fixture);
        } else {
            probe::start(path, probes.restart, probes.prompts);
        }
    }
    #[cfg(not(feature = "native-probes"))]
    let _ = (capture, probes.restart, probes.prompts);
    app.run();
    view.stop();
    window.orderOut(None);
    std::process::ExitCode::SUCCESS
}

#[cfg(feature = "native-probes")]
#[path = "native_probe.rs"]
mod probe;
