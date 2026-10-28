//! Test-only AppKit readback. Never opens, shows or activates a window.
use std::{
    cell::Cell,
    ffi::{CStr, c_char, c_void},
    rc::Rc,
};

type Id = *mut c_void;
type Sel = *const c_void;
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
}

// SAFETY: Each helper is called only on live AppKit menu/application objects,
// on the main thread inside application.run, with the exact selector ABI.
unsafe fn object(receiver: Id, selector: &CStr) -> Id {
    let call: unsafe extern "C" fn(Id, Sel) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(receiver, sel_registerName(selector.as_ptr())) }
}
unsafe fn at(receiver: Id, index: isize) -> Id {
    let call: unsafe extern "C" fn(Id, Sel, isize) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(receiver, sel_registerName(c"itemAtIndex:".as_ptr()), index) }
}
unsafe fn string(receiver: Id, selector: &CStr) -> String {
    let value = unsafe { object(receiver, selector) };
    let utf8 = unsafe { object(value, c"UTF8String") };
    assert!(!utf8.is_null());
    unsafe { CStr::from_ptr(utf8.cast()) }
        .to_str()
        .unwrap()
        .to_owned()
}

unsafe fn integer(receiver: Id, selector: &CStr) -> usize {
    let call: unsafe extern "C" fn(Id, Sel) -> usize =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(receiver, sel_registerName(selector.as_ptr())) }
}

unsafe fn available(delegate: Id, item: Id) -> bool {
    let call: unsafe extern "C" fn(Id, Sel, Id) -> bool =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe {
        call(
            delegate,
            sel_registerName(c"validateMenuItem:".as_ptr()),
            item,
        )
    }
}

pub(super) fn run() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        crate::TranscriptView::bind_keys(cx);
        crate::LocalViewer::bind_keys(cx);
        super::init(cx);
        let dispatched = Rc::new(Cell::new(0));
        let count = dispatched.clone();
        // Synthetic receiver only. No Local client, storage or backend exists.
        cx.on_action(move |_: &crate::local_view::NewChat, _| count.set(count.get() + 1));
        // Native callbacks re-enter App. Run outside an App update borrow.
        cx.spawn(async move |cx| {
            // SAFETY: Running on AppKit's main thread. GPUI owns all objects until
            // after this callback; no pointer escapes and no window is created.
            unsafe {
                let app = object(objc_getClass(c"NSApplication".as_ptr()), c"sharedApplication");
                let menu = object(app, c"mainMenu");
                assert!(!menu.is_null());
                for (index, title) in ["Pilot Next", "File", "Edit", "Go", "Window"].iter().enumerate() {
                    let item = at(menu, index as isize);
                    assert_eq!(string(item, c"title"), *title);
                }
                let file = object(at(menu, 1), c"submenu");
                let delegate = object(file, c"delegate");
                let new_chat = at(file, 0);
                assert_eq!(string(new_chat, c"title"), "New Chat");
                assert_eq!(string(new_chat, c"keyEquivalent"), "n");
                assert!(available(delegate, new_chat), "synthetic handler is available");
                let app_menu = object(at(menu, 0), c"submenu");
                assert_eq!(string(at(app_menu, 2), c"keyEquivalent"), ",");
                assert!(!available(delegate, at(app_menu, 2)), "Settings unavailable without a Local owner");
                assert_eq!(string(at(app_menu, 10), c"keyEquivalent"), "q");
                let edit = object(at(menu, 2), c"submenu");
                for (index, title, key) in [(0,"Undo","z"), (1,"Redo","z"), (3,"Cut","x"), (4,"Copy","c"), (5,"Paste","v"), (6,"Select All","a")] {
                    let item = at(edit, index);
                    assert_eq!(string(item, c"title"), title);
                    assert_eq!(string(item, c"keyEquivalent"), key);
                    let command = 1 << 20;
                    let shift = if index == 1 { 1 << 17 } else { 0 };
                    assert_eq!(integer(item, c"keyEquivalentModifierMask"), command | shift);
                    let action = object(item, c"action");
                    let selector = match index {
                        3 => c"cut:", 4 => c"copy:", 5 => c"paste:", 6 => c"selectAll:",
                        _ => c"handleGPUIMenuItem:",
                    };
                    assert_eq!(action.cast_const(), sel_registerName(selector.as_ptr()));
                }
                // Invoke the native item's GPUI delegate entry point once. This
                // does not need a key window, activation, keyboard events or UI.
                let send: unsafe extern "C" fn(Id, Sel, Id) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                send(delegate, sel_registerName(c"handleGPUIMenuItem:".as_ptr()), new_chat);
            }
            cx.update(|cx| {
                assert_eq!(dispatched.get(), 1, "native item dispatches exactly once");
                assert!(cx.windows().is_empty(), "probe never creates a window");
                println!("native_menus: AppKit hierarchy, standard shortcuts and single dispatch passed (no windows)");
                cx.quit();
            });
        }).detach();
    });
}
