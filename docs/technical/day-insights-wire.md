# Day Insights wire (task 27)

This is a separate Day contract. V1/v2 operation bytes and evidence routes do not
change. No credentials, live history or provider calls are needed for setup.

## Native bridge

Require `hello.capabilities.dayInsights:1`. Support does not mean consent.
All routes are native-authenticated and no-store.

- `GET /api/insights/day`: narrow saved status. No source scan, worker or catalog
  lookup. Status separates draft and effective settings, paused state, uncertain
  operation, and supported execution. Missing execution support is not Enabled.
- `POST /api/insights/day/preflight`: passive review of the exact submitted
  `{action,expectedRevision,projectId,settings}`. `projectId` is the explicit
  execution project, pinned after first Save/Apply, never the selected UI tab.
  Actions are `save`, `apply`, `run`,
  `pause`, `resume`. For pause/resume/run, settings is null. Review never saves,
  applies, grants, schedules or runs anything. Apply does not require Save first.
- `POST /api/operations`: freeze preflight's complete `payload` verbatim as JSON
  in the existing schemaVersion 1 envelope. Kind `day-insights`, targetId the
  payload's owner.workspaceId. Native confirmation is required, including retry.
  `POST /api/operations/receipt` takes that same complete envelope for lookup.
  Never recover uncertainty with a new UUID or reconstructed payload.

Payload is `{schemaVersion:1,admissionEpoch,owner,action,expectedRevision,
settings,disclosure:"day-insights-v1"}`. The owner is the existing v2 app-owned
authority. Settings for Save/Apply are complete submitted settings, not a later
GET or saved draft. Other actions carry null. Preflight returns
`{schemaVersion:1,state:"ready"|"blocked"|"unavailable",reason,payload}`.

Settings are `{model,thinking?,source,weekly,allowance}`:

- `model`: exact configured model ID, never a name/default substitution.
- `source`: `{projects:string[],excludeProjects:string[],excludeSessions:string[]}`.
  At least one chosen project. All eligible active chats in those projects are
  included. Archived chats qualify by archive time in the previous 24 hours,
  not message time. Older messages within those chats remain readable. Apply
  pins scope. Every bounded-reader page rechecks it.
- `weekly`: null (manual) or `{day:0..6,time:"HH:mm",timezone:IANA}`. Sunday is 0.
  Setup never runs a report. Only Run report or a later weekly occurrence does.
- `allowance`: `{perReportMicros,monthlyMicros,basis:"catalog_estimate"}`.
  Positive safe integer USD millionths. Both limits apply (AND), independently
  of background-work limits and their global on/off switch. UTC calendar month
  owns the reservation. Unknown price/bounds hold execution. Provider bills and
  subscription balances are not claimed.

Status is `{schemaVersion:1,revision,owner,draft,effective,paused,
executionSupported,uncertainOperationId,running,nextAt,holdReason,remaining}`.
`running` is boolean or null. `nextAt` is epoch milliseconds or null. `holdReason`
is a machine reason or null. `remaining` is `{perReportMicros,monthlyMicros,
uncertainMicros}`, each number or null. Null means unavailable, never zero or idle.
No effective settings means unconfigured,
not Enabled. Initial paused is false. Apply preserves paused; Resume is separate.
Initial Apply always requires `weekly:null`, even when a saved-only draft has a
weekly schedule. Enabling a weekly schedule needs a later separate review/apply.
Save is optional and only updates draft. Run requires effective settings and
not paused. Any entered effect without exact receipt remains uncertain and
blocks new effects. Historical exact receipts remain lookup-only after restart.

Use existing `/api/insights/workspace/{reports,findings}` list/item/history
routes for evidence. Preserve their partial coverage, cursors, gaps and unavailable
states. Findings become Verified only through the existing native lifecycle
confirmation, and only after Shipped. Reports never imply implementation authority.

## Host boundary and acceptance

The Day service requires a trusted owner lease and passive quiescence proof.
Passive old tracking rows alone do not refuse fresh setup. Old grants, pending
operations, unknown entered effects, active rules or unproven executor/storage
quiescence do refuse fresh execution. Do not transfer or delete legacy rows.
If a legacy report chat is gone, an exact accepted create and later revoke
from the same producer can still prove it was revoked. Pilot also verifies the
report's session and storage are absent. Other non-rejected operations for the
report, open admissions, or existing storage still block setup.
Legacy passive routes remain available with their explicit original selector.

`GET /api/insights/day/legacy?cursor=OPAQUE` discovers old report identities and
returns one existing preserved report/finding projection per page. Native must
not construct selectors. Response is `{schemaVersion:1,state:"available"|
"unavailable",reason,items:[{kind:"report"|"finding",projection}],nextCursor}`.
Cursor is an opaque string or null. A projection includes its host-derived exact
selector and unchanged legacy payload strings. Keep paging until nextCursor is
null. Unavailable never means empty. Discovery reads at most 4,096 loaded metadata
entries, refuses overflow, and keeps the existing 20-row/64 KiB response limit.

Adapters must reuse the existing app-owned Insights closed reader and worker.
They must install the reserve-before-provider kernel gate, atomically reserve
both allowances before dispatch, keep uncertain reservations charged, and settle
only exact usage receipts. No adapter means `executionSupported:false` and
execution effects refuse. Apply can save configuration only, with explicit
`executionSupported:false`. Do not advertise execution from reservation support.

All tests use temporary homes and faux providers. Source-only tests do not prove
native installed-app behavior, private-history coverage or report usefulness.

## Production execution

`daemon-services.ts` installs `DayInsightsExecution` when the owner stores,
SessionManager and scheduler are present. `executionSupported:true` means this
adapter exists, not that settings are applied or a report has run. Missing
services retain explicit unsupported behavior. Native confirmation is required.
Manual Apply creates an inert report container and no rule. Initial execution
Apply requires `weekly:null`, including profiles with only saved/passive settings.
A later Apply can select a weekly schedule. Manual Run does not require global
Automations; a weekly rule still requires its existing opt-in.

Every report opens a different `sessions/<reportId>/day-runs/<runId>/durable`
directory. The kernel refuses a Day context that already has any conversation.
No previous attempt, compacted context, provider transcript or saved system prompt
is reopened. Configuration changes inert model metadata; no model turn is used
to change a fresh report's settings. The stable report session is a container.
Native should link saved tracking reports, not assume one shared chat transcript.
The closed reader's source positions and pattern identities stay in owner tables.

Model-facing `list/get/history/evidence/receipt` reads do not replay prior tracking
contents. They return explicit unavailable state. This conservative boundary
keeps prior reports/findings from becoming an indirect channel for newly excluded
evidence. Native passive tracking/history is unchanged and remains readable.
Reports can propose/amend tracking claims, but cannot grant lifecycle approval.
Models have no `scoped_metrics`, direct history, files, shell, source workers or
ordinary task tools. All other Insights report-engine chats are excluded from Day
sources, while their passive history remains available to the user.

### Shared admission and Stop

`day_insights_control` pins a generation and exact committed settings revision.
Apply/Resume/Pause fence that generation synchronously inside their entry
transaction, before awaiting external effects. Final owner activation, effective
Day settings, generation enablement and exact operation receipt commit together.
Scheduler selection, occurrence claiming, owner/reader admission, fresh input and
provider funding all check that committed control. Held rules have no timer loop;
commits and terminal-run events request a coalesced scheduler sweep.

Pause can interrupt an uncertain Apply/Resume. The older operation cannot pass
its generation CAS or activate a grant after Pause. Pause drains/Stops the exact
report and cancels its rule. Apply keeps paused state; Resume is separate.
Successful Pause durably marks earlier entered operations superseded, never
committed Run receipts. Full original envelope `POST /api/operations/receipt`
returns `{...original receipt identity,state:"rejected",
reason:"day_insights_superseded_by_pause",result:{state:"superseded",
pauseOperationId,execution:"not_inferred"}}`. This proves terminal withdrawal,
not that the older operation never entered an effect. Lookup is passive and
requires native authentication. Changed bytes cannot obtain this outcome.

A manual Run's exact committed receipt reserves its run ID before any input.
It does not claim report completion. Scheduler runs use a distinct durable run
reservation under the same control. Existing IDs never reopen storage or replay
provider input. Restart/unknown placement remains uncertain until native Pause.
Known provider refusal, failure or idle-without-report settles both owner review
and Day run state as terminal `held`. A distinct next run is required. Successful
partial reports remain partial; a late worker exit cannot replace them with held.

### Evidence and cost boundary

Each run pins a cutoff and settings generation. Eligibility must hold both at the
cutoff and at delivery. Prepared excerpts are rechecked before tool disclosure
and at every final provider payload. A changed/expired source withholds the run,
records a coverage gap and produces a terminal hold. No source cursor advances
without the existing exact saved partial report transaction.

Day waits for subscription admission **before** final reserve/revalidation, then
checks cancellation again. The dedicated ledger atomically reserves both report
and UTC-month catalog allowances. Neither background funding nor its global-off
switch can bypass them. The maximum includes all catalog tiers and the SDK's
one-hour cache-write price (twice input) before dispatch. Exact usage can settle
within that bound. Unknown/aborted usage stays charged. Refusals become visible
terminal holds, never a permanently sent report or an automatic retry.

## Synthetic qualification and fixtures

All checks use temp homes, faux providers and fake credentials. No user account,
live history or product provider turn was used. `insights-owner.integration.test.ts`
includes the following Day selections:

- Real SessionManager manual Apply (no worker/rule), explicit closed-reader Run,
  eligible old messages, expired archives, exclusions, actual credential IPC
  reserve/settle, paused Apply, Resume and weekly occurrence history.
- Two actual KernelSession/Harness runs with a faux provider and separate storage.
  Every second-run provider payload excludes the first transcript and saved
  report/finding marker after narrowing. Each provider call has a settled
  dedicated allowance receipt. Two later low-budget runs hold before dispatch.
- Pause across an awaited Apply, pre-commit scheduler fencing, excerpt expiry at
  payload/disclosure, metrics/report-engine denial, idle-without-report settlement,
  uncertain placement, and exact superseded-envelope lookup.

`createDayInsightsFixture()` and `startDayInsightsFixture()` in
`packages/daemon/src/testing/day-insights.ts` provide disposable configuration and
real loopback HTTP fixtures. `seedDayInsightsTracking(f)` adds one partial report
and one Proposed finding without a worker, grant or rule. The HTTP helper omits
the scheduler and therefore intentionally reports execution unsupported. The real
SessionManager tests above compose the scheduler to test production execution.

These checks do not prove installed-app behavior, live-provider report quality,
realized savings or large streaming-session performance. Native acceptance and
final integrated verification remain separate.
