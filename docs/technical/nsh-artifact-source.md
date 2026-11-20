# Captured NSH source foundation

The artifact tool captures and compiles source, then runs it once headless the
way Day's preview would (see [Publish-time check](#publish-time-check)). The native
Day app offers a separate local-state-only preview of saved NSH revisions.
Passive readers still return source with `rendering: "unsupported"`; that wire
value is not authority to execute code. Historical readers still return saved
source; Day does not run legacy native visuals.

## Publication and exact bytes

The existing `artifact` tool offers `kind: "nsh"` only when its host has a
capture binding. An agent writes one UTF-8 `.tsx` file in its own session's
`scratch/artifacts/`, then passes `sourcePath` (a basename or an absolute path
inside that directory). The request cannot select a source root, executable,
module resolver, credentials or bytecode. Ask has no write tool, so in Ask the
request also carries the TSX as `source`: the artifact tool writes that one
basename into the session's own `scratch/artifacts/` (`O_NOFOLLOW`, a plain file
with one link, and a folder that resolves where the host created it), then
captures it the same way. This is the only file Ask writes; project files stay
read-only.
An update must name the current `expectedRevision`. NSH identities cannot
change kind. One helper call captures, compiles and runs the string once before
creating or updating a revision. Syntax/import errors and preview runtime errors
publish nothing and leave earlier revisions unchanged. Cancellation after
compilation also prevents publication. The tool result says what the preview
showed (`preview`) and warns about text with no room.

`captureNshSource` uses the same ordinary unprivileged native helper on Linux
and macOS. Its `openat` path limits reads to 512 KiB and opens each untrusted
directory and final file with `O_NOFOLLOW`. Files must be regular, owned by the
effective user, not group/world writable, and have one hard link. It rejects
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
keeps `nsh` metadata: API 1, write-time runtime provenance, basename, source SHA-256 and
UTF-8 length. These identify saved bytes, not rendering or acceptance. The
prepared HTML is empty. The complete numbered container must also fit the
existing 1 MiB passive-read limit, including JSON escaping; it is never truncated.

Explicit reopen verifies the metadata against source bytes. Earlier revisions
do not follow edits to the scratch file or inherit later state. The existing
exact delivery/member/owner pin reader can return NSH as inert source, not
compiled code, assets or callbacks. Reopen checks API, entry, digest and byte
length, but does not compare runtime provenance with the installed app. New
revisions omit `nsh.rendering`; historical values stay readable and unchanged.
Neither field authorizes rendering or makes preview available.

## App-side preview preparation

`apps/day/native/src/artifact_runtime.rs` builds an isolated NSH engine
configuration from captured source. It reuses the source compiler and supplies
eight fixed, app-owned helper modules and Day's component library as in-memory
source chunks. It uses no filesystem resolver or authored bytecode. The bootstrap
gives the preview Day's theme (`setTheme` with `apps/day/theme.json`), then mounts
the default component through the existing helper error boundary.

`artifact_library.rs` embeds `apps/day/ui` as it is (`pilot-day/ui/<file>` chunks and
a `pilot-day/ui` facade). A preview has no asset reader, so each icon the library
imports is a chunk of its own that exports a `data:image/svg+xml` URL and its size,
and each font file is a chunk that exports its family name ("Geist", "Geist Mono").
A preview cannot register fonts: on macOS, Day's own window registers Geist for the
whole process when it imports the same files, and previews draw with it. Tests keep
the embedded files equal to `apps/day/ui`, its icons and fonts, and check that the
library imports only `nsh`, `nsh/base`, `nsh/base/plot`, its own files, icons and
fonts, and no refused name. Compiling the kit and the library takes about 25-45 ms
once per process (release); an artifact on the library starts and draws its first
screen in under 10 ms and needs about 2 MiB of its 64 MiB heap.

The configuration explicitly declares and grants no host capabilities, hardens
the VM and sets heap, stack, time, node and operation limits. It installs only
NSH's base registry, with no Day context, host channel advertisement, network,
filesystem, assets, storage or credentials. Interpreter limits do not cover
native/GPU allocations.

The preview limits (`artifact_runtime::limits()`) follow the "Limits" rule in `CODING_STANDARDS.md`.
Day keeps at most four previews open, and the engine runs on its own thread, so a slow call never freezes Day.

| Limit                         | Value     | What it protects                                                     | Why this number                                                                                                                                      |
| ----------------------------- | --------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI nodes                      | 10,000    | Day's memory: native views are outside the heap                      | A large mock (three variants of a full page) keeps a few thousand. 256, the feasibility probe's value, stopped real prototypes at their first switch |
| Queued changes                | 400,000   | Memory outside the heap                                              | NSH's default ratio of 40 per node, so a full redraw fits                                                                                            |
| Canvas operations per drawing | 50,000    | Memory outside the heap                                              | A dense chart of some thousand marks with labels                                                                                                     |
| Heap                          | 64 MiB    | Day's memory                                                         | Four previews add up to NSH's default heap for one embedded app (256 MiB)                                                                            |
| Load / one call               | 2 s / 1 s | Code that never ends                                                 | A correct mock loads in milliseconds; one call may draw a whole variant                                                                              |
| Interpreter stack             | 1 MiB     | The engine thread's 8 MiB stack: deep recursion becomes a RangeError | Three saved 700-850 line mocks overflowed 512 KiB in a debug build and render at 1 MiB. NSH's default is 4 MiB                                       |

When NSH stops an engine at a limit, it says so only in its log (`stopped: <reason>`). Day's log facade passes
that to every running preview (NSH does not say which engine). Each shows "This preview was stopped: <reason>"
with **Start again**, which starts a fresh engine from the same saved revision.

On macOS, the connected window registers `pilot/artifact-preview` on its own
native component registry. Preview reads the displayed exact pin through the
existing delivery reader, then passes those saved bytes as data to the native
component. Compilation runs off AppKit with at most two active workers. Each
preview starts a fresh AppView with an empty host and base-only UI sets. The
app restores Day's canonical process-wide sets before returning to AppKit;
the artifact engine keeps its isolated snapshot.

**Full window** shows the open artifact over the whole page (`FullArtifact`, one per window), with the same
preview or source. The card's own viewer closes first, so one preview runs. Escape or Close comes back to the card.

Hiding the inspection, changing the result, losing read authority or closing
the page disposes that preview. Generation checks reject late preparation
results. Preview-local editors are not conversation drafts; native draft
capture skips their subtree, while parent disposal still stops and joins the
child view. AppView uses upstream's interrupt-and-join shutdown. This does not
claim a native/GPU memory quota or native input/performance acceptance.
Clients without the registered component continue to show source only.
Historical non-NSH kinds are never run.

## Compiler and lifetime

Capture compiles its exact in-memory string and returns source only after success.
The separate source-only `compileNshSource` check returns no generated code or
rendering permit. The helper IPC does not carry artifact IDs/revisions or echo
source hashes; canonical storage owns those pins. The app must independently
validate and compile its saved revision when preview is supported. The Rust
`prepare` function remains for that app-side exact-pin boundary, not helper IPC.
Only Capture mounts the component, once, in the publish-time check below.

The source host uses OXC's TSX AST to reject local,
remote, dynamic, default and namespace imports, import metadata/attributes,
TypeScript import aliases/types and module re-exports. A default component
export is required. Named imports from `nsh`, `nsh/base`, `nsh/base/plot` and the
trusted `pilot-day/ui` and `pilot-artifact/ui` are allowed, except the names in `artifact_source::REFUSED`.
`pilot-day/ui` gives the names `ui/index.ts` exports, without the screen agent's
registry functions (`artifact_library::exports`). Refused:
what reaches outside the preview (host calls, clipboard, storage, links, pickers,
web views, notifications, sound, speech, terminal, system alerts, eye dropper),
shaders (no GPU time limit, and they can sample what is drawn behind), `setColorScheme`
(it changes Pilot's window) and `mount`. Other modules (`nsh/desktop`, `fs`, `net`,
`process`, Day/native, raw `nsh:rt`) are refused. Each refusal says why. The
deny-all policy stops the same capabilities at run time; the list says so first.
Day's preview and the publish-time check both start from `artifact_runtime::config_for`,
so they install the same UI set (NSH's base registry, with `nsh/base/plot`).
The host then uses pinned unmodified NSH 0.6.1 `compile_module` on the in-memory
string. It does not use `bundle`, `nsh.json`, aliases, package discovery or a
filesystem resolver. Generated code is limited to 2 MiB, then discarded by the
helper. Syntax diagnostics name virtual
`Artifact.tsx`, with line/UTF-16 column; other compiler diagnostics are limited
to 4096 characters. This is not full TypeScript typechecking or module linking.

The helper API has exactly Ensure, Capture and Compile. Unknown actions/fields,
including authored bytecode, fail. Its Node transport inherits no environment,
limits request/response to 4 MiB, permits at most two active helper calls per
worker process, and kills on abort, output overflow or a ten-second deadline
(the check ends within 9 s: see [Publish-time check](#publish-time-check)).
A call settles, and frees its slot, only on process close: the helper has exited,
Node has reaped it and its pipes have closed. Callers keep their inputs and
cleanup until then. A complete reply written before an abort is still refused.
Close proves the direct helper joined, not a descendant subtree. The fixed helper
does not spawn children. It evaluates authored code only in Capture's check. These are source-host
safeguards, **not** a production native renderer sandbox or a total memory quota.

## Publish-time check

`artifact_check.rs` gives agents the check Day's preview would make, before
anything is saved. After compiling, Capture starts the entry with
`artifact_runtime::config_for` (the same kit, bootstrap, deny-all policy, base UI
set and limits as Day's preview) on NSH's headless engine (`nsh-testing`
`Headless`), in a 900 x 650 desktop viewport. It waits for the first render to
settle, then refuses the capture when the engine reported an error or the kit's
error boundary shows "This artifact stopped with an error" or "could not start".
Otherwise it returns the texts with room to show and those without: a text has
no room when a view around it that clips leaves none of it, or a scroll view
around it has no height or width. This found the blank mockups users saw (a
`Scroll` with `flex-1` inside `Page`).

After the first screen it presses each variant switch once: every tab (`nsh/base`
`Tab`, which `pilot-day/ui`'s `Tab` and `Choices` options are) and every button in a
radio group that is not already selected. Other buttons
may stand for actions in the mock, so it leaves them alone. Each state reached
is checked the same way, and an error is refused with the switch that led to
it. A press that throws is refused too. Presses start only in the first 6 s and
stop after 40, so the run ends within the helper's deadline; the result says
how many were left. Switches inside a variant reached by another press are
pressed only in that state, not in every combination.

It has no window, GPU or native views, so it checks errors and layout, not
appearance. There is no screenshot. A hidden-window AppView capture with
`cacheDisplayInRect` worked in a test process, but the helper is not an AppKit
app; that remains a follow-up.

`examples/artifact_audit.rs` runs the same check over every saved NSH revision
under a sessions folder, read-only. Use `--release`: a debug build needs more
interpreter stack.

Abrupt loss of the owning worker is an open gate. Nothing then joins the helper,
and it has no deadline of its own. From the code, it should see end of input,
finish its limited work and fail to write to the closed pipe. This is not tested.

Preview state is local to one engine. Reopening or replacing a revision disposes
the old engine and starts fresh. Prepared code is not passed into Connected's VM,
and a preview or check that runs does not run historical callbacks or accept a design.

## Scratch cleanup

Archive, idle maintenance and restart no longer remove scratch. Explicit
workspace reclaim uses the existing admission/maintenance serialization,
quiescence and child checks, closes the kernel, then removes that session's
scratch. A repeat explicit cleanup can remove scratch even if automatic
retention already reclaimed the workspace. Automatic retention can still
reclaim a workspace, but leaves scratch alone.

Publication/capture stays within the worker's busy tool lifetime. Capture's
handles and helper process close before the tool returns. Compilation uses the
captured in-memory bytes, never a second scratch read. Day's previews read saved
revisions, never scratch, so cleanup has no live preview to wait for. Published `artifacts/` revisions,
original history and workspace recovery records are outside scratch and survive.
Shared coordinator-main views retain their existing explicit-reclaim refusal;
this is not a new coordinator workspace deletion command. No current user
scratch or workspace was removed while implementing this behavior.

## Availability and remaining gates

The native target is `pilot-artifact-host` with the `artifact-host` feature.
The kernel looks only for the trusted installed code location
`packages/artifacts/native/pilot-artifact-host`, relative to its own module.
It never accepts an executable path from a tool/artifact, nor searches PATH or
scratch. The immutable Day input recipe builds this helper from Day's native
crate and checks its compiled
source/recipe identity through its existing source-only Compile operation.
No new helper command or authored JS execution is added.

The existing recipe calls the existing Node `callArtifactHost` transport directly
with fixed benign source and an 8 KiB response allowance. It reuses the same
empty environment, strict identity/protocol checks, deadline and joined exit;
there is no separate Python process supervisor or staging wrapper. Outside an
archived build, the transport module must match the requested Git source exactly.

Only assembly with explicit Day NSH resources copies it into runtime. The existing
native closure/signing/inventory covers it; a binding records the final signed
bytes before the outer app seal. This NSH helper is separate from the retired
GPUI visual worker. Connected-only candidates still contain no daemon runtime and
therefore no source-helper binding. Packaging tests use synthetic inputs, not
actual signing/native acceptance.
The assembler compares the copied helper with the captured manifest digest and
size, not a later read of potentially changed input. It then uses the existing
native signing/inventory and writes one final binding. It does not re-run the
identity probe on the identical copy or after the trusted signing operation.

Before offering capture, the kernel checks the fixed binding against runtime
source and streams the helper's exact bytes in 64 KiB chunks. A per-process
stat/identity cache avoids hashing unchanged bytes on every call. It also checks
every helper reply's compiled identity. Availability no longer starts a trial
compilation: the exact-byte binding already identifies the build-probed executable.
These checks supplement the
existing verified app/runtime closure, not replace signatures or grant trust to
a loose local helper. First-use hashing adds startup I/O; a genuine signed-bundle
latency measurement remains outstanding.

There is not yet a verifiable inherited app-installation capability at the kernel
launch seam. Day's `bootstrap.rs` verifies the app before loading its GUI, but
`runtime-bootstrap.ts` checks only a runtime stamp. That is not an equivalent
signature/installation proof for the helper. The descriptor, exact-byte hash and
compiled identity echo therefore remain. A fixed path alone cannot replace them;
they also do not turn a loose or unsigned installation into a verified app.

If that installed binding is absent or fails checks, no platform offers sourcePath
publication. An unavailable or unsafe scratch setup also disables this optional
publication path without preventing the rest of the session from opening.
Actual source-matched packaging/signature qualification remains a gate; this
implementation does not assemble/install or change an existing app/runtime.
Test-only helper selection is not authority
to bind an installed executable.

Every supplied example compiles and runs through the publish-time check
(`tests/artifact_check.rs`), and so does a mock that uses animation, gestures,
keymap, an editor and a plot. Its local
development alias is not a production resolver. No missing helper/export
silently falls back to filesystem loading.

### What running artifact code covers

Authored code runs in two places, both from `artifact_runtime`: Day's preview of
a saved revision, in Day's process on the engine's own thread, and the
publish-time check, in the helper process. Both set declared **and** granted
deny-all capabilities, harden the VM, install only NSH's base UI set and no Day
registry, host channel, network, files, storage or credentials, and apply the
limits above. `tests/artifact_runtime.rs` checks the denials. The AST import
list only keeps names out; it is **not** the sandbox.

What is still not covered:

- Native and GPU memory. The heap limit does not count them. The node, queued
  change and canvas limits keep them in proportion; there is no total quota.
- Fault containment in Day. A preview shares Day's process, so a native crash
  while drawing one ends Day. The check runs in its own helper process, which is
  killed at its deadline.
- Code that spins. The call and load limits interrupt it, and closing a preview
  interrupts and joins its engine (`artifact_feasibility.rs` covers both).
- Shaders and screen sampling. The import list refuses `Shader` and the screen effects,
  so neither runs. Nothing enforces a per-artifact GPU budget if that changes.
- Keyboard shortcuts. A `keymap` binding takes keys while the focus is in the
  preview, or when no view in Pilot's window has the focus.
- There is no privileged or VM containment around either process.

See [feasibility evidence and its limits](nsh-artifact-feasibility.md).

## Focused checks

```sh
node apps/day/scripts/test-artifact-source.mjs
node --test --test-name-pattern='NSH scratch' packages/daemon/src/session-workspaces-lifecycle.integration.test.ts
node --test --test-name-pattern='saved nsh' packages/daemon/src/delivered-artifact.test.ts
```

The first command builds only the helper through the Day Cargo wrapper,
then selects the directly affected capture/compiler/tool/transport cases. It
uses the actual Cargo-reported executable, not a guessed shared target path.
The existing Day CI invokes it too. Without that fixture binding, macOS native
capture cases report an explicit skip, not a pass. Broad suites, typechecking,
NSH checks, GUI builds, visible windows and live integrations are not part of
these checks. CI/native acceptance must not be inferred from publication.
