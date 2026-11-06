# Owner execution and legacy transfer

This is the host-side native handoff. Native UI and installed-app acceptance are
separate work. `insightsWorkspace:2` still means reservation and passive tracking
only. Source advertises separate `insightsWorkspaceExecution:2` and
`insightsWorkspaceTransition:2` capabilities when their services and native
authentication are installed. Support is neither consent nor Enabled. All local
checks use temporary homes, synthetic records and faux providers. No real history,
provider review, migration, grant or schedule was activated.

## Execution ownership

`insights-owner.ts` joins the exact reserved owner to SessionManager, the closed
review engine and ScheduleService. It never puts a workspace ID in a mission field
or creates a hidden mission. It mints a separate v2 grant, checked by the kernel's
independent closed parser. V1 validation, envelopes and receipts are not extended.

Enable creates an inert report and one exact recurring rule. It starts no worker
or review. Scheduled reviews use the bounded SessionManager reader. Source chats
never start. Owner models get only the closed backlog/report/checkpoint tool,
including host-prepared `review_context`; no direct legacy history tool. Report
coverage/cursors commit with the tracking report. Normalized IPC requests and
derived coverage stay separate; these are not original transport-byte claims.

The review backend uses fixed owner tables, never mission validation. Runs,
source positions, inventory continuation, read receipts and pattern identities
have separate tables. Run/source capacity is 4,096 each, without eviction. Existing
workspace item/revision/receipt/page limits still apply.

Save changes desired settings only. It does not change effective scope, grant,
model or rule. Row-only state changes refuse once execution exists. Apply needs
new native confirmation and a fresh grant. Pause/Revoke fence authority first,
cancel the exact rule and Stop/drain the report. Unknown cancellation still reaches
Stop and remains entered. A completed Pause transaction ACK, not matching GET
state, permits skipping cancellation during later Revoke.

## Native execution wire handoff

Require both reservation and execution capabilities. All commands keep durable
envelope `schemaVersion:1`, target `owner.workspaceId`, native authentication and
the complete frozen payload. Never reconstruct it from a later GET. Types live in
`packages/protocol/src/insights-workspace.ts`.
Each execution/transfer payload also freezes `admissionEpoch`, an opaque live
SessionManager epoch. Persistent daemon/home IDs are not incarnation proof. A
preflight from another epoch cannot admit fresh effects, while exact already
committed receipt lookup remains valid after restart.

| Route | Contract |
| --- | --- |
| GET `/api/insights/workspace/execution` | Saved execution/resource status, separate from reservation. |
| GET execution `/preflight` | Exact `InsightsOwnerEnablePayload`; no effect. |
| GET execution `/apply-preflight` | Exact `InsightsOwnerApplyPayload`; no effect. |
| GET execution `/pause-preflight` or `/revoke-preflight` | Exact `InsightsOwnerStatePayload`; no effect. |
| POST execution `/check` | Complete original operation; exact store receipt plus current execution status. No settlement/effect. |
| POST `/api/operations` | Confirm the frozen payload with kind `insights-workspace-enable`, `-apply`, `-pause` or `-revoke`. |

All execution routes are authenticated/no-store and accept no query fields.
Preflight returns `{schemaVersion:2,state:"ready",payload,reason:null}`, or explicit
blocked/unavailable state with a null payload. Wrong methods/fields refuse.

Enable pins owner/revision, settings revision, exact model/thinking and settings;
disclosure is `insights-workspace-enable-v2`. It requires global Automations opt-in.
Changed desired models require separate Apply, never silent substitution.
Retained legacy grants, rules, operations or tracking refuse except through the
committed transfer bridge below. Provisioning is pending, not Enabled. Home,
project/path, lineage, settings and Stop are rechecked around asynchronous effects.

Apply pins workspace/grant revisions, exact desired record and rule, and `chat`
(`reportInputGeneration,model,thinking?,reportBindingHash`). Disclosure is
`insights-workspace-apply-v2`. It needs an idle settled report, closes its idle
executor, keeps the old grant in a ledger, uses guarded configuration-only model
change and rearms the same rule with occurrence history intact. Configuration
grants no evidence access. Unsupported compacted cross-provider configuration
refuses rather than forking/rebuilding. Source positions/pattern IDs remain.

Pause/Revoke pin owner/workspace/grant revisions, report input generation and the
complete exact rule. Disclosures are `insights-workspace-pause-v2` and
`insights-workspace-revoke-v2`. Denial still works with global Automations off.
Stop remains admitted during owner configuration-only model changes. It reaches
the existing worker and revokes the original configuration guard; it never opens
a new model input to stop it.

Default thinking stays a preference, not an invented effective level. Status adds
`thinkingSource:"default"|"explicit"` and reported effective `thinking` when known.
The kernel ready ACK pins Default's level durably before input. Cold model Apply
keeps that reported level, not the new model's switch default. Global preferences
and old envelopes remain unchanged. Public status/receipts omit private paths.

Fresh admission needs the journal's first-entry native confirmation. Recovery
with no entered marker rejects instead of rebuilding approval from GET equality.
An entered effect without a committed transaction receipt is status-only after
retry/restart. A new operation cannot bypass it. Only the exact committed receipt
reconciles a lost final ACK. Historical accepted Enable may coexist with current
paused/revoked authority. Missing authority never becomes empty/fresh setup.

## Passive legacy projection

GET `/api/insights/legacy/{reports,findings,checkpoints,settings}` takes exact JSON
`InsightsLegacySelector` as `selector`, plus optional nonnegative `cursor`. It
pins v2 selector version, exact legacy report/project/mission IDs, expected home
and original v1 context. Native authentication is required. Pages expose stored
v1 payload strings unchanged, bounded pending-operation references and explicit
`ownership:"legacy_mission",lifecycleDependency:"mission"`. At most 20 rows and
48,000 encoded body bytes are returned; capacity/unavailable never means empty.

Rows and authority are pinned before journal I/O and rechecked after durability.
Disabled/archived profiles remain readable. Deleting the mission still deletes
legacy rows. Projection does not hide that mission, remove its lifecycle dependency,
start a transition, wake a worker or admit a review. Unavailable/deleted report
identities require exact D14 recovery, never independent fresh setup.

## Separately confirmed tracking transfer

`insights-transition.ts` orchestrates `insights-transition-store.ts`. Supported
plans contain one exact legacy report lineage and one attributable cursor scope.
Require the separate transition capability. Routes are authenticated/no-store:

| Route | Contract |
| --- | --- |
| GET `/api/insights/workspace/transfer/preflight?selector=...` | Exact JSON legacy selector; no other/duplicate fields. `InsightsWorkspaceTransferPreview` includes complete payload or blocked reason. No effect. |
| POST `/api/operations` | Freeze that payload as `insights-workspace-transfer`, target `owner.workspaceId`. Native first-entry confirmation only. |
| POST transfer `/check` | Complete original envelope, no query fields. `InsightsWorkspaceTransferStatus`; no settlement/effect. |
| POST `/api/operations/receipt` | Complete original envelope. Transfer receipt lookup also requires native authentication. |

The payload pins the old selector, grant/control digest, new owner/report/rule IDs
and home context, complete rules/revisions, original operation references/envelope
hash, manifest, desired/effective settings and exact model/thinking. Disclosure is
`insights-workspace-transfer-v2`. More than 8 relevant rules, 32 retained operations
or a 48 KiB confirmation refuses. Unrelated scheduled prompt bodies are not cloned.

The native confirmation must disclose: keep the original mission and old report;
move tracking copies with provenance; cancel listed old rules; keep effective
settings/model/cadence separate from unapplied drafts; create no grant, worker,
review or active new rule. The new report ID is reserved, not provisioned. Enabling
afterward needs a separate explicit native confirmation.

Before entry the host requires the old grant revoked, executor exited, and
admissions/writes/accounting drained. A retained accepted v1 Enable/Replace envelope
must qualify the exact immutable home/context. Metadata equality is not home proof.
Pending old operations, foreign authority, uncertain reviews, stale revisions/
lineage and Stop changes block. Multiple identities need combined exact recovery.

The host also acquires the existing kernel `owner.sqlite` lease read-only, with
zero busy timeout, and holds it through cancellation and copying. This checks OS
writer ownership even after daemon restart; an empty worker map alone is not
quiescence proof. It reads no history, creates no file/schema and never removes a
lock. Missing/busy/aliased storage proof stays blocked for exact recovery, including
legacy profiles that never created executor storage. The frozen payload includes
the executor-proof digest. File identity and control are rechecked around awaits.

The entered marker durably denies old identity/scope admission before cancellation.
The host cancels exact pending rules even with global Automations off, keeps each
actual transaction ACK and rechecks control/settings/rows around awaits. Already
cancelled rules need their old exact ACK, not matching GET state. Lost cancellation
ACK or copy failure stays entered and lookup-only after restart. New operation IDs
cannot bypass that fence. No old grant material is copied or rebound.

The transfer snapshot is all-or-refuse: 1,024 rows, 4 MiB encoded, with a conservative
aggregate check before reading bodies. Multiple report/cursor lineages, unattributed
cursors, pending D14 replacement and active/uncertain reviews refuse. No truncation
or invented completion is allowed. Original tables are never written.

One transaction creates reserved app ownership, copies tracking, archives original
rows/envelopes, verifies archive hashes/counts, adds permanent old-ID denial and
writes its exact receipt. Copied records survive old mission archive/delete.
Finding/report projections declare `origin.kind:"legacy_snapshot"`. Their requests
are explicit host projections, not invented original request bytes. Original v1
payload strings, revisions, evidence, dedupe receipts, envelopes and cursor bytes
stay in the archive and old tables. Old operation IDs cannot become new v2 writes;
historical lookup says `legacy_committed`. Known cancelled/partial run history and
one attributable unfinished source/inventory continuation keep their coverage gaps.
Captured envelope/receipt fields are serialized from the retained journal; this
does not claim original HTTP transport bytes. Payload strings remain exact, and
the original v1 journal files are not rewritten by transfer.

Default legacy setup may have no saved settings row. Its implicit settings can be
projected only from the exact accepted initial Enable and current exact rule/control
proof. No saved v1 row is invented. Owned settings explicitly use
`settingsMapping:"legacy_revision_plus_one"`: implicit old revision zero becomes
owned revision one; saved old revisions shift by one. Original rows, receipt/request
bytes and old revision numbers remain archived. `settingsOrigin` distinguishes
stored settings from initial-Enable projection. Historical runs are explicitly
legacy, with original requests unchanged.

## Transfer to fresh execution

Transferred-owner Enable includes `transitionId`, `desiredSettingsRevision` and
`legacyControl`. It selects the exact committed transfer's effective model/settings/
thinking, not later drafts. Native must show both when they differ. A fresh v2 grant
needs separate confirmation and current admission. Applying drafts later needs
ordinary separate Apply. Current old control and exact cancelled-rule ACKs remain
refusal fences. The old mission need not survive after the committed transfer.
The retired report is excluded as new source evidence. Canonical owner scope keeps
unfinished cursor bytes usable despite JSON key-order changes.

Check separates outer journal delivery, exact tracking transaction
(`absent|entered|committed`) and current tracking owner. A committed transfer can
coexist with a pending outer ACK. That proves its tracking transaction, not execution
or a fresh grant. A marker without a committed receipt remains Unknown/status-only.
GETs and Check never cancel, copy or activate.

Deleted/unavailable old reports remain blocked with exact-D14-recovery guidance.
Pending replacement, multiple lineages, manual/unqualified rules or unprovable
cancellation remain blocked until a combined safe plan exists. New UUIDs or deleting
records are not recovery. This adds no live transition, cleanup or erasure feature.

## Synthetic evidence and limits

`insights-owner.integration.test.ts` uses actual SessionManager, MissionService/
MissionStore, scheduler and closed reader. Two partial-report cycles run through
real KernelSession/Harness and an in-memory faux provider, including findings,
amendment, accounting IPC and guarded model configuration. Other tests cover
first-entry refusal, Save/Apply/Pause/Revoke, cold recovery, Stop, concurrency,
lost ACKs, Default thinking and native HTTP. Legacy and storage tests preserve
original strings, pending state, provenance, lifecycle dependency and unfinished
cursor bytes, with rollback/concurrency/restart injection.

`insights-transition.integration.test.ts` joins actual services and native HTTP:
default/desired/effective mapping, old bytes, cursors, separate fresh grant,
concurrency, absent home proof, Stop, lost cancellation/final ACKs, SQL rollback,
cold reopen and bounded capture with unrelated large prompts.

These are not installed-app/native UI, packaged-runtime agreement, large streaming
session, live-provider, report-quality or user-benefit qualification. HTTP fixtures
emit server close-listener warnings; their cause is not qualified here. Results
belong in the current task evidence, not a release or activation claim.
