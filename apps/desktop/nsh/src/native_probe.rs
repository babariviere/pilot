//! Hidden actual AppKit interactions, not hardware IME or a benchmark.
use super::*;
#[path = "native_images_probe.rs"]
pub(super) mod images;
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
fn composer_ready(window: &NSWindow, session: &str) -> bool {
    let Some(input) = editor(window) else {
        return false;
    };
    input_label(&input).as_deref() == Some(format!("Message in {session}").as_str())
        && input.isEditable()
        && input.window().as_deref() == Some(window)
        && input.bounds().size.width > 0.
        && input.bounds().size.height > 0.
}
fn native_evidence(window: &NSWindow) -> String {
    let root = window.contentView().expect("content view");
    let views = descendants(&root);
    let mut report = format!("root={:?}, native views={}\n", root.bounds(), views.len());
    use std::fmt::Write;
    // Keep editor identity and selected rows even if the hierarchy is clipped.
    for view in &views {
        if view.isAccessibilitySelected() {
            let label = NSAccessibility::accessibilityLabel(&**view).map(|s| s.to_string());
            let _ = writeln!(report, "selected={label:?}");
        }
        if let Some(input) = view.downcast_ref::<NSTextView>() {
            let _ = writeln!(
                report,
                "editor={:?} editable={} bounds={:?}",
                input_label(input),
                input.isEditable(),
                input.bounds()
            );
        }
    }
    for (index, view) in views.iter().take(128).enumerate() {
        let label = NSAccessibility::accessibilityLabel(&**view).map(|s| s.to_string());
        let rect = view
            .layer()
            .map(|layer| layer.convertRect_toLayer(layer.bounds(), root.layer().as_deref()));
        let native_rect = view.convertRect_toView(view.bounds(), Some(&root));
        let input = view.downcast_ref::<NSTextView>().map(|input| {
            (
                input_label(input),
                input.isEditable(),
                NSTextInputClient::hasMarkedText(input),
            )
        });
        let _ = writeln!(
            report,
            "{index}: {} label={label:?} rect={rect:?} native_rect={native_rect:?} input={input:?}",
            view.class().name().to_string_lossy()
        );
    }
    report
}
fn wait_composer(session: &str, deadline: Instant) -> Result<(), String> {
    loop {
        if on_main(|w| composer_ready(w, session)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(on_main(native_evidence));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}
fn open_chat(session: &str, capture: &Path) {
    let started = Instant::now();
    let before = on_main(|w| {
        check_press_coordinates(w);
        let before = native_evidence(w);
        press(w, &format!("Open chat {session}"));
        before
    });
    // A sidebar label and a fixed settle do not establish native editor readiness.
    // Never repeat the click: a missing or wrong-chat editor must still fail.
    let deadline = started + Duration::from_secs(15);
    let selected = || {
        let label = format!("Open chat {session}");
        on_main(|w| {
            descendants(&w.contentView().expect("content view"))
                .iter()
                .any(|view| {
                    view.isAccessibilitySelected()
                        && NSAccessibility::accessibilityLabel(&**view)
                            .is_some_and(|text| text.to_string() == label)
                })
        })
    };
    while !selected() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(30));
    }
    let selection_published = selected();
    if let Err(after) = wait_composer(session, deadline) {
        let failure = capture.with_extension("readiness-failure.png");
        eprintln!(
            "native composer readiness failed: expected Message in {session}, selection_published={selection_published}, elapsed={:?}\nbefore click:\n{before}\nafter wait:\n{after}\ncapture={}",
            started.elapsed(),
            failure.display()
        );
        on_main(|w| screenshot(w, &failure));
        panic!("native composer for {session} unavailable");
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
        .unwrap_or_else(|| {
            panic!(
                "native button {label} unavailable\n{}",
                native_evidence(window)
            )
        });
    let surface = views
        .iter()
        .find(|v| v.class().name() == c"NshView")
        .expect("NSH surface");
    assert_eq!(target.window().as_deref(), Some(window), "attached target");
    assert!(!target.isHiddenOrHasHiddenAncestor(), "visible target");
    assert!(target.bounds().size.width > 0. && target.bounds().size.height > 0.);
    let point = root.convertPoint_toView(press_point(target, &root), None);
    for kind in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
        let event=NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(kind,point,NSEventModifierFlags::empty(),NSProcessInfo::processInfo().systemUptime(),window.windowNumber(),None,0,1,1.).expect("mouse event");
        if kind == NSEventType::LeftMouseDown {
            surface.mouseDown(&event);
        } else {
            surface.mouseUp(&event);
        }
    }
}
fn press_point(target: &NSView, root: &NSView) -> NSPoint {
    if let (Some(layer), Some(root_layer)) = (target.layer(), root.layer()) {
        let mut ancestor = Some(layer.clone());
        while let Some(current) = ancestor {
            if current == root_layer {
                // NSH scrolls can move their content with layer transforms
                // before the native view bounds catch up.
                let rect = layer.convertRect_toLayer(layer.bounds(), Some(&root_layer));
                return NSPoint::new(
                    rect.origin.x + rect.size.width / 2.,
                    rect.origin.y + rect.size.height / 2.,
                );
            }
            ancestor = current.superlayer();
        }
    }
    let bounds = target.bounds();
    // AppKit's view hierarchy is placed before its backing layers are attached.
    // A disconnected layer conversion omits ancestors. Use native geometry then.
    target.convertPoint_toView(
        NSPoint::new(
            bounds.origin.x + bounds.size.width / 2.,
            bounds.origin.y + bounds.size.height / 2.,
        ),
        Some(root),
    )
}

fn check_press_coordinates(window: &NSWindow) {
    let mtm = MainThreadMarker::from(window);
    let root = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0., 0.), NSSize::new(680., 820.)),
    );
    let parent = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(8., 510.), NSSize::new(231., 300.)),
    );
    let target = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0., 32.), NSSize::new(231., 50.)),
    );
    for view in [&root, &parent, &target] {
        view.setWantsLayer(true);
    }
    root.addSubview(&parent);
    parent.addSubview(&target);
    let expected = NSPoint::new(123.5, 567.);
    let layer = target.layer().unwrap();
    // Match NSH's frame placement before AppKit attaches the layer hierarchy.
    layer.setBounds(target.bounds());
    layer.setAnchorPoint(NSPoint::new(0., 0.));
    layer.setPosition(target.frame().origin);
    let rect = layer.convertRect_toLayer(layer.bounds(), root.layer().as_deref());
    let legacy = NSPoint::new(
        rect.origin.x + rect.size.width / 2.,
        rect.origin.y + rect.size.height / 2.,
    );
    assert_eq!(legacy, NSPoint::new(115.5, 57.), "captured wrong center");
    assert_eq!(press_point(&target, &root), expected);

    // Once attached, preserve layer-only movement rather than falling back to
    // native bounds (the real work-disclosure fixture exercises NSH scrolling).
    let root_layer = root.layer().unwrap();
    let parent_layer = parent.layer().unwrap();
    root_layer.addSublayer(&parent_layer);
    parent_layer.addSublayer(&layer);
    for (view, backing) in [(&parent, &parent_layer), (&target, &layer)] {
        backing.setBounds(view.bounds());
        backing.setAnchorPoint(NSPoint::new(0., 0.));
        backing.setPosition(view.frame().origin);
    }
    parent_layer.setPosition(NSPoint::new(8., 471.));
    assert_eq!(press_point(&target, &root), NSPoint::new(123.5, 528.));
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
fn control_key(window: &NSWindow, label: &str, code: u16, text: &str) {
    let control = descendants(&window.contentView().expect("content view"))
        .into_iter()
        .find(|v| NSAccessibility::accessibilityLabel(&**v).is_some_and(|s| s.to_string() == label))
        .unwrap_or_else(|| panic!("keyboard target {label} unavailable"));
    assert!(
        window.makeFirstResponder(Some(&control)),
        "native disclosure accepts keyboard focus"
    );
    let chars = NSString::from_str(text);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown, NSPoint::new(0.,0.), NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, &chars, &chars, false, code
    ).expect("native key");
    control.keyDown(&event);
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateScrollWheelEvent(
        source: *const std::ffi::c_void,
        units: u32,
        wheels: u32,
        ...
    ) -> *const std::ffi::c_void;
    fn CGEventSetLocation(event: *const std::ffi::c_void, location: NSPoint);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: *const std::ffi::c_void);
}

fn wheel(window: &NSWindow, delta: i32) {
    let root = window.contentView().unwrap();
    let surface = descendants(&root)
        .into_iter()
        .find(|v| v.class().name() == c"NshView")
        .unwrap();
    // Match upstream's native synthesized wheel, without posting an OS event.
    // Hidden fixture windows start at (0,0); the point is over transcript prose,
    // outside its inner output scrollers and the sidebar.
    let point = window.convertPointToScreen(NSPoint::new(300., 600.));
    let height = NSScreen::mainScreen(MainThreadMarker::from(window))
        .unwrap()
        .frame()
        .size
        .height;
    // SAFETY: owned CoreGraphics event, one variadic i32 wheel, live AppKit host.
    unsafe {
        let event = CGEventCreateScrollWheelEvent(std::ptr::null(), 0, 1, delta);
        assert!(!event.is_null());
        CGEventSetLocation(event, NSPoint::new(point.x, height - point.y));
        let native = NSEvent::eventWithCGEvent(&*event.cast());
        CFRelease(event);
        // An ordered-out embedding window has no display-link frames. Upstream
        // reports an unmapped scroll immediately; keep the same native tree and
        // reattach it after dispatch, without changing or driving the engine.
        window.setContentView(None);
        surface.scrollWheel(&native.expect("native wheel"));
        window.setContentView(Some(&root));
    }
}

fn app_key(window: &NSWindow, text: &str, code: u16, modifiers: NSEventModifierFlags) {
    let chars = NSString::from_str(text);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown, NSPoint::new(0.,0.), modifiers,
        NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, &chars, &chars, false, code
    ).expect("native app key");
    // The real upstream local key monitor runs through NSApplication's queue.
    // No OS event posting, window activation or internal engine dispatch.
    NSApplication::sharedApplication(MainThreadMarker::from(window))
        .postEvent_atStart(&event, false);
}

fn native_text(view: &NSView) -> Option<String> {
    NSAccessibility::accessibilityValue(view)
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|value| value.to_string())
}
fn wait_text(text: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !on_main(|w| {
        descendants(&w.contentView().unwrap())
            .iter()
            .any(|view| native_text(view).as_deref() == Some(text))
    }) {
        assert!(Instant::now() < deadline, "native text {text} unavailable");
        std::thread::sleep(Duration::from_millis(30));
    }
}
fn prose_position(window: &NSWindow, prefix: &str) -> Option<f64> {
    let root = window.contentView()?;
    descendants(&root).into_iter().find_map(|view| {
        if view.isHiddenOrHasHiddenAncestor()
            || !native_text(&view).is_some_and(|s| s.starts_with(prefix))
        {
            return None;
        }
        let layer = view.layer()?;
        let rect = layer.convertRect_toLayer(layer.bounds(), root.layer().as_deref());
        (rect.origin.y >= 76.
            && rect.origin.y + rect.size.height <= root.bounds().size.height - 62.)
            .then_some(rect.origin.y)
    })
}

pub(super) fn history_start(path: PathBuf, fixture: std::sync::Arc<pilot_nsh::fixture::Fixture>) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("capture directory");
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
            let pages = || {
                fixture
                    .state
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .filter(|(_, p)| p.contains("/history?"))
                    .count()
            };
            wait_for("Open chat a");
            open_chat("a", &path);
            settle();
            assert_eq!(pages(), 0, "initial load is bounded and passive");
            on_main(|w| {
                let input = editor(w).unwrap();
                w.makeFirstResponder(Some(&input));
                // SAFETY: main-thread native fixture input.
                unsafe {
                    input.insertText_replacementRange(
                        &NSString::from_str("history draft 日本語 👩🏽‍💻"),
                        NSRange::new(usize::MAX, 0),
                    );
                }
            });
            settle();
            capture("");
            fixture.state.lock().unwrap().history_delay_ms = 1000;
            on_main(|w| app_key(w, "f", 3, NSEventModifierFlags::Command));
            wait_for("Find source (case-sensitive)");
            settle();
            on_main(|w| {
                let input = w
                    .firstResponder()
                    .and_then(|r| r.downcast::<NSTextView>().ok())
                    .expect("native Find focus");
                // SAFETY: navigate to the first loaded canonical row using the real Find input.
                unsafe {
                    input.insertText_replacementRange(
                        &NSString::from_str("History message 73."),
                        NSRange::new(usize::MAX, 0),
                    );
                }
            });
            wait_text("1 of 1");
            let anchor = || {
                on_main(|w| {
                    let root = w.contentView().unwrap();
                    let target = descendants(&root).into_iter().find(|v| {
                        !v.isHiddenOrHasHiddenAncestor()
                            && native_text(v)
                                .is_some_and(|s| s.starts_with("History message 73. Exact source"))
                    })?;
                    let layer = target.layer()?;
                    Some(
                        layer
                            .convertRect_toLayer(layer.bounds(), root.layer().as_deref())
                            .origin
                            .y,
                    )
                })
            };
            let deadline = Instant::now() + Duration::from_secs(15);
            let before = loop {
                if let Some(y) = anchor() {
                    break y;
                }
                assert!(
                    Instant::now() < deadline,
                    "canonical native anchor missing: {}",
                    on_main(native_evidence)
                );
                std::thread::sleep(Duration::from_millis(30));
            };
            capture("-top-before");
            fixture.append_history("a");
            settle();
            capture("-append");
            eprintln!(
                "native history append: before={before}, after={:?}, completed pages={}",
                anchor(),
                pages()
            );
            while pages() == 0 {
                assert!(
                    Instant::now() < deadline,
                    "top scroll did not load an older page"
                );
                std::thread::sleep(Duration::from_millis(30));
            }
            settle();
            assert!(pages() >= 1, "top-scroll requests an older page");
            capture("-top-after");
            let after = anchor().unwrap_or_else(|| {
                panic!(
                    "canonical native anchor lost after prepend; before={before}, pages={}",
                    pages()
                )
            });
            assert!(
                (before - after).abs() < 0.5,
                "prepend + concurrent append preserve canonical anchor: {before} -> {after}"
            );
            assert!(
                on_main(|w| has_label(w, "Latest message")),
                "reader stays away from tail"
            );
            capture("-prepend");
            on_main(|w| press(w, "Close find (Escape)"));
            settle();
            on_main(|w| {
                let input = editor(w).unwrap();
                w.makeFirstResponder(Some(&input));
                app_key(w, "f", 3, NSEventModifierFlags::Command);
            });
            wait_for("Find source (case-sensitive)");
            settle();
            on_main(|w| {
                let input = w
                    .firstResponder()
                    .and_then(|r| r.downcast::<NSTextView>().ok())
                    .expect("Find input focused by keyboard shortcut");
                assert!(
                    !input_label(&input).is_some_and(|s| s.starts_with("Message in")),
                    "Find, not composer, owns focus"
                );
                // SAFETY: exact source inserted into the focused native Find input.
                unsafe {
                    input.insertText_replacementRange(
                        &NSString::from_str(pilot_nsh::fixture::HISTORY_QUERY),
                        NSRange::new(usize::MAX, 0),
                    );
                }
            });
            wait_for("Load full history");
            wait_text("No matches in loaded messages");
            on_main(|w| press(w, "Load full history"));
            wait_text("All messages · literal source");
            wait_text("1 of 4");
            on_main(|w| press(w, "Next match (Enter)"));
            wait_text("2 of 4");
            settle();
            capture("-find");
            on_main(|w| press(w, "Previous match (Shift-Enter)"));
            wait_text("1 of 4");
            on_main(|w| press(w, "Previous match (Shift-Enter)"));
            wait_text("4 of 4");
            on_main(|w| press(w, "Next match (Enter)"));
            wait_text("1 of 4");
            on_main(|w| press(w, "Close find (Escape)"));
            settle();
            on_main(|w| {
                assert_eq!(
                    editor(w).unwrap().string().to_string(),
                    "history draft 日本語 👩🏽‍💻"
                )
            });
            let position = on_main(|w| prose_position(w, "Older 3:"))
                .expect("old-page reader before navigation");
            open_chat("b", &path);
            open_chat("a", &path);
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stable = 0;
            while stable < 4 {
                let restored = on_main(|w| prose_position(w, "Older 3:"));
                stable = if restored.is_some_and(|y| (y - position).abs() < 0.5) {
                    stable + 1
                } else {
                    0
                };
                assert!(
                    Instant::now() < deadline,
                    "canonical chat return changed reader position: before={position}, after={restored:?}"
                );
                std::thread::sleep(Duration::from_millis(30));
            }
            capture("-restored");
            wait_for("Latest message");
            on_main(|w| press(w, "Latest message"));
            settle();
            capture("-latest");
            assert!(fixture.state.lock().unwrap().envelopes.is_empty());
            on_main(|w| w.performClose(None));
        }));
        if result.is_err() {
            std::process::exit(1);
        }
    });
}

pub(super) fn work_start(path: PathBuf, fixture: std::sync::Arc<pilot_nsh::fixture::Fixture>) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("capture directory");
    }
    std::thread::spawn(move || {
        // A failed probe exits the process; it never resumes a fixture after panic.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let settle = || std::thread::sleep(Duration::from_millis(350));
            let capture = |suffix: &str| {
                let output = path.with_file_name(format!(
                    "{}-{suffix}.png",
                    path.file_stem().unwrap().to_string_lossy()
                ));
                on_main(move |w| screenshot(w, &output));
            };
            wait_for("Open chat a");
            open_chat("a", &path);
            wait_for("Read running.rs · Running…");
            wait_for("Read c.rs, d.rs");
            settle();
            capture("streaming");
            on_main(|w| press(w, "Read c.rs, d.rs"));
            wait_for("Read c.rs");
            on_main(|w| press(w, "Read c.rs, d.rs"));
            settle();
            on_main(|w| press(w, "Read running.rs · Running…"));
            wait_for("Code");
            on_main(|w| control_key(w, "Code", 49, " "));
            wait_for("Copy code");
            on_main(|w| {
                if has_label(w, "Latest message") {
                    press(w, "Latest message");
                }
            });
            settle();
            capture("detail");
            on_main(|w| wheel(w, 700));
            settle();
            let anchor = || {
                on_main(|w| {
                    let root = w.contentView().unwrap();
                    root.displayIfNeeded();
                    let target = descendants(&root)
                        .into_iter()
                        .find(|v| {
                            NSAccessibility::accessibilityLabel(&**v)
                                .is_some_and(|s| s.to_string() == "Working · read running.rs")
                        })
                        .expect("work reader anchor");
                    let layer = target.layer().unwrap();
                    layer
                        .convertRect_toLayer(layer.bounds(), root.layer().as_deref())
                        .origin
                        .y
                })
            };
            capture("anchor-before");
            let settled_anchor = || {
                let deadline = Instant::now() + Duration::from_secs(15);
                let mut previous = anchor();
                let mut stable = 0;
                while stable < 4 {
                    assert!(
                        Instant::now() < deadline,
                        "native reader scroll did not settle"
                    );
                    std::thread::sleep(Duration::from_millis(30));
                    let next = anchor();
                    stable = if (next - previous).abs() < 0.5 {
                        stable + 1
                    } else {
                        0
                    };
                    previous = next;
                }
                previous
            };
            let before = settled_anchor();
            fixture
                .state
                .lock()
                .expect("fixture state")
                .work_events
                .get_mut("a")
                .unwrap()
                .last_mut()
                .unwrap()["output"]["set"] =
                serde_json::json!("late exact 日本語\n<&> 👩🏽‍💻\n".repeat(12));
            fixture.changed();
            settle();
            capture("anchor-after");
            let after = settled_anchor();
            assert!(
                (after - before).abs() < 0.5,
                "late output keeps the native reader anchor: before={before}, after={after}"
            );
            open_chat("b", &path);
            open_chat("a", &path);
            wait_for("Copy code");
            on_main(|w| control_key(w, "Code", 49, " "));
            settle();
            assert!(
                !on_main(|w| has_label(w, "Copy code")),
                "Space collapses source after navigation"
            );
            on_main(|w| control_key(w, "Read running.rs · Running…", 49, " "));
            settle();
            assert!(
                !on_main(|w| has_label(w, "Copy output")),
                "Space collapses individual call"
            );
            on_main(|w| press(w, "Show earlier work steps"));
            wait_for("Read a.rs");
            wait_for("Read b.rs");
            settle();
            capture("expanded");
            on_main(|w| control_key(w, "Working · read running.rs", 49, " "));
            settle();
            capture("folded");
            assert!(
                !on_main(|w| has_label(w, "Read running.rs · Running…")),
                "explicit fold wins during streaming"
            );
            on_main(|w| wheel(w, 2000));
            settle();
            wait_for("Show failed call");
            on_main(|w| press(w, "Show failed call"));
            wait_for("Copy output");
            settle();
            capture("failure");
            on_main(|w| screenshot(w, &path));
            // Stop uses the existing production courier, even with a folded group.
            wait_for("Stop reply");
            on_main(|w| press(w, "Stop reply"));
            settle();
            assert_eq!(fixture.state.lock().expect("fixture state").stops, ["a"]);
            on_main(|w| {
                w.performClose(None);
            });
        }));
        if result.is_err() {
            std::process::exit(1);
        }
    });
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
                open_chat("a", &path);
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
                open_chat("b", &path);
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
                open_chat("coordinator", &path);
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
                open_chat("a", &path);
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
                open_chat("b", &path);
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
            // Exercise the actual native predicate/deadline, without test retries.
            let missing =
                wait_composer("a", Instant::now()).expect_err("no composer before selection");
            assert!(!missing.contains("Message in a"));
            open_chat("a", &path);
            let wrong =
                wait_composer("b", Instant::now()).expect_err("wrong chat must not be ready");
            assert!(
                wrong.contains("Message in a"),
                "wrong-chat failure records observed input"
            );
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
            open_chat("b", &path);
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
            open_chat("a", &path);
            on_main(|w| {
                assert_eq!(
                    editor(w).expect("restored composer").string().to_string(),
                    EXACT
                )
            });
            wait_for("Send message");
            on_main(|w| press(w, "Send message"));
            wait_for("Stop reply");
            settle();
            on_main(|w| {
                assert_eq!(editor(w).expect("sent composer").string().to_string(), "");
            });
            open_chat("b", &path);
            on_main(|w| {
                assert_eq!(
                    editor(w)
                        .expect("independent composer")
                        .string()
                        .to_string(),
                    "independent draft\n保持"
                )
            });
            open_chat("a", &path);
            wait_for("Stop reply");
            on_main(|w| press(w, "Stop reply"));
            settle();
            on_main(|w| screenshot(w, &path));
            open_chat("b", &path);
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
