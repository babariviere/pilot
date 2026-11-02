//! Hidden native opaque-window and appearance lifecycle checks.
#[cfg(target_os = "macos")]
mod mac {
    use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};
    use gpui_kit::{
        AppContext, Context, IntoElement, Render, Window, WindowBackgroundAppearance,
        WindowOptions, div, px, size,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::ffi::{c_char, c_void};

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    struct Fixture;
    impl Render for Fixture {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    fn inspect(window: &Window, background: WindowBackgroundAppearance, visible: bool) {
        let blurred = background == WindowBackgroundAppearance::Blurred;
        let RawWindowHandle::AppKit(handle) =
            HasWindowHandle::window_handle(window).unwrap().as_raw()
        else {
            panic!("expected a real AppKit window");
        };
        // SAFETY: main-thread, live AppKit objects, selectors use their exact ABI.
        unsafe {
            let object: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let integer: unsafe extern "C" fn(*mut c_void, *const c_void) -> usize =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let at: unsafe extern "C" fn(*mut c_void, *const c_void, usize) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let is_kind: unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void) -> bool =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let boolean: unsafe extern "C" fn(*mut c_void, *const c_void) -> bool =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let ns_window = object(
                handle.ns_view.as_ptr(),
                sel_registerName(c"window".as_ptr()),
            );
            assert_eq!(
                boolean(ns_window, sel_registerName(c"isVisible".as_ptr())),
                visible
            );
            if !visible {
                assert!(!boolean(
                    ns_window,
                    sel_registerName(c"isKeyWindow".as_ptr())
                ));
            } else {
                println!(
                    "capture_window={} native_blur={} supported={}",
                    integer(ns_window, sel_registerName(c"windowNumber".as_ptr())),
                    blurred,
                    window.supports_background_blur()
                );
            }
            let content = object(ns_window, sel_registerName(c"contentView".as_ptr()));
            let views = object(content, sel_registerName(c"subviews".as_ptr()));
            let count = integer(views, sel_registerName(c"count".as_ptr()));
            let mut materials = 0;
            for index in 0..count {
                let view = at(views, sel_registerName(c"objectAtIndex:".as_ptr()), index);
                if is_kind(
                    view,
                    sel_registerName(c"isKindOfClass:".as_ptr()),
                    objc_getClass(c"NSVisualEffectView".as_ptr()),
                ) {
                    materials += 1;
                    assert_eq!(
                        integer(view, sel_registerName(c"material".as_ptr())),
                        21,
                        "UnderWindowBackground"
                    );
                    assert_eq!(
                        integer(view, sel_registerName(c"blendingMode".as_ptr())),
                        0,
                        "BehindWindow"
                    );
                    assert_eq!(
                        integer(view, sel_registerName(c"state".as_ptr())),
                        1,
                        "Active even while window is inactive"
                    );
                    assert_eq!(
                        integer(view, sel_registerName(c"autoresizingMask".as_ptr())) & 18,
                        18,
                        "tracks width and height"
                    );
                }
            }
            assert_eq!(
                materials,
                usize::from(blurred),
                "one native material, never plain transparency"
            );
            assert_eq!(
                boolean(ns_window, sel_registerName(c"isOpaque".as_ptr())),
                background == WindowBackgroundAppearance::Opaque
            );
            assert_eq!(
                object(ns_window, sel_registerName(c"firstResponder".as_ptr())),
                handle.ns_view.as_ptr(),
                "retain native input view"
            );
        }
    }

    fn notify_accessibility() {
        // SAFETY: exact AppKit/Foundation method signatures on the main thread.
        // Posting the notification exercises observation without changing preferences.
        unsafe {
            let object: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let string: unsafe extern "C" fn(
                *mut c_void,
                *const c_void,
                *const c_char,
            ) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let post: unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void, *mut c_void) =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let workspace = object(
                objc_getClass(c"NSWorkspace".as_ptr()),
                sel_registerName(c"sharedWorkspace".as_ptr()),
            );
            let center = object(workspace, sel_registerName(c"notificationCenter".as_ptr()));
            let name = string(
                objc_getClass(c"NSString".as_ptr()),
                sel_registerName(c"stringWithUTF8String:".as_ptr()),
                c"NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification".as_ptr(),
            );
            post(
                center,
                sel_registerName(c"postNotificationName:object:".as_ptr()),
                name,
                std::ptr::null_mut(),
            );
        }
    }

    pub fn run() {
        gpui_kit::application().run(|cx| {
            gpui_kit::init(cx);
            pilot_desktop::init_appearance(cx);
            cx.spawn(async move |cx| {
                // Check recreated opaque windows and appearance changes.
                for _ in 0..2 {
                    let notifications = std::rc::Rc::new(std::cell::Cell::new(0));
                    let handle = cx.update(|cx| {
                        let (handle, _) = gpui_kit::open_window(
                            WindowOptions { show: false, focus: false, ..Default::default() },
                            cx,
                            |window, cx| {
                                pilot_desktop::follow_appearance(window, cx);
                                let notifications = notifications.clone();
                                window.observe_window_appearance(move |_, _| {
                                    notifications.set(notifications.get() + 1);
                                }).detach();
                                inspect(window, WindowBackgroundAppearance::Opaque, false);
                                cx.new(|_| Fixture)
                            },
                        ).unwrap();
                        handle
                    });
                    cx.background_executor().timer(std::time::Duration::from_millis(30)).await;
                    let before = notifications.get();
                    cx.update(|_| notify_accessibility());
                    cx.background_executor().timer(std::time::Duration::from_millis(30)).await;
                    assert!(notifications.get() > before, "native accessibility notification reaches GPUI");
                    for (appearance, mode) in [
                        (gpui_kit::WindowAppearance::Light, ThemeMode::Light),
                        (gpui_kit::WindowAppearance::Dark, ThemeMode::Dark),
                    ] {
                        handle.update(cx, |_, window, cx| {
                            cx.set_window_appearance(Some(appearance));
                            Theme::change(mode, None, cx);
                            window.resize(size(px(720.), px(520.)));
                            notify_accessibility();
                        }).unwrap();
                        // One settling delay for native notification/executor callbacks,
                        // not a polling loop or a visible/activated test window.
                        cx.background_executor().timer(std::time::Duration::from_millis(30)).await;
                        handle.update(cx, |_, window, cx| {
                            inspect(window, WindowBackgroundAppearance::Opaque, false);
                            assert_eq!(cx.theme().background.a, 1.);
                            assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                        }).unwrap();
                    }
                    handle.update(cx, |_, window, _| window.remove_window()).unwrap();
                }
                println!("hidden AppKit opaque window, theme/accessibility notifications, resize mask, input view and recreation passed");
                cx.update(|cx| cx.quit());
            }).detach();
        });
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    mac::run();
    #[cfg(not(target_os = "macos"))]
    panic!("this target inspects AppKit");
}
