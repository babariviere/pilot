# Native diagnostic evidence: what can actually be inspected

Source audit, 2026-10-30. This describes Rust/GPUI Next, not Swift UI or Swift
telemetry. No live app, daemon, history, settings or provider was inspected.

**Finding:** Next's bounded numeric capture has a working local review/export
path. It is **not a source for the diagnostic-role reader**. No production
recording/export defect was demonstrated in this audit, so this change adds no
instrumentation or access. The integration below is a proposal, not approval.

## Current paths and useful questions

| Evidence owner | Available evidence | Actual reader and limit |
| --- | --- | --- |
| Next `diagnostics.rs` | Startup presence; completed Local delivery JSON-request phase, transport result, status and elapsed time | Settings → Diagnostics → Review capture → editable JSON → Export reviewed. No automatic agent access. |
| Next private delivery Book | Latest retained operation's typed phase/category and acknowledgment, including receipt/private adoption failures | Existing composer delivery caption/recovery. Not ingested by `diagnostic_logs`; not a permanent operation history. |
| Daemon diagnostic tools | Existing host/session, lifecycle, request timing, tool activity, retained sanitized history/context, watchdog performance | Persisted diagnostics role and exact admitted host/lineage; bounded reads. Does not ingest Next's capture. |
| `diagnostic_logs` source `app` | Swift producer's closed lifecycle/transport/repair codes, when present and enabled | macOS `~/Library/Logs/Pilot/App/app.jsonl` and `.1` only. Not “whichever desktop app is running.” |

For a report of “Send is stuck,” the current Next export can establish **a
completed transport observation**: which phase, HTTP status if received, elapsed
milliseconds and typed failure. It cannot establish the durable operation result,
associate the request with a chat, or explain missing paint/streaming. Use the
existing exact-operation caption/receipt for acknowledgment, and separately
available daemon evidence for server work. Absence of a capture row is not proof
that a request never ran.

| Observation | Supported interpretation | Not supported |
| --- | --- | --- |
| `startup` row | Capture started in that app run | Successful runtime bootstrap, first frame, connection or usable editor |
| `deliveryRequest`, `response_received=true` | HTTP 200 reply parsed as JSON | Correct hello identity, valid receipt, accepted/durable send, model success |
| `response_received=false`, `refused`, `status=503` | That HTTP request returned a nonaccepted status | Rejected durable receipt, or proof the daemon did not act |
| `malformed` with `status=200` | Reply was not parseable JSON | Receipt identity mismatch; that check happens later |
| `interrupted`, no status | Request transport failed before a status was retained | Whether a mutation was admitted remotely |
| Large `elapsed_ms` | Time inside that JSON request boundary | Provider thinking, frame latency, private adoption cost, or a causal CPU diagnosis |
| Nonzero loss/partial counters | Evidence is incomplete | A complete timeline reconstructed from remaining rows |

## Exact producer → disk → review → export trace

Source anchors are symbols as well as line references so they remain searchable.

1. [`main.rs:96`](../src/main.rs#L96) calls `diagnostics::start` after argument
   handling and Local/runtime setup. Help/read-only checks return earlier. A
   failure before `start` has no capture. `start` installs the sole safe tracing
   layer, starts the worker, and emits numeric `operation=1` (startup).
2. [`interaction.rs:1134`](../src/interaction.rs#L1134), `observe`, allocates an
   app-local `request_id`, starts `Instant`, and awaits `read_delivery_json`.
   [`read_json_with:800`](../src/interaction.rs#L800) retains no body/error text:
   transport failure → interrupted; non-200 → refused; size over 4 MiB → tooLarge;
   chunk failure → responseInterrupted; invalid JSON → malformed. On completion,
   `diagnostics::delivery` emits operation=2 plus numeric stage/category/status,
   elapsed milliseconds and a boolean. Cancellation before completion emits no
   completion row. Successful JSON is emitted **before** hello/receipt validation.
3. [`diagnostics.rs:189`](../src/diagnostics.rs#L189), `SafeLayer::on_event`,
   accepts only `pilot::diagnostics`, numeric operation 1/2, five known stages,
   fifteen known categories, boolean `response_received`, status 100–599, and
   optional numeric request/elapsed time. Unknown operations are ignored; unknown
   stage/category values become null. Successful JSON suppresses `outcome` rather
   than exporting the transient `inFlight` category as a semantic result. Strings,
   messages, spans and Debug values are not formatted. The layer stamps build,
   app-run UUID and current wall-clock seconds.
4. `channel`/`run` use a nonblocking 256-command queue and one background writer.
   `Retention::{open,append,read}` owns exactly `events-0.jsonl` through
   `events-2.jsonl` under `Store::default_path()/diagnostics`, with a single
   `capture.lock`. macOS root is
   `~/Library/Application Support/Pilot Next/diagnostics`; Linux source chooses
   `${XDG_STATE_HOME:-$HOME/.local/state}/pilot-next/diagnostics`. No Linux native
   qualification is implied. Slots are private, owned, regular, single-link files
   opened no-follow, at most 64 KiB each; directory is 0700, files 0600.
5. [`diagnostics_view.rs:54`](../src/diagnostics_view.rs#L54), `Diagnostics::review`,
   requests a worker preview, serializes it off-thread, and freezes an editable
   snapshot. Review does not silently replace edits. `Preview::new` keeps the
   newest 512 retained rows. `Diagnostics::export` captures those exact edited
   bytes, asks for a new destination, and calls `diagnostics::export` off-thread.
   Export accepts valid JSON within 512 KiB, creates a new 0600 file, writes and
   syncs it. It does not reload records, send them, open a chat, or overwrite an
   existing file. A partial write is reported as failure and edits remain.

### Concrete synthetic record

The existing
`diagnostics_existing_delivery_vocabulary_roundtrips_through_tracing_and_worker`
fixture emits `delivery(2, diagnostic, 120, false)` with stage Lookup, category
Refused, status 503 and acknowledgment Unknown. Its path is the same safe layer,
queue, private writer and preview parser above. The resulting record has this
shape (build/run/time placeholders below are explanatory, not literal exports):

```json
{
  "build": { "version": "1.99.0", "desktop_source_sha256": "<64 hex digits>" },
  "run": "<app-run UUID>",
  "seconds": 1793361600,
  "operation": "deliveryRequest",
  "request": 2,
  "stage": "lookup",
  "outcome": "refused",
  "response_received": false,
  "status": 503,
  "elapsed_ms": 120
}
```

The acknowledgment is deliberately **not** a capture field. Unedited review
places this row under manifest `records`; export writes that reviewed JSON, not
the Book or any raw response. This is a source trace with independently exercised
capture/storage and export legs, not a live delivery or end-to-end daemon trace.
Passing this Next record to the production `nativeAppLogLine` validator returns
`undefined`: it lacks Swift's `schemaVersion/at/host/event` and has different,
forbidden fields. A whole Next export is rejected too. Copying or renaming the
file cannot make the schema compatible.

### Fields, identity, time and loss

- Record fields are exactly `build`, `run`, `seconds`, `operation`, `request`,
  `stage`, `outcome`, `response_received`, `status`, `elapsed_ms`. Optional values
  serialize as null. Operation/stage/category use camelCase enum values, while
  `response_received` and `elapsed_ms` retain snake_case.
- Stages: identity, target, lookup, execute, adoption. Categories: inFlight,
  interrupted, refused, responseInterrupted, tooLarge, malformed, identity,
  receiptMismatch, unknown, pending, accepted, rejected, privateWrite,
  privateCapacity, privateState. **Vocabulary is not coverage:** production emits
  only the HTTP observations from `observe`, not later receipt/adoption results.
- `build` contains product version and desktop-source SHA-256. It is not a landed
  commit, signed payload/runtime identity or daemon version. Each retained row
  keeps its producing build; manifest `app` describes the reviewing executable.
- `run` is random per process; `request` is an app-local sequence per HTTP request,
  not per delivery. There is no host/daemon/lineage, session, operation ID,
  payload hash, draft revision, stream revision, traceparent or receipt identity.
  Equal timestamps or adjacent request numbers do not supply those missing joins.
- `seconds` is wall-clock Unix seconds at event capture, not request start or
  subsecond ordering. `elapsed_ms` is monotonic request elapsed time. Queue/storage
  time is not included. File order is capture/retention order, not global causal
  order; clock changes can distort wall time. Reader rejects rows older than seven
  days, but does not separately reject future timestamps.
- Manifest fields: `schema=1`, current `app`, `platform`, `coverage`, `trust`,
  `retention`, `dropped`, `storage_errors`, `partial_files`, `preview_omitted`,
  `records`. Loss/storage counters are process-local, not durable lifetime totals.
  `partial_files` also counts invalid **rows**, not just files. Old rotation losses,
  cancelled requests and unflushed crash/exit events have no exact count. Zero
  counters do not prove completeness.
- Slots expire as a whole when the first row parses and is over seven days
  old, on startup/write/review, not while idle/closed. This can remove newer rows
  too. Preview also filters old/invalid records. Bounds and omissions remain
  visible; no synthetic empty success substitutes for unavailable capture.

## Actual diagnostic-role access and privacy boundary

[`session.ts`](../../../packages/kernel/src/session.ts) installs specialist tools
from the trusted diagnostics role; ordinary Ask/Build cannot acquire them through
input text. [`SessionManager::diagnosticLogsCall`](../../../packages/daemon/src/sessions.ts#L6511)
checks persisted role (or the separately confirmed existing repair scope), current
daemon/lineage and admitted subject. It passes the existing local-diagnostics
setting to the fixed catalogue, without waking/subscribing to the subject.

[`daemon.ts:159`](../../../packages/daemon/src/daemon.ts#L159) configures the Swift
app path, not Next's state root. [`DiagnosticLogReader::sources`](../../../packages/daemon/src/diagnostic-logs.ts#L326)
catalogues only that path and `.1` for `app`, checks private files, hides this source
when local diagnostics is disabled, and calls
[`nativeAppLogLine`](../../../packages/daemon/src/native-app-log.ts). That validator
admits only schemaVersion 1, canonical ISO `at` within seven days and not future,
matching `host={hostId:"daemon",daemonId,lineageId}`, six fixed Swift events, and
optional closed error domain/numeric code. Unknown keys or Next records are
discarded, never treated as generic app text. Inventory file availability is not
proof that any Next rows are readable or that the app is alive.

The separate `diagnostic_context` performance selector reads the existing current
daemon watchdog through sanitization. It does not reach Next or fill missing
request/frame attribution. Existing logs/context/history sanitization, bounded
pagination, untrusted-data treatment and repair-proposal restrictions still apply.
See [agent diagnostics](../../../docs/agent-diagnostics.md) and the
[telemetry contract](../../../docs/telemetry-contract.md).

Next private capture currently starts independently of the daemon's local
operational/remote-export settings; it has no collection toggle or retained-file
clear action here. **Clear preview** clears only the editor snapshot. Do not claim
that disabling/clearing daemon diagnostics disables/clears Next capture, or that
reviewing/exporting enables daemon or remote telemetry. No setting is changed by
this audit. Edited JSON can contain user-introduced text, so an export is untrusted
data, not an automatically safe schema or permission for an agent to act.

## Minimal integration proposal, requires explicit user approval

Goal: a diagnostics specialist can answer “which native transport phase failed
recently?” without arbitrary filesystem access or silently admitting unbound old
captures. This does **not** solve frame/render diagnostics or end-to-end delivery
correlation. Keep manual reviewed export available independently.

1. **Paths/platform:** macOS only initially. Add one separate fixed source ID,
   `next_app`, reading only the three slots under the macOS Next diagnostics root
   above. Never accept a model path, scan the parent state/Book/attachments, follow
   links, read `capture.lock`, reuse Swift `app`, or enable a Linux/linked-host
   fallback. This is new daemon root/catalogue authority and needs approval.
2. **Schema/identity:** define a closed version-2 Next record, preserving the
   existing numeric/enumerated fields, adding `schema=2` and optional pinned
   destination `host={hostId:"daemon",daemonId,lineageId}` supplied from existing
   verified Local options, never text/tool arguments. This identifies the intended
   connection, not proof the server accepted/verified a request. Reader discloses
   only records with an exact current daemon/lineage match. Unbound startup and
   legacy v1 records stay manual-export-only; report the omission, never infer a
   host from filesystem ownership, UUID, source hash or timestamps. No automatic
   backfill, migration or new session/operation identifiers.
3. **Admission/controls:** retain persisted-role/current-host checks on every call;
   no linked courier forwarding and no new repair authority. Gate disclosure on
   existing `localDiagnostics`. Before enabling the integration, bridge that
   setting to the client writer through the existing verified Local settings
   path: unknown/disabled means no new integrated collection. A disable/clear
   transition must invalidate/drain queued writes before the existing client
   writer clears its slots; the daemon must not unlink an active writer's files.
   Remote-export consent never grants this access and remains unchanged. This
   control wiring and source semantics need review, not an assumption that today's
   independent capture already obeys daemon settings.
4. **Sanitization/retention:** parse and validate before formatting, with unknown
   keys/enums rejected; canonical bounded version/hash/UUID/status/numeric values;
   no raw line fallback. Permit only the named fields, reject future/expired rows,
   then use existing credential redaction and output bounds. Never copy arbitrary
   edited exports. Preserve three 64 KiB slots, seven-day opportunistic expiry,
   256-command queue, 512-row manual preview, 128 KiB scan/64 KiB reader output,
   1–40 returned rows and existing opaque ref/cursor limits. Report byte/record
   bounds, unbound/invalid/expired omissions, disabled, missing, partial and stale
   refs explicitly. No new background reader, uploader, spool or retention store.
5. **Synthetic acceptance:** exact versioned producer→private slots→catalogue
   search/excerpt fixture; existing v1/Swift schema isolation; true JSON response
   is not acceptance; foreign/missing/replaced daemon/lineage and ordinary-role
   refusals; settings unknown/disabled, disable/clear racing queued writes;
   symlink/hardlink/owner/mode/oversize refusal; rotation/expiry/future clock and
   stale refs; loss/write/unavailable counters; unknown fields/enums and injected
   content/paths/secrets withheld; zero linked forwarding/network/provider calls
   or worker wake/mutation. Only synthetic temporary directories/settings/hosts.

Implementing this proposal would change the daemon catalogue, reader schema,
client identity/control wiring and the reviewed diagnostics/telemetry contracts.
None is implemented or authorized by this audit. Until approved, describe Next
capture as **manual local export only**, not “all app telemetry accessible.”

## Reproduction and verification

The source-only audit uses the existing focused fixtures, not a real application
launch. From the repository root:

```sh
python3 apps/desktop/scripts/check-scoped.py --unit diagnostics
node --test --test-force-exit --test-concurrency=2 \
  packages/daemon/src/native-app-log.test.ts \
  packages/daemon/src/diagnostic-logs.test.ts
```

The Rust fixtures cover safe numeric capture, typed delivery roundtrip through
the writer/preview, overflow, retention/restart, unsafe files, explicit unavailable
storage and exact edited-byte/partial-failure export. The daemon fixtures cover
the existing **Swift** schema/catalogue, identity, disabled reads, sanitized
bounded search/excerpt and unsafe sources; they do not establish Next integration.
No production source or UI changes require an app build/native visual check here.

Audit replay passed: nine tests selected by the Rust `diagnostics` filter
(including the six capture/export tests and simulated native picker/menu cases),
and thirteen daemon schema/catalogue tests. A direct synthetic check also rejected
both the example-shaped Next row and a Next manifest with `nativeAppLogLine`,
while admitting a matching Swift control. Exact field inventories, the sole
production delivery emitter, fixed reader path, document links and whitespace
were checked. This does not qualify OS input, native performance or live operation
outcomes. No production lint/typecheck/full-suite sweep was needed for two
documentation-only files.
