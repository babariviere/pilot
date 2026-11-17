#![cfg(unix)]

use nsh_testing::Headless;
use pilot_day_native::{artifact_runtime, artifact_source::CapturedSource};
use sha2::{Digest, Sha256};

fn captured(source: &str) -> CapturedSource {
    CapturedSource {
        artifact_id: "11111111-1111-1111-1111-111111111111".into(),
        source_session_id: "owner".into(),
        revision: 1,
        entry: "Artifact.tsx".into(),
        source: source.into(),
        source_sha256: format!("{:x}", Sha256::digest(source.as_bytes())),
        source_bytes: source.len(),
    }
}

#[test]
fn captured_module_links_trusted_helpers_and_reopens_with_fresh_local_state() {
    let source = r#"
import {Text, signal} from 'nsh';
import {Button} from 'nsh/base';
import {Page} from 'pilot-artifact/ui';
export default function Artifact() {
  const count = signal(0);
  return <Page title="Captured preview"><Text>{`Count: ${count()}`}</Text>
    <Button onPress={() => count.set(count() + 1)}><Text>Try</Text></Button>
  </Page>;
}"#;
    let mut retired: Option<(nsh_engine::EngineControl, nsh_core::NodeId)> = None;
    for _ in 0..2 {
        let config = artifact_runtime::config(captured(source)).expect("valid captured module");
        assert!(config.network.is_none());
        assert!(config.filesystem.is_none());
        assert!(config.assets.is_none());
        assert!(config.data_dir.is_none());
        assert!(config.storage.is_none());
        assert!(config.clipboard.is_none());
        assert!(config.windows.is_none());
        assert!(config.host.params().is_empty());
        assert_eq!(config.limits, artifact_runtime::limits());
        let mut app = Headless::start(config).expect("separate artifact engine");
        app.wait_for("Count: 0").expect("fresh local state");
        if let Some((control, node)) = &retired {
            control.dispatch_event(
                *node,
                nsh_core::EventKind::Press,
                nsh_core::EventPayload::None,
            );
            app.wait(std::time::Duration::ZERO)
                .expect("retired events drained");
            assert!(
                app.shows("Count: 0"),
                "old controls cannot enter the replacement VM"
            );
        }
        app.press("role:button[Try]").expect("artifact-local press");
        app.wait_for("Count: 1").expect("local interaction");
        retired = Some((
            app.engine().control(),
            app.screen()
                .press_target("role:button[Try]")
                .expect("press selector")
                .expect("press target"),
        ));
        drop(app);
    }
}

#[test]
fn captured_runtime_denies_network_and_string_code_generation() {
    let source = r#"
import {Text, signal} from 'nsh';
export default function Artifact() {
  const result = signal('Checking');
  fetch('https://artifact.invalid/').then(
    () => result.set('NETWORK WAS ALLOWED'),
    e => result.set(e.code),
  );
  return <Text>{`${result()}|eval:${typeof globalThis.eval}`}</Text>;
}"#;
    let mut app =
        Headless::start(artifact_runtime::config(captured(source)).expect("valid source"))
            .expect("isolated engine");
    app.wait_for("ERR_ACCESS_DENIED|eval:undefined")
        .expect("deny-all policy and hardening");
}

#[test]
fn captured_component_errors_stay_inside_the_preview_boundary() {
    let source = "export default function Artifact() { throw Error('Preview fixture failed'); }";
    let mut app =
        Headless::start(artifact_runtime::config(captured(source)).expect("valid source"))
            .expect("isolated engine");
    app.wait_for("This artifact stopped with an error.")
        .expect("existing error boundary");
    app.wait_for("Preview fixture failed")
        .expect("actionable local error");
}

#[test]
fn captured_module_startup_errors_are_visible_without_entering_the_parent() {
    let source = "throw Error('Startup fixture failed'); export default () => null;";
    let mut app =
        Headless::start(artifact_runtime::config(captured(source)).expect("valid source"))
            .expect("isolated engine");
    app.wait_for("This artifact could not start: Error: Startup fixture failed")
        .expect("module evaluation error is visible");
}

#[test]
fn captured_runtime_rejects_wrong_identity_and_host_imports_before_execution() {
    let mut input = captured("export default () => null;");
    input.source.push(' ');
    assert!(artifact_runtime::config(input).is_err());
    // A compiled entry is reused only for the exact verified bytes: other
    // source claiming the same digest is refused, never served from the cache.
    let cached = captured("export default () => null;");
    assert!(artifact_runtime::config(cached.clone()).is_ok());
    let mut swapped = captured("export default () => 'other';");
    swapped.source_sha256 = cached.source_sha256;
    assert!(artifact_runtime::config(swapped).is_err());
    for source in [
        "import {Bridge} from 'pilot-day/native'; export default () => Bridge;",
        "import {ArtifactExport} from 'pilot-day/native'; export default () => new ArtifactExport();",
        "import {host} from 'nsh'; export default () => host;",
        "import {Clipboard} from 'nsh'; export default () => Clipboard;",
        "import {Storage} from 'nsh'; export default () => Storage;",
        "import {openUrl} from 'nsh'; export default () => openUrl;",
        "import {Link} from 'nsh/base'; export default () => Link;",
        "import {Terminal} from 'nsh/base'; export default () => Terminal;",
        "import {mountArtifact} from 'pilot-artifact/ui'; export default () => mountArtifact;",
        "import {readFile} from 'fs/promises'; export default () => readFile;",
        "export default () => import('process');",
    ] {
        assert!(
            artifact_runtime::config(captured(source)).is_err(),
            "{source}"
        );
    }
}

#[test]
fn the_bundled_prototype_example_switches_variants_with_choices() {
    let source = include_str!(
        "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/prototype.tsx"
    );
    let config =
        artifact_runtime::config(captured(source)).expect("the prototype example compiles");
    let mut app = Headless::start(config).expect("separate artifact engine");
    app.wait_for("A: one banner above the list. The list stays as it was.")
        .expect("first variant");
    app.press("role:button[B · Inline row]")
        .expect("Choices option");
    app.wait_for("B: the failed row opens in place with what happened.")
        .expect("second variant");
}

#[test]
fn artifacts_may_use_base_components_and_type_imports() {
    let source = r#"
import {type Accessor, Text, View, signal, computed, effect} from 'nsh';
import type {SelectProps} from 'nsh/base';
import {Checkbox, Collapsible, Input, Progress, Select, Switch, Tab, Tabs, Tooltip} from 'nsh/base';
import {Choices, Page} from 'pilot-artifact/ui';
export default function Artifact() {
  const on = signal(false);
  const label: Accessor<string> = computed(() => (on() ? "On" : "Off"));
  effect(() => label());
  return <Page title="Base components">
    <Choices label="Size" options={[{id: "s", label: "Small"}, {id: "l", label: "Large"}]} value="s" onChange={() => {}} />
    <Switch checked={on()} onChange={(v: boolean) => on.set(v)} accessibilityLabel="Power" />
    <Text>{`State: ${label()}`}</Text>
  </Page>;
}"#;
    let config = artifact_runtime::config(captured(source)).expect("base components are allowed");
    let mut app = Headless::start(config).expect("separate artifact engine");
    app.wait_for("State: Off").expect("rendered");
}

#[test]
fn a_large_mock_switches_variants_and_a_runaway_one_stops_at_the_node_limit() {
    // Three variants of a few hundred rows each: far past the old 256-node limit.
    let source = r#"
import {Text, View, signal} from 'nsh';
import {Button} from 'nsh/base';
const rows = Array.from({length: 400}, (_, i) => i);
export default function Artifact() {
  const variant = signal('A');
  return <View>
    <Button onPress={() => variant.set('B')}><Text>Variant B</Text></Button>
    <Text>{'Showing ' + variant()}</Text>
    {rows.map((i) => <View><Text>{variant() + ' row ' + i}</Text></View>)}
  </View>;
}"#;
    let mut app =
        Headless::start(artifact_runtime::config(captured(source)).expect("valid source"))
            .expect("isolated engine");
    app.wait_for("A row 0").expect("large first screen");
    app.press("role:button[Variant B]")
        .expect("still interactive");
    app.wait_for("B row 0").expect("second variant drawn");
    assert!(app.shows("Showing B"), "the preview kept running");

    let runaway = format!(
        r#"
import {{Text, View}} from 'nsh';
const rows = Array.from({{length: {}}}, (_, i) => i);
export default () => <View>{{rows.map((i) => <Text>{{'row ' + i}}</Text>)}}</View>;"#,
        artifact_runtime::MAX_NODES + 1
    );
    let mut app =
        Headless::start(artifact_runtime::config(captured(&runaway)).expect("valid source"))
            .expect("isolated engine");
    let stopped = app.wait_for("Never shown").err().unwrap_or_default();
    assert!(
        stopped.contains("nodes"),
        "a runaway mock stops at the node limit: {stopped}"
    );
}
