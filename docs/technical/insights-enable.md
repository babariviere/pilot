# Weekly Insights enable contract

Host/protocol implementation. Native UI is separate. No actual access, schedule or review is
activated by importing this code, preflight or status. Reuse an existing dedicated backlog;
never create a mission or infer one from its title. Missing/invalid project/backlog blocks setup.

## Native sequence

1. Require `GET /api/hello` capability `insightsEnable:1` and pin its daemon/lineage identity.
2. `GET /api/insights/enable/preflight?projectId=P&missionId=M`. Optional `model` and `thinking`
   select an explicit configured model for fresh setup, never overwrite an existing chat choice.
3. Show the returned **effective** settings in one native confirmation, including selected-provider
   processing of sanitized local cross-project/archive evidence, partial 1/2/4 sampling and
   approximately $5 **per report**, advisory, unknown pricing/spend, not a cap or guarantee.
4. Freeze `payload` verbatim as JSON inside the existing `DurableOperation`, kind `insights-enable`,
   `targetId` from preflight, stable operation ID/producer/sequence, pinned origin/destination and
   SHA-256 of the actual UTF-8 payload string. Persist locally before sending. Send once through
   `POST /api/operations`, with the existing `x-pilot-github-capability` native confirmation token.
5. On lost/malformed/pending ACK, retain the **same bytes and operation ID**. Passive
   `POST /api/insights/enable/status` takes that complete envelope. It does not execute/resume steps.
   Generic `/api/operations/receipt` remains available for the durable receipt alone.

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

## Existing and partial setups

Preflight uses private admitted grant identity, never a chat/mission title or mere membership.
One exact enabled chat is reused even without a rule. One exact pending, unpaused fixed-chat rule
is reused without editing its title, message, cadence or provenance. Paused/dispatching rules,
unavailable grants, mismatched host/project/backlog, multiple chats/rules and stale rule revisions
block confirmation. Legacy rules without trusted destination metadata are explicit
`existing_rule_identity_unavailable`, not silently adopted. A non-Insights member named Insights
is not a report chat and gains no authority; fresh setup uses a separate stable target identity.

`enable_pending_use_status` requires the retained operation's status lookup, not a new setup.
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
