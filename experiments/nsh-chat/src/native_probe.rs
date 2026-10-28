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

fn mouse(w: &NSWindow, kind: NSEventType, x: f64, y: f64) {
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind, NSPoint::new(x, w.contentView().unwrap().bounds().size.height - y), NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(), w.windowNumber(), None, 0, 1, 1.0).unwrap();
    NSApplication::sharedApplication(MainThreadMarker::from(w)).postEvent_atStart(&event, false);
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
            let y = root.bounds().size.height - rect.origin.y - rect.size.height;
            (id.is_some() || (y + rect.size.height > 65. && y < 600.)).then_some((name, y))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
}

fn copy_transcript(w: &NSWindow) -> String {
    let document = descendants(&w.contentView().unwrap())
        .into_iter()
        .find(|v| {
            NSAccessibility::accessibilityIdentifier(&**v)
                .is_some_and(|id| id.to_string() == "transcript-selection")
        })
        .unwrap();
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
        // Actual NSTextInputClient marked-text path. No claim of OS input-source testing.
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
            unsafe {
                NSTextInputClient::doCommandBySelector(&*e, objc2::sel!(insertNewline:));
            }
        });
        pause();
        let after_return = state();
        checks.push(json!({"check":"marked Return does not send", "pass":after_return["rows"]==1000 && after_return["draft"].as_str().is_some_and(|s|s.contains("にほん"))}));
        main_thread(|w| {
            let e = composer(w);
            unsafe {
                e.setMarkedText_selectedRange_replacementRange(
                    &NSString::from_str("中文"),
                    NSRange::new(2, 0),
                    NSRange::new(usize::MAX, 0),
                );
            }
            unsafe {
                NSTextInputClient::doCommandBySelector(&*e, objc2::sel!(cancelOperation:));
            }
        });
        pause();
        checks.push(json!({"check":"marked Escape does not send", "pass":state()["rows"]==1000}));
        action("chat1");
        pause();
        action("chat0");
        pause();
        // The upstream AppKit editor's shared undo stack can throw an
        // NSRangeException after programmatic draft restoration. Keep the
        // destructive reproducer opt-in; a completed probe is not acceptance.
        if std::env::args().any(|a| a == "--undo-repro") {
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
                unsafe {
                    let manager: Option<Retained<objc2::runtime::AnyObject>> =
                        msg_send![&*e, undoManager];
                    if let Some(manager) = manager {
                        let _: () = msg_send![&*manager, undo];
                    }
                }
                (before, e.string().to_string())
            });
            pause();
            checks.push(
            json!({"check":"native undo changes draft", "pass":state()["draft"]!=before_undo,"native":native_undo,"before_draft":before_undo,"after_draft":state()["draft"]}),
        );
        } else {
            checks.push(json!({"check":"post-navigation native undo", "pass":false,"blocked":"NSRangeException observed; reproduce with --checks --undo-repro. Not qualified."}));
        }
        let large = "Unicode 👩🏽‍💻 日本語 e\u{301}\n".repeat(3000);
        main_thread(move |w| {
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
        checks.push(json!({"check":"native large Unicode paste", "pass":state()["draft"].as_str().is_some_and(|s| s.len()>100000)}));
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
            selected.contains("Keep the reader") && selected.contains("synthetic replay");
        checks.push(json!({"check":"cross-message native mouse selection and targeted copy", "pass":selected_ok, "available":std::env::args().any(|a|a=="--visible"),"copied":selected.chars().take(600).collect::<String>(),"note":"Hidden AppKit windows may not receive posted mouse events; no active-app Copy qualification."}));
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
        pause();
        checks.push(json!({"check":"Latest reaches tail", "pass":state()["endGap"].as_f64().is_some_and(|gap|gap.abs()<=1.)}));
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
