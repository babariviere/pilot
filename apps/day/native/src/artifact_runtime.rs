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
// eight supplied chunks and Day's library (`artifact_library`); the artifact
// compiler rejects authored file imports.
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

/// The fixed trusted chunks: the kit with its `pilot-artifact/ui` facade and
/// Day's library (`artifact_library::chunks`), compiled once per process.
fn trusted() -> Result<&'static [(String, String)], String> {
    static CODE: OnceLock<Result<Vec<(String, String)>, String>> = OnceLock::new();
    CODE.get_or_init(|| {
        let descriptions: Vec<_> = nsh_base::registry()
            .sets()
            .into_iter()
            .map(SetDescription::from)
            .collect();
        let mut chunks = KIT
            .iter()
            .map(|(name, extension, source)| {
                let id = format!("pilot-artifact/kit/{name}");
                let code = nsh_bundler::compile_module(
                    &format!("{id}.{extension}"),
                    source,
                    &descriptions,
                )?;
                Ok((id, code))
            })
            .collect::<Result<Vec<_>, String>>()?;
        chunks.push((
            "pilot-artifact/ui".into(),
            "export * from 'pilot-artifact/kit/index';".into(),
        ));
        chunks.extend(crate::artifact_library::chunks(&descriptions)?);
        Ok(chunks)
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
/// The trusted chunks compile once per process and recent entries are reused by source
/// SHA-256; each call still verifies the exact source and builds a fresh config.
///
/// # Errors
/// Returns source identity, syntax or import errors before any code executes.
pub fn config(captured: CapturedSource) -> Result<EngineConfig, String> {
    config_for(entry(&captured)?)
}

/// The engine configuration for an entry `compile_source` has just compiled.
/// Same trusted chunks, bootstrap, policy, UI sets and limits as a saved
/// revision gets. The bootstrap gives the preview Day's theme first, so token
/// classes and fonts resolve as in the app.
///
/// # Errors
/// Returns trusted chunk compile errors before any code executes.
pub fn config_for(code: String) -> Result<EngineConfig, String> {
    let registry = nsh_base::registry();
    let trusted = trusted()?;
    let mut chunks = Vec::with_capacity(trusted.len() + 1);
    for (id, code) in trusted {
        chunks.push(Chunk::source(id.clone(), code.clone()));
    }
    chunks.push(Chunk::source("artifact-entry", code));
    let bundle = Bundle::source(format!(
        "import {{Text, setTheme}} from 'nsh'; import {{mountArtifact}} from 'pilot-artifact/kit/ui'; setTheme({}); import('artifact-entry').then(module => mountArtifact(module.default)).catch(error => mountArtifact(() => Text({{children: 'This artifact could not start: ' + String(error)}})));",
        crate::artifact_library::THEME.trim()
    )).with_chunks(chunks).with_policy(Policy {
        harden: true,
        declared: Some(Capabilities::default()),
        granted: Some(Capabilities::default()),
    });
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = vec![registry];
    config.limits = limits();
    // EngineConfig::new installs no Day registry/context, host advertisement,
    // network, filesystem, assets, storage, paths, clipboard or window service.
    Ok(config)
}

/// The UI nodes one preview may keep. It protects Day's memory: each node may
/// have a native view, which the heap limit does not cover. A large mock (three
/// variants of a full page, a table of a few hundred rows) keeps a few thousand;
/// 10,000 leaves room for that and still stops a loop that makes views without
/// end. Going over it stops the preview, which then says so and can start again.
pub const MAX_NODES: usize = 10_000;

/// The limits of one artifact preview's engine. Day keeps at most four previews
/// open (`MAX_PREVIEWS`), so the sums stay within what NSH gives one embedded
/// app by default (256 MiB heap). The engine runs on its own thread: a slow
/// call does not freeze Day, so time limits only stop code that never ends.
pub fn limits() -> Limits {
    Limits {
        // 64 MiB × 4 previews = NSH's default heap for one embedded app.
        memory_bytes: 64 << 20,
        // Deep recursion becomes a RangeError, well below the engine thread's 8 MiB stack.
        // Three saved 700-850 line mocks overflowed 512 KiB in a debug build and render at
        // 1 MiB; release frames are smaller. NSH's own default is 4 MiB.
        stack_bytes: 1 << 20,
        // Evaluating the kit and the mock once; a correct mock takes a few ms.
        load_budget: Duration::from_secs(2),
        // One event with the drawing it causes, such as a switch to another
        // variant that draws thousands of nodes.
        call_budget: Duration::from_secs(1),
        // Changes queued at once, held outside the heap. NSH's defaults allow
        // 40 per node; the same ratio keeps a full redraw of MAX_NODES possible.
        max_op_values: MAX_NODES * 40,
        // One canvas drawing: a dense chart of some thousand marks with labels.
        max_canvas_ops: 50_000,
        max_nodes: MAX_NODES,
    }
}
