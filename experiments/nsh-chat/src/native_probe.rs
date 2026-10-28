//! Opt-in real AppKit window probe. Synthetic AppKit events, not hardware IME.
use dispatch2::DispatchQueue;
use nsh_engine::{Root, perf::PerfMonitor};
use nsh_platform_macos::{
    self as platform,
    objc2::{self, MainThreadMarker, MainThreadOnly, msg_send, rc::Retained},
    objc2_app_kit::*,
    objc2_foundation::*,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

fn main_thread<R: Send>(f: impl FnOnce(&NSWindow) -> R + Send) -> R {
    let mut result = None;
    let slot = &mut result;
    DispatchQueue::main().exec_sync(move || {
        let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
        let window = app.windows().firstObject().expect("prototype window");
        *slot = Some(f(&window));
    });
    result.unwrap()
}

fn descendants(view: &NSView) -> Vec<Retained<NSView>> {
    let mut result = vec![];
    for child in view.subviews() {
        result.push(child.clone());
        result.extend(descendants(&child));
    }
    result
}

fn composer(w: &NSWindow) -> Retained<NSTextView> {
    descendants(&w.contentView().unwrap())
        .into_iter()
        .find_map(|v| v.downcast::<NSTextView>().ok())
        .expect("native NSTextView composer")
}

fn insert(w: &NSWindow, value: &str) {
    let editor = composer(w);
    w.makeFirstResponder(Some(&editor));
    unsafe {
        editor.insertText_replacementRange(&NSString::from_str(value), NSRange::new(usize::MAX, 0));
    }
}

fn undo(w: &NSWindow, redo: bool) {
    let e = composer(w);
    e.breakUndoCoalescing();
    // SAFETY: ask the responder chain to perform the standard Undo/Redo action.
    unsafe {
        if !std::env::args().any(|a| a == "--responder-undo") {
            let manager: Retained<objc2::runtime::AnyObject> = msg_send![&*e, undoManager];
            if redo {
                let _: () = msg_send![&*manager, redo];
            } else {
                let _: () = msg_send![&*manager, undo];
            }
            return;
        }
        let action = if redo {
            objc2::sel!(redo:)
        } else {
            objc2::sel!(undo:)
        };
        assert!(
            e.tryToPerform_with(action, None),
            "native Undo/Redo responder must be available"
        );
    }
}

fn mouse(w: &NSWindow, kind: NSEventType, x: f64, y: f64) {
    let root = w.contentView().unwrap();
    let point = NSPoint::new(
        x,
        if root.isFlipped() {
            y
        } else {
            root.bounds().size.height - y
        },
    );
    let location = root.convertPoint_toView(point, None);
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind, location, NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(), w.windowNumber(), None, 0, 1, 1.0).unwrap();
    // Deliver to the real NSH responder without the active-app event queue.
    // This is synthetic responder input, not OS mouse/menu qualification.
    let target = surface_root(w);
    match kind {
        NSEventType::LeftMouseDown => target.mouseDown(&event),
        NSEventType::LeftMouseDragged => target.mouseDragged(&event),
        NSEventType::LeftMouseUp => target.mouseUp(&event),
        _ => unreachable!("selection probe only"),
    }
}

fn screenshot(w: &NSWindow, path: PathBuf) {
    let v = w.contentView().unwrap();
    let panels: Vec<_> = descendants(&v)
        .into_iter()
        .filter(|v| v.class().name() == c"NshFpsPanel")
        .collect();
    for p in &panels {
        p.setHidden(true);
    }
    let bitmap = v.bitmapImageRepForCachingDisplayInRect(v.bounds()).unwrap();
    v.cacheDisplayInRect_toBitmapImageRep(v.bounds(), &bitmap);
    let data = unsafe {
        bitmap.representationUsingType_properties(
            NSBitmapImageFileType::PNG,
            &NSDictionary::<NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>::new(),
        )
    }
    .unwrap();
    std::fs::write(path, data.to_vec()).unwrap();
    for p in &panels {
        p.setHidden(false);
    }
}

fn row_frame(w: &NSWindow, id: Option<&str>) -> Option<(String, f64)> {
    let root = w.contentView()?;
    descendants(&root)
        .into_iter()
        .filter_map(|v| {
            let name = NSAccessibility::accessibilityLabel(&*v)
                .filter(|s| s.to_string().starts_with("message-"))
                .or_else(|| NSAccessibility::accessibilityIdentifier(&*v))?
                .to_string();
            if !name.starts_with("message-") || id.is_some_and(|id| name != id) {
                return None;
            }
            // NSH scrolls with layer transforms before committing NSView bounds.
            let layer = v.layer()?;
            let rect = layer.convertRect_toLayer(layer.bounds(), root.layer().as_deref());
            let y = if root.isFlipped() {
                rect.origin.y
            } else {
                root.bounds().size.height - rect.origin.y - rect.size.height
            };
            (id.is_some() || (y + rect.size.height > 65. && y < 600.)).then_some((name, y))
        })
        // Recycled, parked cells can retain a label at a far-offscreen frame.
        // Prefer the mounted instance nearest the viewport, not the smallest y.
        .min_by(|a, b| {
            let distance = |y: f64| (65. - y).max(0.) + (y - 600.).max(0.);
            distance(a.1)
                .total_cmp(&distance(b.1))
                .then_with(|| a.1.total_cmp(&b.1))
        })
}

fn transcript(w: &NSWindow) -> Retained<NSView> {
    descendants(&w.contentView().unwrap())
        .into_iter()
        .find(|v| {
            NSAccessibility::accessibilityIdentifier(&**v)
                .is_some_and(|id| id.to_string() == "transcript-selection")
        })
        .unwrap()
}

fn surface_root(w: &NSWindow) -> Retained<NSView> {
    let root = w.contentView().unwrap();
    std::iter::once(root.clone())
        .chain(descendants(&root))
        .find(|v| v.class().name() == c"NshView")
        .expect("NSH surface root owns native input and selection dispatch")
}

fn copy_transcript(w: &NSWindow) -> String {
    let document = surface_root(w);
    NSPasteboard::generalPasteboard().clearContents();
    // Exercise the NSH native document's copy implementation directly. A hidden
    // app cannot qualify the active application's menu/key-equivalent routing.
    unsafe {
        let _: () = msg_send![&*document,copy:None::<&objc2::runtime::AnyObject>];
    }
    unsafe {
        NSPasteboard::generalPasteboard()
            .stringForType(NSPasteboardTypeString)
            .map(|s| s.to_string())
            .unwrap_or_default()
    }
}

/// Native addresses deliberately expose cell reuse, not message identity.
fn row_snapshot(w: &NSWindow) -> Value {
    let root = w.contentView().unwrap();
    json!(descendants(&root).into_iter().filter_map(|view| {
        let label = NSAccessibility::accessibilityLabel(&*view)?.to_string();
        if !label.starts_with("message-") { return None; }
        let layer = view.layer()?;
        let rect = layer.convertRect_toLayer(layer.bounds(), root.layer().as_deref());
        let mut hidden = false;
        let mut current = Some(layer);
        while let Some(layer) = current {
            hidden |= layer.isHidden();
            current = layer.superlayer();
        }
        Some(json!({"label":label,"address":format!("{:p}",&*view),"y":rect.origin.y,"hidden":hidden}))
    }).collect::<Vec<_>>())
}

fn select_all(w: &NSWindow) {
    // SAFETY: the surface root implements NSResponder's Select All action.
    unsafe {
        let _: () = msg_send![&*surface_root(w), selectAll: None::<&objc2::runtime::AnyObject>];
    }
}

fn stats(m: &PerfMonitor) -> Value {
    let s = m.snapshot();
    json!({"refresh_hz": s.refresh_rate, "main_work_ms": {"p50":s.frame.p50.as_secs_f64()*1000.,"p95":s.frame.p95.as_secs_f64()*1000.,"max":s.frame.max.as_secs_f64()*1000.},
      "engine_app_ms": {"p50":s.js.p50.as_secs_f64()*1000.,"p95":s.js.p95.as_secs_f64()*1000.,"max":s.js.max.as_secs_f64()*1000.},
      "engine_layout_ms": {"p50":s.layout.p50.as_secs_f64()*1000.,"p95":s.layout.p95.as_secs_f64()*1000.,"max":s.layout.max.as_secs_f64()*1000.},
      "mount_queue_ms": {"p50":s.latency.p50.as_secs_f64()*1000.,"p95":s.latency.p95.as_secs_f64()*1000.,"max":s.latency.max.as_secs_f64()*1000.},
      "work_over_refresh_fraction":s.dropped, "samples":s.frames.len(), "tick_interval_p95_ms":s.tick_interval.p95.as_secs_f64()*1000.})
}

pub fn run(root: Root, mut options: platform::AppOptions) -> std::process::ExitCode {
    let visible = std::env::args().any(|a| a == "--visible");
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("output");
    std::fs::create_dir_all(&output).unwrap();
    let probe = nsh_chat_prototype::screen::probe();
    let rx = Arc::new(Mutex::new(probe.reports));
    let input_rx = probe.inputs;
    let host = probe.commands;
    options.fps = true;
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(if visible {
        NSApplicationActivationPolicy::Regular
    } else {
        NSApplicationActivationPolicy::Prohibited
    });
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(1180., 820.)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Resizable | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("Conversation study · NSH AppKit probe"));
    let view = platform::AppView::new(mtm, options);
    window.setContentView(Some(&view.view()));
    window.center();
    view.load(root.into());
    if visible {
        window.orderBack(None);
    }
    let monitor = view.perf_monitor().unwrap();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| exercise(host, rx, input_rx, monitor, &output));
        if let Err(error) = result {
            eprintln!("native probe failed: {error:?}");
            std::process::exit(1);
        }
        main_thread(|w| {
            let app = NSApplication::sharedApplication(MainThreadMarker::from(w));
            app.stop(None);
            let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined, NSPoint::new(0.,0.), NSEventModifierFlags::empty(), 0., w.windowNumber(), None, 0, 0, 0).unwrap();
            app.postEvent_atStart(&event, false);
        });
    });
    app.run();
    view.stop();
    window.orderOut(None);
    std::process::ExitCode::SUCCESS
}

fn exercise(
    host: tokio::sync::mpsc::UnboundedSender<String>,
    rx: Arc<Mutex<mpsc::Receiver<Value>>>,
    input_rx: mpsc::Receiver<Value>,
    monitor: Arc<PerfMonitor>,
    output: &std::path::Path,
) {
    let bench = std::env::args().any(|a| a == "--bench");
    let _resources = crate::resources::Samples::start(output.join(if bench {
        "nsh-bench-resources.json"
    } else {
        "nsh-resources.json"
    }));
    let pause = || std::thread::sleep(Duration::from_millis(180));
    let action = |name: &str| host.send(name.to_owned()).unwrap();
    let state = || {
        action("state");
        rx.lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(8))
            .unwrap()
    };
    std::thread::sleep(Duration::from_secs(2));
    let mut checks = vec![];
    if std::env::args().any(|a| a == "--selection-only" || a == "--selection-static-only") {
        let control = std::env::args().any(|a| a == "--selection-static-only");
        if !control {
            action("latest");
            pause();
        }
        let y = if control {
            90.
        } else {
            main_thread(|w| row_frame(w, Some("message-minimal:199")))
                .expect("last minimal row")
                .1
                + 12.
        };
        let x = if control { 90. } else { 245. };
        main_thread(move |w| {
            mouse(w, NSEventType::LeftMouseDown, x, y);
            mouse(w, NSEventType::LeftMouseUp, x, y);
            select_all(w);
        });
        pause();
        let before = main_thread(copy_transcript);
        let cells_before = main_thread(row_snapshot);
        if !control {
            action("selection-top");
            pause();
            action("selection-prepend");
            pause();
        }
        let after = main_thread(copy_transcript);
        let cells_after = main_thread(row_snapshot);
        let ordered_once = if control {
            before == "Selection alpha 日本語 👩🏽‍💻 e\u{301}\nSelection beta العربية 한국어"
        } else {
            let indices = before
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("Selection row ")?
                        .split_whitespace()
                        .next()?
                        .parse::<u32>()
                        .ok()
                })
                .collect::<Vec<_>>();
            !indices.is_empty() && indices.windows(2).all(|w| w[0] < w[1])
        };
        let complete_document = control
            || before
                == (0..200)
                    .map(|i| format!("Selection row {i:03} 日本語 👩🏽‍💻"))
                    .collect::<Vec<_>>()
                    .join("\n");
        let result = json!({"control":control,"ordered_once":ordered_once,"complete_document":complete_document,"retained":!before.is_empty() && before == after,"before":before,"after":after,"cells_before":cells_before,"cells_after":cells_after});
        std::fs::write(
            output.join(if control {
                "selection-static-only.json"
            } else {
                "selection-only.json"
            }),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert!(
            ordered_once && complete_document && !before.is_empty() && before == after,
            "native selection contract: {result}"
        );
        return;
    }
    if std::env::args().any(|a| {
        a == "--latest-only" || a == "--latest-fixture-only" || a == "--latest-selection-only"
    }) {
        let fixture = std::env::args()
            .any(|a| a == "--latest-fixture-only" || a == "--latest-selection-only");
        let selection = std::env::args().any(|a| a == "--latest-selection-only");
        if fixture {
            action("selection-fixture");
            pause();
            action("latest");
            pause();
        }
        if selection {
            let y = main_thread(|w| row_frame(w, Some("message-0:9998")))
                .unwrap()
                .1
                + 12.;
            main_thread(move |w| {
                mouse(w, NSEventType::LeftMouseDown, 245., y);
                mouse(w, NSEventType::LeftMouseUp, 245., y);
                select_all(w);
            });
            pause();
        }
        action("hold");
        pause();
        action("older");
        pause();
        action("replay");
        std::thread::sleep(Duration::from_secs(4));
        let held = state();
        action("latest");
        let mut samples = Vec::new();
        for _ in 0..10 {
            pause();
            samples.push(json!({"state":state(),"last_frame":main_thread(|w| row_frame(w,Some("message-0:10000")))}));
        }
        let pass = samples
            .last()
            .is_some_and(|s| s["state"]["endGap"].as_f64().is_some_and(|g| g.abs() <= 1.));
        main_thread(|w| w.setContentSize(NSSize::new(860., 720.)));
        pause();
        main_thread(|w| w.setContentSize(NSSize::new(1180., 820.)));
        pause();
        let result = json!({"pass":pass,"fixture":fixture,"selection":selection,"held":held,"samples":samples,"after_resize":state()});
        std::fs::write(
            output.join(if selection {
                "latest-selection-only.json"
            } else if fixture {
                "latest-fixture-only.json"
            } else {
                "latest-only.json"
            }),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert!(pass, "Latest reaches the tail before resize: {result}");
        return;
    }
    if std::env::args().any(|a| a == "--marked-only" || a == "--marked-raw-only") {
        let notified = !std::env::args().any(|a| a == "--marked-raw-only");
        main_thread(|w| {
            let e = composer(w);
            w.makeFirstResponder(Some(&e));
            unsafe {
                e.setMarkedText_selectedRange_replacementRange(
                    &NSString::from_str("中文"),
                    NSRange::new(2, 0),
                    NSRange::new(usize::MAX, 0),
                );
            }
        });
        pause();
        let before_notification = json!({"state":state(),"native":main_thread(|w| (composer(w).string().to_string(),composer(w).hasMarkedText()))});
        if notified {
            // Direct setMarkedText does not simulate the complete editing cycle.
            // Explicitly finish that edit before testing the command callback.
            main_thread(|w| composer(w).didChangeText());
            pause();
        }
        let before_escape = json!({"state":state(),"native":main_thread(|w| (composer(w).string().to_string(),composer(w).hasMarkedText()))});
        main_thread(|w| unsafe {
            NSTextInputClient::doCommandBySelector(&*composer(w), objc2::sel!(cancelOperation:));
        });
        pause();
        let model = state();
        let native = main_thread(|w| {
            (
                composer(w).string().to_string(),
                composer(w).hasMarkedText(),
            )
        });
        let established = before_escape["state"]["draft"] == "中文"
            && before_escape["state"]["composing"] == true;
        let pass = established
            && model["draft"] == native.0
            && model["composing"] == native.1
            && model["rows"] == 1000;
        let result = json!({"pass":pass,"input":"simulated NSTextInputClient, not OS IME","explicit_did_change_text":notified,"before_notification":before_notification,"before_escape":before_escape,"native":native,"state":model});
        std::fs::write(
            output.join(if notified {
                "marked-only.json"
            } else {
                "marked-raw-only.json"
            }),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert!(pass, "native/model marked-text consistency: {result}");
        return;
    }
    if std::env::args().any(|a| a == "--anchors-only") {
        action("hold");
        pause();
        let before = main_thread(|w| row_frame(w, None)).expect("visible held row");
        action("older");
        pause();
        let key = before.0.clone();
        let prepended = main_thread(move |w| row_frame(w, Some(&key)));
        action("replay");
        std::thread::sleep(Duration::from_secs(4));
        let key = before.0.clone();
        let grown = main_thread(move |w| row_frame(w, Some(&key)));
        let pass = prepended
            .as_ref()
            .zip(grown.as_ref())
            .is_some_and(|(p, g)| {
                p.0 == before.0
                    && g.0 == before.0
                    && (p.1 - before.1).abs() <= 1.
                    && (g.1 - before.1).abs() <= 1.
            });
        let result = json!({"pass":pass,"before":before,"prepended":prepended,"grown":grown,"state":state()});
        std::fs::write(
            output.join("anchors-only.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert!(pass, "one-point native logical anchors: {result}");
        return;
    }
    if std::env::args().any(|a| a == "--undo-only") {
        main_thread(|w| insert(w, "Original draft 日本語 👩🏽‍💻"));
        pause();
        action("chat1");
        pause();
        main_thread(|w| insert(w, "Second draft"));
        pause();
        action("chat0");
        pause();
        let restored = state();
        main_thread(|w| {
            let e = composer(w);
            e.breakUndoCoalescing();
            insert(w, " undo me");
        });
        pause();
        let edited = state();
        eprintln!("minimal undo: restored={restored}, edited={edited}");
        main_thread(|w| undo(w, false));
        pause();
        let after = state();
        let native = main_thread(|w| composer(w).string().to_string());
        let pass = after["draft"] == restored["draft"] && after["draft"] == native;
        let result =
            json!({"pass":pass,"restored":restored,"edited":edited,"after":after,"native":native});
        std::fs::write(
            output.join("undo-only.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert!(
            pass,
            "native undo must restore both editor and Rust draft: {result}"
        );
        main_thread(|w| undo(w, true));
        pause();
        assert_eq!(
            state()["draft"],
            edited["draft"],
            "native redo reaches Rust"
        );
        action("restore");
        pause();
        let restored = state()["draft"].clone();
        main_thread(|w| {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            unsafe {
                pb.setString_forType(
                    &NSString::from_str(" pasted e\u{301} 👩🏽‍💻 日本語"),
                    NSPasteboardTypeString,
                );
                composer(w).paste(None);
            }
        });
        pause();
        let pasted = state()["draft"].clone();
        let expected_paste = format!("{} pasted e\u{301} 👩🏽‍💻 日本語", restored.as_str().unwrap());
        assert_eq!(
            pasted, expected_paste,
            "exact Unicode paste into restored draft"
        );
        assert_eq!(
            main_thread(|w| composer(w).string().to_string()),
            expected_paste
        );
        main_thread(|w| undo(w, false));
        pause();
        assert_eq!(
            state()["draft"],
            restored,
            "paste undo after authoritative restoration"
        );
        main_thread(|w| undo(w, true));
        pause();
        assert_eq!(state()["draft"], pasted, "Unicode paste redo");
        action("send");
        pause();
        main_thread(|w| insert(w, "After send"));
        pause();
        main_thread(|w| undo(w, false));
        pause();
        assert_eq!(state()["draft"], "", "undo never resurrects a sent draft");
        return;
    }
    if !std::env::args().any(|a| a == "--bench") {
        let first = state();
        checks.push(json!({"check":"initial virtual window", "pass":first["rows"]==1000}));
        main_thread(|w| insert(w, "日本語 👩🏽‍💻 cafe\u{301}"));
        pause();
        let draft = state()["draft"].clone();
        action("chat1");
        pause();
        main_thread(|w| insert(w, "Second unsent draft"));
        pause();
        action("chat0");
        pause();
        checks.push(json!({"check":"native draft survives navigation", "pass":state()["draft"]==draft, "value":draft}));
        // Simulate both NSTextInputClient and the completed edit notification.
        // This does not exercise an OS input-context session.
        main_thread(|w| {
            let e = composer(w);
            w.makeFirstResponder(Some(&e));
            unsafe {
                e.setMarkedText_selectedRange_replacementRange(
                    &NSString::from_str("にほん"),
                    NSRange::new(3, 0),
                    NSRange::new(usize::MAX, 0),
                );
            }
            e.didChangeText();
            unsafe {
                NSTextInputClient::doCommandBySelector(&*e, objc2::sel!(insertNewline:));
            }
        });
        pause();
        let after_return = state();
        let native_after_return = main_thread(|w| {
            (
                composer(w).hasMarkedText(),
                composer(w).string().to_string(),
            )
        });
        checks.push(json!({"check":"simulated marked Return commits without sending", "pass":after_return["rows"]==1000 && after_return["draft"].as_str().is_some_and(|s|s.contains("にほん")) && !native_after_return.0 && after_return["draft"]==native_after_return.1,"native":native_after_return}));
        main_thread(|w| {
            let e = composer(w);
            unsafe {
                e.setMarkedText_selectedRange_replacementRange(
                    &NSString::from_str("中文"),
                    NSRange::new(2, 0),
                    NSRange::new(usize::MAX, 0),
                );
            }
            e.didChangeText();
            unsafe {
                NSTextInputClient::doCommandBySelector(&*e, objc2::sel!(cancelOperation:));
            }
        });
        pause();
        let after_escape = state();
        let native_after_escape = main_thread(|w| {
            (
                composer(w).hasMarkedText(),
                composer(w).string().to_string(),
            )
        });
        checks.push(json!({"check":"simulated marked Escape retains consistent draft/composition", "pass":after_escape["rows"]==1000 && after_escape["draft"]==native_after_escape.1 && after_escape["composing"]==native_after_escape.0,"native":native_after_escape,"state":after_escape}));
        action("chat1");
        pause();
        action("chat0");
        pause();
        // This also retains the original --undo-repro sequence. The local
        // source patch must keep undo enabled and propagate its text change.
        // Isolate undo from the earlier composition diagnostic's outcome.
        main_thread(|w| {
            let e = composer(w);
            e.unmarkText();
            unsafe {
                e.selectAll(None);
                e.insertText_replacementRange(
                    &NSString::from_str("Undo baseline 日本語 👩🏽‍💻"),
                    NSRange::new(usize::MAX, 0),
                );
            }
        });
        pause();
        action("restore");
        pause();
        let expected_undo = state()["draft"].clone();
        {
            main_thread(|w| {
                let e = composer(w);
                e.unmarkText();
                w.makeFirstResponder(Some(&e));
                e.breakUndoCoalescing();
                unsafe {
                    e.insertText_replacementRange(
                        &NSString::from_str(" undo me"),
                        NSRange::new(usize::MAX, 0),
                    );
                }
            });
            pause();
            let before_undo = state()["draft"].clone();
            let native_undo = main_thread(|w| {
                let e = composer(w);
                let before = e.string().to_string();
                undo(w, false);
                (before, e.string().to_string())
            });
            pause();
            checks.push(
            json!({"check":"native undo restores exact draft", "pass":state()["draft"]==expected_undo && state()["draft"]==native_undo.1,"native":native_undo,"before_draft":before_undo,"after_draft":state()["draft"]}),
        );
        }
        let large = "Unicode 👩🏽‍💻 日本語 e\u{301}\n".repeat(3000);
        let expected_large = format!("{}{}", state()["draft"].as_str().unwrap(), large);
        main_thread(move |w| {
            let e = composer(w);
            e.setSelectedRange(NSRange::new(e.string().length(), 0));
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            unsafe {
                pb.setString_forType(&NSString::from_str(&large), NSPasteboardTypeString);
            }
            unsafe {
                composer(w).paste(None);
            }
        });
        pause();
        let native_large = main_thread(|w| composer(w).string().to_string());
        checks.push(json!({"check":"native large Unicode paste is exact", "pass":state()["draft"]==expected_large && native_large==expected_large,"bytes":native_large.len()}));
        // Keep screenshots useful rather than photographing the stress-paste.
        main_thread(|w| {
            let e = composer(w);
            unsafe {
                e.selectAll(None);
                e.insertText_replacementRange(
                    &NSString::from_str("Keep the reader in control."),
                    NSRange::new(usize::MAX, 0),
                );
            }
        });
        pause();
        let path = output.join("nsh-chat.png");
        main_thread(move |w| screenshot(w, path));
        action("source");
        pause();
        let path = output.join("nsh-source.png");
        main_thread(move |w| screenshot(w, path));
        action("close");
        pause();
        action("selection-fixture");
        pause();
        action("latest");
        pause();
        main_thread(|_| {
            let p = NSPasteboard::generalPasteboard();
            p.clearContents();
            unsafe {
                p.setString_forType(
                    &NSString::from_str("__no_transcript_copy__"),
                    NSPasteboardTypeString,
                );
            }
        });
        let (start, end) = main_thread(|w| {
            eprintln!(
                "selection geometry: flipped={}, first={:?}, last={:?}, document={:?}",
                w.contentView().unwrap().isFlipped(),
                row_frame(w, Some("message-0:9998")),
                row_frame(w, Some("message-0:9999")),
                transcript(w).frame()
            );
            (
                row_frame(w, Some("message-0:9998"))
                    .map(|p| p.1 + 12.)
                    .unwrap_or(285.),
                row_frame(w, Some("message-0:9999"))
                    .map(|p| p.1 + 18.)
                    .unwrap_or(650.),
            )
        });
        // Mouse selection spanning the rendered transcript, followed by native copy.
        main_thread(move |w| mouse(w, NSEventType::LeftMouseDown, 245., start.max(70.)));
        pause();
        main_thread(move |w| mouse(w, NSEventType::LeftMouseDragged, 1050., end.min(690.)));
        pause();
        main_thread(move |w| mouse(w, NSEventType::LeftMouseUp, 1050., end.min(690.)));
        pause();
        let path = output.join("nsh-selected.png");
        main_thread(move |w| screenshot(w, path));
        let selected = main_thread(copy_transcript);
        let selected_ok =
            selected.contains("Selection alpha") && selected.contains("Selection beta");
        checks.push(json!({"check":"cross-message synthetic responder selection and native copy", "pass":selected_ok,"coordinates":[start,end],"copied":selected.chars().take(600).collect::<String>(),"note":"Direct responder events, not active-app mouse/menu routing."}));
        main_thread(|w| unsafe {
            let root = surface_root(w);
            eprintln!(
                "surface frame={:?}, bounds={:?}, flipped={}",
                root.frame(),
                root.bounds(),
                root.isFlipped()
            );
            let _: () = msg_send![&*root, selectAll: None::<&objc2::runtime::AnyObject>];
        });
        pause();
        let all_selected = main_thread(copy_transcript);
        let all_ok =
            all_selected.contains("Selection alpha") && all_selected.contains("Selection beta");
        let ordered_once = all_ok
            && all_selected.matches("Selection alpha").count() == 1
            && all_selected.matches("Selection beta").count() == 1
            && all_selected.find("Selection alpha") < all_selected.find("Selection beta");
        checks.push(json!({"check":"native Select All copies messages once in order", "pass":ordered_once,"selection_established":all_ok,"copied":all_selected.chars().take(600).collect::<String>()}));
        let selected = all_selected;
        let selected_ok = all_ok;
        action("hold");
        pause();
        let anchor = main_thread(|w| row_frame(w, None));
        let path = output.join("nsh-held.png");
        main_thread(move |w| screenshot(w, path));
        action("older");
        pause();
        let key = anchor.as_ref().map(|a| a.0.clone());
        let prepended = main_thread(move |w| row_frame(w, key.as_deref()));
        let recycled_copy = main_thread(copy_transcript);
        checks.push(json!({"check":"selection identity after recycling/prepend", "pass":selected_ok && recycled_copy==selected,"available":selected_ok,"copied_after":recycled_copy.chars().take(600).collect::<String>()}));
        let path = output.join("nsh-prepended.png");
        main_thread(move |w| screenshot(w, path));
        checks.push(json!({"check":"prepend logical anchor", "pass":anchor.as_ref().zip(prepended.as_ref()).is_some_and(|(a,b)|a.0==b.0&&(a.1-b.1).abs()<=1.),"before":anchor,"after":prepended}));
        let held = state();
        action("replay");
        std::thread::sleep(Duration::from_secs(4));
        let grown = state();
        let key = anchor.as_ref().map(|a| a.0.clone());
        let after = main_thread(move |w| row_frame(w, key.as_deref()));
        checks.push(json!({"check":"held logical anchor across tail/image growth", "pass":prepended.as_ref().zip(after.as_ref()).is_some_and(|(a,b)|a.0==b.0&&(a.1-b.1).abs()<=1.),"before":prepended,"after":after,"raw_offsets":[held["offset"].clone(),grown["offset"].clone()]}));
        action("latest");
        let mut latest = state();
        for _ in 0..10 {
            pause();
            latest = state();
            if latest["endGap"].as_f64().is_some_and(|gap| gap.abs() <= 1.) {
                break;
            }
        }
        checks.push(json!({"check":"Latest reaches tail after settling", "pass":latest["endGap"].as_f64().is_some_and(|gap|gap.abs()<=1.),"endGap":latest["endGap"]}));
        main_thread(|w| w.setContentSize(NSSize::new(860., 720.)));
        pause();
        main_thread(|w| w.setContentSize(NSSize::new(1180., 820.)));
        pause();
        checks.push(json!({"check":"resize retains following", "pass":state()["endGap"].as_f64().is_some_and(|gap|gap.abs()<=1.)}));
        let path = output.join("nsh-grown.png");
        main_thread(move |w| screenshot(w, path));
    }
    // Warmup plus five identical 100-tick, 30 Hz responses. Timings are
    // upstream work counters, not OS-event-to-photon measurements.
    let mut runs = vec![];
    for n in 0..if std::env::args().any(|a| a == "--checks") {
        0
    } else {
        6
    } {
        action("latest");
        action("replay");
        let started = Instant::now();
        std::thread::sleep(Duration::from_secs(4));
        let s = state();
        let mut metrics = stats(&monitor);
        metrics["run"] = json!(n);
        metrics["wall_ms"] = json!(started.elapsed().as_secs_f64() * 1000.);
        metrics["completed"] = json!(s["streaming"] == false && s["last"]["image"] == true);
        runs.push(metrics);
    }
    action("replay");
    while input_rx.try_recv().is_ok() {}
    let mut input_samples = vec![];
    for _ in 0..20 {
        let at = Instant::now();
        main_thread(|w| insert(w, "字"));
        input_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("native edit reaches Rust-owned draft");
        input_samples.push(at.elapsed().as_secs_f64() * 1000.);
        std::thread::sleep(Duration::from_millis(60));
    }
    std::thread::sleep(Duration::from_secs(3));
    let report = json!({"backend":"NSH Rust AppKit", "visible":std::env::args().any(|a|a=="--visible"), "checks":checks,"runs_including_warmup":runs,
      "native_editor_to_rust_callback_ms_while_streaming":input_samples,
      "unavailable":["real OS CJK input-source interaction", "hardware event-to-present latency", "presentation ACK / stale-frame validation", "p99 (upstream exposes p50/p95/max)"]});
    std::fs::write(
        output.join(if bench {
            "nsh-bench.json"
        } else {
            "nsh-probe.json"
        }),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    eprintln!("{}", serde_json::to_string_pretty(&report).unwrap());
}
