//! Hidden attached AppKit tests of the executable's actual owner/delegate.
//! No orderFront/app.run, signed fixture payload, service or provider.
#[cfg(target_os = "macos")]
fn main() {
    use nsh_platform_macos::{
        objc2::{MainThreadMarker, rc::Retained},
        objc2_app_kit::{
            NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSTextInputClient,
            NSTextView, NSView,
        },
        objc2_foundation::{NSDate, NSRange, NSRunLoop, NSString},
    };
    use pilot_day_native::{
        bridge::{Bridge, METHODS},
        contract::Home,
        host::{
            NativeHost, Options, Source,
            updates::{AppTarget, Selection},
        },
        macos_app::{ApplicationOwner, Phase},
        root::DayRoot,
    };
    use serde_json::json;
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };

    fn pump(until: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(40);
        while !until() {
            assert!(Instant::now() < deadline, "hidden owner deadline");
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
        }
    }
    fn nodes(root: &NSView) -> Vec<Retained<NSView>> {
        let mut nodes: Vec<Retained<NSView>> = vec![Retained::from(root)];
        let mut n = 0;
        while n < nodes.len() {
            let children = nodes[n].subviews();
            nodes.extend(children);
            n += 1;
            assert!(n < 4096);
        }
        nodes
    }
    fn shows(owner: &ApplicationOwner, expected: &str) -> bool {
        nodes(&owner.view()).iter().any(|v| {
            v.accessibilityValue()
                .and_then(|s| s.downcast::<NSString>().ok())
                .is_some_and(|s| s.to_string() == expected)
        })
    }
    struct Fixture {
        owner: ApplicationOwner,
        channel: nsh_engine::HostChannel,
        host: NativeHost,
        directory: PathBuf,
    }
    impl Fixture {
        fn new(main: MainThreadMarker, port: u16) -> Self {
            Self::selected(main, port, false)
        }
        fn selected(main: MainThreadMarker, port: u16, app_update: bool) -> Self {
            let directory =
                std::env::temp_dir().join(format!("day-owner-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(
                directory.join("nsh.json"),
                json!({"name":"Hidden owner", "id":"test.day.owner",
                "capabilities":{"host":METHODS}})
                .to_string(),
            )
            .unwrap();
            std::fs::write(directory.join("App.tsx"), r#"
import {mount,signal,View,Text,host} from 'nsh';
import {Input} from 'nsh/base';
const text=signal(''), observed=signal('ready');
const window=host.params.day.window;
const call=(name,args={})=>host.call(name,{version:1,window,args},{timeout:0});
const view=()=>({place:'today',id:'',update:false,goal:text(),focused:'',questions:[]});
let mode='hold', latest=0;
host.on('fixture.mode', value=>{mode=value});
host.on('fixture.old', async generation=>{
 const result=await call('day.flush.ack',{generation,view:view()}); observed.set('old:'+result.error);
});
host.on('fixture.enter', async ()=>{ await call('day.attention.read'); observed.set('entered returned'); });
host.on('fixture.update', async ()=>{
 const p=await call('day.update.prepare',{kind:'app',revision:1});
 if(p.error) { observed.set('prepare:'+p.error); return; }
 const r=await call('day.update.confirm',{confirmation:p.value.snapshot.pending.id,view:view()});
 if(r.error) observed.set('confirm:'+r.error);
});
host.on('day.flush', async event=>{
 latest=event.generation;
 observed.set('captured:'+text());
 if(mode==='fail') {
  const saved=await call('day.plan.save',{}); // real boundary save refusal
  observed.set('save:'+saved.error); return;
 }
 if(mode==='noview') {
  const result=await call('day.flush.ack',{generation:latest});
  observed.set('ack:'+result.error); return;
 }
 if(mode==='ack') {
   const result=await call('day.flush.ack',{generation:latest,view:view()});
   if(result.error) observed.set('ack:'+result.error);
 }
});
mount(()=><View class="flex-1"><Input multiline value={text()} onChange={({value})=>text.set(value)}
 class="h-24 w-96"/><Text>{observed()}</Text></View>);
"#).unwrap();
            let source = Source {
                profile: directory.join("profile"),
                port,
                home: Home {
                    daemon_id: "synthetic".into(),
                    lineage_id: "synthetic".into(),
                },
                project_id: "synthetic".into(),
                project_path: directory.display().to_string(),
            };
            let updates = app_update.then(|| {
                use pilot_desktop_updater::{app_update::Connection, coordination::Location, manifest::Trust};
                use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
                std::fs::create_dir(&source.profile).unwrap();
                std::fs::set_permissions(&source.profile, std::fs::Permissions::from_mode(0o700)).unwrap();
                std::fs::write(source.profile.join("daemon-id"), "synthetic").unwrap();
                std::fs::write(source.profile.join("storage-lineage"), "synthetic").unwrap();
                use std::io::Write;
                std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
                    .open(source.profile.join("github-app-capability")).unwrap()
                    .write_all(json!({"daemonId":"synthetic","lineageId":"synthetic","token":"a".repeat(64)}).to_string().as_bytes()).unwrap();
                let installed = directory.join("unpublished.app");
                Selection {
                    connection: Connection::new(Location { home: source.profile.clone(), port, policy: Default::default() }, "synthetic".into(), "synthetic".into()),
                    trust: Trust { repository: "synthetic/offline".into(), application_id: "com.example.synthetic.day".into(), channel: "desktop-stable".into(), current_build: "1.0".into(), bundle_name: "Pilot Next.app".into(), public_key: [42;32], code_requirement: "identifier com.example.synthetic.day".into() },
                    installed: installed.clone(), capsule: None, binding: None,
                    app: Some(AppTarget { transaction: directory.join("missing-transaction"), target: installed, build: "2.0".into(), source: "a".repeat(40) }),
                    restore_transaction: None,
                }
            });
            let host = NativeHost::open_with_options(
                source,
                directory.join("journal"),
                Options {
                    updates,
                    ..Default::default()
                },
            )
            .unwrap();
            let bridge = Bridge::new(DayRoot::new(host.clone()));
            let channel = bridge.channel();
            let owner = ApplicationOwner::new(
                main,
                nsh_testing::compile_tsx(directory.join("App.tsx"), &[]).unwrap(),
                bridge,
            )
            .unwrap();
            let fixture = Self {
                owner,
                channel,
                host,
                directory,
            };
            pump(|| shows(&fixture.owner, "ready"));
            fixture
        }
        fn mode(&self, mode: &str) {
            self.channel.send("fixture.mode", json!(mode)).unwrap();
        }
        fn editor(&self) -> Retained<NSTextView> {
            nodes(&self.owner.view())
                .into_iter()
                .find_map(|v| {
                    v.downcast::<NSTextView>()
                        .ok()
                        .filter(|e| !e.isFieldEditor())
                })
                .unwrap()
        }
        fn close(&self) {
            self.mode("ack");
            self.owner.request_quit();
            pump(|| self.owner.phase() == Phase::Closed);
            assert_eq!(self.owner.error(), None);
            self.owner.request_quit();
            self.owner.cancel_close();
            assert_eq!(self.owner.phase(), Phase::Closed);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Teardown never waits on a fixture's unreleased I/O gate. Tests
            // release that gate before reaching here, including panic unwind.
            if self.owner.phase() != Phase::Closed {
                let _ = self.host.close().recv_blocking();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    let main = MainThreadMarker::new().expect("main-thread native test");
    NSApplication::sharedApplication(main)
        .setActivationPolicy(NSApplicationActivationPolicy::Prohibited);

    let f = Fixture::new(main, 1);
    let editor = f.editor();
    let window = f.owner.view().window().unwrap();
    assert!(!window.isVisible());
    assert!(window.makeFirstResponder(Some(&editor)));
    let exact = "draft 👩🏽‍💻 e\u{301} 日本語\n  ";
    // SAFETY: valid NSString and UTF-16 selection/replacement ranges.
    unsafe {
        editor.setMarkedText_selectedRange_replacementRange(
            &NSString::from_str(exact),
            NSRange::new(exact.encode_utf16().count(), 0),
            NSRange::new(0, 0),
        );
    }
    assert!(editor.hasMarkedText());
    f.owner.request_close();
    let Phase::Saving(first) = f.owner.phase() else {
        panic!("close was not deferred")
    };
    f.owner.request_quit(); // same owner and generation, not a second close
    assert_eq!(f.owner.phase(), Phase::Saving(first));
    assert!(!editor.hasMarkedText());
    assert!(!editor.isEditable());
    pump(|| shows(&f.owner, &format!("captured:{exact}")));
    f.owner.cancel_close();
    assert_eq!(f.owner.phase(), Phase::Editing);
    assert!(editor.isEditable());
    assert_eq!(editor.string().to_string(), exact);
    assert_eq!(
        editor.selectedRange(),
        NSRange::new(exact.encode_utf16().count(), 0)
    );
    assert!(std::ptr::eq(
        &*window.firstResponder().unwrap(),
        &*editor as &nsh_platform_macos::objc2_app_kit::NSResponder
    ));
    f.owner.request_quit();
    let Phase::Saving(next) = f.owner.phase() else {
        panic!("Quit was not deferred")
    };
    assert!(next > first);
    f.channel.send("fixture.old", json!(first)).unwrap();
    pump(|| shows(&f.owner, "old:stale"));
    assert_eq!(f.owner.phase(), Phase::Saving(next));
    f.owner.cancel_close();
    f.mode("noview");
    f.owner.request_quit();
    pump(|| shows(&f.owner, "ack:busy"));
    assert!(matches!(f.owner.phase(), Phase::Saving(_)));
    assert!(f.host.saved_window().is_none());
    f.owner.cancel_close();
    f.mode("fail");
    f.owner.request_close();
    pump(|| shows(&f.owner, "save:invalid"));
    assert!(matches!(f.owner.phase(), Phase::Saving(_)));
    assert_eq!(editor.string().to_string(), exact);
    // The production deadline, not a synthetic success/failure reply, cancels
    // the failed save and restores editing/focus without replacing the root.
    pump(|| f.owner.phase() == Phase::Editing);
    assert_eq!(
        f.owner.error(),
        Some(pilot_day_native::host::Error::Unavailable)
    );
    assert!(editor.isEditable());
    assert_eq!(editor.string().to_string(), exact);
    // A byte change outside the frozen input path invalidates the ACK. Keep
    // the current native bytes and the same root instead of disposing them.
    f.mode("hold");
    f.owner.request_quit();
    let Phase::Saving(tampered) = f.owner.phase() else {
        panic!("not saving")
    };
    let changed = "new native bytes Δ  ";
    editor.setString(&NSString::from_str(changed));
    f.channel.send("fixture.old", json!(tampered)).unwrap();
    pump(|| f.owner.phase() == Phase::Editing);
    assert_eq!(f.owner.error(), Some(pilot_day_native::host::Error::Stale));
    assert!(editor.isEditable());
    assert_eq!(editor.string().to_string(), changed);
    f.close();
    let saved = f
        .host
        .saved_window()
        .expect("ordinary Close durably saved its view");
    assert_eq!(saved.view["goal"], changed);
    let reopened = NativeHost::open(saved.source.clone(), f.directory.join("journal")).unwrap();
    pump(|| reopened.saved_window().is_some());
    assert_eq!(reopened.saved_window(), Some(saved.clone()));
    assert_eq!(reopened.close().recv_blocking().unwrap(), Ok(()));
    let mut other_source = saved.source;
    other_source.profile = f.directory.join("another-profile");
    let other = NativeHost::open(other_source, f.directory.join("journal")).unwrap();
    pump(|| other.snapshot().freshness.state == pilot_day_native::FreshnessState::Unavailable);
    assert!(
        other.saved_window().is_none(),
        "a different selection cannot adopt this capture"
    );
    assert_eq!(other.close().recv_blocking().unwrap(), Ok(()));
    drop(f);

    // Entered real loopback I/O must finish before the root/engine/window go.
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::mpsc,
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let f = Fixture::new(main, listener.local_addr().unwrap().port());
    pump(|| f.host.snapshot().freshness.state == pilot_day_native::FreshnessState::Unavailable);
    let profile = f.directory.join("profile");
    std::fs::create_dir(&profile).unwrap();
    std::fs::write(profile.join("daemon-id"), "synthetic").unwrap();
    std::fs::write(profile.join("storage-lineage"), "synthetic").unwrap();
    use std::os::unix::fs::OpenOptionsExt;
    let mut capability = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(profile.join("github-app-capability"))
        .unwrap();
    write!(
        capability,
        "{}",
        json!({"daemonId":"synthetic","lineageId":"synthetic","token":"a".repeat(64)})
    )
    .unwrap();
    drop(capability);
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    struct Release(Option<mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }
    let release = Release(Some(release)); // released before Fixture teardown on unwind
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        entered_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(15));
        stream
            .write_all(
                b"HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .unwrap();
    });
    f.channel.send("fixture.enter", json!(null)).unwrap();
    pump(|| entered.try_recv().is_ok());
    f.mode("ack");
    f.owner.request_quit();
    assert!(matches!(f.owner.phase(), Phase::Saving(_)));
    for _ in 0..10 {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
    assert!(matches!(f.owner.phase(), Phase::Saving(_)));
    assert!(f.owner.view().window().is_some());
    drop(release);
    pump(|| f.owner.phase() == Phase::Closed);
    server.join().unwrap();
    assert_eq!(f.owner.error(), None);
    drop(f);

    // A real private-journal write refusal also prevents disposal. No synthetic
    // result substitutes for the durability barrier, and no native work starts.
    let f = Fixture::new(main, 1);
    let editor = f.editor();
    editor.setString(&NSString::from_str("kept on failed fsync path 👩🏽‍💻  "));
    editor.didChangeText();
    std::fs::write(f.directory.join("journal"), "unexpected writer\n").unwrap();
    f.mode("ack");
    f.owner.request_quit();
    pump(|| shows(&f.owner, "ack:storage"));
    assert!(matches!(f.owner.phase(), Phase::Saving(_)));
    assert!(f.host.saved_window().is_none());
    pump(|| f.owner.phase() == Phase::Editing);
    assert!(editor.isEditable());
    assert_eq!(
        editor.string().to_string(),
        "kept on failed fsync path 👩🏽‍💻  "
    );
    assert!(f.owner.view().window().is_some());
    drop(f);
    // The actual production owner consumes an app confirmation once, but never
    // substitutes fixture identity for a missing signed payload.
    let f = Fixture::selected(main, 1, true);
    let editor = f.editor();
    editor.setString(&NSString::from_str("final update bytes 👩🏽‍💻  "));
    editor.didChangeText();
    f.channel.send("fixture.update", json!(null)).unwrap();
    pump(|| matches!(f.owner.phase(), Phase::Saving(_)));
    f.owner.cancel_close();
    assert_eq!(f.owner.phase(), Phase::Editing);
    assert!(editor.isEditable());
    assert!(
        !std::fs::read_to_string(f.directory.join("journal"))
            .unwrap()
            .contains("\"state\":\"entered\"")
    );
    f.close(); // ordinary Close must not resurrect the consumed update intent
    assert!(
        !std::fs::read_to_string(f.directory.join("journal"))
            .unwrap()
            .contains("\"state\":\"entered\"")
    );
    drop(f);

    let f = Fixture::selected(main, 1, true);
    let editor = f.editor();
    editor.setString(&NSString::from_str("kept after refused handoff 👩🏽‍💻  "));
    editor.didChangeText();
    f.mode("ack");
    f.channel.send("fixture.update", json!(null)).unwrap();
    pump(|| f.owner.phase() == Phase::DrainFailed);
    assert!(f.owner.view().window().is_some());
    assert_eq!(
        editor.string().to_string(),
        "kept after refused handoff 👩🏽‍💻  "
    );
    assert_eq!(
        f.host.saved_window().unwrap().view["goal"],
        "kept after refused handoff 👩🏽‍💻  "
    );
    let journal = std::fs::read_to_string(f.directory.join("journal")).unwrap();
    assert_eq!(journal.matches("\"state\":\"entered\"").count(), 1);
    assert!(journal.contains("\"state\":\"stopped\""));
    assert!(!f.directory.join("missing-transaction").exists());
    assert!(!f.directory.join("profile/.daemon-upgrade.json").exists());
    f.owner.request_quit();
    f.owner.cancel_close();
    assert_eq!(f.owner.phase(), Phase::DrainFailed);
    assert_eq!(
        std::fs::read_to_string(f.directory.join("journal")).unwrap(),
        journal
    );
    drop(f);

    println!(
        "PASS hidden production owner: deferred close/Quit, exact preedit, cancel/retry, stale ACK, failed save, entered-I/O drain, one joined disposal, app-confirmation cancel/no replay, missing-signed-payload refusal"
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("application_owner requires macOS");
}
