//! Hidden native production-adapter image check. Same hardened coordinate and
//! input-readiness helpers as the chat/history probes. No system clipboard writes.
use super::*;
use pilot_desktop::nsh_adapter::{ImageAdmission, ImagePreview};
use std::sync::{Arc, Mutex};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateMouseEvent(
        source: *const std::ffi::c_void,
        kind: u32,
        position: NSPoint,
        button: u32,
    ) -> *const std::ffi::c_void;
}
fn middle_drag(window: &NSWindow) {
    let root = window.contentView().unwrap();
    let surface = descendants(&root)
        .into_iter()
        .find(|v| v.class().name() == c"NshView")
        .unwrap();
    let screen_height = NSScreen::mainScreen(MainThreadMarker::from(window))
        .unwrap()
        .frame()
        .size
        .height;
    // An ordinary move establishes the drag's start; two middle-drag packets
    // exercise NSH's supported MouseEvent without posting to the OS.
    for (kind, x, y) in [(5, 400., 400.), (27, 390., 400.), (27, 330., 400.)] {
        let point = window.convertPointToScreen(NSPoint::new(x, y));
        // SAFETY: owned CGEvent, a live AppKit host and standard event/button IDs.
        unsafe {
            let event = CGEventCreateMouseEvent(
                std::ptr::null(),
                kind,
                NSPoint::new(point.x, screen_height - point.y),
                2,
            );
            assert!(!event.is_null());
            let native = NSEvent::eventWithCGEvent(&*event.cast()).expect("native mouse event");
            CFRelease(event);
            if kind == 5 {
                surface.mouseMoved(&native);
            } else {
                surface.otherMouseDragged(&native);
            }
        }
    }
}

fn rect(window: &NSWindow, label: &str) -> Option<NSRect> {
    let root = window.contentView()?;
    let view = descendants(&root).into_iter().find(|v| {
        !v.isHiddenOrHasHiddenAncestor()
            && NSAccessibility::accessibilityLabel(&**v).is_some_and(|s| s.to_string() == label)
    })?;
    let center = press_point(&view, &root);
    let size = view.bounds().size;
    Some(NSRect::new(
        NSPoint::new(center.x - size.width / 2., center.y - size.height / 2.),
        size,
    ))
}

fn focused_find(window: &NSWindow) -> Option<Retained<NSTextView>> {
    let input = window.firstResponder()?.downcast::<NSTextView>().ok()?;
    if !input.isEditable() || input.window().as_deref() != Some(window) {
        return None;
    }
    let root = window.contentView()?;
    for owner in descendants(&root).into_iter().filter(|v| {
        NSAccessibility::accessibilityLabel(&**v)
            .is_some_and(|s| s.to_string() == "Find source (case-sensitive)")
    }) {
        // A single-line AppKit control uses the window's shared field editor;
        // its superview is not necessarily the labelled NSH input's parent.
        let owns = descendants(&owner).iter().any(|view| {
            view.downcast_ref::<NSTextField>()
                .and_then(|field| field.currentEditor())
                .and_then(|editor| editor.downcast::<NSTextView>().ok())
                .as_deref()
                == Some(&*input)
        });
        if owns {
            return Some(input);
        }
    }
    None
}

pub(crate) fn start(
    path: PathBuf,
    fixture: Arc<pilot_nsh::fixture::Fixture>,
    copied: Arc<Mutex<Option<ImagePreview>>>,
    admission: ImageAdmission,
) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let settle = || std::thread::sleep(Duration::from_millis(350));
            let capture = |suffix: &str| {
                on_main(|w| {
                    screenshot(
                        w,
                        &path.with_file_name(format!(
                            "{}{suffix}.png",
                            path.file_stem().unwrap().to_string_lossy()
                        )),
                    )
                })
            };
            wait_for("Open chat a");
            open_chat("a", &path);
            wait_for("Expand image, block 7");
            settle();
            on_main(|w| {
                let input = editor(w).unwrap();
                w.makeFirstResponder(Some(&input));
                insert(&input, "image draft 日本語 👩🏽‍💻");
            });
            let before =
                on_main(|w| rect(w, "Expand image, block 7").expect("upright header viewport"));
            let anchor = on_main(|w| prose_position(w, "Reader anchor after images."))
                .expect("reader anchor before decode");
            capture("-loading");
            // Old work is queued, then cancelled by navigation and recycled rows.
            open_chat("b", &path);
            open_chat("a", &path);
            settle();
            drop(admission);
            wait_for("Inline image, block 7, ready");
            settle();
            let after = on_main(|w| rect(w, "Expand image, block 7").unwrap());
            assert!(
                (before.size.width - after.size.width).abs() < 0.5
                    && (before.size.height - after.size.height).abs() < 0.5,
                "header/decode geometry: {before:?} -> {after:?}"
            );
            assert!(
                (after.size.width / after.size.height - 2.).abs() < 0.01,
                "natural landscape ratio"
            );
            let after_anchor =
                on_main(|w| prose_position(w, "Reader anchor after images.")).unwrap();
            assert!(
                (anchor - after_anchor).abs() < 0.5,
                "reader anchor changes on decode: {anchor} -> {after_anchor}"
            );
            capture("");
            on_main(|w| press(w, "Expand image, block 7"));
            wait_for("Zoom in");
            settle();
            capture("-fit");
            on_main(|w| press(w, "Actual size (100%)"));
            settle();
            let actual = on_main(|w| rect(w, "Reader image pixels").unwrap());
            let ratio = on_main(|w| w.backingScaleFactor());
            assert!(
                (actual.size.width - 960. / ratio).abs() < 0.5
                    && (actual.size.height - 480. / ratio).abs() < 0.5,
                "actual upright pixels: {actual:?}"
            );
            on_main(|w| {
                app_key(
                    w,
                    "+",
                    24,
                    NSEventModifierFlags::Command | NSEventModifierFlags::Shift,
                )
            });
            settle();
            let keyboard_zoom = on_main(|w| rect(w, "Reader image pixels").unwrap());
            assert!(
                (keyboard_zoom.size.width - actual.size.width * 1.25).abs() < 0.5,
                "native Command-plus"
            );
            on_main(|w| press(w, "Actual size (100%)"));
            settle();
            on_main(|w| {
                for _ in 0..5 {
                    press(w, "Zoom in");
                }
            });
            settle();
            capture("-zoom");
            let enlarged = on_main(|w| rect(w, "Reader image pixels").unwrap());
            assert!(
                enlarged.size.width > actual.size.width,
                "zoom must change native image geometry"
            );
            on_main(|w| app_key(w, "Right", 124, NSEventModifierFlags::Option));
            settle();
            on_main(|w| app_key(w, "Down", 125, NSEventModifierFlags::Option));
            settle();
            capture("-pan");
            let panned = on_main(|w| rect(w, "Reader image pixels").unwrap());
            assert!(
                panned.origin.x < enlarged.origin.x || panned.origin.y < enlarged.origin.y,
                "native pan moves content: {enlarged:?} -> {panned:?}"
            );
            on_main(middle_drag);
            settle();
            let dragged = on_main(|w| rect(w, "Reader image pixels").unwrap());
            assert!(
                dragged.origin.x < panned.origin.x,
                "middle drag moves native content: {panned:?} -> {dragged:?}"
            );
            on_main(|w| press(w, "Copy image in reader"));
            settle();
            let png = copied
                .lock()
                .unwrap()
                .as_ref()
                .expect("image owns native Copy")
                .clone();
            assert_eq!((png.width, png.height), (960, 480));
            assert!(png.first_frame);
            assert!(png.png.starts_with(b"\x89PNG"));
            *copied.lock().unwrap() = None;
            on_main(|w| app_key(w, "c", 8, NSEventModifierFlags::Command));
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if copied.lock().unwrap().is_some() {
                    break;
                }
                assert!(Instant::now() < deadline, "image owns native Command-C");
                std::thread::sleep(Duration::from_millis(30));
            }
            assert_eq!(copied.lock().unwrap().as_ref().unwrap().png, png.png);
            // Clipboard sink is isolated. Exact RGBA/first-frame encoding is also
            // checked by the existing production codec/clipboard tests.
            on_main(|w| press(w, "Reset image"));
            settle();
            capture("-reset");
            on_main(|w| press(w, "Fit image"));
            settle();
            let fit = on_main(|w| rect(w, "Reader image pixels").unwrap());
            assert!(
                fit.size.width <= 1180. && fit.size.height <= 750.,
                "fit readable viewport"
            );
            on_main(|w| press(w, "Close image (Escape)"));
            settle();
            let returned = on_main(|w| prose_position(w, "Reader anchor after images.")).unwrap();
            assert!(
                (returned - after_anchor).abs() < 0.5,
                "reader anchor after zoom"
            );
            // Visit each image with the existing native Find/list navigation.
            // Ordered-out detached-wheel movement is not hardware qualification.
            let originals = pilot_desktop::nsh_adapter::synthetic_images();
            for (index, expected) in [(3, (300, 600)), (2, (960, 480)), (1, (400, 600))] {
                on_main(|w| press(w, "Find in conversation (⌘F)"));
                wait_for("Find source (case-sensitive)");
                let deadline = Instant::now() + Duration::from_secs(15);
                while !on_main(|w| {
                    let Some(input) = focused_find(w) else {
                        return false;
                    };
                    input.setSelectedRange(NSRange::new(0, input.string().len()));
                    insert(&input, &format!("Stored image {index}."));
                    true
                }) {
                    assert!(
                        Instant::now() < deadline,
                        "native Find focus: {}",
                        on_main(native_evidence)
                    );
                    std::thread::sleep(Duration::from_millis(30));
                }
                wait_text("1 of 1");
                settle();
                let block = index * 2 - 1;
                let label = format!("Expand image, block {block}");
                let ready = format!("Inline image, block {block}, ready");
                let deadline = Instant::now() + Duration::from_secs(15);
                while !on_main(|w| has_label(w, &ready)) {
                    assert!(Instant::now() < deadline, "image {block} native pixels");
                    std::thread::sleep(Duration::from_millis(30));
                }
                let body = on_main(|w| rect(w, &label).unwrap());
                let pixels = on_main(|w| rect(w, &ready).unwrap());
                assert!(
                    (body.size.width / body.size.height - expected.0 as f64 / expected.1 as f64)
                        .abs()
                        < 0.01,
                    "upright inline aspect for {block}: {body:?}"
                );
                assert!(
                    (body.size.width - pixels.size.width).abs() < 0.5
                        && (body.size.height - pixels.size.height).abs() < 0.5,
                    "pixels must fill reserved geometry: {body:?}, {pixels:?}"
                );
                capture(&format!("-earlier-{index}"));
                on_main(|w| press(w, &label));
                wait_for("Copy image in reader");
                settle();
                if index == 2 {
                    on_main(|w| {
                        press(w, "Actual size (100%)");
                        for _ in 0..5 {
                            press(w, "Zoom in");
                        }
                    });
                    settle();
                    on_main(middle_drag);
                    settle();
                    capture("-landscape-zoom");
                    on_main(|w| press(w, "Reset image"));
                    settle();
                }
                on_main(|w| press(w, "Copy image in reader"));
                settle();
                let selected = copied.lock().unwrap().as_ref().unwrap().clone();
                assert_eq!((selected.width, selected.height), expected);
                let original = &originals[index - 1];
                assert_eq!(
                    selected.original.as_str(),
                    format!(
                        "data:{};base64,{}",
                        original["mimeType"].as_str().unwrap(),
                        original["data"].as_str().unwrap()
                    )
                );
                on_main(|w| press(w, "Close image (Escape)"));
                settle();
            }
            open_chat("b", &path);
            open_chat("a", &path);
            settle();
            on_main(|w| {
                assert_eq!(
                    editor(w).unwrap().string().to_string(),
                    "image draft 日本語 👩🏽‍💻"
                )
            });
            assert!(fixture.state.lock().unwrap().envelopes.is_empty());
            on_main(|w| w.performClose(None));
        }));
        if result.is_err() {
            std::process::exit(1);
        }
    });
}
