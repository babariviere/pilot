# Decision help and human actions

These are backend contracts, not a live feature activation. `AttentionService` owns help and
human-action receipts in the existing `missions.sqlite`. `NativeAttention` now supplies authenticated
daemon ingress and the Rust host has a shared-ledger attention transport
([native boundary](day-native-host.md#attention-transport)). See that guide for the connected card
feed. No production help executor or dependent-work consumer is installed: both capabilities remain
explicitly unavailable. The offline executor qualification below does not enable either capability.

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

`ReadOnlyAttentionExecutor` supplies the typed execution path. Native capability discovery no longer
treats a truthy generation callback as qualification. The executor uses the existing SDK credential
resolver and concrete provider, a fresh tool-free transcript, explicit configured model/output/time
limits and a mandatory reserve-before-send admission port. It constructs no agent, session, tool,
extension, package, MCP client or continuation. Simpler text, supplied context and inline answers are
commentary only. Missing facts must remain missing; there is no placeholder answer or source fallback.

Native ingress pins the executor configuration digest alongside the current project, owner,
membership, mission controls and question/decision scope. It re-reads the actual pending question
after budget and credential I/O. Final synchronous permission/lifecycle/budget checks immediately
precede concrete provider dispatch. Configured revision replacement invalidates prior help scopes,
including receipt reads. Ready records keep provider/model, configuration digest and reservation ID
with the exact request and output in the original attention store.

Origin/project/mission notifications cancel revoked or held execution. Stop and close keep the
actual provider and accounting promise admitted even if the provider ignores cancellation. Native
close also joins final attention writes. The executor's maintenance contributor participates in
daemon update admission when explicitly supplied to the server. Neither cancellation nor an empty
consumer queue proves provider exit.

### Qualification limit: production stays unavailable

Only the **offline SDK faux transport** is admitted by this implementation. This verifies the real
native/HTTP admission path without contacting a provider. No production executor is constructed by
daemon startup. Visual generation is unsupported. Existing immutable visual receipts remain readable
under their original resource and scope checks.

Live enablement still needs these explicit, separately qualified inputs:

- An attention-specific configured provider/model and permission revision. Chat defaults, first
  authenticated models, reviewer choices and classifier models are not assistance policy.
- An enforcing assistance budget owner: scope, window, included work, pricing, durable worst-case
  reservations, revocation and lookup-only recovery after lost ACKs. `AIUsageBudget` is informational;
  reviewer allowances do not authorize attention calls. No budget grant/store is invented here.
- A production transport proof for exact auth shaping, physical sends, token limits, retries and
  cancellation. A `maxRetries: 0` or `maxTokens` option alone is not that proof. The faux fixture does
  not establish paid-provider limits or live correctness.
- Wiring the configured owner into mission Stop/Pause checkpoint/drain. The typed reservation's
  synchronous fence and cancellation must come from current authority, not request JSON. Event
  cancellation alone does not make mission Pause acknowledged or establish quiescence.

The admission port is a trusted integration contract, not itself a budget service or a sandbox for
an arbitrary callback. Missing configuration or an unsupported transport refuses honestly. Nothing
here activates a model, grants spending authority, starts work or changes the stopped continuation
and budget-request implementations.

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

`attention-executor.test.ts` exercises native admission with the real SDK faux provider, authenticated
HTTP help, exact text-only outputs and provenance, absent/unsupported configuration, forbidden tools,
changed question/actor/configuration, Stop/Pause fences after I/O, stale credentials, lost entry,
reservation, usage and result ACKs, restart lookup and provider-ignores-cancellation close/drain.
The reservation owner in these fixtures is synthetic, not a new product budget policy.

## Pilot Day cards (mock)

Pilot Day's decision and action cards (`apps/day`) use these shapes against an in-process mock, not this
service: help names the decision revision shown and never changes it; action commands carry the exact
revision, digest and a new operation ID recorded before sending; a lost answer stays Unknown until a lookup.
The Rust-only transport now covers authenticated reads, current ordinary questions, local file and
immutable visual checks, native-created intents, exact receipts and saved draft locations. The
existing card feed is not yet bound to it. No production provider or automatic continuation is enabled.
