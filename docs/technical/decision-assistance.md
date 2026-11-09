# Decision help and human actions

These are backend contracts, not a live feature activation. `AttentionService` is an explicit
host-integration seam. It installs no HTTP route, model producer, scheduler, tool or worker wake.
The upcoming native host must supply current access checks, exact source/resource readers and
its authenticated native-user boundary. Mock callbacks do not qualify those production adapters.

## Reuse audit

- `MissionStore` already owns binding decisions and pending change proposals. A `MissionDecision`
  is not a pending user choice. `assistanceSource` reads actual decision/proposal rows and the
  mission event high-water. Proposal sources include the current binding text. No duplicate
  choice store or inferred approval is introduced.
- Kernel `held-inputs.ts` checks an ordinary question's exact transcript entry, current pending
  boundary, Stop and reply identity before admitting a native answer. Its transaction can resume
  a suspended run. Decision help must **not** use that reply admission path.
  `nativeQuestionAssistance` instead requires a trusted current-boundary reader. It rejects older
  entries, answered/stopped questions and database-access prompts. Reading historical transcript
  records alone does not satisfy this port.
- `workflow-confirmations.ts` and `workflow-confirmation-store.ts` own workflow approval and
  reviewer consent. Help cannot write them, accept proposals, resolve questions or edit guidance.
- Ordinary asks have no durable manual-action/file/destination/completion lifecycle. Human actions
  therefore have distinct records, sharing the existing `missions.sqlite` transaction and replica
  lane. Neither temporary native ask ACKs nor agent messages count as completion receipts.
- Visual help references exact immutable artifact revisions and SHA-256 bytes. It does not create
  another artifact format or execute artifact code.

## Help

`prepare` returns a scope containing the exact subject, project, content digest, event identity
and current authority digest. Help requests support simpler text, context, pinned visuals and an
inline question/answer pair. Inline questions are not replies to the underlying user choice.

The service records entry durably **before** invoking the optional producer. It rechecks scope
after generation, artifact verification and saving. Typed outputs reject additional authority
fields. An entered request without a settled receipt is Unknown, including after restart.
`lookupAssistance` never invokes the producer. Use the exact original request to look up a lost ACK;
do not generate again automatically. Changing text and then reverting it still invalidates help
because the source event identity changed.

The producer receives only copied request data and source text. Its implementation must separately
enforce provider admission, spending limits, cancellation and read-only generation. This module
does not grant provider access or claim to sandbox an arbitrary callback.

## Human actions

The typed content pins origin project/chat/optional mission, action/reason, versioned files or
artifacts, destination/package version and completion requirements. Creation and replacement
require exact resource verification. Saved progress, Later, returning to attention and cancellation
do not complete the action. Replacement preserves origin and clears progress for the changed work.
Every state change advances the request revision; content also carries a digest.

Only a host-authenticated native user can save progress, defer, return or report completion.
Agents may request, replace or cancel only within the supplied current origin authority. No actor
flag from untrusted JSON can establish this authority. The host must check current membership,
project/home identity, configured permissions and later holds at each authorization call.

Commands carry stable operation IDs and exact expected request identities. The state update and
immutable command/result receipt commit in one transaction. Responses cross the store durability
barrier and recheck authority and row identity. A lost saving ACK is Unknown. Duplicate commands
refuse mutation and direct callers to `lookupOperation`; lookup never repeats external work.
Historical receipt lookup explicitly reports whether the receipt still matches the current row.
Completed/cancelled requests are terminal. New work needs a new request, not revival of old consent.

`completion(originalRequestIdentity, operationId)` returns only the exact current, durable
**user-report** receipt after checking resources and authority again. Missing receipts remain
Unknown. It does not prove an external upload or publication. A dependent-work consumer must still
check its own current assignment/permission/Stop/pause fences and dedupe its own continuation.
No unrelated chat or mission work is paused by these records. No dispatch or continuation is
implemented here; native integration must not treat a GET, link open or model prose as its trigger.

## One-shot check integration

Schedule adapters should bind `HumanActionIdentity` (ID, revision, content digest), exact file/artifact
bytes and destination/package version. Cancel obsolete checks when the request changes or becomes
terminal. This is an integration requirement, not a second timer engine or live check activation.

`HumanActionObservation` deliberately separates submitted, review pending, published, not observed
and Unknown. Observations never complete an action. A public version lag cannot prove upload absence.
Follow-up checks must use the existing scheduler's delegation, disabled-Automations, cancellation,
pause and deduplication rules. No substantive new scheduling engine is required by this seam.

## Limits and verification

Requests are size-limited. The store refuses more than 4,096 combined help/operation records instead
of evicting uncertain requests or completion receipts. Capacity cleanup/export policy is not provided.

`attention-service.test.ts` covers ordinary question identity, guidance/proposal separation, all
help modes, async staleness, invalid authority fields, immutable visuals, restart, deferral, stale
files, changed origins, explicit user completion, exact duplicate/lost ACK lookup and durability
races. These fixtures do not claim native UI acceptance, production provider/resource-reader
qualification, external store verification or live scheduler execution.
