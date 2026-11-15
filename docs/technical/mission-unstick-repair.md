# Mission Unstick: repair agent (plan)

Status: proposed. Nothing in this document is built yet, except the parts listed under "Already built".

## Problem

Unstick's rules (`PlanningWorkers.unstickView`) find the stuck cases we already know: an idle planner on an open
plan, answers to an earlier wording, research findings not read, and a refused save. When a case is new, or when
the rule's fix already failed once, the user has nothing to do but ask a coding agent by hand. The planner itself
is a poor helper: it is the agent that is stuck, and its context holds the confusion.

On 2026-11-15 the Pilot Day mission stopped because the map held 40 questions and Pilot refused the 42nd with
"Invalid planning list". Continue made the planner resend the same save. A separate agent that read the refusal,
the planner's last messages and the map counts would have named the cause in a minute.

## Already built

- Unstick card with rules, one fix and **Apply** (`apps/day/Unstick.tsx`, `unstickView`).
- The last refused planning save per mission (`MissionPlanStore.refused`, memory only).
- Log lines: every settled operation, planning step changes, planner input, research and question chats
  (`pilotd.log`); close steps, unsaved forms and caught window errors (`day.log`).
- The **Diagnostics** chat role (`docs/technical/agent-diagnostics.md`): Ask mode, read-only, with
  `diagnostic_context` (missions, chats, logs), `diagnostic_logs`, `diagnostic_history` for a target chat,
  and `repair_proposal` with a user-confirmed handoff to a Build chat in the repair project.

## Decision

The repair agent is a **Diagnostics chat that targets the mission's planner chat**. No new agent kind, role or
permission. It reads; it never writes the map, answers a question, starts a task or wakes the planner. It returns
one proposal. Only the user's **Apply** acts, through the same operations the app already uses.

## User flow

1. The Unstick card shows the rule result as today. When the state is **stuck**, it also shows
   **Have an agent look**. It does not appear for moving or waiting, and it never starts on its own.
2. Pressing it starts one Diagnostics chat for this mission. The card says "An agent is looking. This takes
   about a minute." and links to the chat. One repair chat per mission at a time; pressing again opens it.
3. The agent ends with one proposal. The card shows:
   - **Cause**, in plain words (at most 600 characters).
   - **Proposed fix**, from the closed list below, with the exact text it would send.
   - **How sure**: low, medium or high.
   - **Evidence**: what it read (log lines, refused operations, planner messages), as short labels.
   - **Apply** and **Not now**. The user may edit a note's text before Apply.
4. Apply re-reads the mission. If the planning state changed since the agent read it (plan revision, phase or
   interview revision), Apply refuses: "The mission changed since the agent looked. Ask again." Nothing is sent.
5. The user can open the chat and ask follow-up questions, like any chat.

## Fixes the agent may propose (closed list)

| Fix | What Apply does | Existing path |
| --- | --- | --- |
| `continue` | Continue planning | `plan-continue` |
| `planner-note` | Continue planning with a note the planner must act on, for example "The map is full: merge open research questions X and Y." | `plan-continue` with a new `note` field (below) |
| `drop-earlier-answers` | Remove saved answers to an earlier wording | `interview-save` (Unstick today) |
| `code-repair` | Open the existing repair review: a Build chat in the repair project, with the findings | `repair_proposal` + handoff (needs a Day review sheet, slice 6) |
| `none` | Show the cause only | none |

The agent cannot propose anything else. Pause, Stop, worker caps, answering questions and settling decisions stay
with the user.

## Changes

### Daemon

1. **Mission planning in `diagnostic_context` → `mission`.** Add a `planning` block, read-only:
   - `unstick` (the rule result), the planning phase, the last refused save and its reason;
   - map counts: open and settled questions, fog, saved bytes against `PLAN_STATE_LIMIT`;
   - the current round: question count, saved answers, answers to an earlier wording, submitted or not;
   - the last 20 operations on this mission: kind, state, reason, time (from the operation journal);
   - research and question chats: state and reason.
   No question text, answer text or Knowledge bodies: the agent reads those through the planner's history only
   if needed.
2. **Start operation `plan-repair-start`** (Day → daemon, journaled). It spawns
   `{ role: "diagnostics", diagnosticTarget: <planner chat>, diagnosticHistoryAccess: true }` with a fixed first
   message that names the mission, asks for the cause and one fix from the closed list, and says to answer with
   `mission_fix`. It saves `repair: { sessionId, operationId, startedFrom: contextDigest }` in
   `PlanningWorkerState`. A second start while one runs returns the same chat.
3. **Tool `mission_fix`** (host-owned, only in a Diagnostics chat started by `plan-repair-start`). Closed fields:
   `fix`, `cause`, `note` (only with `planner-note`, at most 2000 characters), `certainty`, `evidence`
   (1–16 refs that `diagnostic_context`/`diagnostic_logs`/`diagnostic_history` returned). The daemon checks the
   fields and refs, binds the proposal to the planning context digest it was made from, and saves it in
   `repair.proposal`. Calling it again replaces the proposal. For `code-repair` it also writes the existing
   `repair_proposal`.
4. **`plan-continue` gains `note`.** The planner message says: "Pilot's repair agent looked at why planning
   stopped. The user approved this note: <note>. Act on it, then continue planning. It answers no question and
   approves nothing." `note` and `feedback` cannot both be set.
5. **Read.** The planning read gains `repair: { state: "looking" | "proposed" | "failed", sessionId, proposal? }`.

### Day

6. Rust: `Unstick.repair` in `plan.rs`, parsed in `plan_host::page`; bridge commands `day.plan.repairStart` and
   `day.plan.repairApply`; host checks that the proposal's context digest matches the current read.
7. `Unstick.tsx`: the **Have an agent look** action, the looking line with the chat link, and the proposal block
   with Apply / Not now. Notes are editable in an `Input`. **Not now** hides that proposal only.
8. Later slice: a Day review sheet for `code-repair` (the GPUI app has one; Day does not). Until then Day shows
   the findings and "Copy for a chat".

### Logs

- `pilotd.log`: repair started, proposal saved (fix and certainty, not text), applied, refused as stale.
- Still missing: errors that nothing in the window catches. NSH has no global hook; ask upstream for one.

## Limits

- One repair chat per mission at a time. It protects cost: each run is one Diagnostics turn with history access.
- Proposal fields use the sizes above because they are shown in a card, not stored in history.
- The repair chat uses the Diagnostics default model. Open question: should Unstick pick a cheaper model?

## Tests

- Daemon: the planning block contents and that it has no question or answer text; `plan-repair-start` spawns one
  Diagnostics chat targeting the planner and returns it again on a second start; `mission_fix` refuses unknown
  fixes, refs not returned by the tools, and a note on a fix other than `planner-note`; `plan-continue` with
  `note` reaches the planner word for word and refuses with `feedback`; Apply after a planning change refuses.
- Day: the card shows the action only when stuck; looking state; proposal with Apply sending the fix once;
  stale refusal; Not now.
- A replay test with the 2026-11-15 case: a map at 40 questions and a refused `plan-map`. The faux agent proposes
  `planner-note`, and Apply sends it.

## Slices

1. Planning block in `diagnostic_context` (daemon only; useful at once from any Diagnostics chat). **Built:**
   `PlanningWorkers.diagnosticPlanning`; recent operations come from `OperationJournal.onSettled`, which now
   passes the receipt.
2. `plan-continue` `note`. **Built:** `{purpose, note}`, 1–2000 characters, never with `feedback`, and only when
   plain Continue is available (not while a round waits for answers).
3. `plan-repair-start`, the proposal, `repair` in the read. **Built,** with one change from the design above:
   no `mission_fix` tool. The repair chat ends its reply with one JSON block in the closed format, and the daemon
   reads it when the chat finishes (`parseMissionFix`), the same way it collects research and question answers.
   This needs no new kernel tool or worker packet. Evidence is short labels, not checked refs: Apply uses only
   `fix` and `note`. Repair chats are not mission members, so `PlanningWorkers.repairChats` maps their changes
   to the mission.
4. Day card: start, looking, proposal, Apply. **Built:** `Unstick.tsx` (`RepairAgent`), `plan_host::repair_start_request`
   and `repair_apply_request`, bridge commands `day.plan.repairStart` and `day.plan.repairApply`.
5. Docs: `docs/missions.md` user guide paragraph.
6. Later: Day review sheet for `code-repair`.
