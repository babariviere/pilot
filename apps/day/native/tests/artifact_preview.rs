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
    /// The view as AppKit draws it in process, as a PNG (NSH's own in-process capture does the same).
    fn picture(view: &NSView) -> Vec<u8> {
        use nsh_platform_macos::{
            objc2::runtime::AnyObject,
            objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey},
            objc2_foundation::NSDictionary,
        };
        let bounds = view.bounds();
        let rep = view
            .bitmapImageRepForCachingDisplayInRect(bounds)
            .expect("a bitmap of the view");
        view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
        // SAFETY: an empty property dictionary is valid for PNG.
        let data = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        };
        data.expect("PNG data").to_vec()
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
    // The parent entry sits in Day's app directory, so it builds with Day's theme and with the fonts and icons
    // ArtifactPreview's parts import, as Day's own window does. It is removed when the test ends.
    let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(format!(
            "ArtifactPreviewHost-{}.tsx",
            uuid::Uuid::new_v4().simple()
        ));
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _temp = Temp(entry.clone());
    std::fs::write(
        &entry,
        r#"
import {mount,Text,View,signal,host} from 'nsh';
import {ArtifactPreview} from './ArtifactPreview';
const inspected=signal(null);
host.on('fixture.show',value=>inspected.set(value));
mount(()=><View class="flex-1"><Text>Parent stays connected</Text>
  <If when={inspected()}><ArtifactPreview inspection={inspected()} /></If>
</View>);
"#,
    )
    .expect("fixture entry");
    let host = HostChannel::new();
    host.set_params(
        serde_json::from_value(json!({"day":{"version":1,"window":"fixture"}})).unwrap(),
    );
    let options = AppOptions {
        host: host.clone(),
        // Where Day's window reads the fonts and icons its parts import (bootstrap.rs sets its bundle's).
        asset_base: Some(nsh_platform_macos::AssetBase::Directory(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".."),
        )),
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
    let bundle = nsh_testing::compile_tsx(
        &entry,
        &[nsh_base::registry(), pilot_day_native::registry()],
    )
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
                && view
                    .accessibilityLabel()
                    .is_some_and(|label| label.to_string() == "Try")
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
    let mut invalid = inspection.clone();
    invalid["artifact"]["metadata"]["kind"] = json!("html");
    host.send("fixture.show", invalid)
        .expect("historical source stays inert");
    pump(&root, "legacy source refused", || {
        shows(&root, "Unsupported saved NSH revision")
    });
    assert!(!shows(&root, "Count: 0"));

    // Day's library (`pilot-day/ui`) in a preview, with Day's theme. The parent registered Geist for the whole
    // process when ArtifactPreview's parts imported ui/fonts.ts, as Day's own window does.
    let page = r#"import {Scroll} from 'nsh';
import {Body, Button, Column, Icon, Notice, Num, Page, PageHead, Panel, Question, Row, Rows, Section, State, Tab, Tabs} from 'pilot-day/ui';
export default function Artifact() {
  return <Scroll class="flex-1"><Page>
    <PageHead pre={<Num>Thursday 14 November</Num>} title="Release 2.4" state={<State kind="needs" />}
      text="Drawn with Pilot's parts, theme and Geist." actions={<Button label="Share" icon="share" onPress={() => {}} />} />
    <Panel tabs={<Tabs><Tab label="Overview" selected onPress={() => {}} /><Tab label="Done" count={2} selected={false} onPress={() => {}} /></Tabs>}
      notice={<Notice text="Checks are slow today" detail="About 20 min a run." placement="panel" />}>
      <Column>
        <Section title="Needs you" count={1}>
          <Question title="Ship behind a flag?" foot={<Button kind="primary" icon="check" label="Decide" onPress={() => {}} />}>
            <Body>Support has not seen the new page yet.</Body>
          </Question>
        </Section>
        <Section title="Working" count={2}>
          <Rows>
            <Row mark="working" title="Move the billing tables" meta="Billing" trailing={<Icon name="check" tint="tint-ok" />} />
            <Row mark="failed" title="Retry failed uploads" meta="Uploads" state="Failed" stateTone="failed" />
          </Rows>
        </Section>
      </Column>
    </Panel>
  </Page></Scroll>;
}"#;
    let mut library = inspection.clone();
    library["pin"]["revision"] = json!(3);
    library["artifact"]["reference"]["revision"] = json!(3);
    library["artifact"]["content"]["source"] = json!(page);
    host.send("fixture.show", library)
        .expect("show the library page");
    pump(&root, "library page", || {
        shows(&root, "Ship behind a flag?")
    });
    // Icons decode off the main thread; give them a few frames.
    let settle = Instant::now() + Duration::from_millis(800);
    pump(&root, "icons decode", || Instant::now() >= settle);
    let png =
        std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("artifact-preview-library.png");
    std::fs::write(&png, picture(&root)).expect("write the capture");
    println!("Library preview capture: {}", png.display());
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
