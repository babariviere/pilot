//! Hidden actual AppKit interactions, not hardware IME or a benchmark.
use super::*;
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn on_main<R: Send>(f: impl FnOnce(&NSWindow) -> R + Send) -> R {
    let mut result = None;
    dispatch2::DispatchQueue::main().exec_sync(|| {
        let app = NSApplication::sharedApplication(MainThreadMarker::new().expect("main queue"));
        result = Some(f(&app.windows().firstObject().expect("native chat window")));
    });
    result.expect("main queue reply")
}
fn has_label(window: &NSWindow, label: &str) -> bool {
    descendants(&window.contentView().expect("content view"))
        .iter()
        .any(|view| {
            NSAccessibility::accessibilityLabel(&**view)
                .is_some_and(|text| text.to_string() == label)
        })
}
fn wait_for(label: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !on_main(move |w| has_label(w, label)) {
        assert!(
            Instant::now() < deadline,
            "native label {label} unavailable"
        );
        std::thread::sleep(Duration::from_millis(30));
    }
}
fn press(window: &NSWindow, label: &str) {
    let root = window.contentView().expect("content view");
    let views = descendants(&root);
    let target = views
        .iter()
        .find(|v| {
            NSAccessibility::accessibilityLabel(&***v).is_some_and(|text| text.to_string() == label)
        })
        .expect("native button");
    let surface = views
        .iter()
        .find(|v| v.class().name() == c"NshView")
        .expect("NSH surface");
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
        let event=NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(kind,point,NSEventModifierFlags::empty(),NSProcessInfo::processInfo().systemUptime(),window.windowNumber(),None,0,1,1.).expect("mouse event");
        if kind == NSEventType::LeftMouseDown {
            surface.mouseDown(&event);
        } else {
            surface.mouseUp(&event);
        }
    }
}
fn screenshot(window: &NSWindow, path: &Path) {
    let view = window.contentView().expect("content view");
    let bitmap = view
        .bitmapImageRepForCachingDisplayInRect(view.bounds())
        .expect("native bitmap");
    view.cacheDisplayInRect_toBitmapImageRep(view.bounds(), &bitmap);
    // SAFETY: live AppKit bitmap and an empty PNG-properties dictionary.
    let data = unsafe {
        bitmap.representationUsingType_properties(
            NSBitmapImageFileType::PNG,
            &NSDictionary::<NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>::new(),
        )
    }
    .expect("PNG encoding");
    std::fs::write(path, data.to_vec()).expect("native capture");
}
const EXACT: &str = "  日本語 👩🏽‍💻 cafe\u{301}\nsecond line  ";
fn reply_editor(window: &NSWindow) -> Retained<NSTextView> {
    descendants(&window.contentView().expect("content view"))
        .into_iter()
        .filter_map(|view| view.downcast::<NSTextView>().ok())
        .find(|view| input_label(view).is_some_and(|l| l.starts_with("Reply in ")))
        .expect("native question input")
}
fn insert(input: &NSTextView, text: &str) {
    // SAFETY: the fixture calls this on AppKit's main thread with a live input.
    unsafe {
        input.insertText_replacementRange(&NSString::from_str(text), NSRange::new(usize::MAX, 0));
    }
}
pub(super) fn start(path: PathBuf, restart: bool, prompts: bool) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("capture directory");
    }
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| {
            let settle = || std::thread::sleep(Duration::from_millis(350));
            if prompts {
                wait_for("Open chat a");
                on_main(|w| press(w, "Open chat a"));
                wait_for("Send answer");
                settle();
                on_main(|w| {
                    let ordinary = editor(w).expect("ordinary input");
                    w.makeFirstResponder(Some(&ordinary));
                    insert(&ordinary, "ordinary draft\n保持");
                    let reply = reply_editor(w);
                    assert!(w.makeFirstResponder(Some(&reply)));
                    insert(&reply, EXACT);
                });
                settle();
                on_main(|w| {
                    let reply = reply_editor(w);
                    // SAFETY: simulate the native marked-text protocol on a whole
                    // Japanese selection, not hardware/input-method qualification.
                    unsafe {
                        reply.setMarkedText_selectedRange_replacementRange(
                            &NSString::from_str("日本語"),
                            NSRange::new(3, 0),
                            NSRange::new(2, 3),
                        );
                    }
                    assert!(NSTextInputClient::hasMarkedText(&*reply));
                    w.performClose(None);
                    assert!(
                        NSTextInputClient::hasMarkedText(&*reply),
                        "Close cannot release marked input"
                    );
                    insert(&reply, "日本語");
                    assert!(!NSTextInputClient::hasMarkedText(&*reply));
                    assert_eq!(reply.string().to_string(), EXACT);
                });
                settle();
                on_main(|w| press(w, "Typecheck"));
                settle();
                on_main(|w| press(w, "Tests"));
                settle();
                let question_capture = path.clone();
                on_main(move |w| screenshot(w, &question_capture));
                on_main(|w| press(w, "Open chat b"));
                wait_for("Allow database access");
                settle();
                let permission = path.with_file_name(format!(
                    "{}-write.png",
                    path.file_stem().expect("stem").to_string_lossy()
                ));
                on_main(move |w| {
                    screenshot(w, &permission);
                    press(w, "Deny database access");
                });
                settle();
                on_main(|w| press(w, "Open chat coordinator"));
                wait_for("Allow database access");
                settle();
                let permission = path.with_file_name(format!(
                    "{}-read.png",
                    path.file_stem().expect("stem").to_string_lossy()
                ));
                on_main(move |w| {
                    screenshot(w, &permission);
                    press(w, "Allow database access");
                });
                settle();
                on_main(|w| press(w, "Open chat a"));
                wait_for("Send answer");
                settle();
                on_main(|w| {
                    assert_eq!(reply_editor(w).string().to_string(), EXACT);
                    assert_eq!(
                        editor(w).expect("ordinary input").string().to_string(),
                        "ordinary draft\n保持"
                    );
                    let reply = reply_editor(w);
                    assert!(w.makeFirstResponder(Some(&reply)));
                    let range = NSRange::new(2, "日本語".encode_utf16().count());
                    reply.setSelectedRange(range);
                    assert_eq!(NSTextInputClient::selectedRange(&*reply), range);
                    press(w, "Send answer");
                });
                settle();
                on_main(|w| press(w, "Stop reply"));
                settle();
                on_main(|w| {
                    assert_eq!(
                        editor(w).expect("kept ordinary draft").string().to_string(),
                        "ordinary draft\n保持"
                    );
                    w.performClose(None);
                });
                return;
            }
            if restart {
                wait_for("Open chat b");
                on_main(|w| press(w, "Open chat b"));
                settle();
                on_main(move |w| {
                    assert_eq!(
                        editor(w).expect("restarted composer").string().to_string(),
                        "independent draft\n保持",
                        "process restart restores exact draft"
                    );
                    screenshot(w, &path);
                    w.performClose(None);
                });
                return;
            }
            wait_for("Open chat a");
            on_main(|w| press(w, "Open chat a"));
            settle();
            on_main(|w| {
                let input = editor(w).expect("composer");
                assert!(
                    w.makeFirstResponder(Some(&input)),
                    "native composer takes focus"
                );
                // GCD insertions do not create real keyboard-event undo boundaries.
                // Isolate their native undo groups without changing the app policy.
                let undo = input.undoManager().expect("native undo manager");
                undo.setGroupsByEvent(false);
                undo.beginUndoGrouping();
                // SAFETY: native editor mutation on its main thread.
                unsafe {
                    input.insertText_replacementRange(
                        &NSString::from_str(EXACT),
                        NSRange::new(usize::MAX, 0),
                    );
                }
                assert_eq!(input.string().to_string(), EXACT);
                undo.endUndoGrouping();
            });
            settle();
            on_main(|w| {
                let input = editor(w).expect("composer");
                let undo = input.undoManager().expect("native undo manager");
                undo.beginUndoGrouping();
                let range = NSRange::new(2, "日本語".encode_utf16().count());
                input.setSelectedRange(range);
                assert_eq!(
                    NSTextInputClient::selectedRange(&*input),
                    range,
                    "native UTF-16 selection"
                );
                input.breakUndoCoalescing();
                // SAFETY: replace a complete grapheme-aligned native selection.
                unsafe {
                    input.insertText_replacementRange(&NSString::from_str("replacement"), range);
                }
                assert!(input.string().to_string().contains("replacement"));
                undo.endUndoGrouping();
            });
            settle();
            on_main(|w| {
                let input = editor(w).expect("composer");
                let undo = input.undoManager().expect("native undo manager");
                let app = NSApplication::sharedApplication(MainThreadMarker::from(w));
                w.makeKeyWindow();
                assert!(
                    // SAFETY: standard AppKit Undo through the native responder chain.
                    unsafe { app.sendAction_to_from(objc2::sel!(undo:), None, None) },
                    "native Undo action is handled"
                );
                assert_eq!(
                    input.string().to_string(),
                    EXACT,
                    "native undo keeps exact Unicode"
                );
                undo.setGroupsByEvent(true);
            });
            settle();
            on_main(|w| press(w, "Open chat b"));
            settle();
            on_main(|w| {
                let input = editor(w).expect("second composer");
                assert_eq!(input.string().to_string(), "");
                w.makeFirstResponder(Some(&input));
                // SAFETY: main-thread native insertion.
                unsafe {
                    input.insertText_replacementRange(
                        &NSString::from_str("independent draft\n保持"),
                        NSRange::new(usize::MAX, 0),
                    );
                }
            });
            settle();
            on_main(|w| press(w, "Open chat a"));
            settle();
            on_main(|w| {
                assert_eq!(
                    editor(w).expect("restored composer").string().to_string(),
                    EXACT
                )
            });
            on_main(|w| press(w, "Send message"));
            wait_for("Stop reply");
            settle();
            on_main(|w| {
                assert_eq!(editor(w).expect("sent composer").string().to_string(), "");
                press(w, "Open chat b");
            });
            settle();
            on_main(|w| {
                assert_eq!(
                    editor(w)
                        .expect("independent composer")
                        .string()
                        .to_string(),
                    "independent draft\n保持"
                )
            });
            on_main(|w| press(w, "Open chat a"));
            settle();
            on_main(|w| press(w, "Stop reply"));
            settle();
            on_main(move |w| screenshot(w, &path));
            on_main(|w| press(w, "Open chat b"));
            settle();
            on_main(|w| {
                assert_eq!(
                    editor(w).expect("saved composer").string().to_string(),
                    "independent draft\n保持"
                );
                w.performClose(None);
            });
        });
        if result.is_err() {
            std::process::exit(1);
        }
    });
}
