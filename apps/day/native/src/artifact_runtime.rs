//! App-owned preview configuration. Captured source and trusted helper chunks
//! get a separate NSH engine, never the connected window's VM or host services.
use std::time::Duration;

use nsh_core::{access::Capabilities, element::description::SetDescription};
use nsh_engine::{Bundle, Chunk, EngineConfig, Limits, Policy};

use crate::artifact_source::CapturedSource;

// Fixed app sources, not a source resolver. Relative imports stay within these
// eight supplied chunks; the artifact compiler rejects authored file imports.
const KIT: &[(&str, &str, &str)] = &[
    (
        "index",
        "ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/index.ts"
        )),
    ),
    (
        "ui",
        "tsx",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/ui.tsx"
        )),
    ),
    (
        "charts",
        "tsx",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/charts.tsx"
        )),
    ),
    (
        "diagrams",
        "tsx",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/diagrams.tsx"
        )),
    ),
    (
        "check",
        "ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/check.ts"
        )),
    ),
    (
        "flow",
        "ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/flow.ts"
        )),
    ),
    (
        "sequence",
        "ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/sequence.ts"
        )),
    ),
    (
        "text",
        "ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/kit/text.ts"
        )),
    ),
];

/// Compile an exact captured revision for its own local-state-only engine.
/// Call off the UI thread. The app owns the engine and must join disposal off
/// the UI thread before replacing it. This function neither reads a path nor
/// starts an engine, opens a window, or changes the connected app's permissions.
///
/// # Errors
/// Returns source identity, syntax or import errors before any code executes.
pub fn config(captured: CapturedSource) -> Result<EngineConfig, String> {
    let prepared = crate::artifact_source::prepare(captured)?;
    let registry = nsh_base::registry();
    let descriptions: Vec<_> = registry
        .sets()
        .into_iter()
        .map(SetDescription::from)
        .collect();
    let mut chunks = Vec::with_capacity(KIT.len() + 2);
    for (name, extension, source) in KIT {
        let id = format!("pilot-artifact/kit/{name}");
        let code =
            nsh_bundler::compile_module(&format!("{id}.{extension}"), source, &descriptions)?;
        chunks.push(Chunk::source(id, code));
    }
    chunks.push(Chunk::source(
        "pilot-artifact/ui",
        "export * from 'pilot-artifact/kit/index';".into(),
    ));
    chunks.push(Chunk::source("artifact-entry", prepared.code));
    let bundle = Bundle::source(
        "import {Text} from 'nsh'; import {mountArtifact} from 'pilot-artifact/kit/ui'; import('artifact-entry').then(module => mountArtifact(module.default)).catch(error => mountArtifact(() => Text({children: 'This artifact could not start: ' + String(error)})));".into(),
    ).with_chunks(chunks).with_policy(Policy {
        harden: true,
        declared: Some(Capabilities::default()),
        granted: Some(Capabilities::default()),
    });
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = vec![registry];
    config.limits = Limits {
        memory_bytes: 16 << 20,
        stack_bytes: 512 << 10,
        load_budget: Duration::from_millis(250),
        call_budget: Duration::from_millis(100),
        max_op_values: 4096,
        max_canvas_ops: 1024,
        max_nodes: 256,
    };
    // EngineConfig::new installs no Day registry/context, host advertisement,
    // network, filesystem, assets, storage, paths, clipboard or window service.
    Ok(config)
}
