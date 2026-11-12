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
	budget: { authorityId: string; revision: number };
}
```

These fields identify actual current authority/configuration records, not new grants.
A qualified adapter must check exact task scope, dispatch permissions, pending/revoked
authority, model scope/price/thinking and remaining budget synchronously. It must return
blocked/unavailable for unsupported gates and emit an event when those gates change.
Reapproval with a different authority ID or revision invalidates earlier selection even
if the projected state still says allowed. This task adds no budget store, spending
grant, workflow-approval shortcut or live runtime activation.

The scheduler pins the allowed package before entering a start. It compares fresh policy
again after preparation, at metadata commit and before initial kernel input dispatch.
The resolved model/thinking must match that package. Canonical owner/assignment/definition,
coordinator/project/scope, mission Stop/pause generations, persistent user Stop holds,
archive state, current dependencies, phase gates, pinned order and two-worker capacity
(including owned reviewers and uncertain starts) remain independent checks.

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
