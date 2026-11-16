# Codebase refactor, November 2026

Status: implemented and verified. This is a decision log, not a
claim that every dependency or special case has been eliminated.

The user selected both comment cleanup and test-quality cleanup. Preserve
behavior, authorization, saved records, wire formats, cancellation and resource
limits. Keep regression tests until the corresponding structural changes pass.
No installation, service restart, account access or release is authorized.
The user subsequently excluded the GPUI app. GPUI-only implementation changes
were withdrawn; keep `apps/desktop` unchanged. Shared native helpers used by Day
remain in scope.

## Audit method

Read-only domain audits cover daemon, kernel/protocol/artifacts/telemetry,
Day/power, shared native support, and repository tooling. The initial Desktop
audit is excluded from implementation by the user's scope clarification. Inspect source,
callers, tests, existing cleanup logs and relevant history. A repository-wide
TypeScript import summary checks dependency direction, including relative imports.
Fixture source strings are not actual imports. A full Node baseline and workspace
typecheck run before implementation.

## Installation evidence files

- Give installation and legacy recovery one exclusive durable byte writer.
  - `scripts/day-install.ts:492` and `scripts/day-recover-legacy.ts:61` each
    implement create-only mode-0600 writes, file sync, close, and parent sync.
    Both must change together if the durability contract changes, but the link
    is hidden. Their only meaningful difference is JSON encoding at the caller.
  - Keep raw plist/state bytes raw. Encode JSON at the installation caller.
    Keep exclusive creation and propagate all write/sync failures. An incomplete
    entry must remain present so a later invocation cannot replay effects.
  - Do not replace this with the daemon's atomic-replacement JSON writer. It has
    different overwrite semantics. Do not unify private readers with different
    size limits and diagnostic contracts just because they look alike.

## Required special cases

- Installation's exact build-197 capability qualification and the source-pinned
  legacy recovery are documented compatibility requirements in
  [Day installation](day-install.md). Keep their source/hash, seal, live lease,
  identity and lookup-only checks. A refactor cannot make unsupported historical
  daemons understand the new protocol.
- Recovery polling observes operating-system process/service state, not a local
  call-order workaround. Keep its deadlines and never retry effects.
- Test lane and heavy-file classifications are explicit scheduling/CI policy,
  not generic feature extension points. Keep their behavior.

## Domain decisions

- [Daemon](untangle-daemon-2026-11.md): composition, subscriptions, source policy,
  native authority and durable operation ownership.
- [Kernel and shared packages](untangle-kernel-2026-11.md): artifact contracts,
  serialization ownership, telemetry catalogs and dependency direction.
- [Day](untangle-day-2026-11.md): navigation, saved state, connection and feed ownership.
- [Native support](untangle-native-2026-11.md): shared source-boundary checks;
  GPUI-only changes are excluded.
- [Power helper](untangle-power-2026-11.md): shared command decoding with distinct
  platform policy, timing and teardown.
- [Tooling](untangle-tooling-2026-11.md): benchmark loading/dependencies,
  behavioral contract tests and distribution documentation.

## Verification

Installation and legacy recovery checks pass (28 tests), including concurrent
exclusive creation, exact Unicode bytes, private modes, symlink refusal, lost
replies and lookup-only repeats. Empty and truncated entry records refuse without
native/host effects, HTTP requests, replacement bytes or new recovery records.
Biome checks pass for the installation implementation and tests.

The initial workspace typecheck passed. The long Node run began before edits;
unstarted test files can observe later edits. Compare failures against the separate
pristine pre-change tracked-source snapshot before calling them baseline failures.
Native headless checks do not prove appearance, scrolling, focus or IME. No UI
redesign or live GUI acceptance is claimed.

The global formatter initially followed linked Rust targets into shared build
caches. Explicit target exclusions now prevent that, with a disposable symlink
fixture and a negative control. Installer-owned skill lock metadata keeps its
generator's formatting. Global `pnpm fmt:check` still reports existing Markdown
formatting across vendored skills and documentation, including excluded GPUI
work. No mass Markdown reformat or shared-cache write is part of this change.

Independent review checked the completed daemon composition, explicit session
service defaults, initialized journal reader, feature-owned Day persistence and
surface-owned animation. Follow-up review found two remaining links: operation
recovery still lived in transport, and custom workers still suppressed usage
history in their start spec. Those receive scoped fixes before the full gate
restarts. Review also confirmed the disposable Git/jj benchmark fixture and
partial installation-entry tests. Focused checks do not replace the full gate.

Both remaining links are now fixed and independently reviewed. Durable operation
admission/recovery belongs to the service owner, and production starts recovery
after session restoration. Worker usage-history delivery has an independent
explicit option; offline fixtures preserve explicitly supplied choices.

The complete Node run reached 4,762 tests: 4,745 passed, five failed and 12 were
skipped. The failures exposed test/fixture problems rather than product changes:
an expired synthetic Slack clock, a revision-fence assertion, JSON whitespace,
store teardown after home removal, and copying an incomplete Homebrew Node
runtime into a worker probe. All five have focused passing checks after their
test/fixture fixes. Production behavior and packaged-runtime relocation checks
remain unchanged. The repeated complete gate passed.

Before pushing, the working change was rebased cleanly onto upstream `747e8e23`
(thread reading position). Combined daemon thread tests passed (12), and Day's
bridge/native checks passed. Independent review found no merge-coherence issue.
The unrelated GPUI document kept the same SHA-256 before and after rebasing.

## Final checks

- Full Node gate on the merged tree: 4,750 passed, zero failed, 12 skipped
  (4,762 total). Two files ran concurrently, with inherited `PILOT_*` settings
  cleared. The per-test deadline stayed at two minutes.
- Workspace typechecking passed. Formatting passed for all 250 changed
  TypeScript, TSX, JSON and JavaScript files. Task-owned technical documents and
  whitespace checks passed. The unrelated global Markdown baseline remains as
  described above; no generated caches or vendored skills were reformatted.
- Combined upstream thread checks passed: 28 headless, three bridge and three
  actual macOS tests. The upstream midnight-sensitive test now uses its existing
  clock option instead of depending on the wall clock. Production sorting and
  scroll behavior are unchanged. Earlier Day ownership/build/type checks and
  Power tests/Clippy are recorded in their domain logs; their counts overlap.
- Independent structural review and follow-up reviews found no further
  actionable issue in the completed changes. Historical compatibility and
  platform policy remain intentional, not generic extension points.

No live accounts, profile migration, installation, service restart, signed
distribution qualification or general native GUI responsiveness check was run.

The parent reran workspace typechecking and strict isolated checking of the
installation scripts successfully. A Babel AST import audit of 791 production
TypeScript/TSX files (excluding tests and fixtures) found no runtime imports from
kernel into daemon or repository tooling. Daemon depends on kernel, artifacts,
telemetry and protocol; kernel depends on artifacts and telemetry. Repository
benchmarks depend on their measured modules, not the reverse. This is a static
cross-package check, not proof that dynamic imports or all internal seams are ideal.
