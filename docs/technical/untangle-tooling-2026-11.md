# Repository tooling audit and redesign, November 2026

Status: tooling changes implemented and focused checks passed. Full workspace
verification remains with the parent. The parent owns the exclusive
durable writer. The kernel agent owns the SDK compatibility adapter and the
Linux smoke-test import change; this agent will not edit `check-runtime.mjs`.

Decision before implementation: keep benchmarks at their existing paths and
declare their direct root development dependencies. Share only historical-module
loading, with current workspace resolution. Keep pipeline behavior unchanged.
Perform test-quality cleanup after the structural changes pass focused checks.

Implemented: explicit root development dependencies, one colocated baseline
loader used by all six existing baseline benchmarks, direct visual fixture
construction, corrected headless instructions and the Biome schema reference.
The Renovate relocation commands now live in a shell script with executable
fixture coverage. Its workflow condition and command order are unchanged.
Lane selection validates configured macOS paths instead of copying their full
registry into tests. The kernel agent handles the shared SDK import separately.

Read against [coding standards](../../CODING_STANDARDS.md) and the parent
[refactor log](untangle-2026-11.md). Scope: root dependency/configuration files,
`.github`, and `scripts`. Native app scripts are outside this agent's ownership.
The user explicitly excluded the GPUI app and its app-specific runtime code.
No `apps/desktop` files were changed by this agent. References to existing
packaging contracts do not authorize widening that scope.

## Boundaries and ownership

- The parent owns the shared exclusive durable byte writer used by
  `scripts/day-install.ts` and `scripts/day-recover-legacy.ts`. This agent will
  not edit those implementations or their tests.
- This agent owns other repository scripts, root dependency configuration,
  workflow cleanup if justified, and `scripts/linux/README.md`.
- The generated SDK chunk import crosses tooling, daemon tests and native
  packaging. The parent must coordinate a kernel-owned compatibility adapter
  before this agent changes the Linux caller.
- Preserve pipeline triggers, conditions, jobs, lane membership, tool pins,
  release ordering, permissions and isolation. Preserve authentication, signing,
  checksum, source identity, relocation, ABI and ownership checks. No safety
  check is a cleanup target.
- No installation, restart, credentials, publication or live-session benchmark
  is authorized. Implement structural fixes first. Clean up tests last, after
  replacement coverage passes.

## Findings and proposed changes

### 1. Give root benchmark imports explicit dependency ownership

`scripts/bench/io.ts:11-14` imports chord, pi-ai and pi-durable.
`scripts/bench/reopen.ts:12` imports `@pilot/kernel`.
`scripts/bench/daemon-reopen.ts:11` imports `ws`. None is declared by the root
`package.json`, which owns these scripts.

A read-only `createRequire` resolution probe found missing root dependencies.
It also resolved `ws` from the installed coding agent rather than this checkout.
The agent supplies `NODE_PATH`, so that resolution is evidence of environment
coupling, not proof that a clean checkout works. The CommonJS probe is not a
complete ESM execution test.

Ownership alternatives:

| Approach                                                                   | Benefit                                            | Cost                                               | Decision                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Declare direct root development dependencies                               | Keeps commands and files; standard pnpm resolution | Adds explicit root lockfile entries                | Preferred for existing root benchmarks                 |
| Move implementations into daemon/kernel workspaces and keep root launchers | Uses existing owning manifests                     | Moves several files and splits benchmark ownership | Use only when a benchmark needs a package-private seam |
| Resolve each dependency through another workspace at each call site        | Avoids manifest changes                            | Hides ownership and repeats resolver machinery     | Reject for ordinary root imports                       |

Declare only packages directly imported by root scripts. Keep SDK versions
aligned with the existing workspace pins and use `workspace:*` for
`@pilot/kernel`. Use root development dependencies so production dependency
installation does not grow for benchmark use. Refresh the lockfile normally;
do not delete it, bypass scripts policy, or change production linker behavior.

### 2. One benchmark-only baseline module loader

Repeated extraction/import rewriting occurs in:

- `scripts/bench/io.ts:35-47`.
- `scripts/bench/daemon-activity.ts:16-25`.
- `scripts/bench/mission-recovery.ts:21-29`.
- `scripts/bench/daemon-stalls.ts:77-88`.
- `scripts/bench/startup-preparation.ts:16-25`.
- `scripts/bench/workspace-cleanup.ts:42-58`.

The implementations differ in URL escaping, temporary location, revision
syntax and TypeScript stripping. Startup preparation already places its module
under daemon's dependency directory to obtain current package resolution.

Add a small benchmark-only loader that reads the selected source revision,
loads the module with current workspace dependencies, and cleans up its temporary
output. Preserve each caller's accepted revision
syntax, including workspace cleanup's jj revision support. Do not build a generic
historical package manager or a second benchmark framework.

Implementation decision: write an exclusively created, UUID-named hidden `.mjs`
beside the original source file, not in a child directory or under node_modules.
Strip TypeScript without rewriting imports. The original directory preserves
sibling imports, JSON imports, workspace package resolution, and relative
`new URL(..., import.meta.url)` worker/resource paths. The temporary basename
differs; this is not a byte-identical module identity or a historical checkout.
No additional parser dependency or AST rewrite framework is needed.

Inspection covers five source modules across six benchmarks: changes, missions
(two callers), mission-notices, sessions and shared-workspaces. Current and HEAD
versions contain no `import.meta` resource construction in those modules.
Sessions uses imported `workerEntry`, whose defining module keeps its own URL.
Nevertheless older revisions can contain direct resource URLs; the colocated
design preserves their relative directory semantics without enumerating them.

Keep workload setup, legacy API adaptations, sample order and metrics in callers.
Output must state that the baseline is one historical module with current
sibling modules and dependencies, not a complete historical checkout.

### 3. Coordinate the SDK bundle compatibility seam

`scripts/linux/check-runtime.mjs:32-35` and
`packages/daemon/src/mcp-setup.test.ts:97` name
`bundle/chunks/chunk-MMDXLZVS.js` directly. Generated bundle layout is not a
stable API, and both checks must change together when the chunk name changes.

First check for a supported SDK export. Otherwise propose one narrow adapter
in `packages/kernel/src`, owned and coordinated by the parent. It should expose
the MCP configuration operations the checks need, resolve the installed SDK from
the kernel workspace, and keep the one version-specific path explicit. Do not
scan arbitrary chunks or silently fall back to a different implementation.

The Linux smoke test must still run the real SDK write/Pilot read interoperability
check from the relocated production package. Confirm that the kernel adapter
ships in both runtime layouts. The kernel agent owns the Linux import change;
this agent does not edit that file.

### 4. Replace presentation-sensitive workflow assertions last

`scripts/renovate.test.ts:114-127` splits YAML by a display name and exact
indentation. `scripts/linux/contracts.test.mjs:26-62` asserts long shell strings
and source formatting, including code in an out-of-scope native script.

Keep permissions, PR conditions, offline containers, read-only mounts, frozen
installation, and relocation checks. Prefer the existing workflow validation
mechanism for structure. Test extracted command behavior with temporary fixture
executables when a shell body warrants extraction. Do not introduce a YAML
framework just to replace a few assertions, or alter workflow execution to make
tests easier. Leave cross-owner assertions intact until equivalent coverage is
agreed and working. Reword harmless formatting checks only where the replacement
still detects the original failure.

Implemented without a YAML dependency: extract the Renovate relocation body
verbatim into `scripts/check-packaged-dependencies.sh`, retain the PR-only
condition, and test archive/extraction/check order, relocated sentinel contents,
exit propagation and cleanup with fixture executables. Existing actionlint
validates workflow structure. Keep the Linux container/native-builder wiring
assertions for now: replacing those requires broader native-script ownership or
running the actual Linux package toolchain. They check a real cross-owner
PATH/mount contract; no safety coverage was removed to claim cleanup.

### 5. Test lane contracts without a second registry

`scripts/test-suites.test.ts:56-79` repeats the full macOS coverage registry.
Its discovered-test coverage assertion is unconditional in practice because
`testInLane(path, "portable")` always returns true.

Keep representative defaults and macOS inclusion/exclusion examples. Validate
that every configured macOS coverage path exists in discovered tests, without
copying the complete registry into a second expected list. Keep runner suite/lane
intersection tests and refusal tests. Preserve all current lane classifications
and scheduling weights. The runner now uses `testLaneFiles`, which validates
configured paths when selecting the macOS lane. Tests exercise that public
selection behavior, including a missing configured path. No registry export
or generic scheduling model was added.

### 6. Remove the retired visual-fixture variant branch

`scripts/bench/visual-artifacts.ts:47-67` always chooses `kind = "visual"`, but
retains an extra scope and a conditional spread for other kinds.

Construct the visual revision directly. Keep output fields, IDs and prepared
artifact data unchanged. Do not remove compatibility fields merely because
their names refer to an older renderer.

### 7. Separate headless tooling instructions from GUI publication

`scripts/linux/README.md:18-26` describes independently signed headless release
assets and asks operators to provision `LINUX_RUNTIME_*` keys. The current
headless workflow builds unsigned PR evidence; stable release jobs call the
GUI packaging workflow instead.

Document the actual headless PR artifact and the separate manual signing CLI.
Do not imply that the stable release workflow signs or publishes the headless
archive. Link to the current GUI release contract instead of repeating its
publication guarantees. Keep signing code, key checks and archive verification.

### 8. Align the Biome schema reference

`biome.json:2` references schema 2.6.5 while `package.json` installs 2.6.7.
Align the schema URL only. Keep formatter/linter rules and installed versions.
Do not remove historical release-age exceptions without a separate reason.

## Implementation order after authorization

1. Confirm root dependency declarations and the kernel adapter owner/contract.
2. Apply dependency ownership and the small baseline loader. Verify their callers.
3. Simplify visual fixture construction and correct headless documentation/schema.
4. Let the kernel agent switch the Linux SDK caller to its shared adapter.
5. Replace low-value test assertions only after equivalent checks pass.

## Verification plan and current evidence

Audit evidence initially consisted of source inspection and a dependency
resolution probe. Implementation checks are recorded below. No signing,
installation or remote pipeline run has been performed.

After implementation, run focused Node tests two files at a time and
`pnpm typecheck`. Test loader import resolution, URL escaping, accepted revisions,
failure cleanup and baseline labels using disposable sources. Check representative
benchmarks with small synthetic workloads, not user session directories. Compare
visual fixture output before and after where the renderer is available.

Run Linux contract tests, Python metadata tests with bytecode disabled, shell
syntax checks and the existing workflow validator where supported. Report host
limitations rather than claiming a Linux production smoke on macOS. Keep real
relocated-runtime verification in its existing pipeline. Review diffs to ensure
that job policy, pins, security checks and release behavior remain unchanged.

Focused results:

- Baseline loader fixtures and suite/runner tests pass (8 tests). Loader fixtures
  cover real sibling exports, dynamic imports, bare packages, spaces/hash signs
  in paths, resource URL parity with the actual current module, a real worker,
  failed-import cleanup and Git/jj extraction.
- Packaging command fixture and Renovate tests pass (9 tests). The fixture
  verifies success and failed-check paths, command order and temporary cleanup.
- Linux contracts plus existing release workflow tests pass (23 passed, one
  Linux-only service test skipped on macOS). Python runtime metadata tests pass
  (3 tests). Shell syntax and existing actionlint checks pass.
- Isolated strict tooling typecheck and focused Biome lint/format checks pass.
  Full `pnpm typecheck` encountered the concurrent daemon server options migration
  and GitHub setup refactor, outside this agent's files. The parent must rerun
  the full gate after those edits settle.
- Root ESM dependency resolution passes with `NODE_PATH` unset. Frozen pnpm
  installation passes. Offline installation initially lacked cached supply-chain
  metadata; normal frozen installation completed without dependency upgrades.
- The I/O benchmark completed against HEAD using temporary Git and SQLite
  fixtures, including baseline/current summaries and streaming progress writes.
  This checks loader integration, not a performance improvement claim.
- Visual fixture output matches HEAD exactly for all ten prepared revisions.
- A mission-recovery probe was blocked by a transient duplicate
  `AI_LAUNCH_REASONS_SET` declaration in concurrent telemetry edits. No live
  session or whole-daemon benchmark was run.

Independent review found that the first extraction test assumed the real
checkout was already a jj repository. GitHub Actions checks out Git only.
The test now initializes its own disposable colocated jj/Git repository,
records one historical entry, changes its current sibling, and verifies both
Git and jj load the historical entry with the current sibling. Extraction runs
from the source directory, so neither the helper nor the test requires the
calling checkout's repository metadata. The actual checkout is never initialized.
Verification: all 8 loader/runner tests pass. Copied only the loader, its test
and a minimal package manifest into a separate Git-only temporary checkout;
all 3 loader tests pass there without node_modules and without creating `.jj`
in that calling checkout. Isolated strict typecheck, Biome lint and whitespace
checks pass after the correction.

## Generated formatting inputs, final-gate follow-up

The read-only full formatter gate found generated Cargo target JSON through
`apps/day/target`, a symlink into the shared build cache, plus a broken nested
target symlink. Root `pnpm fmt` could otherwise write outside the checkout.
Force-ignore `**/target` in Biome's scanner. Do not edit app code, target links
or their cache contents. No repository-wide formatter write was run.

Exclude only the root `skills-lock.json` from formatting: the external skill
installer owns its layout and emits spaces, so reformatting it would be undone
by the next sync. This does not exclude hand-written configuration, change any
hash or metadata, or ignore other lockfiles.

`scripts/biome-config.test.ts` runs the actual formatter with writes enabled
only inside a disposable project. A nested target symlink points to a separate
fixture cache containing unformatted and invalid JSON; another target link is
broken, and a root target holds invalid output. The check verifies successful
source formatting while cache bytes and generated skill metadata stay exact.
A read-only negative control without the target exclusion fails on generated
JSON. The focused test, config/test formatting, lint and whitespace checks pass.

The parent's subsequent read-only global formatter run no longer reports target
or shared-cache errors. It still reports 3,654 pre-existing Markdown formatting
errors in existing documentation and vendored skills. The parent's changed-code
check passes for 243 files. Do not exclude hand-written documentation or code to
hide that baseline limitation. No additional formatter scope changes are planned.

## Worker probe host-executable correction

Authorized decision: the leaf probe measures staged worker sources and generator
behavior, not Node distribution relocation. Run the invoking executable in place
instead of copying only its executable without its dynamic-library closure.
Keep exact executable/source/generator hashes, version metadata, isolated HOME
and environment, fresh processes, database staging and workload limits. Label
this explicitly and leave packaged-runtime relocation qualification untouched.
This fixes the unchanged baseline failure reproduced under Homebrew Node 26:
the copied executable could not resolve `@rpath/libnode.147.dylib`.

Verification on the same Homebrew Node 26.13.1: all three usage-worker tests
pass, including generated-source relocation and the twelve-case leaf fixture.
A separate limited probe passes eight samples across `shipped` and `js_worker`,
covering empty/populated stores, serialized queries and writes (one trial, one
batch, two operations). Its executable hash matches the invoking binary exactly.
Focused source lint, formatting and whitespace checks pass. No runtime
packaging, app code, skip or environment allowlist was changed.
