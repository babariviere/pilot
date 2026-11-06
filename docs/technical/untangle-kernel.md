# Kernel untangling decision log

## Selected fixes

1. Rename `mission-authoring` to `mission-write`, including its exported kernel subpath and daemon consumer. Use the write-limit constants in mission tool descriptions. Call the validator directly during argument preparation instead of catching and rethrowing its error. Keep validation at preparation, execution, and daemon admission. Each is a separate boundary. Preserve code-point counting, supplied-field checks, and legacy reads. Remove only the two tests inspecting refinement internals and description wording.
2. Move disposable worker admission and lifecycle code from `exploration-runner.ts` into `analysis-worker.ts`. Both exploration and saved-call comparison will import it directly. Keep the shared two-running/eight-waiting pool, permissions, deadlines, cancellation, pending reads, and join-before-release order unchanged. This removes a domain-to-domain infrastructure dependency without changing scheduling.
3. Inline the production commit observer adapter into `activity.ts` and delete `commits.ts`. Keep observation detach in the existing cleanup path. Two integration tests also imported the adapter; use the native observer API there and keep their detach cleanup.
4. Rename snapshot's local `bounded` page to `recentPage` and comparison's local signal to `deadlineSignal`. Name the repeated exploration page byte budget. Simplify prose in touched files without changing wire names or compatibility contracts.
5. Make protocol outcome types accept the same outcome/reason pairs as the existing parser. Keep serialized values and parser behavior unchanged. Test every supported pair and mismatched reasons.

The problems are repeated write-limit numbers, catch/rethrow scaffolding, hidden shared-worker ownership, a single-use lifecycle wrapper, and locals named after constraints rather than their values. No runtime policy belongs in protocol, and no new package is needed.

## Verification

Run focused Node tests with inherited `PILOT_*` variables removed: mission tool write boundaries, activity cleanup, exploration cancellation/pagination, saved-call authorization, and recent snapshot reads. Check formatting on changed files. Parent runs aggregate typecheck. Use local fixtures only; no accounts, builds, jobs, commits, or pushes.

## Deferred

- Replacing the bundled dependency-pin test needs a functional dispatcher/proxy verification plan first.
- Keep dependency-light question constants and TypeBox enum helpers; they protect useful boundaries.
- Do not rename serialized `retained` fields or capability strings. Do not split the shared worker pool; that would change resource limits.

## Results and second review

- Passed 94 focused tests: mission tools/activity (42), exploration/saved-call comparison (16), relocated exploration/recent history (8), call paths/impact (26), and the two changed observer integration cases (2). All runs removed inherited `PILOT_*` variables and used local fixtures.
- Formatting passed for the 13 changed kernel source/manifest files. Diff whitespace checks passed.
- Second review checked all renamed consumers, the relocated payload fixture, observer detach ownership, unchanged serialized fields, and all three write-validation boundaries. Worker lifecycle and validator bodies match their originals apart from names and formatting. No new residual issue found.
- No large-session performance claim: this pass preserves the worker implementation and scheduling limits. Aggregate typecheck belongs to the parent verification pass.

## Follow-up: falsy cancellation reasons

Cross-review found a pre-existing bug preserved by the worker extraction: the lifecycle used the cancellation reason as a boolean. `abort(false)`, `abort(0)`, and `abort("")` could accept a late success or send bytes after cancellation. Keep a separate cancellation flag and preserve the reason for rejection. Keep public limits, deadlines, error messages, and join-before-release ordering unchanged.

Added a real disposable-worker fixture and six regressions covering each reason with a late success and a pending-byte response. Each checks pending-read draining, no post-cancellation byte delivery, exact rejection reason, and a successful subsequent call. All six failed before the fix and passed afterward. The existing exploration and saved-comparison cancellation cases also passed (two tests). Formatting and diff whitespace checks passed. No other kernel or Rust files changed in this follow-up.

Each focused command removed inherited `PILOT_*` variables first:

```sh
for name in $(env | cut -d= -f1 | grep '^PILOT_'); do unset "$name"; done
node --test --test-force-exit --test-concurrency=2 packages/kernel/src/analysis-worker.test.ts
node --test --test-force-exit --test-concurrency=2 --test-name-pattern='rooted path denials and cancellation|second-side failures' packages/kernel/src/exploration.test.ts packages/kernel/src/retained-call.test.ts
```

Extended the same fix to explicit `abort(null)`: queued and running abort handlers now test signal presence rather than replace a null reason. Added null to both worker-response cases and a separate queued-abort check. The focused `analysis-worker.test.ts` command above now passes nine tests. Native `abort(undefined)` still supplies its own DOMException. Formatting and whitespace checks pass.
