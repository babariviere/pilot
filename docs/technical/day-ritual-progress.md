# Native ritual progress

Day's trusted host saves explicit ritual progress in its existing private,
fsynced command ledger. It does not add a database or import the shipping
desktop's `delivery_store::Store`. That Store owns chat drafts and delivery,
has no ritual/visit records, and depends on shipping chat types.

## Native root contract

`NativeHost::open_day(source, ledger, DaySource)` pins an explicit native
selection. `DaySource` holds the OS user ID and a native-only clock callback.
The callback returns `LocalDay { date, time_zone, hour, unix_ms }`, sampled
together from the root's current local clock. It must supply the current IANA
zone, not a cached startup zone, UTC fallback or the daemon's observation time.
No calendar/clock authority is exported to TSX. Without this source, day part,
visit and ritual availability remain unknown/unavailable. The mock constructor
and live app selection do not change.

The production native bootstrap still needs to bind its audited native clock/time-zone source and supply
`RitualFeed::from_host` under its root owner. This change does not pretend that
the currently mock-only bootstrap already has a native clock provider.

Identity is the exact profile path, OS user ID, daemon ID and storage lineage.
Progress keys additionally contain the local date and zone. Project switches
within one profile do not make another daily ritual. Date/zone changes select
another key and create a fresh opaque context token. Returning to an old key
restores its marks. Profile/user changes cannot reuse another identity's marks.
The root must close and join an old host before replacing its selection.
`NativeHost::open_with_options` can compose the clock, navigation and planning
bindings on that one host, rather than opening competing ledger writers.

## Typed feed for UI integration

`RitualFeed` has no TSX constructor. Its snapshot contains:

- `availability`: `available`, `unavailable` or `unknown`.
- An opaque `context`, storage `revision`, date, zone and day part.
- `start` and `end`: explicit `mark` (`unmarked`, `done`, `skipped`) and
  resume `step` (0 through 32). A saved step is never completion.
- `visit` and exact decimal `lastLookedAt` milliseconds. An absent saved visit
  stays Unknown: absence cannot prove the user never looked before. A saved
  explicit visit makes a later open Returning.
- Separate `resultsAvailability`, `results`, and `resultsLimited`.

Mirror the snapshot and subscribe with `onChange`. On focus/day-context
refresh, call `refresh()` to sample the current native clock and read progress.
It writes nothing. The root does not poll or auto-start a ritual.

After Today is actually presented, `visit({ context, revision })` explicitly
records that visit. Background reads, opening the host, and WS activity do not.
The current context keeps the previous-visit baseline, so recording this visit
does not erase the recap while the user reads it.

`save({ context, revision, ritual, mark, step })` saves one explicit choice.
Use `unmarked` for a resume position, `done` for Finish and `skipped` for Skip.
Escape only leaves the screen and **must not call save**. Final marks cannot
be erased or changed by a late resume save. Submit only against the last
confirmed context/revision. No response is permission to resend automatically.

An ACK follows append and fsync. A failed/uncertain write keeps the last
confirmed marks and returns Unknown, never a fabricated saved Done. An entered
write failure poisons the writer. A passive read cannot bless its RAM state;
close reports the storage failure. Cold reopen validates and syncs the journal
before exposing recovered records. It never replays a save. A cut-off/corrupt
ledger refuses recovery, rather than replacing it with an empty state.

The existing 64 MiB/global 16,384-record limits include rituals. There is also
a 4,096 daily-key limit. Capacity refusal evicts nothing. Native close drains
entered work, joins the worker and syncs this same ledger. Disposing a feed
only cancels its listener task; the bootstrap still owns safe close.

## Results, not inferred progress

`refreshResults()` reuses Changes' authenticated retained inventory and exact
history checks. It reads the newest 20 kept snapshots with limited history
counts; unreadable slots, incomplete history, stale identity and offline reads
stay unavailable, never a successful empty global recap. `resultsLimited`
states whether more snapshots exist. This is **kept-change evidence**, not all
results in a project. No capture, review, schedule or work is started.

Each `DoneEntry` needs matching source evidence in the read window:

- Reported: a saved completion claim names this snapshot's exact head commit.
- Landed: an observed default-branch landing names this exact target.
- Accepted: a human approval names this exact target. A later request for
  changes does not read as acceptance. This is snapshot approval, not mission
  acceptance or a current grant to act.

Movement reports, task counts, working chats and snapshot capture alone produce
no DoneEntry. Unavailable sources are not downgraded to Reported. Mission titles
are left empty when the source does not provide them. Evidence keeps the exact
snapshot and commit, rather than inventing a mission association.

The backend seam is ready for separate Opus ritual UI integration. Existing
view-local `ritualView.ts` marks are not silently migrated or treated as saved.
No live activation, visible tests, app restart or native acceptance is implied.
