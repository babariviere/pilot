# Scheduled messages, read-only

Settings → Scheduled messages reads the existing Local daemon's complete schedule
roster. Scope is explicitly **all projects and chats**, not the selected chat.
One owner is created from immutable pinned `LocalOptions`; changing chat/project
does not relabel these rows as belonging to that chat/project. Target chat IDs,
project IDs and new-chat request fields come from the record, never title matching.

The native Kit List virtualizes the roster. Confirm a row with pointer or keyboard
to open literal selectable Details, including its trigger, UTC times, revision,
target/message, latches, reported state and reported error. New-chat requests are
inert JSON, not executable controls. Refresh is the only read action after opening.
No create/edit/cancel/dispatch/pause/enable, activity promotion, service, credential,
provider or account action is exposed. Management remains separate work.
One-time creation was separately audited: the existing POST lacks a mutation-time
daemon/lineage precondition. See the [creation blocker and isolated evidence](schedule-creation.md).

## Existing passive contract

`GET /api/schedules[?projectId=…]` routes directly to
`ScheduleService.snapshot` → `ScheduleStore.snapshot` → worker `snapshot`.
That worker only SELECTs, optionally filters exact project ID and JSON-encodes.
`GET /api/schedules/:id` calls `require`, a clone of the cached stored record.
Neither path validates targets, refreshes reachability, queues a sweep, arms a
timer, changes latches/state/revision, or invokes session/provider work.

Do not confuse reads with startup: `load` repairs interrupted/retired records;
`start`, timer callbacks, store changes and detector signals can dispatch. The
app does not call those operations. The server's independent scheduler can still
dispatch while a read is in flight. A GET response is only an observation, not a
dispatch receipt or proof of agent completion.

The store already limits retained records to 1000 and target payloads to 4 MiB
(16 KiB per target). Native reads accept up to 8 MiB wire bytes for the full index
and metadata. Oversized/malformed/duplicate responses are rejected as a whole,
never partially displayed as empty. Only the existing fixed list GET is used,
with hello daemon/lineage checks before and after, no redirects/retries, a bounded
cancel-on-replacement reader and generation fencing. No schedule WS subscription
or polling is added. Opening/Refresh uses the existing loopback contract, not
authentication. No filesystem fallback exists.

## Meaning and presentation

Historical Swift `ScheduleUI.swift` offers creation/edit/cancel and mostly filters
to pending/failed rows. Next deliberately retains every reported state here,
including cancelled and unknown, with exact target details. `at` is epoch
milliseconds. All displayed times are explicitly UTC, not guessed local timezone.
Pending deadlines earlier than the read time say overdue **at last read**, not
sent. `fired` means the dispatch call returned, not that the agent succeeded.
`dispatching` has no confirmed delivery; `failed` retains its error, including
interrupted-delivery uncertainty. Unknown state/trigger labels remain unknown.
Wake/online/back triggers are one-shot event conditions, not calendar dates.

Loading is not empty. Read errors/unavailable/identity refusal retain the previous
report with a stale notice and unchanged last-read time. Successful empty reports
clear prior rows/details. Leaving or closing cancels the reader and invalidates
its generation; reopening reads again. No cross-daemon owner/cache is shared.

## Verification

`schedules-passive.test.ts` runs an isolated real HTTP server, SQLite worker and
started scheduler with an injected clock. After its deadline passes without the
timer callback, repeated list/project-filter/detail/missing GETs leave the row,
revision, latches and timer untouched. Session validation/send/spawn, project and
ticket validation, ticket mutation and reachability probes are forbidden spies.
No provider or real data is used. This proves reads do not initiate dispatch,
not that the real scheduler cannot independently dispatch concurrently.

`scheduled_messages_tests` covers exact target/text/time/status interpretation,
malformed/duplicate/oversized bodies, scope IDs, stale generations, empty reports,
hello changes before/after reads and replacement cancellation. The hidden
`scheduled_messages` probe exercises actual Settings navigation and Kit List at
680/1100, light/dark (theme asserted after production window-open appearance),
loading, time/failed Details, keyboard confirmation, Unicode selection/copy,
stale/error/empty and navigation cancellation against faux HTTP only. Screenshots
are native synthetic fixtures, not production acceptance or OS IME qualification.
