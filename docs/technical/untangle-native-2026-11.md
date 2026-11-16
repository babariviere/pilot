# Native structure audit and shared cleanup

Date: 2026-11. Status: GPUI excluded by user scope change (“ignore gpui app btw”).
All seven native-agent changes under `apps/desktop` were undone. Only shared
macOS boundary-test cleanup and shared native-authorization documentation remain.
Power and installation cross-reviews remain in scope.

## Current scope and decisions

Own shared support in `apps/macos` and `apps/native-daemon`, plus the requested
independent power and installation cross-reviews. Day is owned by its agent.
Do not edit root `scripts/*.ts`; the parent owns installation/recovery changes.
No further GPUI reviews, builds or tests are planned.

The initial audit used `CODING_STANDARDS.md` and the Rust best-practices and review
skills. These are application crates, not published libraries. The retained
changes do not alter UI behavior, user copy, wire fields, storage names,
authorization checks or toolchain policy.

## Retained shared changes

### Source-boundary test: explicit roots, no repository-size threshold

`apps/macos/scripts/tests/test_source_boundary.py` used to check for removed Swift
GUI consumers and then require more than 1000 scanned files. Unrelated source
consolidation could fail that assertion without introducing a forbidden consumer.
The number did not enforce a resource limit or dependency contract.

The check now uses explicit existing roots, asserts each exists, and includes the
previously omitted `apps/native-daemon`, `apps/desktop/updater/src`, and
`apps/desktop/visual-worker` roots. Keeping existing Desktop roots in this shared
removed-path test does not authorize changes or further review of the GPUI app.
The old Cartesian root list included nonexistent directory combinations, so it
was replaced with the actual intended directories before adding existence checks.
The arbitrary count assertion was removed. Removed-path rejection and test-file
exclusions remain unchanged. No general scanner abstraction was added.

Verification before the scope change: all 4 source-boundary tests passed.
An isolated temporary-tree characterization also passed: a small tree did not
need a minimum file count; a forbidden consumer was rejected in each of the three
added roots; a missing required root was rejected. No real repository inputs were
mutated by that characterization.

### Shared capability source: document compiled consumers only

`apps/native-daemon/credentials.rs` now documents that Desktop model-scope access
and Day host transport compile it through path modules. This is documentation of
existing consumers, not a new dependency or crate.

Capability filename, daemon/lineage binding, token format, sanitized errors,
ownership and permission checks, no-follow/nonblocking flags and byte ceilings
are unchanged. These safeguards protect authorization and are not redundant
defensive code. The proposed Desktop fingerprint change was undone with the
GPUI exclusion; no fingerprint improvement is claimed as delivered.

## GPUI scope exclusion and exact reversions

Before the clarification, the parent authorized the initial selected fixes 1–4.
The user then excluded GPUI. The native agent reversed only its own diff in these
seven paths with `applyPatch`:

- `apps/desktop/build.rs`
- `apps/desktop/src/mission_metadata_transport.rs`
- `apps/desktop/src/task_edit_transport.rs`
- `apps/desktop/updater/Cargo.toml`
- `apps/desktop/updater/src/daemon_upgrade_native_tests.rs`
- `apps/desktop/updater/src/bundled_service_tests.rs`
- `apps/desktop/scripts/bundle_runtime.py`

Read-only diff inspection confirmed those diffs contained only this agent's
changes. After reversal, `git diff --exit-code` on all seven paths was clean.
The unrelated `apps/desktop/docs/lazy-history.md` change was left untouched.
No broad restore or version-control mutation was used.

The response-reader consolidation, fixture-argument/comment cleanup and Desktop
fingerprint addition are **not delivered**. Earlier completed-work claims for
those changes are superseded by this scope decision. The updater transition
helper was never implemented: it would mainly deduplicate lines rather than
reduce caller knowledge, and the different validators encode real trust
boundaries. Further GPUI analysis is excluded.

Historical checks ran before exclusion: 13 selected transport tests passed
(nextest run `bf09f39f-f5ea-477e-9d61-d3a257d82a69`), native updater tests compiled
without running ignored fixtures, and Desktop/updater clippy passed. Temporary
fingerprint characterization and leaf formatting also passed. These are records
of work before the scope change, **not** claims that GPUI changes remain delivered
or qualification of the final scoped changes. No further GPUI tests were run
after the exclusion. The compiler lane was already released.

## Shared constraints and compatibility disposition

- Keep supported Day/shared helper build paths even when they live under
  `apps/desktop/scripts`. Their location alone does not make them obsolete.
- Keep native arm64 macOS and macOS 15 deployment requirements. Static or mocked
  checks do not establish other-platform acceptance.
- Keep the shared Swift power comparison fixtures, C visual engine, image credits
  and license notices. Live consumers are documented in `apps/macos/README.md`.
- Keep exact Day debug executable size exceptions, immutable source staging,
  helper containment, signature checks, offline relocated-runtime checks and
  native dependency verification.
- Keep inventory and capsule-identity algorithms separate. Their output/hash
  semantics differ; similar traversal does not justify merging them.
- Preserve pending/Unknown non-replayability and existing UI behavior. No UI
  redesign or native visual artifact is needed for the retained shared changes.

The hashed SDK chunk imported by `apps/macos/scripts/check-runtime.sh` is an
upstream compatibility dependency, also exercised by the daemon MCP tests.
The kernel agent owns its compatibility centralization and any change to that
script. This agent did not touch it. Do not replace actual SDK editor coverage
with handcrafted JSON and claim equivalent interoperability.

## Shared verification and blockers

Before the scope change, the shared source-boundary suite passed (4 tests).
Native snapshot/capsule checks also passed (13 run, 1 skipped), but used the
shared packaging tests under `apps/desktop/scripts`; no rerun is planned here.

The runtime-stamp test failed its explicit Node 24 precondition because the host
command resolves Node 26.13.1. This remains an environment blocker, not evidence
of a stamp logic regression. No tools were installed solely for this refactor.
No app installation, live daemon action, ignored live launchd fixture or visual
acceptance was performed or claimed.

Report structure, the power-report link, and changed-file whitespace are checked
without occupying the native compiler lane.

## Independent cross-reviews

Both cross-reviews were source-only. No production files were edited, no compiler
lane was used, and no additional test pass is claimed for the reviewed changes.
The final native self-check found no further issue worth changing.

### Power command decoder

Reviewed `apps/power/src/{protocol,runtime,linux,tests}.rs` and
`apps/power/src/linux/tests.rs`. No production semantic regression was found.
Heartbeat precedence, signed request IDs, unsigned generations, strict boolean
fields and ignored extra fields remain unchanged. Missing or non-string actions
still stop macOS, while Linux rejects those with valid IDs and stops those without
valid IDs. Platform effects and policy remain outside the shared decoder.

One actionable test-quality finding was sent to the parent:
`apps/power/src/linux/tests.rs:376–389` waits for invalid-ID shutdown without a
deadline. If the frame were ignored, later lease expiry could close the helper and
make the no-reply/resource assertions pass anyway. Require exit within a short
fixture deadline below the lease duration, with the sender still alive. Bound the
new reply waits too, so a missing reply fails rather than waiting indefinitely.
The parent notified the power agent to fix this. This report does not yet claim
verification of that follow-up. Power decisions and execution results belong in
[the power report](untangle-power-2026-11.md).

### Installation evidence writer

Reviewed `scripts/installation-records.ts`, its two caller diffs in
`scripts/day-install.ts` and `scripts/day-recover-legacy.ts`, and all three test
files. No correctness regression was found. JSON formatting stays with callers;
no newline is added; recovery's copied UTF-8 strings remain unchanged. The helper
keeps exclusive creation with mode `0o600` and the ordering write, file fsync,
file close, parent fsync, parent close. Callers await it before service effects.
Failures leave created files intact, and existing entered-record branches prevent
apply/stop/start replay, including malformed evidence that fails parsing.

The byte-writer helper removes real duplication without absorbing serialization,
service ordering or recovery policy. Its partial-file comment records an important
contract. Unicode, concurrent-writer, symlink refusal and one-shot recovery tests
are useful behavior checks, not surplus abstractions or tests.

One small coverage addition was recommended, not a production fix: precreate an
empty or truncated entered record for each caller, then assert rejection, unchanged
bytes and zero native/host effects. The existing complete-file replacement test
does not directly cover this partial-file non-replay case. No new filesystem mock
or injection abstraction is needed. The parent's reported 26 passing tests are
the execution evidence; this review did not rerun them.

## Authorized daemon test-quality cleanup

After the independent source review, the parent handed off exactly three test
files. No production or GPUI code changed:

- Removed the source/import regex scans and filesystem imports from
  `packages/daemon/src/retained-review-contract.test.ts`. Kept the mission/task
  snapshots, report parsing, partial-report rejection and ineligible acceptance
  negative control. The test name now describes unchanged mission state and
  eligibility, not a global absence of transport or acquisition calls.
- Removed the final source-scan test and filesystem imports from
  `packages/daemon/src/retained-review-linkage-contract.test.ts`. Kept the earlier
  stronger disabled-dispatch assertions (exact status, frozen result and refused
  mutation), plus all claim validation and fidelity coverage.
- Removed only the private statements-map cast/size assertion from
  `packages/daemon/src/usage-history.test.ts`. Kept the actual preparation count
  across 100 parameter variations. The name now claims reuse across parameters,
  not statement release at close. Fixture cleanup remains unchanged.

The scans could reject harmless extraction while missing aliased or indirect
effects. Their removal does not establish a global no-transport guarantee.
The negative control's throwing resolver also remains a rejection trap, not a
measured assertion of zero resolver calls.

Verification passed on host Node 26.13.1:

```sh
node --test --test-concurrency=2 --test-timeout=120000 \
  packages/daemon/src/retained-review-contract.test.ts \
  packages/daemon/src/retained-review-linkage-contract.test.ts \
  packages/daemon/src/usage-history.test.ts
pnpm exec biome check \
  packages/daemon/src/retained-review-contract.test.ts \
  packages/daemon/src/retained-review-linkage-contract.test.ts \
  packages/daemon/src/usage-history.test.ts
```

All 57 tests passed, none skipped, in 1.416 seconds. Concurrency was limited to two
files. Biome checked all three files with no fixes needed; diff whitespace checks
passed. No further worthwhile issue was found in this scoped cleanup. These files
are stable for parent integration.

## Authorized Slack test-only baseline repairs

The parent reproduced three failures unchanged in a pristine snapshot after the
full Node gate reported 4762 tests (4745 passed, 5 failed, 12 skipped). A local
pre-change run of the two handed-off files reproduced exactly those three failures
(6 passed, 3 failed). Only `slack-cases.test.ts` and `slack-label-effects.test.ts`
changed; no product source or GPUI code changed.

Reviewed the current implementation and the common-case contract in
`docs/technical/product-reference.md`, plus label/status behavior in `docs/slack.md`:

- Common cases use the newest 200 bugs within 30 days, retain memberships/names,
  and supply the dashboard's top three cases. The test's explicit October fixture
  time was used by direct case reads, but dashboard preview reads `Date.now()`.
  The real November clock correctly aged the fixture out. The test now pins
  `Date.now()` to the same fixture instant and compares the actual preview cases
  with the case-list result, instead of merely checking a nonzero length. Existing
  age, severity, project filtering, membership, rename, trend and retirement checks
  remain unchanged. No state or time filter was weakened.
- Explicitly reconfirming a user status refreshes its status/intake revision fence.
  The previous whole-item equality assertion failed only on that revision. The
  replacement compares every item field except revision and additionally asserts
  no new correction was recorded. It keeps user-owned dismissal and label-close
  distinctions, later reclassification, relabeling and selective reopening checks.
  It does not claim repeated explicit status actions leave internal revisions or
  event counts unchanged.
- Project migration writes compact JSON. The old regex required a pretty-printed
  space after the colon. The test now parses the persisted file and compares the
  complete label array with the expected migrated labels, including effects and
  absence of legacy fields. Cold restart, pre-poll reconciliation, cached Inbox
  counts, notifications, hidden groups and reopening assertions still run.

Verification:

```sh
node --test --test-concurrency=2 --test-timeout=120000 \
  packages/daemon/src/slack-cases.test.ts \
  packages/daemon/src/slack-label-effects.test.ts
pnpm exec biome check \
  packages/daemon/src/slack-cases.test.ts \
  packages/daemon/src/slack-label-effects.test.ts
```

Final run passed all 9 tests, none skipped, in 0.375 seconds on host Node 26.13.1.
The first Biome pass found existing import ordering in `slack-cases.test.ts`; the
imports were sorted and both tests and Biome reran successfully. Changed-file
whitespace checks passed. This focused result does not claim the other two failures
from the parent's full gate are fixed or that the complete gate is green.
