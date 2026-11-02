# Recurring schedules (design)

**Status: design proposal, not implemented.** Recurring time triggers such as "every Monday at 9:00, run a
database performance analysis". When the computer was off or asleep at the due time, the run happens once
Pilot is back. Scope is the daemon (`pilotd`) and the Rust desktop app (`apps/desktop`); the Swift app is no
longer supported and gets no work.

This builds on one-shot scheduled items (`ScheduleService`, `ScheduleStore`, `schedules.sqlite`). The
one-shot `on_wake`, `on_online` and `on_back` triggers are being removed separately; afterwards a schedule
is either `at` (one time) or `recurring` (this document).

## Summary

- A **rule** repeats daily, weekly or monthly at a local time in a stored time zone. No cron syntax.
- Its **action** starts a new chat in the project (saved prompt and model) or sends a message to a fixed chat.
- Each rule durably records the **last occurrence it handled**. On daemon start, wake or reconnect, a missed
  occurrence runs **once**, only while its period (that day, week or month) is still current. Several misses
  coalesce into one late run; the prompt says it ran late and when it was due.
- Runs wait for a working network only, never for AC power.
- **No overlap**: if the previous run's chat is still working, the occurrence is recorded as skipped.
- A rule runs on **one host**: the daemon that stores it, which is the project's home host.
- The **Inbox** shows late, skipped, missed and failed runs; **Settings** lists rules with their next due time.

## 1. Where rules live

Rules are rows in the existing `ScheduleStore`, dispatched by `ScheduleService`. They are **not** entries in
the project automation definitions (`Project.automations` in `projects.json`, see
[automations.md](automations.md)).

| Concern | ScheduleStore (chosen) | Project automation definitions |
| --- | --- | --- |
| Actions | Already has new-chat (`SpawnRequest`) and fixed-chat message targets | Shell and follow-up actions on a chat's own workspace; no chat creation |
| Durable per-occurrence claim | SQLite revision/state compare-and-swap, interrupted claims never replayed | Would need a second state store beside `projects.json` |
| One host | A row lives in one daemon's `schedules.sqlite`, so it runs exactly there | Definitions are meant to sync to every linked host, which would need a home-host filter |
| Fixed-chat target | Chat IDs are host-local, which fits a host-local row | A synced definition cannot point at a host-local chat |
| UI and timers | Existing roster, nearest-deadline timer, online gate | None yet |

Automation definitions stay for workspace and run lifecycle hooks. Project settings may show both lists on one
Automations page, read from their own endpoints. A later flow format can start a flow from a recurring rule by
adding a third target kind; nothing here blocks that.

## 2. Data model

```ts
// packages/protocol/src/schedules.ts (after the one-shot wake/online/back triggers are removed)
export type ScheduleTrigger = "at" | "recurring";

export interface ScheduleRecurrence {
	every: "day" | "week" | "month";
	/** Local wall time, "HH:MM", 24-hour. */
	time: string;
	/** IANA zone, captured from the app when the rule is created ("Europe/Paris"). */
	timeZone: string;
	/** day only: 1 = Monday … 7 = Sunday. Omitted means every day. */
	weekdays?: number[];
	/** week only: 1 = Monday … 7 = Sunday. */
	weekday?: number;
	/** month only: 1…31. Months without that day use their last day. */
	dayOfMonth?: number;
}

export interface ScheduleRun {
	/** Epoch ms of the occurrence this record handles. */
	due: number;
	/** When it was handled. */
	at: number;
	outcome: "started" | "sent" | "skipped_running" | "missed" | "failed";
	/** Started more than 5 minutes after due. */
	late?: true;
	/** started: the new chat; sent: the target chat; skipped_running: the chat still working. */
	sessionId?: string;
	/** missed: how many occurrences this record covers. */
	count?: number;
	error?: string;
}

export interface ScheduledItem {
	// existing fields …
	trigger: ScheduleTrigger | "removed";
	/** at: the one-time instant. recurring: the next due occurrence, computed by the daemon, read-only. */
	at?: number;
	recurrence?: ScheduleRecurrence;
	/** recurring: occurrences at or before this instant are handled. Starts at creation time. */
	handledThrough?: number;
	/** recurring: newest last, at most 10. */
	runs?: ScheduleRun[];
	/** recurring: the run the Inbox shows until dismissed. */
	notice?: ScheduleRun;
	/** recurring: no occurrences are handled while paused. */
	paused?: true;
}
```

- A recurring row stays `pending` while active. `dispatching` is the claim for one occurrence, after which the
  row returns to `pending` with the next `at`. Delete cancels it like a one-shot item (`cancelled`).
- `handledThrough` is the durable "last occurrence handled". Creation sets it to the creation time, so a new
  rule never catches up times before it existed. An edit to `recurrence` sets it to the edit time. Resume after
  pause sets it to the resume time: paused time is not caught up.
- Recurring chat targets need a `projectId` (no `cwd`-only, `missionId` or `trackedItemId` targets). Message
  targets keep the target chat's project, as today.
- Limits: at most 50 active recurring rules per host, inside the store's existing 1,000-row and payload limits.

**Time computation** runs in the daemon with `Intl` and the rule's `timeZone`, so a laptop that travels still
runs at 9:00 in the stored zone (Settings shows the zone when it differs from the computer's). A local time that
does not exist on a DST spring-forward day runs at the first valid minute after it; an ambiguous fall-back
time runs at its first instance. `at` is recomputed on load, after each claim and after edits.

## 3. Dispatch and catch-up

Each sweep (daemon start, timer, wake, network back, store change) evaluates every active rule:

1. `due` = the latest occurrence at or before now. If `due <= handledThrough`, there is nothing to do.
2. **Period check.** The period is the local calendar day (daily), week starting Monday (weekly) or month
   (monthly) that contains `due`. If now is past its end, record `missed` (with `count` of unhandled
   occurrences), set `handledThrough = due` and run nothing. A daily rule at 23:50 that wakes at 00:10 has missed
   its day; a weekly Friday rule that wakes on Monday has missed its week.
3. **Coalesce.** Otherwise only `due` runs. Unhandled occurrences before it, in earlier periods, are folded into
   the same record's `count` (daily, weekly and monthly rules have at most one occurrence per period).
4. **Network gate.** Wait until the existing reachability check (`refreshOnline`) succeeds. Wired networks and
   hotspots count; power state does not. A period that ends while waiting turns into `missed`.
5. **Claim.** Compare-and-swap the row to `dispatching` with `handledThrough = due` in the same write, before any
   side effect. That write is the at-most-once guarantee for the occurrence.
6. **Overlap.** If the previous run's chat (the newest run's `sessionId`, or the fixed target chat) is
   `SessionSummary.working`, record `skipped_running` and dispatch nothing.
7. **Dispatch.** New chat: `sessions.spawn` with the saved request, title `<rule title> · <local date>`.
   Message: `sessions.send(…, "followUp", "schedule:<id>:<due>")`. Record `started`, `sent` or `failed`, return
   the row to `pending` and arm the next `at`.

**Late runs.** A run starting more than 5 minutes after `due` is late. Its prompt starts with one line before
the saved text:

```text
<schedule rule="Weekly DB performance analysis" due="2026-11-02T09:00+01:00" started="2026-11-02T14:12+01:00">Started late: Pilot was off, asleep or offline when this was due.</schedule>
```

The saved prompt stays the user's own input (request IDs `schedule:…` map to user origin, as today).

**Failures and restarts.**

- A row found `dispatching` on load records that occurrence as `failed` ("interrupted; delivery is uncertain,
  check the chats"), returns to `pending` and continues with the next occurrence. It is never re-dispatched.
- A spawn or send error records `failed`; the rule stays active. A deleted target chat or removed project pauses
  the rule with that error, since it can never succeed.
- Sleep pause: no dispatch while the daemon is in the sleep pause; due work waits and runs after wake (late if
  more than 5 minutes).

## 4. Wake and network detection

Removing the one-shot wake/online/back triggers removes the sleep/wake latches. Recurring rules do not need
them: a calendar deadline plus the durable `handledThrough` already tells, on any sweep, what was missed while
the computer was off or asleep. The scheduler needs only:

- **One nearest-deadline timer** over `at` for both kinds. Node timers on macOS keep counting during sleep, so an
  overdue timer fires right after wake. Linux timers stop during suspend, so the armed delay is capped at
  15 minutes there.
- **A sweep on wake** from the power helper's wake events (`SystemPowerSource`) when available. No subprocess wake
  sampling is needed for schedules.
- **The online check** before dispatching due work, and the offline→online edge to resume waiting work.

One behavior changes with recurring rules: today detection is active whenever any pending row exists, which
keeps a reachability probe every 30 seconds. Active recurring rules always exist, so detection must be active
**only while due work waits for the network**. At a due time the scheduler runs one `refreshOnline`; only when
it fails does detection start its offline backoff probes, and it stops again once nothing due is waiting.
One-shot `at` items benefit from the same change.

## 5. One host

A rule runs only in the daemon whose `schedules.sqlite` holds it. The app creates it on the project's home host
(Local unless the project lives elsewhere). Linked placements of the project on other hosts get no copy, and
rules are not part of environment profile sync. When the home host is off, nothing runs elsewhere; it catches
up under the rules above when it returns.

## 6. API and authority

- `POST /api/schedules` with `trigger: "recurring"` and `recurrence`; `PATCH` edits title, recurrence, target,
  `paused` or `dismissNotice: true`, with `expectedRevision`. `at`, `handledThrough`, `runs` and `notice` are
  daemon-owned and rejected from clients.
- A recurring rule starts chats repeatedly and spends model budget, so create and edit require the native
  host-action capability (`x-pilot-github-capability`), like automation definition writes. An agent with
  loopback access cannot add one.
- Create and edit carry `expectedHome: { daemonId, lineageId }`, checked before the row is written, so the app
  never creates a rule on a different daemon than it checked (the gap described in
  [schedule-creation.md](../apps/desktop/docs/schedule-creation.md)). One-shot creation can adopt the same field.
- `GET` stays passive. The roster and WebSocket `schedules` message carry the new fields unchanged.

## 7. Presentation (apps/desktop)

**Settings → Schedules** (the current read-only Scheduled messages roster, which gains management), following
the calm settings list pattern:

```text
Schedules                                          [+ New schedule]
3 recurring · 1 one-time

Needs you
  ● Weekly DB performance analysis   Skipped: still running            ›
Recurring
  ○ Weekly DB performance analysis   Mondays 09:00 · next Mon 9 Nov    ›
  ○ Daily dependency check           Weekdays 08:30 · next tomorrow    ›
  ◌ Monthly cost report              Paused                            ›
One-time
  ○ Follow up on deploy              Thu 5 Nov 14:00                   ›
```

- The editor offers Repeat (Daily, Weekly, Monthly), the day choice for that repeat, Time, Time zone (defaults to
  the computer's), then the action: **Start a new chat** (project, model, prompt) or **Send to a chat** (chat,
  message). A summary line under the form reads "Every Monday at 09:00 (Europe/Paris). Next: Mon 9 Nov."
- Details show the last runs (`runs`) with links to their chats, and Pause, Resume, Delete.

**Inbox.** A rule with a `notice` appears as one row in Needs you, linking to its chat or the rule:

| Notice | Row | Counts in the badge |
| --- | --- | --- |
| late | `Weekly DB performance analysis ran late · due Mon 09:00, started 14:12` | no |
| skipped_running | `… skipped: the previous run is still working` | yes |
| missed | `… missed 2 runs: Pilot was off` | yes |
| failed | `… failed to start: <error>` | yes |

A notice is replaced by the next noteworthy run, and cleared by Dismiss or by the next on-time successful run.

## 8. Implementation split

Each step is one PR with focused tests (injected clock and time zone, temporary directories, faux sessions).

1. **Model and store**: protocol types, recurrence validation, occurrence and period computation with DST cases,
   `handledThrough` on create, edit and resume, capability and `expectedHome` checks, load repair of interrupted
   claims.
2. **Dispatcher**: catch-up, coalescing, period expiry, network gate, claim, overlap skip, late prompt line,
   runs and notices; detection active only while due work waits; wake sweep; Linux timer cap. Needs the
   one-shot trigger removal to land first.
3. **Inbox and dashboard**: notice projection into Needs you, badge rules, `dismissNotice`.
4. **Desktop app**: Settings → Schedules list, editor and details; Inbox rows.

## 9. Open questions

1. **Week start.** Weeks start on Monday for the catch-up period. Make it follow the system locale if needed.
2. **Run now.** A manual "Run now" in details is easy to add later; it would not move `handledThrough`.
