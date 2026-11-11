//! Hidden attached-editor qualification. Never orders a window front or runs a
//! provider/service/update. Run with --features macos-host on macOS only.
#[cfg(all(target_os = "macos", feature = "macos-host"))]
fn main() {
    use nsh_platform_macos::{
        objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
        objc2_app_kit::{
            NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType,
            NSTextField, NSTextInputClient, NSTextView, NSView, NSWindow, NSWindowStyleMask,
        },
        objc2_foundation::{NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString},
    };
    use pilot_day_native::{
        bridge::{Bridge, METHODS},
        contract::Home,
        host::{NativeHost, Source},
        macos_host::WindowOwner,
        root::DayRoot,
    };
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn nodes(view: &NSView) -> Vec<Retained<NSView>> {
        let mut all: Vec<Retained<NSView>> = vec![Retained::from(view)];
        let mut i = 0;
        while i < all.len() {
            let children = all[i].subviews();
            all.extend(children);
            i += 1;
            assert!(i < 4096);
        }
        all
    }
    fn pump(until: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !until() {
            assert!(Instant::now() < deadline, "native fixture deadline");
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
        }
    }

    let main = MainThreadMarker::new().expect("native probe main thread");
    let app = NSApplication::sharedApplication(main);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    let directory =
        std::env::temp_dir().join(format!("day-capture-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(
        directory.join("nsh.json"),
        json!({"name":"Capture fixture","id":"test.day.capture","capabilities":{"host":METHODS}})
            .to_string(),
    )
    .unwrap();
    let file = directory.join("App.tsx");
    std::fs::write(&file, r#"import {mount,signal,View,Text,host} from 'nsh';
import {Input} from 'nsh/base';
const text=signal(''), line=signal(''), saved=signal('waiting');
host.on('day.flush',async event=>{
  saved.set('captured:'+text()+'|'+line());
  await host.call('day.flush.ack',{version:1,window:host.params.day.window,args:{generation:event.generation,
    view:{place:'today',id:'',update:false,goal:text()+'|'+line(),focused:'',questions:[]}}},{timeout:0});
});
mount(()=><View class="flex-1"><Input multiline testID="editor" value={text()} onChange={({value})=>text.set(value)} class="h-24 w-96"/><Input testID="line" value={line()} onChange={({value})=>line.set(value)} class="h-8 w-96"/><Text testID="saved">{saved()}</Text></View>);
"#).unwrap();
    let host = NativeHost::open(
        Source {
            profile: directory.join("missing-profile"),
            port: 1,
            home: Home {
                daemon_id: "synthetic".into(),
                lineage_id: "synthetic".into(),
            },
            project_id: "synthetic".into(),
            project_path: directory.display().to_string(),
        },
        directory.join("journal"),
    )
    .unwrap();
    let bridge = Bridge::new(DayRoot::new(host));
    let mut owner = WindowOwner::new(main, bridge);
    // SAFETY: designated public AppKit initializer on the main thread. The
    // retained window is never shown, and outlives its attached view.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(main),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(600., 400.)),
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setContentView(Some(&owner.view()));
    owner
        .load(nsh_testing::compile_tsx(file, &[]).unwrap())
        .unwrap();
    pump(|| {
        nodes(&owner.view()).iter().any(|v| {
            v.downcast_ref::<NSTextView>()
                .is_some_and(|e| e.isEditable() && !e.isFieldEditor())
        })
    });
    let editor = nodes(&owner.view())
        .into_iter()
        .find_map(|v| {
            v.downcast::<NSTextView>()
                .ok()
                .filter(|e| e.isEditable() && !e.isFieldEditor())
        })
        .unwrap();
    assert!(window.makeFirstResponder(Some(&editor)));
    let exact = "draft 👩🏽‍💻 e\u{301} 日本語\n  ";
    // SAFETY: NSString is one of NSTextInputClient's documented string types;
    // the selection/replacement ranges are valid UTF-16 offsets.
    unsafe {
        editor.setMarkedText_selectedRange_replacementRange(
            &NSString::from_str(exact),
            NSRange::new(exact.encode_utf16().count(), 0),
            NSRange::new(0, 0),
        );
    }
    assert!(editor.hasMarkedText());
    assert_eq!(editor.string().to_string(), exact);
    let generation = owner.begin_close(main).unwrap();
    assert!(!editor.hasMarkedText());
    assert!(!editor.isEditable());
    let observed = format!("captured:{exact}|");
    pump(|| {
        nodes(&owner.view()).iter().any(|v| {
            v.accessibilityValue()
                .and_then(|value| value.downcast::<NSString>().ok())
                .is_some_and(|s| s.to_string() == observed)
        })
    });
    owner.cancel_close(generation).unwrap();
    assert!(editor.isEditable());
    assert_eq!(editor.string().to_string(), exact);
    let field = nodes(&owner.view())
        .into_iter()
        .find_map(|v| v.downcast::<NSTextField>().ok().filter(|e| e.isEditable()))
        .unwrap();
    assert!(window.makeFirstResponder(Some(&field)));
    let line_editor = field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap();
    let line_exact = "line Δ 👩🏽‍💻  ";
    // SAFETY: valid NSString and UTF-16 ranges in this attached field editor.
    unsafe {
        line_editor.setMarkedText_selectedRange_replacementRange(
            &NSString::from_str(line_exact),
            NSRange::new(line_exact.encode_utf16().count(), 0),
            NSRange::new(0, 0),
        );
    }
    assert!(line_editor.hasMarkedText());
    let next_generation = owner.begin_close(main).unwrap();
    assert_eq!(next_generation, generation + 1);
    assert!(!line_editor.hasMarkedText());
    let observed = format!("captured:{exact}|{line_exact}");
    pump(|| {
        nodes(&owner.view()).iter().any(|v| {
            v.accessibilityValue()
                .and_then(|value| value.downcast::<NSString>().ok())
                .is_some_and(|s| s.to_string() == observed)
        })
    });
    owner.cancel_close(next_generation).unwrap();
    assert!(field.isEditable());
    assert_eq!(
        field.currentEditor().unwrap().string().to_string(),
        line_exact
    );
    let final_generation = owner.begin_close(main).unwrap();
    // An early finish is Busy, never disposal. Pump until the exact durable
    // worker ACK is available, without resending any engine or native effect.
    let deadline = Instant::now() + Duration::from_secs(10);
    let joined = loop {
        assert!(Instant::now() < deadline, "worker flush ACK deadline");
        match owner.seal_close(final_generation) {
            Ok(sealed) => break sealed,
            Err(pilot_day_native::host::Error::Busy) => NSRunLoop::currentRunLoop()
                .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01)),
            Err(e) => panic!("close refused: {e:?}"),
        }
    };
    assert!(matches!(
        owner.seal_close(final_generation),
        Err(pilot_day_native::host::Error::Stale)
    ));
    let joined = owner.close_sealed(joined).unwrap();
    assert!(matches!(
        owner.finish_close(final_generation),
        Err(pilot_day_native::host::Error::Stale)
    ));
    let result = joined.recv_blocking().unwrap();
    assert_eq!(result.result(), Ok(()));
    owner.dispose_joined(result).unwrap();
    window.setContentView(None);
    drop(owner);
    drop(window);
    std::fs::remove_dir_all(directory).unwrap();
    println!(
        "PASS hidden attached native preedit -> all-form barrier -> seal -> joined root close -> stop"
    );
}

#[cfg(not(all(target_os = "macos", feature = "macos-host")))]
fn main() {
    panic!("capture probe requires macOS and --features macos-host");
}
