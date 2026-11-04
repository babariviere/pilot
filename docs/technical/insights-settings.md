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

An explicit new enable preflight can use saved settings only when the existing chat's exact model
matches the saved resolved ID and the requested model still resolves to that ID. A model change needs
the separate existing explicit chat-model confirmation. No automatic switch occurs here.
An open old rule with a different revision returns `settings_activation_required`; it is not silently
edited or unpaused. This backend exposes no compound reconfiguration action. A caller must separately
confirm cancellation of that exact pending rule with its existing CAS, then confirm fresh enable.
The new rule has a distinct settings-qualified identity, pinned `insightsSettingsRevision`, and a
future start boundary, not replayed past occurrences. Never automate this cancellation as a save effect.
Native reconfiguration UX remains separate work.
The current fixed-only native parser intentionally refuses extended settings payloads. A future
editor must consume this capability/contract and display every selected value before enabling.

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
