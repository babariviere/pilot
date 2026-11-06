# App-owned Insights workspace (v2)

This contract is separate from the immutable [v1 contracts](insights-enable.md).
It uses owner-keyed tables in `missions.sqlite`, not a mission or task. A local
profile is the daemon's exact canonical data-home path. A copied database or
changed daemon/lineage cannot silently acquire its old owner.

## Native contract

`hello.capabilities.insightsWorkspace:2` means passive projections and explicit
reservation are supported. It does **not** mean activation or transition is
supported. Native must not call v1 Enable with a v2 workspace ID.

- `GET /api/insights/workspace`: status and the current owner, or explicit absent,
  blocked or unavailable state. No mission ID. Foreign owners disclose no records.
- `GET /api/insights/workspace/preflight?projectId=P&model=M`: exact execution
  project and configured model choice. Missing project requires a choice. Model
  names resolve only uniquely; missing/ambiguous choices never substitute defaults.
- `GET /api/insights/workspace/reports?cursor=N`, `/findings?cursor=N`,
  `/settings`: owner-scoped projections, at most twenty rows and 64 KiB per page.
  Unavailable is not empty. Reads never create defaults, reserve an owner, start a
  worker, read source history, change a journal receipt or activate anything.
- `/reports/:key` and `/findings/:key` return one exact saved tracking request.
  Their `/history?cursor=N` routes return immutable revisions, with the same page
  and byte limits. These are integration-owned claims, not source-history reads.

All reads are no-store. Native freezes the complete preflight payload as UTF-8 JSON
in the existing durable operation envelope. Kind `insights-workspace-reserve`,
target the exact workspace ID. `POST /api/operations` requires the existing native
capability, including retries. The operation atomically reserves the owner, exact
report/rule IDs and original envelope before acknowledging. Reservation is **not**
a grant, report chat, rule or activation. Competing confirmations cannot select a
second owner. An exact retry recovers the original receipt without another write.
Unknown uses the same envelope's passive receipt lookup, never a new UUID.

The authority pins schema version 2, workspace/report/rule IDs, project/path,
profile/home and daemon/lineage. Public projections use a context digest instead of
private paths. Revalidate the authority inside transactions, after asynchronous
work and before result disclosure. Historical owners/receipts/bytes remain stored.
Pause/revoke advance a CAS revision and keep records. No delete, reset, rebind or
automatic resume API exists. A reservation never makes an executable task.

### Exact wire shapes

Types live in `packages/protocol/src/insights-workspace.ts`. All operations retain
the existing envelope `schemaVersion:1`; **payloads** and the new capability are v2.
Envelope destination matches daemon/lineage; `owner.expectedHome` stays exactly as
preflight returned, including its `hostId`. There is no mission ID in these types.

`owner` is `{schemaVersion:2,workspaceId,reportSessionId,scheduleId,projectId,
expectedHome,context}`. IDs are stable host-derived UUIDs from the exact context.
`context` hashes version, canonical data home, host identity, project ID and path.
An existing workspace always keeps its execution project. A copied database at a
different data home is blocked, not treated as a fresh profile. Foreign/changed
identity status returns no owner or record details.

Reservation payload is `{schemaVersion:2,owner,model,thinking?,settings,
disclosure:"insights-workspace-reservation-v2"}`. It must exactly match a fresh
host preview. Settings reuse `InsightsReviewSettings`; initial model resolution is
the unique configured Terra 6.1 display name or an explicitly selected exact ID.
Unknown/ambiguous catalog state is a refusal, not a model default. Model lookup
uses only the explicitly selected execution project's path. Existing reads do not
resolve another model. Preflight never selects a project from the current UI tab.

Accepted reserve result is `{owner,revision:1,state:"reserved",
activation:"not_activated"}`. Concurrent different operations cannot own another
row; exact historical retries use the transaction's original receipt. The journal
keeps failures after a committed transaction Pending, not falsely Rejected. Cold
recovery looks up that receipt without a catalog lookup, regrant or second write.
Passive `/api/operations/receipt` never accepts a pending result. Only re-admission
of the same native-confirmed envelope may reconcile its exact committed receipt.

Other native operation kinds, all targeting `owner.workspaceId`, are:

| Kind | Exact payload (all include `schemaVersion:2,owner`) | Accepted result |
| --- | --- | --- |
| `insights-workspace-state` | `expectedRevision,state:"paused"|"revoked"` | New workspace snapshot |
| `insights-workspace-settings` | `expectedRevision,settings` | `{revision,settings,model,activationRequired:true}` |
| `insights-workspace-lifecycle` | `key,expectedRevision,lifecycle` | `{key,revision,lifecycle}` |

State CAS is the owner revision. Settings and finding CAS use their own revisions.
Revoked is terminal; no mutation can enable or resume it. Reads still show its
records. Paused blocks report/record writes; native settings/finding decisions can
still maintain tracking data. Neither state action stops an executor because this
contract cannot create one. The execution bridge must implement real Stop/drain
before exposing active lifecycle controls.

Status is `{schemaVersion:2,state:"absent"|"present"|"blocked"|"unavailable",
reason,workspace}`. A workspace snapshot contains owner/revision/state/activation.
Preflight adds `projectId,model,payload,activationRequired:true` and state
`ready|existing|choice_required|blocked|unavailable`. Missing context returns
`choice_required/execution_project_required`, with null payload. Existing returns
the pinned workspace, never a replacement payload.

List shape is `{schemaVersion:2,state:"available"|"unavailable",reason,workspace,
items,nextCursor}`. Summaries contain key/revision/lifecycle/title/priority/targets/
cost/updatedAt; there is deliberately no task ID. A nextCursor means incomplete,
not an exact total. Settings GET returns `{schemaVersion:2,workspace,record}` with
the saved desired record. Item/history failure is an HTTP error, never empty
success. Lists explicitly return unavailable on failed qualification/durability.
Unknown fields, duplicate query keys, negative/noninteger cursors and mutation GETs
refuse. Wrong method is 405, unconfigured service 503. Nothing deletes rows.

Retained non-rejected v1 operations, grants, rules and backlog data fence fresh
reservation across **all** projects. Unknown/unreadable evidence refuses. A new
workspace UUID cannot bypass it. Safe legacy transition is a separate contract;
v1 payload parsers, envelopes and receipts must remain unchanged.

## Host adapter boundary

Host-only record adapters accept an owner admission lease, never model-supplied
workspace authority. They reuse the existing closed draft/report/settings
validation without changing v1 parsing. Exact submitted UTF-8 JSON bytes, immutable
revisions and operation receipts are stored separately from projections. Evidence
and implementation links remain append-only. Lifecycle confirmation is native-only;
approval starts no implementation and Verified requires Shipped.

Settings are desired-only; saving neither applies them nor starts a rule. Reports
and checkpoints remain partial claims unless an execution bridge supplies its
existing bounded reader/run receipts. No generic mission permission is added.
Ordinary mission archive/delete/catalog/task APIs neither own nor expose these rows.

## Execution handoff

The unpublished [owner execution work](insights-owner-execution.md) exercises the
host/session/scheduler seam with synthetic providers. Native-gated execution,
passive legacy projections and separately confirmed bounded transfer now have
source contracts. Separate `insightsWorkspaceExecution:2` and
`insightsWorkspaceTransition:2` capabilities describe those services, never consent
or Enabled. The reservation capability still must not mean activation support.

The reservation is the durable prerequisite for an owner-backed session/scheduler
bridge. That bridge must pin this exact authority, preserve Stop generations and
durable entered markers, and keep entered effects lookup-only. It must not copy a
v1 grant, infer consent from matching rows, or advertise activation while absent.
The linked handoff defines their previews, frozen confirmations, Check and status.
Native UI and installed-app qualification remain separate. Neither is enabled by
the reservation capability alone.

The next host integration must introduce a distinct versioned owner-backed grant
and session/scheduler adapter. Do not pass a workspace ID into a v1 mission slot,
relax its parser, or infer authority from `reserved`. The existing closed reader,
review run/Stop machinery and scheduler can be reused only behind that admission.
The later native tab can use these passive projections and tracking confirmations,
but must keep Enable/Apply/real Stop unavailable until that bridge advertises a
separate supported activation contract. Legacy transition must use an explicit
transactional transfer seam, not this fresh-reservation path's legacy refusal.

## Synthetic verification and limits

`insights-workspace.test.ts` uses temporary homes, actual MissionStore/replica and
native operation journal, faux project-scoped catalog metadata and one real HTTP
server with a worker factory that refuses every start. Tests cover passive absent/
unavailable reads, explicit context/model choice, concurrent windows, durability
barriers and stale absent reads, restart/lost ACK, unchanged v1 bytes/receipts,
closed parser compatibility, foreign owner/home/path/lineage denial, mission
archive/delete independence, bounded lists, partial reports/checkpoints, immutable
evidence/patterns/history, native lifecycle/settings CAS and pause/revoke retention.
The Stop test invalidates a trusted host lease while durability is held; it is not
a native or kernel Stop integration test. The HTTP source metadata stays unchanged
and starts no worker. The fixture's Automations switch stays off.

Limits: no v2 report/grant/rule is created. No legacy transfer, actual catalog,
private history, selected-provider turn, real activation, native UI, installed app
or realized benefit is tested here. Existing v1 compatibility selections remain
separate. The HTTP fixture emits the pre-existing MaxListeners warning; this is
not evidence that listener lifecycle is qualified. Storage bounds are 64 owner
rows, 4,096 revisions and receipts per owner, 64 KiB input/encoded item response,
20-row/64 KiB pages, with no eviction. Exhaustion refuses; it never discards data.

The reconciled focused selection passed 221 tests: workspace/journal 25,
Enable/Apply/backlog 92, review/settings 15, replacement/scheduler 58, and the
Insights-only session selection 31. Typecheck, scoped Biome and guide links passed;
shared-file Biome warnings remain. No full repository or native suite was run.
Run the files explicitly with `node --test --test-force-exit --test-concurrency=2`,
two per invocation, with inherited `PILOT_*` variables removed. For sessions use
`--test-name-pattern='Insights|insights' packages/daemon/src/sessions.test.ts`.
