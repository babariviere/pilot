//! Hidden native request/lifecycle checks, NOT proof of visible backdrop blur.
#[cfg(target_os = "macos")]
mod mac {
    use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};
    use gpui_kit::{
        AppContext, Bounds, Context, IntoElement, ParentElement, Render, Styled, Window,
        WindowBackgroundAppearance, WindowBounds, WindowOptions, div, point, px, size,
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
                // First prove the real opaque, non-opted-in request path.
                for requested in [false, true, true] {
                    let notifications = std::rc::Rc::new(std::cell::Cell::new(0));
                    let handle = cx.update(|cx| {
                        if requested { pilot_desktop::enable_glass(cx); }
                        let (handle, _) = gpui_kit::open_window(
                            WindowOptions { show: false, focus: false, ..Default::default() },
                            cx,
                            |window, cx| {
                                pilot_desktop::follow_appearance(window, cx);
                                let notifications = notifications.clone();
                                window.observe_window_appearance(move |_, _| {
                                    notifications.set(notifications.get() + 1);
                                }).detach();
                                let background = if requested && window.supports_background_blur() {
                                    WindowBackgroundAppearance::Blurred
                                } else { WindowBackgroundAppearance::Opaque };
                                inspect(window, background, false);
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
                            let blurred = requested && window.supports_background_blur();
                            inspect(window, if blurred { WindowBackgroundAppearance::Blurred } else { WindowBackgroundAppearance::Opaque }, false);
                            assert_eq!(cx.theme().background.a < 1., blurred);
                            assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                        }).unwrap();
                    }
                    handle.update(cx, |_, window, _| window.remove_window()).unwrap();
                }
                println!("hidden AppKit material, inactive state, opaque fallback, theme/accessibility notifications, resize mask, input view and window recreation passed; visible blur unqualified");
                cx.update(|cx| cx.quit());
            }).detach();
        });
    }

    struct Pattern;
    impl Render for Pattern {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .relative()
                .size_full()
                .bg(gpui_kit::white())
                .children((0..190).map(|index| {
                    let color = [0xe44060, 0x305de0, 0x29b070, 0xffd035][(index / 24) % 4];
                    div()
                        .absolute()
                        .left(px(index as f32 * 6.))
                        .top_0()
                        .w(px(6.))
                        .h_full()
                        .bg(gpui_kit::rgb(if index % 2 == 0 { color } else { 0xffffff }))
                }))
        }
    }
    struct Comparison {
        label: &'static str,
        opaque: bool,
    }
    impl Render for Comparison {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            use gpui_kit::component::StyledExt as _;
            let mut page = cx.theme().background;
            if self.opaque {
                page.a = 1.;
            }
            div()
                .v_flex()
                .size_full()
                .bg(if self.opaque {
                    page
                } else {
                    cx.theme().transparent
                })
                .text_color(cx.theme().foreground)
                .child(div().p_3().bg(cx.theme().popover).child(self.label))
                .child(div().flex_1().child("No app tint"))
                .child(div().flex_1().bg(page).child("Approved page tint"))
        }
    }

    /// Explicitly opt-in visible compositor comparison, never run by CI.
    pub fn visible() {
        gpui_kit::application().run(|cx| {
            gpui_kit::init(cx);
            pilot_desktop::init_appearance(cx);
            pilot_desktop::enable_glass(cx);
            pilot_desktop::TranscriptView::bind_keys(cx);
            let bounds = Bounds::centered(None, size(px(1140.), px(700.)), cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    focus: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    window.set_window_title("Known background: sharp 6pt stripes");
                    cx.new(|_| Pattern)
                },
            )
            .unwrap();
            let mut handles = Vec::new();
            for (index, (label, background)) in [
                ("Native material", WindowBackgroundAppearance::Blurred),
                (
                    "Plain transparency control",
                    WindowBackgroundAppearance::Transparent,
                ),
                ("Opaque control", WindowBackgroundAppearance::Opaque),
            ]
            .into_iter()
            .enumerate()
            {
                let (handle, _) = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            bounds.origin + point(px(20. + index as f32 * 375.), px(85.)),
                            size(px(350.), px(550.)),
                        ))),
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        if background == WindowBackgroundAppearance::Blurred {
                            pilot_desktop::follow_appearance(window, cx);
                        } else {
                            window.set_background_appearance(background);
                        }
                        window.set_window_title(label);
                        println!("{label}: page_alpha={}", cx.theme().background.a);
                        cx.new(|_| Comparison {
                            label,
                            opaque: background == WindowBackgroundAppearance::Opaque,
                        })
                    },
                )
                .unwrap();
                handles.push((handle, background));
            }
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                for (handle, background) in handles {
                    handle
                        .update(cx, |_, window, _| {
                            inspect(
                                window,
                                if background == WindowBackgroundAppearance::Blurred
                                    && !window.supports_background_blur()
                                {
                                    WindowBackgroundAppearance::Opaque
                                } else {
                                    background
                                },
                                true,
                            );
                        })
                        .unwrap();
                }
            })
            .detach();
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    if std::env::args().any(|arg| arg == "--visible") {
        mac::visible();
    } else {
        mac::run();
    }
    #[cfg(not(target_os = "macos"))]
    panic!("this target inspects AppKit; Wayland request fixtures are in gpui-pre-linux");
}
