# A failed chat's next attempt

The existing native model/thinking menus can save a preference for a failed
Local chat. The caption says **Next attempt only**. This is not a retry:
the failure, reason/version, current effective model, attempts, history,
queued input, composer draft and reader remain intact. Thinking can be an
explicit supported level or **Scoped default**, which stores no override.
Unavailable models are retained, not replaced by the first catalog entry.

## Passive contract

`hello.capabilities.passiveFailedModel` gates the separate
`POST /api/sessions/:id/failed-model`. Missing capability or failure evidence
fails closed, without falling back to the legacy model endpoint. The request
contains exact home identity, an operation ID, model/optional thinking and the
captured `failedModelSource`. This source is an opaque SHA-256 precondition over
the exact chat/project/directory, startup failure versus settled failed outcome,
failure/completion version and evidence, current model/thinking, queued outbox,
execution ceiling, competing preference and private configuration revision.
It is not authentication or an idempotency key.

Admission holds the existing per-chat configuration and daemon-update gates
through scoped catalog resolution and persistence. It rechecks the source after
the catalog await and refuses busy/starting, replaced/healthy, read-only,
archived/continued/transferring, coordinator/Control/diagnostic, delegated or
workspace-transitioning chats. Unknown worker activity fails closed. The save
only sets `nextAttemptModel`, its private revision and metadata update time.
It neither opens nor closes/configures a worker, calls native input hooks,
drains a queue, reconciles notices, clears the failure, nor changes attempts.
General session-change listeners include notice admission, so this save does not
broadcast through them. The exact HTTP ACK updates the caller; other clients see
the preference on their next ordinary read.

Successful HTTP200 follows file flush, rename and parent-directory fsync. The ACK
must match home, operation, chat, original failure source and exact requested
preference. Post-rename failures can still leave a saved preference. Every
malformed/error/lost ACK is therefore **Unknown**, with the immutable target and
choice retained privately across navigation/restart. GET equality is observation,
not settlement. Explicit local acknowledgment dismisses uncertainty without
claiming success or replaying POST. Late ACKs cannot retarget the selected draft,
change its text/selection or steal focus. Existing healthy model callers are
unchanged; this opt-in path never uses their worker-backed endpoint.

## Separate recovery

Only a subsequent explicit startup retry or ordinary user message admitted by the
user HTTP/durable-operation path activates the saved choice. Internal senders,
including a previously scheduled message, cannot infer this permission from an
unrecognized request ID. Automatic notices/drains and cold reads do not activate it. A cold
subscription remains a history read. Explicit recovery carries the choice into
the next worker and applies the kernel's existing atomic idle/inbox model guard
before scheduling resumes, rather than letting an old durable pin override it.
An existing idle failed worker closes only at that later explicit recovery.
The preference is consumed after matching kernel readiness. Unavailable models,
busy durable inboxes and provider-context safety failures remain failures; there
is no fallback. A provider-compaction rebuild requires another explicit recovery
to open the rebuilt attempt. No new retry/start/continuation UI is added here.

## Focused verification

The session-model daemon file maps persistence/restart, no-worker/no-work,
failure/configuration/authority races, legacy behavior, HTTP validation/exact ACK,
persistence errors and separate explicit activation. One faux-kernel test proves
an activated preference overrides a durable model pin before resume without a
model request. `--unit chat_model --test project_creation --lint` maps transport
and real offscreen picker input, default thinking, failed Unknown/GET retention,
delayed ACK navigation, preedit/draft/reader retention, 680/1100 light/dark and
existing creation regressions. `--unit model_picker --native-probes` maps retained
picker state and stale callback guards. These are synthetic tests, not live-chat
mutation, OS IME/AX, animation/performance, Linux or release acceptance.
