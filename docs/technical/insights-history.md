# Restricted cross-project history

## Status and scope

Internal Insights profile foundation only. No public HTTP/native setup route, live grant,
private-history review or recurring rule is enabled by this change. The only model tool in this
profile is `insights_history`. Backlog writes, report checkpoints, native activation and scheduling
are separate integrations. This document does not certify end-to-end availability.

## Admission and recovery

`SessionManager.spawnInsightsDurable(setup, targetId, operationId)` is a trusted host-only entry
point. Its caller must reserve the durable create operation and disclose selected-model processing
before activation. Generic spawn, caller-supplied roles, history text and schedule messages cannot
mint the grant. Concurrent requests serialize by exact target; operation ID and setup digest must
match for replay. A replay only returns an already committed, currently valid binding.

The private persisted grant binds schema/revision, grant UUID, report session, project ID and path,
exact active backlog mission, local home, and host/daemon/lineage. Only its public identity subset
reaches the kernel. Missing/corrupt, disabled, moved-project, replaced-host, archived or non-member
bindings fail closed. Coordinator promotion cannot acquire a workspace or general mission tools.
Continuation cannot transfer this profile into an ordinary chat.

Setup first persists a private pending fence, joins the exact mission and waits for mission durability,
then clears the fence in a final durable metadata save. An interrupted pending setup fails closed
on reload even if membership survived. Failed setup retains a disabled tombstone; exact retries
cannot mint replacement authority. Recovery never recreates missing membership. A durable completed
setup may be looked up after a lost reply; an unknown result is not permission to rerun creation.

`insightsAdmission(callerId, worker)` derives `{ binding, revalidate() }` from the supervised live
worker, not model arguments. Future narrow writers must revalidate inside their transaction and
before delivering a result. It grants no generic mission-write authority. Startup, input admission,
history-read completion and final IPC delivery recheck authority. Reload retains the role and its
closed tool list; it does not upgrade an invalid grant.

`revokeInsights(id, expectedRevision)` closes admission synchronously and persists a newer disabled
revision before acknowledging. It drains already-admitted own-chat accounting first; queued lifecycle
saves cannot resurrect an enabled grant. Revocation suppresses stale content delivery, but does not
cancel an already-running SQLite read or retract excerpts already disclosed. It does not stop an
already-admitted model turn; subsequent tools and input admission fail closed.

## Reader and boundaries

The closed selector permits `chats`, `projects`, `history` and literal `search` with bounded
`sessionId`, `query`, `after`, `before`, `limit` fields. Host selection, paths and other diagnostic
actions are rejected. Reads reuse the [diagnostic context/history reader](agent-diagnostics.md),
with a host identity supplied by admission. They do not connect to linked hosts, wake/subscribe to
source workers or inspect current repository files.

- Discovery scans at most 200 metadata rows and returns at most 20. History pages return at most
  20 entries, scan at most 200 committed records, and cap entry text at 8 KiB and encoded data at 64 KiB.
- Responses preserve host qualification, collection time, stable refs, source availability, pagination,
  truncation and partial coverage. Cross-chat search must carry both returned paging coordinates.
- Credential fields/text, private reasoning and embedded attachment bodies are withheld/redacted.
  Canonical `pilot://chat/<UUID>` citations survive sanitization, not arbitrary URLs or paths.
- Missing/offline/unreadable sources are unavailable, never evidence of absence. History-only evidence
  cannot establish repository state or directly inspect artifact source/rendering.
- Cancellation settles the caller promptly; bounded cold reads may finish later, without late disclosure.

Both the kernel tool-dispatch list and daemon IPC list are closed. The profile loads no personal or
project extensions, context files, skills, MCP, codemode, shell, file, repair, general mission,
subagent or artifact tools. It does not inherit Diagnostics authority. Forged IPC cannot bypass
these restrictions. Own-chat usage accounting is rebound to its grant and host-derived attribution;
foreign source IDs, parent/scope claims and other-chat attribution are not accepted as authority.

Historical excerpts remain untrusted evidence, not instructions or approval. Ordinary chats gain
no app-wide history tool. The profile can propose improvements, not approve implementation or change
models/budgets/limits. Shipped work is not proof of verified benefit.

## Synthetic verification

`packages/daemon/src/sessions.test.ts` exercises setup/replay, archived cross-project discovery,
real committed cold storage, sanitization, missing storage, bounded pagination/truncation, cancellation,
worker replacement, membership/project/host/revocation fences, forged IPC/accounting, reload,
continuation refusal, asynchronous startup and failed/interrupted setup. No real accounts are used.

`packages/kernel/src/insights-role.integration.test.ts` checks hostile project/personal resources,
spoofed tool definitions, reload and malformed start envelopes before storage opens. Existing Ask,
Diagnostics, diagnostic-context/history and mission-service tests cover adjacent behavior. Typecheck,
targeted formatting and whitespace checks cover the changed TypeScript surfaces. Swift only mirrors
the role enum; no local Swift build or native UI activation is claimed.

The session suite has a separately reproduced failure on the parent implementation:
`a new execution drain is busy even during a reentrant idle worker factory notification`.
Its assertion is retained unchanged; the failure is not evidence that the new profile passes that
unrelated admission scenario. No live native setup, selected-provider disclosure, scheduler dispatch,
report durability or benefit verification is established by these synthetic checks.
