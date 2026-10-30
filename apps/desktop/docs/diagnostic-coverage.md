# Native diagnostic evidence

Rust/GPUI Next, not Swift. D120 adds a **macOS-only**, read-only `next_app`
source for persisted diagnostic specialists on the current daemon/lineage.
No live app, daemon, settings, history or provider was inspected or changed.

## What evidence means

| Observation | Supported interpretation | Not proof of |
| --- | --- | --- |
| Unbound `startup` | Manual capture started in that app run | Bootstrap, connection, first frame or usable editor |
| `deliveryRequest`, `response_received=true`, status 200 | A completed HTTP200 reply parsed as JSON | Correct hello, receipt validation, durable/accepted send, model result or private adoption |
| `refused`, status 503 | Nonaccepted HTTP status | Rejected durable receipt, or that the daemon did not act |
| `malformed`, status 200 | Reply was not JSON | Receipt identity mismatch, which is checked later |
| `interrupted`, no status | Transport failed before a status was retained | Whether a mutation was admitted remotely |
| `elapsed_ms` | Monotonic time in the JSON request boundary | Provider time, frame latency, or a causal CPU diagnosis |
| Loss/omission counters | Evidence is incomplete | A complete timeline, even when counters are zero |

Vocabulary is not production coverage. Stages are identity, target, lookup,
execute and adoption. The existing outcome enum includes later receipt/private
categories, but the production emitter still records only completed JSON
transport boundaries **before** hello/receipt/adoption validation. Cancellation
before completion emits no row. No new receipt, delivery or frame claim is added.

## Producer → fixed slots → specialist

1. `main.rs` starts `diagnostics::start` after argument/Local setup. Failures
   before that point have no capture. The safe tracing layer accepts only its
   numeric schema; it never formats Debug, messages, spans, bodies or raw errors.
2. `interaction::observe` calls `diagnostics::delivery_to` with pinned Local
   options and a completed numeric observation. A host is attached only if that
   destination exactly matches the enabled current control. It is an intended
   destination, not a server-acceptance assertion. Startup and unknown/disabled
   destinations remain unbound, manual-only capture.
3. The sole background capture owner uses its existing 256-command bounded queue,
   three 64 KiB slots and private writer lock. Only `events-0.jsonl`,
   `events-1.jsonl`, `events-2.jsonl` under
   `~/Library/Application Support/Pilot Next/diagnostics` are reader sources.
   The daemon never reads the parent state/Book/attachments, `capture.lock`,
   edited exports, arbitrary filenames or Swift logs through this source.
4. `SessionManager::diagnosticLogsCall` rechecks persisted role and exact current
   execution host on every call. Ordinary roles and confirmed repair grants gain
   no Next authority. The standalone specialist `diagnostic_logs` catalogue,
   literal search and opaque excerpt interfaces add `next_app`. The separate
   `diagnostic_context`/linked courier paths do not gain Next access or forwarding.
5. `nextAppLogLine` validates before formatting, with no raw fallback. Reader
   files must be regular, private, owned, single-link, no-follow, at most 64 KiB;
   the exact private root must have no symlink alias. Permissions/ownership/size
   are checked again on reads. Fixed path checks are not authentication or a
   claim of protection against every transient ancestor-replacement race.

### Closed v2 record

Exactly `schema=2`, optional nullable `host`, nullable numeric `epoch`, `build`, `run`, `seconds`,
`operation`, `request`, `stage`, `outcome`, `response_received`, `status`,
`elapsed_ms`, `loss`. Nullable observation fields preserve the original schema.
`host` is exactly `{hostId:"daemon",daemonId,lineageId}` with canonical UUIDs.
`build` contains canonical numeric release version and lowercase 64-hex
`desktop_source_sha256`, not a commit or signed payload/runtime identity.
`run` is an app-run UUID; `request` is an app-local HTTP sequence, not a session
or durable operation identifier. `epoch` is the persisted local privacy-control token, not a request/session ID.
`loss={dropped,storage_errors}` snapshots
producing-process counters at write time, not lifetime totals. Safe integers,
canonical numeric spellings, UUIDs, enums, keys, field combinations and HTTP
status 100–599 are checked before existing credential redaction. Unknown fields,
text, malformed records and edited exports are not admitted.

`seconds` is wall-clock capture time, not request start or causal ordering.
Reader excludes future and older-than-seven-day rows, foreign identity,
unbound/v1 and records from another privacy epoch. Omissions are
reported by category for the **bounded scanned window**, not an exact inventory
of all retained files. No migration, backfill or inferred host identity.

Search retains 128 KiB scan/64 KiB output, 1–40 returned rows and existing opaque
cursor/ref limits. Next refs also pin the exact raw-record digest so in-place
clear/rewrite cannot substitute another observation. Rotation/shrink/replacement
or expiry yields stale/changed/unavailable evidence, never silent fallback.
Available files do not establish readable rows, app liveness or complete history.

## Controls and manual export stay distinct

The existing verified Local global connection carries a small closed
`diagnostics.next-control` snapshot, derived from telemetry settings, with
`schemaVersion=1`, exact host, `localDiagnostics` and numeric `epoch`.
`GET /api/telemetry` also exposes the optional versioned Next privacy epoch;
older/missing controls leave integration unknown. No new reader polling, upload,
retention store, credential access or remote-consent behavior is added.

Disable and explicit daemon diagnostic clear persist a fresh 48-bit numeric privacy epoch before
notifying the native writer. The reader independently requires an exact epoch match, including
while the app is disconnected. The daemon **never unlinks writer files** and its
clear response does not prove native physical clearing has completed. Native
control handling immediately invalidates queued bound writes, drains the owned
queue, selectively clears that host's old-epoch bound rows (all bound rows when disabled), then enables a matching new
control only after writer completion. Failure stays unbound. Disconnect or
malformed/replaced controls invalidate integrated collection. The epoch prevents pre-clear future-clock rows from reappearing when time
catches up, without suppressing legitimate same-second post-clear observations.
Future/expired timestamps are independently excluded.

Independent unbound manual capture and legacy bytes are preserved, not silently
erased by daemon controls. Settings → Diagnostics → Review capture still creates
a 512-row editable local JSON preview; Clear preview clears only that editor.
Export reviewed writes exactly the reviewed JSON into a new 0600 file, at most
512 KiB, and syncs it. Export never reloads logs, sends data, starts a chat or
confers permission. Edited exports are untrusted/manual-only. No remote setting
implicitly enables collection/disclosure or uploads Next events.

The existing seven-day slot expiry is opportunistic on startup/capture/review,
not while idle/closed. Expiring the oldest row's slot can also discard newer rows.
Crash/exit, cancelled requests and rotation losses are not all counted. Preview
reports current dropped/storage/partial/omitted counts; missing storage is not an
empty-success promise. Swift `app` remains its separate closed v1 reader at
`~/Library/Logs/Pilot/App/app.jsonl` and `.1`.

## Synthetic verification

No visible app launch or live state is required:

```sh
PILOT_NEXT_DIAGNOSTIC_READER_NODE="$(command -v node)" \
  python3 apps/desktop/scripts/check-scoped.py --unit diagnostics --lint
python3 apps/desktop/scripts/check-scoped.py --unit local_client::
python3 apps/desktop/scripts/check-scoped.py --unit interaction::
node --test --test-force-exit --test-concurrency=2 \
  packages/daemon/src/next-app-log.test.ts \
  packages/daemon/src/native-app-log.test.ts
```

The explicit Node environment opt-in makes the Rust fixture run the actual
producer → private slots → TypeScript catalogue/search/excerpt bridge. Without
it the Rust test still exercises producer/control/storage but does **not** claim
that cross-language leg. Other focused suites cover persisted-role/current-host
admission, telemetry control broadcasts/privacy-epoch persistence, existing reader
bounds, unknown/disabled settings, queued invalidation/clear, unsafe sources,
rotation/expiry/stale refs, loss counters and content rejection. All fixtures use
temporary roots/settings/hosts and no provider, linked forwarding, target wake,
repair or live mutation. This is not end-to-end delivery, native frame, OS input,
performance or Linux acceptance.

See [agent diagnostics](../../../docs/agent-diagnostics.md),
[telemetry contract](../../../docs/telemetry-contract.md),
[manual dogfooding diagnostics](dogfooding-diagnostics.md) and
[scoped checks](scoped-checks.md).

Observed scoped checks: 12 Rust diagnostics cases (including the actual Rust→Node bridge),
37 Local reader cases and 47 interaction cases passed; one pre-existing explicit autosave
disk-replay test remains ignored. The focused TypeScript schema/catalogue/control suites
and persisted-role/current-host cases, typecheck, scoped Clippy and plain desktop build
were exercised. Existing repository-wide Biome server findings are not fixed by this
change; matching changed-file lint and baseline comparison are reported separately.
