# Weekly Insights enable contract

Persisted desired settings are a separate [native settings contract](insights-settings.md).
The original fixed command remains byte-compatible; no revision field is added during replay.

Host/protocol implementation. Native UI is separate. No actual access, schedule or review is
activated by importing this code, preflight or status. Reuse an existing dedicated backlog;
never create a mission or infer one from its title. Missing/invalid project/backlog blocks setup.

## Native sequence

1. Require `GET /api/hello` capability `insightsEnable:1` and pin its daemon/lineage identity.
2. `GET /api/insights/enable/preflight?projectId=P&missionId=M`. Optional `model` and `thinking`
   select an explicit configured model for fresh setup, never overwrite an existing chat choice.
   When a report identity is already known, also pass `reportSessionId` to pin it. An unavailable
   pinned report refuses even if no receipt/rule reference survives, never falls back to new setup.
3. Show the returned **effective** settings in one native confirmation, including selected-provider
   processing of sanitized local cross-project/archive evidence, partial 1/2/4 sampling and
   approximately $5 **per report**, advisory, unknown pricing/spend, not a cap or guarantee.
4. Freeze `payload` verbatim as JSON inside the existing `DurableOperation`, kind `insights-enable`,
   `targetId` from preflight, stable operation ID/producer/sequence, pinned origin/destination and
   SHA-256 of the actual UTF-8 payload string. Persist locally before sending. Send once through
   `POST /api/operations`, with the existing `x-pilot-github-capability` native confirmation token.
   Envelope host labels may differ: native uses `hostId:"local"`, preflight uses `hostId:"daemon"`.
   Destination matching uses the journal's daemonId + lineageId identity. Do not rewrite the frozen
   payload's `expectedHome`; it still must match the daemon's preflight home exactly, including hostId.
5. On lost/malformed/pending ACK, retain the **same bytes and operation ID**. Passive
   `POST /api/insights/enable/status` takes that complete envelope. It does not execute/resume steps.
   Generic `/api/operations/receipt` remains available for the durable receipt alone.
   Native **Check** performs that lookup first. Only an `unknown` receipt permits re-admitting the
   retained command through the native-gated operations route, never constructing another attempt.
   A lookup observation is not proof that no effects occurred: concurrent admission may have
   entered an effect since the read. Journal reservation and durable step markers, not absence,
   make this same-command re-admission safe. Pending/accepted/rejected receipts are not resent.

All these reads return `Cache-Control: no-store`. GET preflight requires both IDs (400 if absent,
404 if missing, 409 for a wrong/inactive backlog); wrong methods return 405. Status needs no native
capability because it is read-only; malformed/conflicting/expired envelopes are refused by the
existing operation journal. Enable requires the native capability, including exact retries.
Unconfigured hosts return 503. Capability denotes the interface, not a grant or global scheduler enable.
The existing Automations opt-in must be on; this operation never switches global settings.

## Exact schemas

Types live in `packages/protocol/src/insights.ts`; `OperationHost`, `DurableOperation` and
`OperationReceipt` live in `packages/protocol/src/operations.ts`. No implicit optional keys are
added during replay. `thinking` is omitted when absent, not null.

```ts
type InsightsEnableChat = {
  sessionId: string; grantId: string; revision: number;
  inputGeneration: number; model: string; thinking?: string;
};
type InsightsEnablePayload = {
  projectId: string; missionId: string;
  expectedHome: { hostId: string; daemonId: string; lineageId: string };
  context: string; // host hash of storage home, project path and exact backlog
  model: string; thinking?: string;
  recurrence: ScheduleRecurrence;
  scope: { host: "local"; projects: "admitted"; includeArchived: true;
    sourceAccess: "read_only"; coverage: "partial" };
  bounds: { inventoryPages: number; historyPages: number; entriesPerPage: number };
  budget: { usd: number; period: "report"; enforcement: "advisory";
    basis: "initial_assumption" };
  disclosure: "insights-weekly-v1";
  chat: InsightsEnableChat | null;
  schedule: { id: string; revision: number } | null;
};
type InsightsEnablePreflight = {
	projectId: string; missionId: string; targetId: string;
	cost: { pricing: "unknown"; spendUsd: null };
  model: { state: "available"; id: string }
    | { state: "unavailable"; reason: "not_found" | "catalog_unavailable" }
    | { state: "ambiguous"; ids: string[] };
  state: "ready" | "existing" | "blocked";
  reason: string | null; payload: InsightsEnablePayload | null; nextAt: number | null;
};
type InsightsEnableProgress = {
  phase: "chat_pending" | "chat_ready" | "schedule_pending" | "enabled";
  sessionId: string; scheduleId: string; chat: InsightsEnableChat | null;
};
type InsightsEnableStatus = {
  receipt: OperationReceipt | { state: "unknown" };
  state: "not_found" | "partial" | "unknown" | "enabled" | "blocked";
  sessionId: string; scheduleId: string | null; nextAt: number | null; reason: string | null;
};
```

`ScheduleRecurrence` is the existing calendar schema in `packages/protocol/src/schedules.ts`.
Fresh values are Friday 18:00 Europe/Paris, bounds 1/2/4 and advisory $5/report. The host rejects
altered scope/bounds/budget/disclosure/home/context or added fields. Existing trusted chat model,
thinking and existing rule cadence are returned instead of replaced. Exact explicit model choices
can resolve ambiguous defaults; unavailable catalog choices cannot enable. No Pi/Sol fallback.

Receipt is `{operationId,payloadHash,destination,targetId,state,result?,reason?}`. Accepted result
is `InsightsEnableProgress` with `phase:"enabled"`; pending result may contain a persisted step
marker. A marker means **entered**, not completed. `chat_ready` means committed chat identity only.
Neither receipt nor `enabled` certifies a report, provider execution, future access or user benefit.
Status rechecks present admission/Stop/settings and both resources. A later edit/revoke can make
an accepted operation's current status blocked. `not_found` is a lookup observation, not permission
to generate a fresh ID. Unknown/partial must never clear the saved attempt or blindly replay effects.

Check reuses the stored native-confirmed envelope, not a newly resolved preflight. The writer's
Check branch never calls `prepare_insights`; it loads the open attempt from the same private host
book. Sending still requires the pinned hello and native capability. The host validates exact
operation identity/hash/producer sequence and destination lineage, rejects retired sequence floors,
and rechecks current home/project/backlog, model, settings and grant/Stop fences before new steps.
The only enable effects are passive report creation and rule creation. Re-admitting this command
is not review dispatch, message delivery or provider-input resend.

## Existing and partial setups

Preflight uses private admitted grant identity, never a chat/mission title or mere membership.
One exact enabled chat is reused even without a rule. One exact pending, unpaused fixed-chat rule
is reused without editing its title, message, cadence or provenance. Paused/dispatching rules,
unavailable grants, mismatched host/project/backlog, multiple chats/rules and stale rule revisions
block confirmation. Legacy rules without trusted destination metadata are explicit
`existing_rule_identity_unavailable`, not silently adopted. A non-Insights member named Insights
is not a report chat and gains no authority; fresh setup uses a separate stable target identity.

`enable_pending_use_status` requires the retained operation's status lookup, not a new setup.
`report_identity_unavailable` means a retained native setup/enable intent or trusted rule references
a report missing from the current session index. It does **not** prove deletion or revocation.
Preserve that exact identity and refuse before any create step, even if home/path/lineage changed;
never derive a substitute report ID. Unavailable live bindings refuse as `report_chat_unavailable`;
an otherwise admitted identity pointing outside the selected project/backlog refuses as
`report_binding_mismatch`. Retained intent is only a refusal fence, never permission to rebind,
regrant, restart a report or replay a review. With no retained identity at all, preflight cannot
certify historical absence. Real incident recovery must investigate separately, not guess a cause.
Other reason codes include `model_unavailable`, `model_ambiguous`, `thinking_unavailable`,
`existing_model_choice_differs`, `report_chat_unavailable`, `multiple_report_chats`,
`multiple_recurring_rules`, `existing_rule_not_ready`, `preflight_changed`,
`binding_unavailable`, `scheduling_unavailable` and `setup_unavailable`.

The existing host operation journal stores durable markers before each effect. Chat creation has
no pending input and starts no worker. An entered chat-create step is lookup-only after interruption;
exact persisted operation ownership, grant, settings and Stop generation are required. A committed
chat step may continue to a previously **unentered** schedule step on recovery/re-admission of the
same immutable command. An entered rule-create step is lookup-only, even if absence is observed.
Creation uses a stable rule ID plus a single-worker SQLite overlap guard shared with manual writes.
No duplicate grants/chats/rules, guessed title adoption, destructive rollback or automatic regrant.
If an entered effect cannot be resolved, pending/Unknown remains, retaining existing resources.

Only the next strictly future occurrence is scheduled, with the existing Paris/DST calendar.
Existing Stop, revoke, admission, home/lineage, no-overlap, pause, offline, missed/late run and
review-completion semantics remain in force. See [review orchestration](insights-review.md).

## Native confirmation (desktop)

`apps/desktop/src/insights_enable.rs` parses preflight/status strictly and freezes `payload` as the exact
JSON value (no added, dropped or rewritten keys; `expectedHome` checked by daemon/lineage against the pinned
hello). `insights_enable_view.rs` is the one confirmation inside the existing Insights panel, opened from
**Automations → Weekly Insights…** or the report chat's settings. The backlog comes only from report chats'
exact project/mission binding; with zero or several, the confirmation offers active local missions from the
passive catalog. Preflight pins `reportSessionId` whenever one report identity is known for the exact
backlog: a bound report chat, or this app's retained non-rejected enable / accepted setup command. Several
known identities block without a read, and an offer whose `targetId` differs from the pin is refused as a
substitute. A newer choice or a sent confirmation discards late preflight replies. The command is the
existing writer's `insights` slot `enable:<missionId>`, persisted before the single POST. **Check** posts
the retained envelope to the status route and resends the same bytes only when the receipt is `unknown`;
pending/accepted/rejected receipts are never resent. "On" requires passive status `enabled`. Automations
off links to Settings → Chats and switches nothing. After a lost schedule ACK the host reports a pending
receipt at its `schedule_pending` marker with status `enabled`. Native shows On but keeps the attempt
pending with Check; it never treats that as accepted or as a completed report. `enabled` pairs only with an
accepted result or a full host marker naming this target, its model and the status's exact `scheduleId`;
a marker-less pending, unknown or rejected receipt beside `enabled` is malformed. `report_chat_unavailable`
covers several admission failures, so its words name no cause. Mounted probe: `cargo test --features
native-probes --test insights_enable` (synthetic Local only).
Each settled Check or send re-reads status, even when the receipt stays pending at the same step, and only
the newest read lands. Present state (enabled, blocked, partial) outranks the receipt's step words.

## Source and verification

- `packages/daemon/src/insights-enable.ts`: preflight, frozen intent, steps and passive reconciliation.
- `packages/daemon/src/server.ts`: native capability gate, HTTP routes and hello capability.
- `packages/daemon/src/operation-journal.ts`: bounded durable checkpoints in existing receipts;
  passive reads do not initialize disk or garbage-collect. Explicit recovery/writes clean retired files.
- `packages/daemon/src/sessions.ts`: passive Insights creation and committed identity/Stop fences.
- `packages/daemon/src/schedules{,-worker}.ts`: existing calendar admission, stable create and overlap guard.
- `packages/daemon/src/insights-enable.test.ts`: synthetic temporary homes, real metadata/SQLite,
  native HTTP, concurrent dedupe, crash boundaries, lost ACK and authority fences. Worker factory
  refuses all starts. No live grant, history read, provider turn or schedule activation is tested.

## Verification and limits

The joined audit inspects the actual native assertions, not only their pass counts. The original
22 `insights`-filtered units include seven weekly-enable tests: exact JSON-value freeze, malformed
scope/budget/model/home/chat refusals, explicit model choice, durable attempt round-trip, exact
receipt binding, bounded backlog choices and unavailable reasons. Retained report pinning adds a
23rd test refusing a substitute target; its mounted restart case removes the report from the list
and asserts that only a pinned preflight is requested, blocked/substitute offers cannot confirm,
and no operation is sent. Lost schedule ACK validation adds a 24th test using a complete host-shaped
pending marker plus enabled status, preserving the pending attempt and refusing malformed markers,
contradictory receipts and changed identities. The other tests cover shared Insights parsing, storage,
writer and reader behavior. The HTTP fixture uses native `local` envelope
labels with verbatim `daemon` expectedHome, verifies the capability gate and cold receipt loading,
and rejects daemon/lineage changes and relabeled retries before effects.

Host tests additionally exercise stale-unknown observations followed by persisted entry at each
chat/schedule boundary, repeated exact-command re-admission, passive status preserving journal bytes,
retirement floors, disabled Automations and disconnect after report placement with a missing index.
Entered effects never replay even when unresolved; only an unentered rule step may run. Existing
cases cover concurrent dedupe, model refusal, unchanged user choices/cadence, Stop/revoke/home and
binding fences, refused membership, retained identities and future Paris DST occurrences. The
synthetic disconnect is fault injection, not reproduction or diagnosis of a real IPC incident.

The hidden `insights_enable` probe mounts LocalViewer against owned synthetic HTTP. It checks
Automations entry, no write before confirmation, payload/ID persistence across close and writer
restart, unknown-receipt same-command Check, pending status-only Check, accepted status, report
navigation, backlog/model choices, late replies, rejection and global Automations off without writes.
Its main recovery interaction is 1100 light; chooser/refusal interactions also run at 680 dark,
and lost schedule ACK/status-transition interactions run at 680 light. The separate 680 light/dark
and 1100 dark layout passes are render-only, not repeated complete journeys. The
existing `insights_native`, standalone `insights` and `automations` probes cover their own surfaces.
This is macOS arm64 headless TestPlatform evidence, not OS IME/accessibility, Linux/Wayland, live
Local, actual model availability, report quality, spending or realized-benefit acceptance.

The host may say `enabled` with a still-pending `schedule_pending` receipt after rule placement/lost
ACK. Native now accepts the matching marker without inventing acceptance and uses cause-neutral
unavailability copy. Each settled reply triggers a fresh passive status read even if the attempt
remains pending; a sequence fence discards older replies. The mounted probe changes nextAt, then
shows pending+blocked in the same view with the same phase, waits for an overtaken slow reply and
asserts it cannot restore On. Blocked/partial present state outranks pending-step words. Close,
restart and eventual acceptance preserve the same envelope, and every POST in that recovery path
is status-only. Host tests verify blocked-on-revoke with the exact same pending receipt and no replay.
This costs one extra passive status read per settled reply. The pending Check row still says
"Still applying." beside On or blocked words; that pairing has not been visually qualified.
Preserve retained identity and Unknown outcomes, never substitute/rebind/regrant or resend a review.

Existing unrelated baseline failures/warnings remain recorded in
[review verification](insights-review.md#synthetic-checks-and-limits). Focused passes are not a broad
suite pass; synthetic HTTP still emits its existing MaxListeners warning. Desktop checks also
report the existing `block 0.1.6` future-incompatibility warning. The pending-marker delivery's
Clippy run including test bodies failed `-D warnings` in unrelated `chat_actions_restore_tests` and
`interaction_automatic_tests`; a clean scoped production/probe lint is not a claim those passed.
Real activation and the first authorized review require the user's native confirmation; this audit
performs neither. The real IPC-disconnect/binding-change incident's cause and previous delivery
remain unknown; synthetic passing tests do not classify it or authorize live recovery.
