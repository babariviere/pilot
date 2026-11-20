# Pilot refactor decisions

The audit started at `293c6e35`. The integrated changes build on `9c7c78d3`.
The scope includes structural changes, comments that only restate code, and
tests that fail without a behavior regression or cannot catch one.

## Decisions

- **Use one worker link for calls, replies and cancellation.**
  - A host call used to require matching entries in the kernel worker, the
    session adapter and daemon packet dispatch. The shared method types now
    describe both sides. The daemon still checks the current worker before
    dispatch and before replying, and each handler keeps its authority checks.
  - The process worker owns transport and packet activity. Session admission
    counts in-flight sends and releases the count it acquired, including
    Insights reviews. One release must not erase another send.
  - Request ID builders and readers share an owner. IDs already in the outbox
    and journal retain their exact spelling.
  - Shutdown stops new host calls, cancels reads and joins already-entered
    writes. The exiting worker can finish accounting before the stores close.
- **Keep one mission transaction owner and separate its readers.**
  - Mission stores used to receive copies of the same SQLite operations.
    `mission-database.ts` owns the connection, nested writes, replica and
    durability. The schema keeps its migration order. Change notices and
    reconciliation use named options.
  - Knowledge now asks the mission store for cited facts and listens for their
    changes. Its observation tokens retain the same bytes. The kernel tool
    and daemon share mission write rules without lowering existing store limits.
  - Pilot Day mission task 13 is developing scoped AI review. Keep the
    critical and retained review code, delivery-evidence stores and tests. Task
    14 builds on that work. No stored records or migrations were retired.
- **Give refresh, provider calls and storage different owners.**
  - The source registry owns slots, timeouts, cancellation and backoff. Slack
    and Linear own their workflows. The worker and client share a typed
    tracked-item operation table. Synchronous read snapshots stay in the daemon.
  - Slack reaction reads had no consumer. Existing database columns, evidence
    and history stay readable. Old boolean `force` requests remain valid and
    do not bypass provider backoff.
  - Insights owns review dispatch policy. The scheduler still owns the serial
    queue, the durable occurrence claim and the rule against replay.
- **Put shared contracts in leaves rather than reaching into another package.**
  - The protocol index now re-exports topic modules. Day uses client-safe
    leaves without loading the SDK. Kernel storage, funding and test helpers
    have explicit package imports. Diagnostic source IDs, feedback path
    parsing and connectivity names have single owners.
- **Keep transport separate from Day data sources.**
  - The bridge owns the call envelope. Today, Planning and Ritual own their
    adapters. Source helpers keep the last read, coalesce wakeups and drop
    replies for an obsolete scope. Callers preserve stable draft identity.
  - An uncertain write can trigger a receipt lookup, not another write.
    Feedback Check stays explicit: the native call can resume an investigation
    the user requested. Feature-specific refusal wording stays where useful.
- **Put native admission with the operation owner.**
  - Connection, Slack, schedule, diagnostics and model controls share one
    HTTP admission path. Each supplies its own validation and lookup policy.
    Authentication still runs before reading receipts. Hashing and durable
    file replacement have separate owners from the operation journal.
  - The connected Day app uses the JSON bridge, not a second native-class
    host path. Keep the Ritual fixture and the legacy Loss journal reader.
    Drop the unreachable Force controls without enabling Force preparation.
- **Let a test file name select its suite.**
  - The runner discovers fast and stress tests by suffix. New ordinary tests
    still default to integration. Linux runs all suites. The checked macOS
    subset stays explicit.
  - The Node Day tests share one presentation stub and check the real data
    adapters. PR tests check the published state and archive behavior rather
    than an incidental count of notifications. Private workspace disposal and
    preserved history are both checked across restart.

## Special cases to keep

- Recovery looks up uncertain effects instead of sending them again.
- Worker generation fences, platform wake handling and bounded retry still
  protect effects that cross a process or service.
- Old journal fields, the legacy install proof and readers for previous Day
  installs protect real records. Keep them separate from active producers.

## Follow-up scope

The earlier [November refactor log](untangle-2026-11.md) explains why progress
does not require a wholesale rewrite of session or mission lifetime. Further
session persistence and lifecycle work, Day reply type generation, source
identifier normalization and packaging unification need their own verification.
Headless Day checks do not establish appearance, keyboard focus or IME behavior.
