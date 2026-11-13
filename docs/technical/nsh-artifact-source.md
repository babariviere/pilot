# Captured NSH source foundation

This is the production **source capture, revision and compiler boundary**, not
an enabled interactive preview. Authored JavaScript is never executed by this
path. Every prepared result still says `rendering: "unsupported"`. Existing
visual/Mermaid publication and all historical readers remain available.

## Publication and exact bytes

The existing `artifact` tool offers `kind: "nsh"` only when its host has a
capture binding. An agent writes one UTF-8 `.tsx` file in its own session's
`scratch/artifacts/`, then passes `sourcePath` (a basename or an absolute path
inside that directory). The request cannot select a source root, executable,
module resolver, credentials or bytecode. Ask does not offer file capture.
An update must name the current `expectedRevision`. NSH identities cannot
change kind. The tool reports that source was saved, not that a preview ran.

`captureNshSource` limits source to 512 KiB before allocation. Linux opens
directories through owned `/proc/self/fd` descriptors. macOS cannot traverse
`/dev/fd/<directory>/child`, so it uses the ordinary unprivileged native helper's
`openat` path instead. Both paths open each untrusted directory and the final
file with `O_NOFOLLOW`; files must be regular with one hard link. They reject
directory traversal, symlinks, invalid UTF-8, changing file metadata, missing
files, cancellation and oversized source. No filesystem bundler runs. Capturing
an import statement does not read its target. The session root comes from the
trusted worker spec, under the existing Build file authority, not artifact code.
The host supplies a canonical absolute root: each root component is walked with
no-follow directory handles. The selected root, scratch and artifacts directories
must belong to the effective user and must not be group/world writable. Aliases
are refused, not resolved as a path-check fallback.

The captured string round-trips exact UTF-8, including BOM, CRLF and Unicode.
`ArtifactStore` reuses its UUID, ownership, serialized writes, immutable numbered
JSON revisions, durable latest pointer and conflict rules. Each NSH revision
keeps `nsh` metadata: API 1, pinned runtime name, basename, source SHA-256 and
UTF-8 length. These identify saved bytes, not rendering or acceptance. The
prepared HTML is empty. The complete numbered container must also fit the
existing 1 MiB passive-read limit, including JSON escaping; it is never truncated.

Explicit reopen verifies the metadata against source bytes. Earlier revisions
do not follow edits to the scratch file or inherit later state. The existing
exact delivery/member/owner pin reader can return NSH as inert source. It still
returns `rendering: "unsupported"`, not compiled code, assets or callbacks.

## Compiler and lifetime

`prepareNshRevision` accepts one saved `ArtifactRevision`, not a live file. It
calls the fixed native source host with its exact ID, owner, revision, source,
entry, digest and length. The result must echo that identity and remain
Unsupported. The helper never mounts a component or constructs a JS VM.

The source host validates those pins and uses OXC's TSX AST to reject local,
remote, dynamic, default and namespace imports, import metadata/attributes,
TypeScript import aliases/types and module re-exports. A default component
export is required. Only named imports from the explicit `nsh`, `nsh/base` and
trusted `pilot-artifact/ui` export lists are prepared. The agent cannot import
`mount`, host, filesystem/process modules, Day/native, shaders or raw `nsh:rt`.
The host then uses pinned unmodified NSH 0.5.0 `compile_module` on the in-memory
string. It does not use `bundle`, `nsh.json`, aliases, package discovery or a
filesystem resolver. Output is at most 2 MiB. Syntax diagnostics name virtual
`Artifact.tsx`, with line/UTF-16 column; other compiler diagnostics are limited
to 4096 characters. This is not full TypeScript typechecking or module linking.

The helper API has exactly Ensure, Capture and Compile. Unknown actions/fields,
including authored bytecode, fail. Its Node transport inherits no environment,
limits request/response to 4 MiB, permits at most two active helper calls per
worker process, and kills on abort, output overflow or a five-second deadline.
A call settles, and frees its slot, only on process close: the helper has exited,
Node has reaped it and its pipes have closed. Callers keep their inputs and
cleanup until then. A complete reply written before an abort is still refused.
Close proves the direct helper joined, not a descendant subtree. The fixed helper
does not spawn children or evaluate authored code. These are source-host
safeguards, **not** a production native renderer sandbox or a total memory quota.

Abrupt loss of the owning worker is an open gate. Nothing then joins the helper,
and it has no deadline of its own. From the code, it should see end of input,
finish its limited work and fail to write to the closed pipe. This is not tested.

There is no stateful preview in this increment. Existing example signals remain
local to a future admitted engine; reopening/replacing a revision must dispose
the old engine and start fresh. Prepared code is not passed into Connected's VM,
and successful preparation does not run historical callbacks or accept a design.

## Scratch cleanup

Archive, idle maintenance and restart no longer remove scratch. Explicit
workspace reclaim uses the existing admission/maintenance serialization,
quiescence and child checks, closes the kernel, then removes that session's
scratch. A repeat explicit cleanup can remove scratch even if automatic
retention already reclaimed the workspace. Automatic retention can still
reclaim a workspace, but leaves scratch alone.

Publication/capture stays within the worker's busy tool lifetime. Capture's
handles and helper process close before the tool returns. Compilation uses a
copy of published bytes, never scratch. No production preview is admitted, so
there is no live preview pin to bypass. Any later preview lifecycle must join
its owned work before participating in cleanup. Published `artifacts/` revisions,
original history and workspace recovery records are outside scratch and survive.
Shared coordinator-main views retain their existing explicit-reclaim refusal;
this is not a new coordinator workspace deletion command. No current user
scratch or workspace was removed while implementing this behavior.

## Availability and remaining gates

The native target is `pilot-artifact-host` with the `artifact-host` feature.
The kernel looks only for the trusted installed code location
`packages/artifacts/native/pilot-artifact-host`, relative to its own module.
It never accepts an executable path from a tool/artifact, nor searches PATH or
scratch. The Day-only immutable input recipe now builds this fourth native
executable through the supported Cargo/MBX wrapper and checks its compiled
source/recipe identity through its existing source-only Compile operation.
No new helper command or authored JS execution is added.

The existing recipe calls the existing Node `callArtifactHost` transport directly
with fixed benign source and an 8 KiB response allowance. It reuses the same
empty environment, strict identity/protocol checks, deadline and joined exit;
there is no separate Python process supervisor or staging wrapper. Outside an
archived build, the transport module must match the requested Git source exactly.

Only assembly with explicit Day NSH resources copies it into runtime. The existing
native closure/signing/inventory covers it; a binding records the final signed
bytes before the unchanged outer app seal. GPUI assembly and release selection
do not gain it. Connected-only candidates still contain no daemon runtime and
therefore no source-helper binding. Packaging tests use synthetic inputs, not
actual signing/native acceptance.
The assembler compares the copied helper with the captured manifest digest and
size, not a later read of potentially changed input. It then uses the existing
native signing/inventory and writes one final binding. It does not re-run the
identity probe on the identical copy or after the trusted signing operation.

Before offering capture, the kernel checks the fixed binding against runtime
source and streams the helper's exact bytes in 64 KiB chunks. A per-process
stat/identity cache avoids hashing unchanged bytes on every call. It also checks
the helper's compiled identity with fixed benign source before Ensure can touch
session storage; every later reply must match it. These checks supplement the
existing verified app/runtime closure, not replace signatures or grant trust to
a loose local helper. First-use hashing adds startup I/O; a genuine signed-bundle
latency measurement remains outstanding.

If that installed binding is absent or fails checks, macOS does not offer sourcePath
publication. An unavailable or unsafe scratch setup also disables this optional
publication path without preventing the rest of the session from opening.
Actual source-matched packaging/signature qualification remains a gate; this
implementation does not assemble/install or change an existing app/runtime.
Test-only helper selection is not authority
to bind an installed executable.

The supplied summary, chart, flow and sequence examples are checked as captured
modules, not linked/running kit acceptance. The mockup's `LayoutAnimation` import
remains outside this first preparation list. The trusted kit has not been loaded
in a production artifact VM. Its local development alias is not a production
resolver. No missing helper/export silently falls back to filesystem loading.

Execution stays hard-refused because the earlier audit's native/GPU memory,
fault-containment, active-spin disposal and shader enforcement limitations are
not resolved. An AST import list is **not** a sandbox. A separate QuickJS VM,
its heap/time settings, and configuration alone do not prove host survival.
Any later runtime entry must also explicitly set declared **and** granted
deny-all, with no inherited Day registry/channel/services. No shader or screen
sampling is enabled, and no privileged/VM containment architecture was added.
See [feasibility evidence and its limits](nsh-artifact-feasibility.md).

## Focused checks

```sh
node apps/day/scripts/test-artifact-source.mjs
node --test --test-name-pattern='NSH scratch' packages/daemon/src/session-workspaces-lifecycle.integration.test.ts
node --test --test-name-pattern='saved nsh' packages/daemon/src/delivered-artifact.test.ts
```

The first command builds only the helper through supported MBX/global cache,
then selects the directly affected capture/compiler/tool/transport cases. It
uses the actual Cargo-reported executable, not a guessed shared target path.
The existing Day CI invokes it too. Without that fixture binding, macOS native
capture cases report an explicit skip, not a pass. Broad suites, typechecking,
NSH checks, GUI builds, visible windows and live integrations are not part of
these checks. CI/native acceptance must not be inferred from publication.
