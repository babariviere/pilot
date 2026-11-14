# Re-plan an old mission (plan)

Status: part 1 (Old plan label and prefill) is built; parts 2 and 3 are
proposals. Facts checked against the code at `402b0307` and read-only reads of
the live daemon on 2026-11-14.

## Goal

An old mission (created before native planning) can be re-planned as a new
mission. The user goes through the full planning interview again. When the new
plan is published, the user finishes the migration and the old mission is
archived. Its history stays.

Not in scope: changing an old mission in place ("adoption" is refused by the
daemon, `missions.ts:2813`), deleting missions, moving chats or tasks.

## Today's facts

- Old missions have no `planningVersion`. Their planning read returns
  `not-enrolled`, so Revisit and mission threads are unavailable. All 19
  missions in the `pilot` project are old.
- The planning inventory lists only active missions with `planningVersion 1`.
  The Day overview lists all active missions. Neither carries the version.
- New takes a free goal (at most 4,000 characters in Day, 12,000 bytes in the
  daemon). `FeedbackRow` already prefills it (`goalDraft`, then `openNew`).
- Published = the planning worker ran `plan-publish` (brief and `todo`
  tasks written, no worker started). The inventory reports `stage: published`.
- `POST /api/missions/:id/lifecycle {action: archive}` archives without
  deleting. It has no capability check or journal. Archive does not stop
  workers. `DELETE` cascades and must not be used.
- There is no mission-wide Stop and no mission-to-mission link.
- A managed Linear link is unique across all missions, archived ones too.
  Moving it today takes two writes, and task contributions must be detached
  first.
- Live: the old missions' 49 member chats are all parked. Two old missions each
  have 4 chats with unpublished work and no pull request.

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
2. Successor link and Re-planning label (daemon + Day, service restart).
3. Finish migration (daemon + Day).

## Open questions

- Wording of the labels.
- Should blocked and todo old tasks be offered as a checklist in the interview
  instead of plain text?
- Should finish also be possible before publication (old mission archived while
  the new one is still in review)? Proposed: no.
