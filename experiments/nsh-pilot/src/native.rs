//! Hidden AppKit smoke check and capture. Not hardware input or a performance test.
use dispatch2::DispatchQueue;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::*,
    objc2_foundation::*,
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn on_main<R: Send>(f: impl FnOnce(&NSWindow) -> R + Send) -> R {
    let mut result = None;
    DispatchQueue::main().exec_sync(|| {
        let app = NSApplication::sharedApplication(MainThreadMarker::new().expect("main queue"));
        let window = app.windows().firstObject().expect("prototype window");
        result = Some(f(&window));
    });
    result.expect("main queue result")
}

fn descendants(view: &NSView) -> Vec<Retained<NSView>> {
    let mut found = vec![];
    for child in view.subviews() {
        found.push(child.clone());
        found.extend(descendants(&child));
    }
    found
}

fn editor(window: &NSWindow) -> Retained<NSTextView> {
    descendants(&window.contentView().expect("content view"))
        .into_iter()
        .find_map(|view| view.downcast::<NSTextView>().ok())
        .expect("native multiline composer")
}

fn press(window: &NSWindow, id: &str) {
    let root = window.contentView().expect("content view");
    let views: Vec<_> = std::iter::once(root.clone())
        .chain(descendants(&root))
        .collect();
    let target = views
        .iter()
        .find(|view| {
            NSAccessibility::accessibilityLabel(&***view)
                .is_some_and(|value| value.to_string() == id)
        })
        .expect("native button by test id");
    let surface = views
        .iter()
        .find(|view| view.class().name() == c"NshView")
        .expect("NSH input surface");
    let layer = target.layer().expect("button layer");
    let rect = layer.convertRect_toLayer(layer.bounds(), root.layer().as_deref());
    let point = root.convertPoint_toView(
        NSPoint::new(
            rect.origin.x + rect.size.width / 2.,
            rect.origin.y + rect.size.height / 2.,
        ),
        None,
    );
    for kind in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind, point, NSEventModifierFlags::empty(), NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, 0, 1, 1.).expect("synthetic mouse event");
        match kind {
            NSEventType::LeftMouseDown => surface.mouseDown(&event),
            _ => surface.mouseUp(&event),
        }
    }
}

fn screenshot(window: &NSWindow, path: &Path) {
    let view = window.contentView().expect("content view");
    let bitmap = view
        .bitmapImageRepForCachingDisplayInRect(view.bounds())
        .expect("native bitmap");
    view.cacheDisplayInRect_toBitmapImageRep(view.bounds(), &bitmap);
    // SAFETY: valid AppKit-owned bitmap and an empty PNG-properties dictionary.
    let data =
        unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG,
        &NSDictionary::<NSBitmapImageRepPropertyKey, platform::objc2::runtime::AnyObject>::new())
        }
        .expect("PNG encoding");
    std::fs::write(path, data.to_vec()).expect("write native capture");
}

fn has_label(window: &NSWindow, label: &str) -> bool {
    descendants(&window.contentView().expect("content view"))
        .iter()
        .any(|view| {
            NSAccessibility::accessibilityLabel(&**view)
                .is_some_and(|value| value.to_string() == label)
        })
}

pub(super) fn capture(options: platform::AppOptions, path: PathBuf) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("capture directory");
    }
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    // SAFETY: create and keep the window on the main thread throughout its lifetime.
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
    // SAFETY: this scope owns the retained window until the app loop stops.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let view = platform::AppView::new(mtm, options);
    window.setContentView(Some(&view.view()));
    view.load(pilot_nsh_workbench::root().into());
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| {
            // Allow hidden native mount/layout callbacks to settle. No timing claim.
            let settle = || std::thread::sleep(Duration::from_millis(400));
            std::thread::sleep(Duration::from_secs(2));
            on_main(|window| {
                let input = editor(window);
                window.makeFirstResponder(Some(&input));
                // SAFETY: native insertion into a live main-thread NSTextView; NSNotFound appends at its selection.
                unsafe {
                    input.insertText_replacementRange(
                        &NSString::from_str("日本語 👩🏽‍💻 native draft"),
                        NSRange::new(usize::MAX, 0),
                    );
                }
            });
            settle();
            on_main(|window| {
                assert_eq!(
                    editor(window).string().to_string(),
                    "日本語 👩🏽‍💻 native draft"
                )
            });
            on_main(|window| press(window, "Open Keep drafts across navigation"));
            settle();
            on_main(|window| assert_eq!(editor(window).string().to_string(), ""));
            on_main(|window| press(window, "Open Native Shell chat and sidebar"));
            settle();
            on_main(|window| {
                assert_eq!(
                    editor(window).string().to_string(),
                    "日本語 👩🏽‍💻 native draft"
                )
            });
            on_main(|window| screenshot(window, &path));
            on_main(|window| press(window, "Send message"));
            settle();
            on_main(|window| {
                assert_eq!(editor(window).string().to_string(), "");
                assert!(
                    has_label(window, "Stop reply"),
                    "native Send starts a reply"
                );
                press(window, "Stop reply");
            });
            settle();
            on_main(move |window| {
                assert!(
                    !has_label(window, "Stop reply"),
                    "native Stop ends the replay"
                );
                let reply = path.with_file_name(format!(
                    "{}-reply.png",
                    path.file_stem().expect("capture stem").to_string_lossy()
                ));
                screenshot(window, &reply);
            });
        });
        if result.is_err() {
            std::process::exit(1);
        }
        on_main(|window| {
            let app = NSApplication::sharedApplication(MainThreadMarker::from(window));
            app.stop(None);
            let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined, NSPoint::new(0.,0.), NSEventModifierFlags::empty(), 0., window.windowNumber(), None, 0, 0, 0).expect("stop event");
            app.postEvent_atStart(&event, false);
        });
    });
    app.run();
    view.stop();
    window.orderOut(None);
    println!("Native composer, sidebar draft round-trip, Send and Stop passed.");
}
