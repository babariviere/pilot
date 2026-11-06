# Codebase cleanup decisions

This pass applies [untangle-codebase](https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md).
The user chose both optional comment and test cleanup, plus simpler names.
The review covered the kernel, daemon, protocol, artifacts, telemetry, test scripts and desktop.
It is not proof that the entire codebase has no remaining design problems.

## Rules

- Keep behavior, wire values, stored records, public compatibility boundaries and safety checks.
- Move code to its real owner rather than adding forwarding modules.
- Use concrete names. Prefer limited to bounded, saved or kept to retained, and writing to authoring
  when those words preserve the meaning. Do not rename a stored field or technical contract blindly.
- Remove comments that repeat code, not comments that explain outside constraints.
- Test behavior, not bundled filenames, private representations or copied implementations.

## Shared language and socket tests

- Name the WebSocket send factory `createSocketSender`, and test its deadline with a controlled clock.
  - `packages/daemon/src/backpressure.ts:15` calls a send factory `boundedSender`, which says little about its role.
  - `packages/daemon/src/backpressure.test.ts:62–71` sleeps to test a local timer, making scheduler load part of the assertion.
  - The small “oversized snapshot” case at lines 55–59 only repeats the queue-cap test; the actual frame-limit test already exists.
  - Keep UTF-8 byte limits, transport-buffer accounting, the close grace period and forced termination.
- Use plain language in user guides, agent prompts and tool descriptions.
  - These describe saved history, limited samples and writing with inconsistent, more abstract terms.
  - Keep exact schema enum values and permission/coverage limits unchanged.
- Name the ticket text helper `clipText` rather than `bounded`.
  - `packages/daemon/src/mission-ticket-context.ts:34` returns clipped text, not a general limit policy.
  - Keep its exact UTF-16 clipping and trailing-surrogate behavior.
- Check that Ask returns each allowed bundled reference unchanged, not that every file has a Markdown heading.
  - `packages/kernel/src/ask-tools.test.ts` treated JavaScript examples as Markdown documents and failed without a reader bug.
  - Keep all path, alias, cancellation and permission-refusal tests.
- Give tracking HTTP fixtures the real idle reload observer required by the server.
  - `packages/daemon/src/tracking-server.test.ts` left `piReload` out of its session stub, so server setup failed before testing tracking.
  - Do not weaken the production server with optional handling for a required service.

## Domain decisions

The read-only audits came before implementation. Each domain log records the selected fixes,
the concrete links they remove, and the special cases that remain necessary:

- [Kernel](untangle-kernel.md): mission write limits, analysis worker ownership and commit observation.
- [Daemon](untangle-daemon.md): source tool rules, GitHub URL parsing, Slack identifiers and recovery assertions.
- [Artifacts and test tooling](untangle-artifacts.md): publication preparation, shader diagnostics,
  telemetry validation, test lanes and fixture naming.
- [Desktop](untangle-desktop.md): text helpers, response-body reading and reader shutdown guards.

## Review and verification

Four auditors checked the domain changes again. Cross-review found and fixed the worker cancellation
bug described in the kernel log. The final import review found no stale imports through the removed
owners. A further static review checked that lint-related feature gates keep every native caller
and default unit fixture available. Required cancellation, authorization, durability and compatibility
boundaries remain.

- Prompt, reader, memory, ticket and socket checks: 95 passed.
- Protocol outcomes and local feature aggregates: 9 passed.
- The 20-file Node regression run passed 480 tests and found two stale tracking fixtures. After adding
  the required reload observer, the tracking file passed both tests. No production fallback was added.
- Worker cancellation and saved-call checks: 17 passed, including false, zero, empty and null reasons.
- Desktop nextest after the lint fixes: 447 selected tests passed. The 999 unselected tests were not run.
- Domain logs list the additional focused checks. Counts overlap, so they are not added together.

Workspace typechecking and Biome checks passed. Rust formatting passed for all changed files.
The first lint pass found a partial-read issue in the new HTTP test and existing test/helper lint
issues. Those were fixed without lint suppressions; native-only helpers stay behind their existing
probe feature. The final Rust tests and both default and native-probe Clippy checks passed.
Keep broad suites in CI; no live accounts,
provider calls, release activation or stored-data migration are part of this refactor. No speedup or
native visual acceptance is claimed. Desktop behavior and layout are unchanged.
