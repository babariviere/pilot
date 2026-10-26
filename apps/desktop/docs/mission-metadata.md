# Edit a Local mission's title and goal

Overview's contextual **Edit mission** opens a retained native form for that
exact canonical Local home, mission and project. Save (Command-Return) changes
only title and goal. Close/Escape keeps the draft in this window, not across
process restart. The brief, revisions, tasks, membership, coordinator, project,
lifecycle and conversations are not form fields or outgoing payload fields.

## Source audit

- Swift `EditMissionSheet` in `MissionSheets.swift` calls
  `PilotClient.updateMission` with `UpdateMissionRequest`. Unlike that sheet,
  this scoped form does not expose or send phase gating.
- `server.ts` `missionRoute`: `PATCH /api/missions/:id`, JSON object,
  response **200 with a raw Mission**, not detail or a receipt wrapper.
- `missions.ts` `update`/`text`: ECMAScript trim, nonblank title, empty goal
  allowed, raw JavaScript string lengths at most200/4000 UTF-16 units.
  Native edits reject over-limit paste atomically, retaining prior text.
- No expected version, CAS or idempotency key exists here. Both fields are
  written on explicit Save, so concurrent changes can be overwritten. Identity
  preflight is not conflict protection. This is disclosed beside Save.
- Metadata edits do not request lifecycle, phase, task or member changes and
  do not start an agent. Store `changed()` still publishes existing mission
  context updates and adds the existing metadata activity event when changed.
- Mission mutation HTTP responses pass through `acknowledgeWhenDurable`, which
  withholds completion until `MissionStore.durable()`. The client validates a
  complete200 body, identity and normalized captured content; it does not infer
  a separate persistence receipt from a later GET. Publication/listeners can
  fail after COMMIT, and durability failure can destroy the response.

## Ownership and uncertainty

At most16 retained forms are pinned to home/mission/project and Local connection.
Each has bounded input and at most one immutable pending save. No redirects,
HTTP retry or fallback host. The transport verifies hello/catalog canonical
identity and full, unclipped metadata before sending only `{title,goal}`.
Close/navigation neither cancels an admitted write nor drops its late result.
Late results update only their retained exact attempt, never focus or another
mission. No-op content does not send. A confirmed save can explicitly enter a
fresh edit; pending and Unknown cannot. Failure before PATCH is Not sent and
may be explicitly retried; every attempted write without a validated200 ACK
is Unknown, including400/409/500, interrupted/oversized/mismatched JSON.
Unknown retains text and exposes Copy, without replay or GET-match settlement.

Shared native textarea, semantic text/actions/notices and the existing reading
column are used. Plain Return edits; Command-Return saves; Escape closes.
Preedit fences Save/Close/navigation and sibling mousedown before blur. Browser
restores mounted page focus before unmount. No composer or transcript mutation.

## Scoped verification

`python3 scripts/check-scoped.py --unit mission_metadata --test mission_metadata --lint`
selects only the metadata state/transport tests and offscreen production
Browser/form journeys at680/1100 light/dark. The normal shared verification
slot and mbx CPU2/4GiB/private target constraints apply. Native probes use only
an owned synthetic HTTP server. They do not mutate a live profile or establish
OS IME, accessibility, animation, Linux/Wayland or full-app acceptance.
