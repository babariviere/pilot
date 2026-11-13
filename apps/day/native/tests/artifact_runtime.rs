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
        assert_eq!(config.limits.memory_bytes, 16 << 20);
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
fn captured_runtime_rejects_wrong_identity_and_host_imports_before_execution() {
    let mut input = captured("export default () => null;");
    input.source.push(' ');
    assert!(artifact_runtime::config(input).is_err());
    for source in [
        "import {Bridge} from 'pilot-day/native'; export default () => Bridge;",
        "import {host} from 'nsh'; export default () => host;",
        "import {readFile} from 'fs/promises'; export default () => readFile;",
        "export default () => import('process');",
    ] {
        assert!(artifact_runtime::config(captured(source)).is_err());
    }
}
