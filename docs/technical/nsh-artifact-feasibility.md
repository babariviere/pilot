# Agent-authored NSH artifacts: bounded feasibility

Status: source audit and isolated probes, **not a production artifact runtime**.
Those checkpoints added no publication API, stored kind or viewer. The later
[captured source foundation](nsh-artifact-source.md) keeps execution refused.
The existing Day source reader stays inert. Focused local execution on
macOS arm64 now supplies the limited observations below. Source findings and
headless results are **not production isolation or native acceptance**.

## Question and method

Can unmodified, tagged NSH execute agent-authored TSX with native controls and
local state, while denying host access and keeping Day safe from hostile code?

The audited runtime is longbridge/nsh **v0.5.0**, peeled commit
`f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`. The installed CLI reports
`nsh 0.5.0 (f4d68f7)`. Day's Cargo lock pins the matching crates.io archives;
their `.cargo_vcs_info.json` names that commit. Earlier v0.4 shader references
are not current qualification. Source references below mean files at that
exact upstream commit, also available in the locked published crate sources.

The macOS-only probes live in `apps/day/native/tests/artifact_feasibility.rs` and
`tests/fixtures/artifact-feasibility/` beneath that crate. They use only released
NSH interfaces. They do not import the Day registry, native Bridge, daemon,
credentials or artifact reader. Every probe runs in a private subprocess with
a 30-second parent deadline. On timeout or parent-test unwinding, the parent
kills and waits for its owned process group, then removes its temporary tree.
This test supervisor is **not** a proposed production sandbox.

## Existing artifact path (observed in repository source)

| Boundary | Current contract to preserve |
| --- | --- |
| `packages/kernel/src/artifact-tools.ts` | One create/update/get/list tool. Writes allow image/shader/visual, not TSX. Source is at most 512 KiB UTF-8 except images. Local image file loading is a separate, permission-checked host operation; Ask forbids it. |
| `packages/artifacts/src/store.ts` | UUID identity and session/project ownership. Serialized writes. Numbered JSON revision is flushed before the atomic latest summary. Update supports `expectedRevision`; failed preparation does not publish. Explicit old revisions remain readable. |
| `packages/artifacts/src/stored-revision.ts` | Passive exact-container read: 4 KiB pointer, 1 MiB numbered container, stable files, no final symlink, identity/revision checks. Container bytes are not pre-publication submission bytes. It supports only existing stored kinds. |
| `packages/daemon/src/delivered-artifact.ts` | Exact delivery/owner/source/artifact/revision and current membership fences, checked again after I/O. No latest fallback or worker wake. |
| `apps/day/native/src/host/delivery_artifact.rs` and `apps/day/deliveryArtifact.ts` | Exact read-only selection. Source text only, images metadata-only, `rendering: "unsupported"`. No assets, callback evaluation or acceptance. |
| `apps/day/deliveryView.ts` | Inspect source is explicit. Selection/generation changes hide stale content. Source is not saved in the window state or run on cold reopen. |

See [captured result reads](day-captured-artifacts.md) and
[retained acquisition](retained-artifact-acquisition.md). The latter is a
review-authority path, not permission for a preview. Legacy readers must not
be repurposed to execute historical HTML/React/SwiftUI/visual callbacks.

Existing captured/stored/store/render-lifecycle regressions cover the canonical
storage path, not an NSH runtime. No existing artifact bytes or publication
behavior changed. Earlier storage checks predated the lint-only policy; they
do not qualify the new probes or native rendering.

## Upstream loader and isolation (source findings)

1. **Separate VM is supported.** `nsh-engine/src/lib.rs` exposes
   `Bundle::source`, `EngineConfig`, `Policy` and `Engine`. Each JS surface has
   its own QuickJS runtime. Never load artifact code into Connected's VM or
   give its registry/channel to the artifact. A separate VM is not a process
   or native-memory fault boundary.
2. **Deny must be explicit twice.** `Policy::default()` has `declared: None`,
   which means broad legacy defaults, not deny-all. The probes override both
   `declared` and `granted` with `Capabilities::default()`, and `harden: true`.
   The compiler's manifest is not the host grant. No native services, storage,
   data directory or assets are installed. This setup is not itself evidence
   that every route denies access.
3. **Runtime imports are not filesystem imports.** `nsh-js/src/modules.rs`
   resolves registered native modules and supplied bundle chunks. Its loader
   refuses other names. `chunks.rs` rejects directory/URL/escape chunk names.
   However, a registered Rust module exposes its exports; do not register
   Day/native exports and expect the general capability declaration to hide
   those functions. Do not attach host params/events carrying private data.
4. **Source compilation is a different trust boundary.**
   `nsh-testing::compile_tsx` uses the filesystem-based bundler and compiles
   bytecode locally. It is not a captured-source loader or file-permission
   checker. Parent imports and symlink re-exports are explicit probes using
   only owned canary files. Asset-root checks in `nsh-bundler/src/plugin.rs`
   do not establish a source-import root boundary.
5. **Never accept authored bytecode.** `Bundle::bytecode` is unsafe: QuickJS
   does not validate crafted bytecode. Any future cached bytecode must come
   from a trusted matching compiler over captured bytes, not agent input.
   `compile_tsx` makes development bundles; it is convenient test machinery,
   not the selected production compilation contract.
6. **Interpreter limits exist.** `nsh-core/src/js/limits.rs` and
   `nsh-js/src/sandbox.rs` implement heap, stack, load/call time, pending-op,
   canvas-op and core-node ceilings. Standalone/dev-without-limits uses
   unlimited heap/time/node defaults. The probes explicitly select a 16 MiB
   JS heap, 512 KiB stack, 250 ms load, 100 ms call, 4096 pending ops,
   1024 canvas ops and 256 nodes. These are experiment settings, not product
   limits. Time checks interrupt interpreted JS, not arbitrary native work.
7. **Credentials need a real denial check.** `process.env` is not the entire
   host environment. `nsh-core/src/access.rs` uses a built-in metadata
   allowlist plus explicit grants. Deny-all still exposes allowlisted
   language/terminal/platform metadata. Do not call it an empty environment.
   No actual secrets are read in these probes.
8. **Engine disposal joins.** `Engine::drop` sets shutdown/interrupt state and
   joins its thread. Quit listeners have a separate short grace period.
   This does not interrupt an arbitrary native compiler or GPU driver call.
   A stale control handle targets the old engine, not a new revision's engine.

Upstream source: [engine](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-engine/src/lib.rs),
[limits](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-core/src/js/limits.rs),
[VM sandbox](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-js/src/sandbox.rs),
[module loader](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-js/src/modules.rs),
[chunks](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-js/src/chunks.rs).

## Shader findings and blockers

Native WGSL support is real, but it is not artifact qualification. The locked
`nsh-core/src/shader.rs` checks 64 KiB source, 4096-byte uniforms, no custom
bindings/resources/entry points, and Naga validation. The core shader cache
keeps at most 64 entries. The renderer caps a frame side at 4096 pixels,
skips pending frames, handles absent GPUs and has pause/visibility behavior.
These are useful individual limits, not a whole-preview resource budget.

Two precise gaps prevent claiming hostile shader safety in the current host:

- **No per-artifact shader capability gate.** `Capabilities` has no shader
  permission. A denied bundle can still create a shader and request backdrop
  inputs. The probe only observes the compiled layer, never samples any app
  pixels. Same-surface embedding must not let it sample Day. Setting the
  environment's shader-support flag is not a permission boundary.
- **No artifact-owned GPU execution deadline.** WGSL can contain very costly
  loops. `nsh-engine/src/shader.rs` explicitly relies on the OS GPU watchdog
  for infinite shaders. JS call budgets cannot stop that work. The expensive
  shader probe validates source only and never submits it to a GPU.

Native allocations are also outside the JS heap ceiling. For example,
`nsh-js/src/dom.rs::push` counts pending operations, not their payload bytes;
`nsh-core/src/core/mod.rs` keeps text strings supplied by `CreateText`.
Repeated copies of one JS value can occupy native memory without counting
against that heap. `Limits` is not a total native/GPU memory quota. This is a
source finding, not a measured OOM or a demonstrated native exploit.

Sources: [shader validation](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-core/src/shader.rs),
[renderer](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-engine/src/shader.rs),
[macOS pictures/lifecycle](https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/crates/nsh-platform-macos/src/shader.rs).

No GPU was opened for hostile work. Actual bounded native drawing,
pause/dispose, reduced-motion fallback, device loss and recovery remain
unqualified. Basic controls in the example do not depend on shaders. No fork,
cache edit, WebView, VM containment or replacement architecture is proposed.

## Probe coverage and limits

The focused local command uses the supported MBX wrapper/global cache and the
unchanged locked NSH 0.5.0 dependencies. It opens no native window or GPU
renderer. A 30-second process deadline limits each whole probe in addition to
the VM budgets. Temporary input is generated under the OS temp directory and
removed after the owned child is reaped. This supervisor covers only these
known test programs, not arbitrary native children or a production sandbox.

### Executed findings (2026-11-13, macOS arm64)

**Final result: 12 passed, 0 failed**, including each supervised child, in
1.50 seconds after compilation. The supported MBX command below used the
locked dependencies; only the test target and required dependencies were built.
The source/fixture/documentation started unchanged from checkpoint
`265749dc1badac8dd3994127762b321f20070759`. Repairs changed only this probe
target and this document, not NSH, manifests, production code or CI selection.
Execution used repository base `41b59b2bce0d04ebe38f01d08d957d1eca012c82`.
Before publication, upstream `57820b54` changed Day's SHA-2/base64 dependency
requirements. This evidence was rebased without changing those upstream edits;
the focused result does not claim to verify that dependency update. The pinned
NSH version and these probe sources were unchanged by it; new-head coverage
remains with CI.

The original checkpoint compiled and ran all 11 tests: 8 passed, 3 failed.
There was no Rust compiler failure. The failures exposed probe/fixture defects:

- The denial-result text starts with `exit:`. Headless treated that as a
  selector prefix; the probe now explicitly uses `text:`.
- After that selector repair, the next run exposed the obsolete raw import
  `nsh/host`. NSH 0.5.0 serves `host` from `nsh`; the probe now uses that
  public export. The missing module was not an observed denial.
- A bare internal text node did not appear as a paragraph in Headless. The
  result now uses public `Text`. That exposed the actual host result:
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when no host is advertised, not a
  permission denial. The probe distinguishes absent-host and advertised-host
  configurations without installing a handler or real channel.
- Heap exhaustion first reports `Uncaught`, then `Stopped`. Taking only the
  first report falsely rejected the stop. Heap/op/node probes now wait for
  the actual `Stopped` report and assert the specific reason.
- The recursive promise chain holds promises. It exhausted the 16 MiB heap
  before the time budget; it cannot prove a promise time interrupt. That
  case is separate from the load/timer time-budget assertions.

| Boundary | Observed result and limit |
| --- | --- |
| TSX controls and comparison | Local count and alternative changed; reopening the same compiled bundle reset local state. Headless behavior only, not appearance/input acceptance. |
| Old identity/bytes | Old event/control handles did not change the replacement VM; a compiled first source still showed first after the input file changed. No canonical stored-revision binding was implemented. |
| Capability calls | File read, fetch, process run, process exit and global process spawn returned `ERR_ACCESS_DENIED`, not missing-file, DNS, TypeError or transport errors. An unadvertised host returned `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; advertising a host (no handler/channel) instead produced `ERR_ACCESS_DENIED`. No real host action was dispatched. Only harmless nonexistent file/network/command targets were used. |
| Source/module failures | Malformed source, unknown exports, absent Day module, file/HTTPS module imports and string-code constructors failed. Missing APIs/import resolution are not capability-denial evidence. |
| Compiler imports | Owned parent-file imports and symlink re-exports compiled; missing import and malformed TSX failed. The compiler is demonstrably not a capture-root boundary. |
| Shader source | Oversized/invalid WGSL failed; expensive valid WGSL compiled. A deny-all engine emitted a backdrop shader layer. No GPU work or pixel sampling occurred. |
| Load and timer loops | The nested catch/load loop reported the 250 ms load-budget interrupt; the timer loop reported the 100 ms call-budget interrupt. This is not a native-code deadline. |
| Promise recursion | The growing promise chain reached the JS heap ceiling and emitted `Stopped`, not a measured promise time-budget interrupt. The probe accepts either specific stop boundary without attributing heap exhaustion to time. |
| Heap, pending operations and nodes | Separate fixtures emitted `Stopped` with out-of-memory, more than 4096 changes, and more than 256 nodes respectively. Native/GPU payload bytes remain outside the heap quota. |
| Disposal | Dropping after the fixture's first `armed` timer report joined within 2 seconds despite a 10-second call budget. The second spinning timer is pending or running; its entry is not acknowledged, so this does not prove interruption of an already-entered spin. |

These observations come from execution, not from the initial failed assertions.
A missing service, TypeError, transport/DNS error or timeout never counts as an observed
`ERR_ACCESS_DENIED`. No real credential was read, and no environment secrecy
guarantee is established by these probes.

The parent test runner survived the hostile fixtures and continued to subsequent
tests. Children exited and were reaped; temporary-tree removal did not fail.
The 30-second watchdog kill path was not triggered, so its presence is a source
safeguard, not an observed timeout/recovery qualification. Existing non-host
library dead-code and linker unwind-size warnings do not qualify or invalidate
these headless observations; native exception/performance acceptance is outside
this target.

The existing `.github/workflows/day-qualification.yml` selects this exact test
target after its library tests. It runs on macOS arm64 against the same locked
NSH dependencies. The selected CI command is:

```sh
apps/day/scripts/cargo test --locked --manifest-path apps/day/native/Cargo.toml --test artifact_feasibility -- --test-threads=1
```

Only this affected test target and file formatting run locally under the focused
test policy. No full suite, NSH check, broad typecheck, app rebuild or visible
window is part of this qualification. Broader tests remain in CI; no CI result
is inferred or polled. Even passing this target does not establish native/GPU
memory quotas, compiler containment, hostile GPU deadlines, credential secrecy,
all capability routes, process fault isolation or production/native acceptance.

The fixture is a behavioral example, not a viewer design or visual acceptance.
It owns local signals. Closing/disposal loses them; reopening the same compiled
input starts fresh. Comparing an alternative changes only a local label, not
an acceptance, verdict, applied change, stored revision or host intent. Source
changes do not silently update an already compiled input. A future runtime
must bind those bytes and handlers to canonical revision identity and dispose
the old engine before replacement; these probes do not implement that binding.

## Deferred choices, not new contracts

**Source files:** a permission-checked host capture of self-contained source and
assets fits the existing artifact publication/revision model better than live
links. It still needs exact-byte capture, import/dependency allowlisting,
escape/symlink refusal, size/count limits, compiler containment and provenance.
Runtime code receives no filesystem grant. This slice adopts no source-import
API and no new persisted representation.

**Comparison:** one artifact with local named alternatives needs no new tracker
and makes paired inspection simple; linked pinned artifacts let each alternative
have its own independent history. Neither represents the prototype question or
verdict automatically. Selection is not acceptance or implementation promotion.
No variant policy or schema is selected here.

Keep production rendering unsupported until the required isolation/resource
properties have evidence. Inert source/history readers remain available.
