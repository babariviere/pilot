//! Hidden AppKit menu dispatch with a memory-only driver and hidden GPUI prompts.
//! No Local discovery, service commands, default Store or native alerts.
use super::*;
use gpui_kit::{Context, EventEmitter, FocusHandle, Focusable, IntoElement, Render, WindowOptions};
use std::{
    ffi::{c_char, c_void},
    sync::Mutex,
};
type Id = *mut c_void;
type Sel = *const c_void;
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
}
// SAFETY: AppKit-owned live objects on its main thread, exact selector ABIs.
unsafe fn object(receiver: Id, selector: &std::ffi::CStr) -> Id {
    let call: unsafe extern "C" fn(Id, Sel) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(receiver, sel_registerName(selector.as_ptr())) }
}
unsafe fn at(receiver: Id, ix: isize) -> Id {
    let call: unsafe extern "C" fn(Id, Sel, isize) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(receiver, sel_registerName(c"itemAtIndex:".as_ptr()), ix) }
}
unsafe fn item(ix: isize) -> (Id, Id) {
    let app = unsafe {
        object(
            objc_getClass(c"NSApplication".as_ptr()),
            c"sharedApplication",
        )
    };
    let main = unsafe { object(app, c"mainMenu") };
    let app_menu = unsafe { object(at(main, 0), c"submenu") };
    let daemon = unsafe { object(at(app_menu, 3), c"submenu") };
    (unsafe { object(daemon, c"delegate") }, unsafe {
        at(daemon, ix)
    })
}
unsafe fn enabled(ix: isize) -> bool {
    let (_, item) = unsafe { item(ix) };
    let call: unsafe extern "C" fn(Id, Sel) -> bool =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(item, sel_registerName(c"isEnabled".as_ptr())) }
}
unsafe fn dispatch(ix: isize) {
    let (delegate, item) = unsafe { item(ix) };
    let call: unsafe extern "C" fn(Id, Sel, Id) =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe {
        call(
            delegate,
            sel_registerName(c"handleGPUIMenuItem:".as_ptr()),
            item,
        )
    }
}
struct Prompt(FocusHandle);
impl Focusable for Prompt {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.0.clone()
    }
}
impl EventEmitter<gpui_kit::PromptResponse> for Prompt {}
impl Render for Prompt {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui_kit::div()
    }
}

pub(crate) fn run(cx: &mut App) {
    let (done, completed) = async_channel::unbounded();
    let state = Arc::new(Mutex::new(State::Stopped));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let driver = state.clone();
    let worker: Worker = Arc::new(move |command, _| {
        recorded.lock().unwrap().push(command);
        let mut state = driver.lock().unwrap();
        if let Some(command) = command {
            *state = if command == Command::Stop {
                State::Stopped
            } else {
                State::Running
            };
        }
        Ok(Report {
            state: *state,
            available: true,
        })
    });
    let owner = cx.new(|_| Owner {
        worker,
        window: None,
        available: true,
        state: Some(State::Stopped),
        message: "Last checked: stopped".into(),
        busy: false,
        command: None,
        confirming: false,
        unknown: false,
        manual: false,
        cancel: Arc::new(AtomicBool::new(false)),
        task: None,
    });
    cx.set_global(Managed(owner.clone()));
    cx.subscribe(&owner, move |_, _: &Changed, _| {
        let _ = done.try_send(());
    })
    .detach();
    // Substitute only the platform prompt renderer, not the production command,
    // confirmation gate, worker bridge or result projection. Never show an alert.
    cx.set_prompt_builder(|_, message, _, _, handle, w, cx| {
        assert!(message.ends_with("Local daemon?"));
        let prompt = cx.new(|cx| Prompt(cx.focus_handle()));
        let answer = prompt.clone();
        let view = handle.with_view(prompt, w, cx);
        cx.defer(move |cx| answer.update(cx, |_, cx| cx.emit(gpui_kit::PromptResponse(0))));
        view
    });
    let (window, _) = gpui_kit::open_window(
        WindowOptions {
            show: false,
            focus: false,
            ..Default::default()
        },
        cx,
        |_, cx| cx.new(|cx| Prompt(cx.focus_handle())),
    )
    .unwrap();
    owner.update(cx, |o, _| o.window = Some(window));
    refresh(cx);
    cx.spawn(async move|cx| {
        // Native callbacks must run outside the App borrow.
        unsafe {
            assert!(enabled(2));assert!(!enabled(3));assert!(!enabled(4));
            dispatch(2);
        }
        completed.recv().await.unwrap();
        cx.update(|cx| assert_eq!(owner.read(cx).state,Some(State::Running)));
        unsafe {assert!(!enabled(2));assert!(enabled(3));assert!(enabled(4));dispatch(4);}
        completed.recv().await.unwrap();
        unsafe {dispatch(3);}
        completed.recv().await.unwrap();
        cx.update(|cx|assert_eq!(owner.read(cx).state,Some(State::Stopped)));
        unsafe {assert!(enabled(2));assert!(!enabled(3));dispatch(6);}
        completed.recv().await.unwrap();
        unsafe {dispatch(2);}
        completed.recv().await.unwrap();
        cx.update(|cx| {
            assert_eq!(*calls.lock().unwrap(),vec![Some(Command::Start),Some(Command::Restart),Some(Command::Stop),None,Some(Command::Start)]);
            window.update(cx,|_,w,_|w.remove_window()).unwrap();
            refresh(cx);
            assert_eq!(owner.read(cx).state,Some(State::Running));
        });
        unsafe {assert!(!enabled(2));assert!(!enabled(3));assert!(!enabled(4));dispatch(3);}
        cx.update(|cx| {
            assert_eq!(calls.lock().unwrap().len(),5,"window close/no-window action never stops a daemon");
            cx.on_app_quit(move |_| {assert_eq!(calls.lock().unwrap().len(),5);async{}}).detach();
            println!("native_menus: hidden Daemon Start/Stop/Restart, confirmation, state, inspection and no-window/Quit independence passed");
            cx.quit();
        });
    }).detach();
}
