# Pilot Day #35: legacy retirement audit

**Blocked.** This is a source and task-record audit, not an approved removal list.
Source baseline: `00fdadfb`. Mission brief: revision 45.

## What blocks removal

| Gate                                                            | Status in Pilot Day on 2026-11-20                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| #32, explicit Mac cutover after #31 Mac daily-use qualification | Todo. A signed candidate or a working Day install is not proof of an approved switch.                            |
| #33, final Linux qualification                                  | Todo. Requires physical x86_64 KDE Plasma Wayland hardware, three working days, and user review.                 |
| #34, full native screen-reader walkthroughs                     | Todo. Required for #35, even though it does not gate the first Mac switch.                                       |
| Separate approval of exact removals                             | Not evidenced. Approval to qualify Day, switch the default app, or publish this audit does not approve removals. |

## Predecessor evidence

The Pilot project's Knowledge record **Pilot Day: complete old-task index and delivery
reconciliation** (`a1f18464-5433-4aae-adee-dd45fd1d6c35`, revision 2) is the existing
205-task index. A read-only comparison verified that every task number, ID, and status
matches the replaced **Pilot Day Redesign** mission: 173 Done, 23 Blocked, 7 Todo, and
2 Dropped. This verifies the inventory, not the recorded outcomes. The
[Today qualification report](day-today-qualification.md) identifies the linked Day,
distribution, ownership, artifact, and power inventories and distinguishes their
source audits from native observations.

Before removal, join those inventories to current evidence for each affected task and
safeguard: exact replacement source, relevant checks, native/user evidence if required,
and remaining gap or explicit retirement decision. Do not count a predecessor's Done,
mock, or historical test claim as current replacement evidence. For example, the old
index records delivered artifact preview work under #176 but broader artifact scope
still blocked under #27. Old #202–205 record installed regressions; current source by
itself proves neither that they persist nor that they are fixed in a package.

## Surviving callers and data

- **GPUI:** [Keep it usable](../../apps/desktop/README.md) through cutover. The daemon
  database feature was removed in `692a5716`, but mission decision #1 defers the
  [GPUI database question code](../../apps/desktop/src/database_access.rs) to #35.
  Do not reopen database access or change saved GPUI drafts as a side effect.
- **Build, update, and release:** [Day's native manifest](../../apps/day/native/Cargo.toml)
  depends on the updater under `apps/desktop` on Mac and Linux.
  [Day qualification CI](../../.github/workflows/day-qualification.yml) calls shared
  build, helper, packaging, and verification scripts there. Its unsigned qualification
  bundle is not the signed release path. [GUI Package](../../.github/workflows/gui-package.yml)
  and [Release](../../.github/workflows/release.yaml) still call tooling under
  `apps/desktop` or `apps/macos`. Prove a working replacement before dropping any
  old entry point.
- **Swift GUI and helpers:** The obsolete Swift GUI was removed in `632281f4`.
  [The helper-only Swift package](../../apps/macos/Package.swift) and
  [bundle tooling](../../apps/desktop/scripts/bundle_runtime.py) still support
  SystemEvents, power, and visual artifacts. Keep the Swift and C helper sources,
  assets, notices, and packaging Day uses. A minimal connected candidate is not
  the full helper inventory.
- **Remote-backed mode:** [Remote devbox execution is already retired](devboxes.md).
  [The compatibility adapter](../../packages/daemon/src/retired-devboxes.ts) still
  reads old ownership records and refuses delegated admission. Preserve cached history
  with original host identity and unresolved ownership and operation records.
  Do not turn remote drafts or runs into Local work.
- **Old mission and flow execution:** [Finishing a re-plan](day-mission-migration.md)
  archives the source mission, preserving original tasks, chats, and unpublished
  work. It does not transfer execution or managed Linear resources.
  [Automation definitions](../../packages/daemon/src/automation-definitions.ts)
  still validate flows. The [daemon HTTP server](../../packages/daemon/src/server.ts)
  still has a gated flow Start route, and
  [session supervision](../../packages/daemon/src/sessions.ts) still calls `resumeFlows`.
  Split execution and scheduling from definitions and read paths.
  Account for unfinished runs before disabling their writer or recovery code.
- **Shared-note summarizer:** [Daemon startup](../../packages/daemon/src/daemon.ts)
  wires the [project memory service](../../packages/daemon/src/project-memory.ts)
  without a summarizer. The old implementation remains in source, but the service
  does not schedule it without that dependency. Preserve disk and history access
  independently of any code removal. Ordinary chat context compaction is separate.
- **Advanced closed-lid power:** [Daemon power control](../../packages/daemon/src/power.ts)
  still handles closed-lid policy. Separate it from ordinary keep-awake, native
  sleep notifications, and selective connectivity recovery. Reconcile any Pilot-owned
  setting before dropping the old path.

## Evidence needed for an exact removal proposal

1. Record the completed gates and identify the exact replacement source, packaged builds,
   app and service owners, and recovery path on each supported platform.
2. List exact source paths, routes, dependencies, packaging entries, settings, and draft
   stores to remove. For each, identify surviving callers and state where the behavior or
   data moves. Leave an item out if its callers or ownership are unknown.
3. Show that original mission, flow, chat, and review history and artifact links remain
   readable after reopen. Preserve needed readers and provenance. Account for unfinished
   runs and each owned setting. List the unwanted UI drafts separately; do not infer that
   an unknown draft or unpublished workspace can be discarded.
4. Obtain explicit approval of that list before removal. Then verify the remaining
   package, release, launch, update, rollback, and service paths on their supported
   baselines. Check CLI and background callers, including schedules, recovery, and
   power. Read back kept history and artifacts with representative old records.

Audit checks covered source inspection, the read-only task comparison, and docs.
No native qualification, removal, cutover, or live data change was performed.
