# Re-plan an old mission (plan)

Status: parts 1 (Old plan label and prefill) and 2 (successor link) are built.
Day now exposes reviewed finish without Linear transfer through the native operation journal.
Opening a replacement first offers context sections and preserves an existing New draft unless
the user explicitly replaces it. Window capture keeps the replacement origin without enrollment.
Earlier facts below were checked against the code at `402b0307` and
read-only reads of the live daemon on 2026-11-14.

## Goal

An old mission (created before native planning) can be re-planned as a new
mission. The user goes through the full planning interview again. When the new
plan is published, the user finishes the migration and the old mission is
archived. Its history stays.

Not in scope: changing an old mission in place ("adoption" is refused by the
daemon, `missions.ts:2813`), deleting missions, moving chats or tasks.

## Implemented finish contract

Authenticated `GET /api/missions/:oldId/successor/preview` returns the exact `oldSource`,
`newSource`, successor publication, both missions, member IDs and managed Linear resources.
It does not pause, archive, transfer, grant permission or start work.
The native preview also includes `oldBrief`, `newBrief`, `oldTasks`, `newTasks` and `keptChats`
(ID, title, archive time and cached `unpublishedWork: true | null`). Null means unknown, not clean.
The sources bind these displayed records and cached chat facts. The native read rechecks them after
durability; native finish recomputes them at its transaction boundary. No workspace scan runs.

Native durable kind `mission-replan-finish` uses the old mission target, binding ID `oldSource`,
generation 1, and `{purpose,newMissionId,projectId,oldSource,newSource,transferLinear:false}`.
Both missions must still be active in the same project, the old mission must remain legacy,
and its exact linked successor must be published. Old members and assigned chats require an
acknowledged existing Mission Pause covering them. Idle or parked is not safe checkpoint proof.
Refresh the preview after Pause. A stale source refuses rather than substituting current bytes.

One SQLite transaction archives the old mission, finishes the successor link and saves the
receipt. All tasks, history, chats and unpublished work stay. The successor gets no Start or
permission grant. Exact operation receipt lookup recovers lost replies, never repeats effects.

Managed Linear resources stay on the old mission. Transfer is currently unavailable, and
`transferLinear:true` is refused. Any future transfer needs its own explicit resource/contribution
preview and sync drain, not the automatic transfer proposed below. No live acceptance or real
worker process proof is claimed by the fake-participant backend tests.

## States

- **Old plan**: active, shown on the dashboard, and not in a complete planning
  inventory read. Derived, no stored field, no per-mission read. If the
  inventory read fails, no label shows (unknown is not "old").
- **Re-planning**: the old mission has an open successor link (below). Its page
  names the new mission. The new mission's page names the old one.
- Neither counts in Needs you.

Labels: "Old plan" with the action "Re-plan as a new mission", then
"Re-planning as <title>". Wording to confirm with the user.

## Steps

### 1. Prefill (Day only)

On an old mission's page, "Re-plan as a new mission" builds a draft goal in
Rust from the mission detail and opens New with it, in the mission's project.
It refuses when New already holds a draft (same rule as FeedbackRow).

The draft holds, cut to fit 4,000 characters in this order: title and goal;
brief (first paragraphs); decisions still in force (number and text); open and
blocked tasks (title and status, capped); tasks with unpublished work; the
managed Linear ticket. The user edits it. Nothing is sent until Plan.

### 2. Plan with a successor link (daemon + Day)

`planning-enroll` gains an optional `replaces: <oldMissionId>`. In the same
transaction as enrollment, the daemon saves a row in a new
`mission_successors` table: `old_mission_id` (primary key), `new_mission_id`,
`operation_id`, `state` (`planning`, `finished`, `abandoned`), times.

It refuses when the old mission is not active, has a `planningVersion`, is in
another project, or already has an open successor. Lookup-only recovery comes
from the existing operation journal. Hello gains `missionReplanning: 1`; Day
hides the button without it.

Reads: the Day overview's dashboard missions and the planning inventory items
gain `successor` / `replaces` (`{missionId, state}`) from this table.

"Stop re-planning" sets `abandoned` and changes nothing else. The new mission
stays and can be archived by itself.

### 3. Finish (daemon + Day)

When the new mission's inventory stage is `published`, both pages offer
"Finish migration". The confirmation lists what will happen and what is kept:

- the old mission is archived (history, comments, decisions and chats kept);
- its managed Linear ticket moves to the new mission;
- chats with unpublished work, listed by title (they are not archived).

A new native durable operation `mission-replan-finish`
`{oldMissionId, newMissionId, expectedOldStatus, operationId, home, projectId}`
runs in one daemon transaction:

1. Refuse unless the link is `planning` and the new mission is published.
2. Refuse while any old member chat is working (list them). No Stop is sent:
   per-session Stop raises the old mission's stop generation and Day never
   stops work on a guess.
3. Refuse when the old managed Linear link still has task contributions
   (list them). Otherwise move the link: old resource becomes `reference`,
   new resource `managed`, in one transaction (new store method), so the
   unique-ticket rule never sees two managers or a gap. The saved `paused`
   sync state is copied, not reset.
4. Archive the old mission with the existing passive lifecycle.
5. Set the link `finished`.

Capability-checked like other native operations; recovery is receipt lookup
only. A lost reply shows Unknown with Check.

## Tests

- Daemon (node:test, temporary profile): successor row with enrollment; each
  refusal; abandoned; finish moves Linear atomically and archives; refusals for
  working chats, contributions and unpublished plans; lost reply recovery by
  lookup; overview and inventory expose the link.
- Day native: prefill text and cut order from a recorded legacy detail; button
  only for old missions with the capability; finish confirmation lists.
- Day TSX: labels, prefill refuses over a draft, finish flow and Unknown.
- Live acceptance (separately authorized): one small old mission end to end.

## Order

1. Built. Old plan label and prefill (Day only, no daemon change). The mission
   page decides "old" from `mission.planningVersion` in its detail read; Today
   rows from a live planning inventory. `project::replan_draft` builds the text.
2. Built. Successor link and Re-planning label (daemon + Day, service restart).
   Stop re-planning is `POST /api/missions/:oldId/successor`
   `{action: "abandon", newMissionId}` (authenticated, repeatable, no
   journal: a lost reply shows Unknown and the next read shows the link).
   A restored window keeps New's words but not which mission they re-plan.
3. Finish migration (daemon + Day).

## Open questions

- Wording of the labels.
- Should blocked and todo old tasks be offered as a checklist in the interview
  instead of plain text?
- Should finish also be possible before publication (old mission archived while
  the new one is still in review)? Proposed: no.
