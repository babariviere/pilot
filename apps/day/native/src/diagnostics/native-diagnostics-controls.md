# Native diagnostics controls

`GET /api/diagnostics-controls` requires `x-pilot-github-capability`, like native model
controls. It returns a no-store `DiagnosticsControlsSnapshot` (see
`packages/protocol/src/diagnostics/diagnostics-controls.ts`). Reading does not launch a model,
enable upload, or start monitoring. The snapshot carries the service host, effective
telemetry settings, eligible task-start models, and at most 100 non-archived app-scoped
diagnostics chats admitted for that exact host. `chats.hasMore` reports truncation.

## Durable actions

Use `POST /api/operations`, kind `diagnostics-controls`, target `global-diagnostics`.
Set `bindingId` to the snapshot's opaque `binding`, `bindingGeneration` to 1, and
destination to its exact host. Origin must have the same daemon and lineage; the
native client's `local` origin host ID is allowed. The binding hashes host identity,
settings (including clear epochs), model choices, and admitted chat identities/models.
Stale bindings are rejected before effects, except for the exact reduction below.

An exact `save` with all four booleans false and no endpoint is a reduction-only
revocation. It still requires native authority, the exact envelope schema and pinned
host, but does not need a current snapshot or model catalogue. Its binding can be
64 zeroes when no snapshot is available. It runs outside the diagnostics FIFO and has
one reserved journal execution slot beyond the four ordinary running effects. A
privacy revision fences older queued/in-flight catalogue reads before they can save
an enabling value. This does not replay, settle or grant authority to an older unknown
operation. Other saves, start, send and clear retain their normal CAS checks.

The immutable payload is `{purpose:"diagnostics-controls",binding,action,value}`:

| Action | Value | Accepted receipt result |
| --- | --- | --- |
| `save` | Four required independent booleans `localDiagnostics`, `localFeatureUsage`, `remoteOperational`, `productAnalytics`; optional `endpoint` | `{action,saved:true,retained}` |
| `clear` | `null` | `{action,saved:true,retained}` |
| `start` | `{model,thinking,question,focus?:"app"}` | `{action,sessionId}` |
| `send` | `{sessionId,message}` | `{action,sessionId}` |

`save` preserves the separate AI usage budget. It does not infer upload consent from
local collection. Remote operational reporting needs an explicit endpoint. Endpoints
have a 512-byte UTF-8 limit and permit only HTTPS or numeric loopback HTTP, no
userinfo, query, fragment, whitespace, encoded/traversal paths, or arbitrary collector
path. Only `/` or `/v1/traces` is accepted. Validation runs before journal lookup or
reservation, so rejected collector secrets never enter durable operation records.
Save/clear payloads have a 2048-byte limit. All payloads have a 20000-byte limit;
questions and follow-up messages have a 16000-byte UTF-8 limit. Unknown fields and
actions are rejected. Operation journal limits still apply to the envelope.

`start` requires an exact eligible model and supported thinking level. There is no
provider fallback. It uses the existing durable spawn mechanism with a deterministic
UUID, diagnostics role, Ask mode, app scope, and explicit execution host. It grants
no target transcript access and cannot start repairs. `send` uses durable follow-up
admission only for a non-archived app-scoped diagnostics chat on the same host.

An uncertain operation is **lookup-only**. Send the exact original envelope to
`POST /api/operations/receipt`. Do not mint another ID or resend the action. Neither
startup recovery nor a repeated operation re-enters an uncertain effect. Errors after
entry are sanitized and remain pending rather than claiming nothing changed.

## Clear boundaries

Clear reuses telemetry privacy epoch rotation, session/native diagnostic clearing,
local aggregate clearing, and tracking diagnostic evidence clearing. Telemetry settings
publication uses fsync and atomic rename before the final durable receipt. Clear
does not change consent. Revocation fences future local collection but is not a claim
that independently kept records were erased. Runtime listeners receive disabled
consent before fallible persistence and aggregate-file cleanup. Enables are published
only after durable persistence, and obsolete asynchronous updates cannot restore a
newer failed grant. Public settings, daemon exporter options and kernel options all
read the effective snapshot, not pending enables or pending collector changes. A
failed consent write leaves the operation Unknown while live
collection stays off. A saved revocation can succeed even
when deleting kept aggregate files fails; it confirms consent, not physical deletion.

The result discloses records outside this service clear: service stdout/stderr,
OS logs, manual exports, agent history, independently controlled GPUI writers,
already uploaded remote data, and durable operation intents/receipts containing
submitted questions and settings. Clear does not delete these operation records.
The Day app must clear its own writer separately;
this service receipt never confirms Day app files were cleared.

## Protected Day app evidence

The `diagnostic_logs` catalogue includes `day_app` on the local macOS host. It reads
only `~/Library/Logs/Pilot/day.log` and `.1` through `.3`, never a model-selected path
or the writer's test override. Slots must be private user-owned regular files with
one link, at most 1 MiB each, under a private user-owned canonical directory. Reads
use nonblocking no-follow opens, recheck file identity/mode/size/link count and directory
safety, and retain the existing 128 KiB scan / 64 KiB output budgets and opaque
content-hashed excerpt refs. Four slots give at most 4 MiB of eligible retained data;
a page does not claim to scan all four files.

Rows require the closed Day schema v1, current local consent and privacy epoch, and
`sha256(UTF8("daemon") || NUL || UTF8(daemonId) || NUL || UTF8(lineageId))` binding.
Only fixed event/error names, a canonical RFC3339 millisecond timestamp, u32 PID,
safe nonnegative integer generation/protocol fields, and boolean connection/update
fields are admitted. Unknown keys, malformed/unsafe numbers, foreign bindings, expired,
future and cleared rows are omitted. No malformed row falls back to raw text.
Consent/epoch changes during search or excerpt withhold the result. Missing or stale
evidence never proves app health, and these records do not prove delivery acceptance.
The Day writer still acknowledges its own clear separately from the service.

Day admits control tokens before settings reads or blocking work. Its writer rejects
obsolete controls as well as queued events. Explicit all-false revocation stops and
drains this process's writer before service or journal work; its app-writer result is
separate from service acceptance. A pending same-home revoke restores that local hold
before the watcher starts, without resending the service intent. Unsupported control
schemas cannot enable collection or release the hold. A verified current disabled
snapshot or the original revoke's accepted receipt can release only the associated
hold, never a newer one. Historical receipt lookup does not release holds.

Legacy `GET/PUT /api/telemetry` and `DELETE /api/diagnostics` remain available for
existing clients. Day uses the native-gated, CAS-bound durable controls instead.

## Verification

`diagnostics-controls.test.ts` covers persistence/reopen receipts, stale CAS,
independent consent, clear deduplication, explicit model/thinking, UUID targets,
host-scoped follow-ups, native HTTP authority, and pre-journal endpoint rejection.
`telemetry-settings.test.ts` covers private settings persistence, consent epochs,
analytics revocation, and older-client budget preservation.
