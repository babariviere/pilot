//! Actual nested AppViews in an attached hidden window. No orderFront,
//! application run loop, daemon, profile, provider or screen capture.
#[cfg(target_os = "macos")]
fn main() {
    use nsh_core::access::Capabilities;
    use nsh_engine::{HostChannel, Policy};
    use nsh_platform_macos::{
        AppOptions, AppView,
        objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained},
        objc2_app_kit::{
            NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType,
            NSView, NSWindow, NSWindowStyleMask,
        },
        objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
    };
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn nodes(root: &NSView) -> Vec<Retained<NSView>> {
        let mut result: Vec<Retained<NSView>> = vec![Retained::from(root)];
        let mut at = 0;
        while at < result.len() {
            assert!(at < 4096, "bounded hidden view inventory");
            let children = result[at].subviews();
            result.extend(children);
            at += 1;
        }
        result
    }
    fn shows(root: &NSView, text: &str) -> bool {
        nodes(root).iter().any(|view| {
            view.accessibilityLabel()
                .is_some_and(|value| value.to_string() == text)
                || view
                    .accessibilityValue()
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .is_some_and(|value| value.to_string() == text)
        })
    }
    fn pump(root: &NSView, label: &str, until: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !until() {
            assert!(
                Instant::now() < deadline,
                "hidden preview deadline ({label}): {:?}",
                nodes(root)
                    .iter()
                    .map(|view| (
                        view.accessibilityLabel().map(|s| s.to_string()),
                        view.accessibilityValue()
                            .and_then(|s| s.downcast::<NSString>().ok())
                            .map(|s| s.to_string())
                    ))
                    .collect::<Vec<_>>()
            );
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
        }
    }
    let main = MainThreadMarker::new().expect("native fixture main thread");
    NSApplication::sharedApplication(main)
        .setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    let directory = std::env::temp_dir().join(format!("artifact-preview-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).expect("fixture directory");
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _temp = Temp(directory.clone());
    let component = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ArtifactPreview.tsx");
    std::fs::write(
        directory.join("nsh.json"),
        r#"{"name":"Hidden artifact preview","capabilities":{}}"#,
    )
    .expect("manifest");
    std::fs::write(
        directory.join("App.tsx"),
        format!(
            r#"
import {{mount,Text,View,signal,host}} from 'nsh';
import {{ArtifactPreview}} from {};
const inspected=signal(null);
host.on('fixture.show',value=>inspected.set(value));
mount(()=><View class="flex-1"><Text>Parent stays connected</Text>
  <If when={{inspected()}}><ArtifactPreview inspection={{inspected()}} /></If>
</View>);
"#,
            json!(component)
        ),
    )
    .expect("fixture entry");
    let host = HostChannel::new();
    host.set_params(
        serde_json::from_value(json!({"day":{"version":1,"window":"fixture"}})).unwrap(),
    );
    let options = AppOptions {
        host: host.clone(),
        ..AppOptions::default()
    };
    pilot_day_native::macos_artifact::register(main, &options.components, &host);
    assert_eq!(host.params()["day"]["artifactPreview"], true);
    nsh_platform_macos::set_ui_sets(vec![nsh_base::registry(), pilot_day_native::registry()]);
    let parent = AppView::new(main, options);
    let root = parent.view();
    // SAFETY: standard attached NSWindow construction; this window is never ordered front.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(main),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(900., 650.)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: this retained test owner, not AppKit, releases the hidden window.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setContentView(Some(&root));
    let bundle = nsh_testing::compile_tsx(directory.join("App.tsx"), &[])
        .expect("real preview TSX builds")
        .with_policy(Policy {
            harden: true,
            declared: Some(Capabilities::default()),
            granted: Some(Capabilities::default()),
        });
    parent.load(bundle.into());
    pump(&root, "parent mounted", || {
        shows(&root, "Parent stays connected")
    });
    let source = "import {Text,signal} from 'nsh'; import {Button} from 'nsh/base'; import {Page} from 'pilot-artifact/ui'; export default function Artifact(){const n=signal(0);return <Page title='Local preview'><Text>{`Count: ${n()}`}</Text><Button onPress={()=>n.set(n()+1)}><Text>Try</Text></Button></Page>}";
    let inspection = json!({"key":"fixture","title":"Saved count example","kind":"nsh","generation":1,"preview":true,"state":"shown","message":"",
        "pin":{"revision":1},"artifact":{"version":1,"metadata":{"kind":"nsh","title":"Saved count example"},"rendering":"unsupported",
        "reference":{"artifactId":"11111111-1111-1111-1111-111111111111","sourceSessionId":"owner","revision":1},
        "content":{"state":"text","source":source,"containerSha256":"a".repeat(64),"containerBytes":1000}}});
    host.send("fixture.show", inspection.clone())
        .expect("show saved fixture");
    pump(&root, "preview mounted", || shows(&root, "Count: 0"));
    let button = nodes(&root)
        .into_iter()
        .find(|view| {
            view.accessibilityRole()
                .is_some_and(|role| role.to_string() == "AXButton")
        })
        .expect("actual child button");
    // SAFETY: NSH's own AXButton view implements accessibilityPerformPress.
    let pressed: bool = unsafe { msg_send![&*button, accessibilityPerformPress] };
    assert!(pressed);
    pump(&root, "local press", || shows(&root, "Count: 1"));
    assert!(shows(&root, "Parent stays connected"));
    host.send("fixture.show", json!(null))
        .expect("close preview");
    pump(&root, "preview closed", || !shows(&root, "Count: 1"));
    host.send("fixture.show", inspection.clone())
        .expect("reopen immutable revision");
    pump(&root, "preview reopened", || shows(&root, "Count: 0"));
    let mut failed = inspection.clone();
    failed["pin"]["revision"] = json!(2);
    failed["artifact"]["reference"]["revision"] = json!(2);
    failed["artifact"]["content"]["source"] =
        json!("throw Error('Startup fixture failed'); export default () => null;");
    host.send("fixture.show", failed)
        .expect("show failed revision");
    pump(&root, "startup failure visible", || {
        shows(
            &root,
            "This artifact could not start: Error: Startup fixture failed",
        )
    });
    let mut invalid = inspection;
    invalid["artifact"]["metadata"]["kind"] = json!("html");
    host.send("fixture.show", invalid)
        .expect("historical source stays inert");
    pump(&root, "legacy source refused", || {
        shows(&root, "Unsupported saved NSH revision")
    });
    assert!(!shows(&root, "Count: 0"));
    parent.stop();
    window.setContentView(None);
    window.close();
    println!(
        "PASS hidden app preview: actual TSX/native frame, local press, parent isolation, close/reopen reset and historical-kind refusal"
    );
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("artifact_preview requires macOS");
}
