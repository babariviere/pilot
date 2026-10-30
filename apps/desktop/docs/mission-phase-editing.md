# Mission phase definition editing: blocked contract audit

Source reconciliation on 2026-10-30 against
`d3d7d631e3125d04ee727ab7ef6f18a4d82a48b1`. No editor or backend
behavior is added. The existing REST contract cannot safely provide the selected
definition-only create/rename/description slice. Do not expose its writes behind
a new native Save button without a separately approved contract change.

## Current native and historical behavior

- Historical `apps/macos/Sources/Pilot/MissionPhases.swift` provides a phase
  header menu and `MissionPhaseForm` popover for name and optional goal. Create
  calls `createMissionPhase` (including next order); edit calls
  `updateMissionPhase` with name and goal. Empty goal clears the description.
  Move/delete/drop handling also exists there but is outside this slice.
- Native `mission_phases::Index` validates and orders first-class IDs, supports
  legacy milestone-name display, and groups empty phases and unphased tasks.
  `mission_overview_view::phase_row` shows progress and opens Tasks.
  `mission_tasks_view::Rows::render_item` renders folding phase headers with
  counts, not an edit menu or description. `Index` retains ID/name, not goal.
  Create/rename/description editing is genuinely missing, not hidden elsewhere.
- Keep the existing phase display, canonical IDs, task semantics and generation
  fences. Legacy milestone names and “No phase” are not editable phase IDs.

## Existing transport and admission

`packages/daemon/src/server.ts::missionRoute` dispatches directly to the store:

| Request | Store call | Success body |
| --- | --- | --- |
| `POST /api/missions/:id/phases` | `addPhase(id, write)` | 201, raw `MissionPhase` |
| `PATCH /api/missions/:id/phases/:ref` | `updatePhase(id, ref, write)` | 200, raw `MissionPhase` |

`MissionPhaseWrite` in `packages/protocol/src/index.ts` has only optional
`name`, `goal`, `order`. The description is `goal`, not a new payload field.
Name is required on create, nonblank after ECMAScript trim, at most 200 UTF-16
units; goal permits empty text and at most 4000 UTF-16 units. Omitted goal
preserves it on edit; empty goal clears it. Name collisions return Conflict.

Both calls default to trusted local `USER`, not a request-supplied session actor.
`MissionStore::assertPlanner` permits that path in planningVersion 1. Worker IPC
uses its actual actor: v1 members cannot plan unless they are the coordinator;
unsupported planning versions fail. Legacy missions retain legacy admission.
The loopback route is not an authenticated user-identity boundary.

`acknowledgeWhenDurable` withholds mutation response completion for store
durability. It supplies neither an operation receipt nor an idempotency key.
Listener failures can occur after COMMIT; error/connection loss cannot establish
that a write was not applied. A later matching GET is not an exact attempt ACK.

## Concrete blockers

1. **Create has lifecycle/agent-notice effects.** `insertPhase` queues phase
   reconciliation. The ordinary transaction marks the empty phase completed and
   adds `Phase completed: …` with `wake: true`, producing a pending coordinator
   notice. `MissionNotices` can deliver it through `sessions.sendNotice` when
   eligible, not necessarily immediately. A definition-only create cannot opt
   out. The synthetic test prepares this notice but never delivers it or starts
   a session.
2. **Both writes are ordinary, not passive mutations.** Their transaction runs
   global `reconcileLinearSync`; `changed(id)` publishes with passive=false and
   preferenceOnly=false. `MissionService` requests linked-PR/main refresh, and
   ordinary notice/Linear-PR listeners schedule their work. Changed member
   contexts can reach `SessionManager::missionChanged`, which can resume queued
   role work or reconcile archive state. Context deduplication often suppresses
   member callbacks for name/goal-only edits because phase definitions are not
   in `MissionContext`. This is a conditional path, not evidence that every
   phase rename starts an agent. PATCH does not itself queue phase completion
   reconciliation; its direct task write only updates the compatibility
   `milestone` alias, preserving authoritative `phase_id` and task status.
3. **Even a captured canonical ID is not an exact target.** `resolvePhase`
   searches ID, then name. Reproduce: capture phase A's UUID, create phase B
   whose name is that UUID, delete A, PATCH A's UUID. B is changed and returned.
   A response-ID check rejects the ACK only after the wrong write happened.
   A preflight GET cannot exclude deletion/name creation between read and write.
4. **There is no atomic captured-definition precondition.** A coordinator can
   change name/goal after an editor captures them; a stale explicit Save
   overwrites them without Conflict. Sending fewer fields reduces overwrite
   scope but does not detect concurrent edits to the same field. There is no
   revision or captured-row condition in this contract. Client generation
   fences protect presentation, not server-side admission or this race.

The minimum unblock needs separately scoped backend approval for passive phase
definition writes with strict mission/project/phase identity and atomic captured
definition validation, while preserving existing callers, planner authority and
task semantics. The exact new API remains a decision, not an implementation here.
Do not use existing endpoints, optimistic UI, preflight reads or blind retries
as substitutes. Pending/Unknown drafts must remain attributable to their exact
immutable attempt if a safe editor is later approved.

## Verification and remaining scope

`packages/daemon/src/phases.test.ts` adds five in-memory characterization checks:
completion notice, ordinary publication/Linear entry, deleted-ID alias
retargeting, planner admission/concurrent overwrite, and throw-after-commit.
They record current limitations, not desired future safety guarantees. The full
file also covers durable restart, migration, gating, progress and task identity.
The phase and planning files passed together (18 tests); scoped Biome check and
TypeScript checking of those files and their imports passed. Repository-wide
`tsgo -p tsconfig.json` remains blocked by unchanged errors in
`server-durable-send-telemetry.test.ts` (environment type, lines 64/94) and
`server-mcp.test.ts` (`finish` on never, line 88). Biome reports the existing
schema-version and literal-key informational diagnostics, not new lint errors.
No production behavior changed; no real mutation endpoints, agents, providers,
apps, services, installs or releases were invoked.

No native UI was added, so 680/1100 light/dark, popup keyboard/focus/IME,
selection/drafts, conflict/error/Unknown/project-switch journeys and native
lint/plain builds were not run or claimed. Those remain required for the future
editor. No Cargo/mbx/private target or heavy native resource slot was needed.
Deletion, order/drag, gates/autostart/progress and task reassignment remain
separate unfinished work under the existing phase-management parent.
