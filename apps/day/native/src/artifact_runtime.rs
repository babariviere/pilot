//! App-owned preview configuration. Captured source and trusted helper chunks
//! get a separate NSH engine, never the connected window's VM or host services.
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
    time::Duration,
};

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

/// How many compiled entries the process keeps, newest last.
const CACHED_ENTRIES: usize = 8;

/// The fixed kit chunks, compiled once per process.
fn kit() -> Result<&'static [(String, String)], String> {
    static CODE: OnceLock<Result<Vec<(String, String)>, String>> = OnceLock::new();
    CODE.get_or_init(|| {
        let descriptions: Vec<_> = nsh_base::registry()
            .sets()
            .into_iter()
            .map(SetDescription::from)
            .collect();
        KIT.iter()
            .map(|(name, extension, source)| {
                let id = format!("pilot-artifact/kit/{name}");
                let code = nsh_bundler::compile_module(
                    &format!("{id}.{extension}"),
                    source,
                    &descriptions,
                )?;
                Ok((id, code))
            })
            .collect()
    })
    .as_deref()
    .map_err(Clone::clone)
}

/// The compiled entry for an exact, verified source. Keyed by the source's
/// SHA-256, which `verify` has just checked against the bytes. The cache keeps
/// compiled code only: never an engine, its state or any grant.
fn entry(captured: &CapturedSource) -> Result<String, String> {
    static ENTRIES: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());
    crate::artifact_source::verify(captured)?;
    let key = &captured.source_sha256;
    {
        let mut entries = ENTRIES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(at) = entries.iter().position(|(k, _)| k == key) {
            let hit = entries.remove(at).expect("position is in range");
            let code = hit.1.clone();
            entries.push_back(hit);
            return Ok(code);
        }
    }
    let code = crate::artifact_source::compile_source(&captured.source, &captured.entry)?;
    let mut entries = ENTRIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !entries.iter().any(|(k, _)| k == key) {
        entries.push_back((key.clone(), code.clone()));
        if entries.len() > CACHED_ENTRIES {
            entries.pop_front();
        }
    }
    Ok(code)
}

/// Compile an exact captured revision for its own local-state-only engine.
/// Call off the UI thread. The app owns the engine and must join disposal off
/// the UI thread before replacing it. This function neither reads a path nor
/// starts an engine, opens a window, or changes the connected app's permissions.
/// The kit compiles once per process and recent entries are reused by source
/// SHA-256; each call still verifies the exact source and builds a fresh config.
///
/// # Errors
/// Returns source identity, syntax or import errors before any code executes.
pub fn config(captured: CapturedSource) -> Result<EngineConfig, String> {
    let code = entry(&captured)?;
    let registry = nsh_base::registry();
    let mut chunks = Vec::with_capacity(KIT.len() + 2);
    for (id, code) in kit()? {
        chunks.push(Chunk::source(id.clone(), code.clone()));
    }
    chunks.push(Chunk::source(
        "pilot-artifact/ui",
        "export * from 'pilot-artifact/kit/index';".into(),
    ));
    chunks.push(Chunk::source("artifact-entry", code));
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
