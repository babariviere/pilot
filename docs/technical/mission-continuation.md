# Authorized work continuation

## Queue API

Only the current coordinator can request a slice through the mission tool:

```ts
mission({
	action: "start",
	id: "task-id-or-number", // Or ids: ["1", "2"] for one ordered slice.
	operationId: "stable-slice-operation-id",
	model: "provider/model-id",
	thinking: "high",
	message: "The exact already-authorized scope, not a new grant.",
});
```

The reply contains `operationId`, reserved `targetId`, `state` and `reason`.
`get` exposes pending starts under `continuation.starts`, plus occupied slots and the
user-order pin. Repeat the same start with identical arguments to look up its original
operation. Changed bytes reject. An Unknown result never permits another identity,
another target or a replay. No queue control enables Autopilot or grants provider spend.

Only unclaimed todo tasks can be queued. Dependencies may still be unfinished. Worker
finish/failure notices wake an idle coordinator without waiting for all other workers.
The coordinator reads current task assignment/revision, scope and report currentness,
then reconciles canonical status separately from worker claims or user acceptance.
Neither a published increment nor a finished turn closes a task. Canonical task changes,
worker lifecycle events and policy-source events reconcile saved intents. Blocked records
have no timer, self-message or acknowledgement loop. Archive is not a prerequisite for
continuation, and continuation never dismisses assistance or weakens archive guards.

## Typed current-policy source

`MissionService.setContinuationPolicySource(source)` is a trusted host-only seam. Its
`ContinuationPolicySource` type lives in `packages/daemon/src/mission-continuation.ts`.
Agents cannot supply or bind it through tool arguments. No production source is currently
qualified/bound: production intents therefore wait with an explicit unavailable-policy
reason. Coordinator identity, a preferred model, decision prose, an informational budget
or an old approval receipt is not a substitute.

The source implements synchronous `current(record)` and `onChange(listener)`. It returns
either `{version:1, state:"blocked"|"unavailable", gate:"dispatch"|"model"|"budget", reason}`
or this source package:

```ts
interface AllowedContinuationPolicy {
	version: 1;
	state: "allowed";
	dispatch: { authorizationId: string; revision: number };
	model: { sourceId: string; revision: string; model: string; thinking: string };
	budget: { mode: "no-execution-cap" } | { authorityId: string; revision: number };
}
```

These fields identify actual current authority/configuration records, not new grants.
A qualified adapter must check exact task scope, dispatch permissions, pending/revoked
authority, model scope/price/thinking and any configured execution cap synchronously. It must return
blocked/unavailable for unsupported gates and emit an event when those gates change.
Reapproval with a different authority ID or revision invalidates earlier selection even
if the projected state still says allowed. This task adds no budget store, spending
grant, workflow-approval shortcut or live runtime activation.

`no-execution-cap` explicitly represents the absence of an optional execution cap; it
needs no fabricated budget authority ID. It is not a fallback for unknown policy and
does not replace dispatch/model authority. A source that cannot determine the applicable
cap must still return `unavailable`. The optional diagnostic `AIUsageBudget`, whether
unset or configured, is not an execution cap or a spending grant.

The scheduler pins the allowed package before entering a start. It compares fresh policy
again after preparation, at metadata commit and before initial kernel input dispatch.
The resolved model/thinking must match that package. Canonical owner/assignment/definition,
coordinator/project/scope, mission Stop/pause generations, persistent user Stop holds,
archive state, current dependencies, phase gates, pinned order and two-worker capacity
(including owned reviewers and uncertain starts) remain independent checks.

## Production qualification audit

Audited against main `3e2f3e54`, including the factual-report/status ownership changes.
These are source findings, not new authority or a cancellation of authorized continuation.

| Current source | Observed boundary |
| --- | --- |
| [ExecutionPermission](../../packages/kernel/src/tool-policy.ts#L5-L28) | Carries an inherited tool ceiling and an authorization ID. The audited runtime does not resolve that ID to a current, revocable mission delegated-start grant. Missing permission preserves legacy Build behavior; it is not proof of delegation. |
| [Workflow confirmation package](../../packages/protocol/src/workflow-confirmations.ts#L50-L65) | Fixed actions are plan/classify/assign/assess/accept-outcome, not start. The package explicitly excludes subdelegate. [assertApproval](../../packages/daemon/src/workflow-confirmations.ts#L208-L220) checks the exact existing package; it cannot enlarge those powers. |
| [Native published Start](../../packages/daemon/src/planning-workers.ts#L694-L781) | An authenticated human operation selects one exact published task and permanently reserves its session/task identity. It does not authorize another sibling or an automatic later start. [startView](../../packages/daemon/src/planning-workers.ts#L623-L640) refuses another Start after that reservation. |
| [Model selection](../../packages/daemon/src/models.ts#L399-L427) | Validates scope, task price cap, model and thinking through asynchronous [settings snapshots](../../packages/daemon/src/model-settings.ts#L84-L99). [updateScope](../../packages/daemon/src/models.ts#L327-L336) clears in-flight lists but exposes no synchronous final-dispatch configuration witness/invalidation revision. A selected model ID alone is not that witness. |
| [AIUsageBudget](../../packages/protocol/src/telemetry.ts#L1-L8) | Explicitly optional and diagnostic-only, never execution/provider-quota control. [compareAIUsageBudget](../../packages/daemon/src/ai-usage-budget.ts#L30-L43) returns no comparison when unset and marks configured comparisons informational. This is not a missing mandatory cap and does not require resolving the budget-increase policy. |

The precise blocking source is a **current delegated-start authorization**, not a new
mandatory USD cap. A production adapter cannot truthfully return an allowed dispatch ID
from any of the sources above. User authorization to continue work is not withdrawn;
the missing engineering link is its typed, host-verifiable representation.

Minimum remaining qualification:

1. Capture explicit ongoing authorization through trusted native ingress in an existing
   approval/journal path. Bind the exact mission/project/coordinator and approved scope,
   with current record identity/revision and revocation/expiry checks. Define whether an
   explicit Continue confirmation extends an existing workflow package or uses a separate
   versioned operation. Do not reinterpret old packages, decision prose, task todo state
   or an earlier one-task Start as this grant. No new policy store is proposed here.
2. Expose a prepared model-admission witness backed by the actual effective scope/auth/
   price/thinking configuration, with synchronous invalidation at final dispatch and
   events on changes. Reuse model selection; do not label an async cached selection as a
   fresh synchronous witness or manufacture its revision.
3. Bind those real sources to `ContinuationPolicySource`. Check any execution cap that
   actually applies, or explicitly report `no-execution-cap`. An unknown or unsupported
   configured cap stays blocked. This does not settle the optional budget-increase policy.

The adapter remains unbound rather than fabricating these records. The queue, source
fences and Unknown lookup-only recovery remain available for qualification with faux
providers. This audit changes no current grants or live runtime state.

## Durability and recovery

Intents and waiting reasons share canonical mission SQLite and its off-thread durable
writer. The queue keeps at most 128 unsettled intents and 4096 identity receipts. Full
storage refuses admission rather than erasing replay history. Known task sources changing
before dispatch invalidate the old intent. Entered effects are never re-entered.

Existing `spawnDurable` receives the reserved target and operation ID. A pre-admission
metadata marker prevents cold startup from repairing membership or launching an uncertain
creation. Saved initial inputs keep current-policy/source fences until their exact kernel
acceptance. Recovery only looks up the original committed admission marker; absent or
unreadable evidence stays Unknown. Admission is not completion, acceptance or quiescence.

## Verification

`mission-continuation-admission.test.ts` covers deduplication, durable waits, dependency
changes, partial deliveries, pinned priorities, full slots, crash/reopen and dispatch races.
The service fixture scripts a fake coordinator and faux workers through the real notice,
fresh task read/status, slot release and durable start path. It also covers interrupted
pre-admission recovery and fresh-identity attempts to revive user-stopped tasks. Policy
fixtures exercise unavailable budget gates and same-state authority replacement. No real
provider, worker account, live app update or restart runs in these tests.
