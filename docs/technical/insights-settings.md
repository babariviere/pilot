# Insights desired settings

Backend/protocol only. The fixed native flow remains compatible. No settings editor is shipped
here, and no real grant, history review, provider input or schedule is activated by these APIs.

## Native contract

Require hello capability `insightsSettings:1`. For an existing, admitted report chat:

1. `GET /api/insights/sessions/:id/settings` returns `InsightsSettingsSnapshot`, with
   `Cache-Control: no-store`. This reads only configuration/model metadata, never source history.
   It includes exact project/mission/home/context/chat fences, revision, desired settings, model
   availability, next suggested occurrence and `{pricing:"unknown",spendUsd:null}`.
2. Show an editable copy. Preserve the snapshot identity, set `expectedRevision` to `revision`,
   and send exactly `InsightsSettingsPayload` from `packages/protocol/src/insights.ts`.
   Use the existing durable native operation writer, kind `insights-settings`, target report ID,
   immutable JSON bytes/hash, producer/sequence and pinned destination. Explicit user confirmation
   and `x-pilot-github-capability` are required on `/api/operations`, including exact re-admission.
   Native envelope host labels may be `local`; frozen `expectedHome` stays exactly as returned.
3. Accepted `result` is `InsightsSettingsRecord`: `{revision,settings,model}`. `model` is the exact
   resolved available ID. Save means persisted **desired** configuration, not active configuration.
4. Lost/malformed ACKs stay Unknown. Check uses passive `/api/operations/receipt` with the **same
   complete envelope**. Do not replace the ID, sequence, payload, or hash. Pending may carry
   `{phase:"settings_pending"}`; it is not success. Native must not resend a pending operation.
   Daemon recovery uses the transaction's operation receipt if the save already committed, without
   repeating the write or re-resolving its model. Revoked/changed authority after entry remains
   pending if it cannot be reconciled safely. Generic Unknown lookup is not proof of no effects.

Wrong identity, stale CAS, unavailable/ambiguous models, invalid fields and active/uncertain reviews
refuse without a settings write. Storage failures remain pending. A failed synchronous transaction
is a stable rejection; a lost ACK after commit is not. On refusal, refresh before a new confirmation.

## Values and preservation

`InsightsReviewSettings` is an exact object with:

- `recurrence`: existing weekly calendar schema, ISO weekday 1–7, `HH:MM`, valid time zone.
  Paris uses the scheduler's existing DST policy: first fold instance, first valid minute after a gap.
- `requestedModel: {kind:"id"|"name",value:string}`. Exact configured ID, or unique normalized
  display-name match only. No provider guessing, Pi/project default fallback or substitution.
- `scope`: `host:"local"`, `projects:"admitted"|string[]`, `includeArchived:boolean`,
  `excludeProjects:string[]`, `excludeSessions:string[]`, `sourceAccess:"read_only"`,
  `coverage:"partial"`. Lists are unique and at most 100 IDs. Empty project selection reads none.
  Explicit selected projects must exist in this local project store; exclusions can retain tombstones.
- `bounds`: inventory pages 1–4, history pages 2–8, entries/page 1–20. Anchor probes count as pages.
- `budget`: positive finite `usd` up to 10,000, `period:"report"|"month"`,
  `enforcement:"advisory"`, `basis:"initial_assumption"|"user_choice"`.
  This is not a spending cap, guarantee or permission. Missing spend/pricing stays unknown, not zero.

Revision zero is an unpersisted suggestion. It preserves the report chat's exact existing model and
one existing rule's cadence, filling only absent values from the initial 1/2/4, local admitted/archive,
$5/report defaults. Reads never write defaults. Saved choices always win after restart.
The original `/api/insights/defaults` remains a fixed suggestion for fresh setup, not an authoritative
read of an existing report's settings. No settings are saved before exact report admission exists.

## Save is not activation

Save never edits the report model, grant or rule, enables Automations, or sends input. Every save
advances the desired revision. Original rules/commands retain omitted revision fields and their exact
bytes. They do not adopt a new revision: a due stale occurrence is claimed and refused, never replayed.
Old accepted enable receipts stay accepted; their current status can become blocked.

The legacy enable preflight can use saved settings only when the existing chat's exact model
matches the saved resolved ID and the requested model still resolves to that ID. A model change needs
the separate explicit Apply confirmation below (or an existing explicit chat-model action).
No automatic switch occurs during Save or enable.
An open old rule with a different revision returns `settings_activation_required`; it is not silently
edited or unpaused. Use the separate explicit Apply contract below, not Save or an automatic repair.
Native reconfiguration UI remains separate work.
The current fixed-only native parser intentionally refuses extended settings payloads. A future
editor must consume this capability/contract and display every selected value before enabling.

## Explicit Apply contract (native handoff)

Require `hello.capabilities.insightsApply:1`, `insightsSettings:1` and the same pinned daemon/lineage.
This backend/protocol addition does not ship a settings editor or activate any real resources.

1. After a separately acknowledged Save, read `GET /api/insights/sessions/:id/apply` (no-store).
   `InsightsApplyPreflight` returns ready + payload, nextAt and unknown pricing/spend, or blocked
   with a reason and null payload. This reads configuration/catalog metadata only; no history,
   worker startup, grant changes or provider input. Unsaved revision zero cannot be applied.
   A preview exceeding the existing 64 KiB operation payload limit refuses before confirmation.
2. Show one compact **Apply** confirmation, separate from **Save**. Display `record.revision`,
   exact resolved `record.model`, reported thinking (omitted means Default), recurrence/time zone,
   all source/archive selections and exclusions, partial bounds and advisory budget/period.
   Disclose selected-provider processing and unknown spend. Show the exact `rule` being retained
   or cancelled/replaced (ID, revision, title, cadence, target). No manual rule is adopted/cancelled.
3. Freeze `InsightsApplyPayload` verbatim in a durable operation, kind `insights-apply`, targetId
   the exact report session. Use the existing private writer, immutable UTF-8 bytes/hash,
   operation ID/producer/sequence and pinned origin/destination. `expectedHome` stays verbatim;
   native envelope host labels may be local. Send once through native-gated `/api/operations`.
4. Accepted result is `InsightsApplyProgress` with phase `applied`, exact acknowledged chat,
   scheduleId and settingsRevision. This is configuration acknowledgement, never review success.
   Check is passive `/api/operations/receipt` with the complete retained envelope. Pending/Unknown
   never constructs a fresh attempt or resends entered effects. Only an unknown receipt may
   re-admit the same native-confirmed envelope, whose journal closes concurrent-entry races.
   Pending Apply fences fresh Apply, Save and enable. Do not infer receipt success from GET values.

Apply preserves the report ID, grant, backlog and history. Unchanged settings-qualified rules are
retained without a write. A changed revision uses an exact integration-owned pending/unpaused rule
CAS and a distinct deterministic replacement ID. The old row/history remains cancelled; new
occurrences start strictly in the future. Manual, multiple, dispatching, paused, terminal same-revision
or untrusted rules refuse without cancellation. Unrelated one-shot/other-chat rules stay untouched.
There is no global Automations opt-in, review dispatch, source mutation, regrant, substitution,
automatic rollback or recreation. An unavailable model refuses without fallback.

The existing model command has a distinct opt-in configuration-only discriminant. Old workers
cannot ignore an optional guard and fall back to ordinary switching. The kernel rechecks host
admission at its idle/configuration transaction boundary, and requires the worker's advertised
`modelConfiguration:1` support before sending a command. It refuses **all** compacted cross-provider
switches before selection, even if raw replay might fit: Apply cannot rebuild context, spend provider
tokens or fork attempts. Normal callers retain their legacy rebuild semantics. An explicit existing
thinking level must be supported and is preserved; omitted legacy/default thinking may become
reported when an idle worker opens. No paid migration is skipped or silently deferred by Apply.
Refusal requires a separate user decision outside Apply, not automatic repair.
A cold configuration worker uses a distinct startup discriminant and the existing Stop model/tool
barriers. It never resumes a recovered inbox, refuses non-idle durable work and closes before
releasing the per-chat configuration gate. Old workers cannot interpret that startup as ordinary
resume. A later explicit chat action, not Apply, may open an ordinary worker.

Each effect has a durable entered marker: `model_pending`, `cancel_pending`, `schedule_pending`.
After lost ACK/crash these phases are status-only forever, even when current values match; there
is no downstream exact model/cancel receipt to settle them safely. No new ID bypasses that fence.
`model_ready` and `rule_cancelled` are written only after the live exact effect ACK (or a no-op);
recovery may perform only the next unentered effect after revalidation. `applied` persists the final
ACK before journal acceptance. At every step, current home/context/grant/Stop/idle, desired revision,
model availability, review state, pending delivery and exact rule identity are rechecked. Authority or
CAS drift after entry leaves partial configuration pending, never a false no-effect rejection.
Unknown or interrupted reviews block Apply conservatively; inspection does not clear them.
The exact acknowledged cancelled row is retained in `cancelledRule` and rechecked before replacement.
Its disappearance/change is a refusal, not permission to recreate or infer this attempt's success.

Synthetic coverage: `insights-enable.test.ts` (Apply, fixed compatibility, CAS, drift, checkpoint
crashes, lost effect ACKs), `session-model.test.ts` (host guards/unsupported workers) and
`model.integration.test.ts` (zero-provider/no-fork safe switches, compacted refusal, late guard
refusal, unchanged legacy rebuilds). These do not qualify real activation or native UI acceptance.

## Host enforcement and storage

Desired settings and exact save receipts use the existing `missions.sqlite` transaction/durable lane
(`insights_settings` plus `insights_operations`), not another settings file or authority subsystem.
The record is bound to exact grant/session/project/backlog/host; session admission also checks local
home/project path, current membership, revocation and Stop. Native confirmation is checked again after
async catalog and journal work, inside the synchronous settings transaction.

Configured reviews pin the desired revision and exact bounds at reservation. Active/unknown runs
and a working report chat block new saves. Inventory excludes disallowed metadata **before** summary
delivery; histories check current local project/archive/session selection before and after reading.
Previously queued sources are reauthorized too. Queue selection inspects at most 200 metadata rows;
heavy exclusions can leave eligible rows outside that window, so coverage is still partial.
Unrestricted model-directed source reads are closed once settings exist; configured reviews use only
the bounded host-prepared `review_context` packet. Neither settings nor model text expands existing
host access, creates grants, connects hosts, or authorizes source writes. Fixed legacy behavior is
unchanged until an explicit settings save.

Synthetic coverage lives in `insights-settings.test.ts`, `insights-enable.test.ts`, existing
`insights-review.test.ts` and `schedules-insights.test.ts`. It does not qualify a live review or editor.
