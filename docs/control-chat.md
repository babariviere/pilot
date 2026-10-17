# Control chat internals

## Memory storage

`ControlMemory` sends bounded RPCs to the existing project-memory worker entrypoint. The worker
opens a separate control-chat store under `memory/control-chat/`. No model or synchronous filesystem
work runs on pilotd's event loop. Project memory's fixed-width, 280-byte note format is not suitable
for verbatim, variable-length messages, so the control store uses SQLite instead.

The store reuses project memory's exclusive SQLite owner-lease pattern. It never expires or deletes
the lease; process exit releases it. A WAL database with `synchronous=FULL` commits each message,
its ready jobs and its view addition together. SQLite crash recovery replaces fixed-record tail
repair here, avoiding a separate log/view recovery window. Log rows cannot be updated or deleted;
summary nodes are also write-once. Delivery keys make retried appends idempotent.

Messages have permanent zero-based IDs. Tool calls retain the name and JSON input. Only tool
echoes are clipped (head and tail, at most 30,000 characters). Other long texts split losslessly
into adjacent messages. Thoughts are not an accepted message kind. Raw reads are paged.

Nodes hold at most 512 UTF-8 bytes, including the source's kind. Short sources need no model call;
long sources enter a durable ready queue. Building a child only checks its sibling and enqueues
their parent. Claimed work returns to the ready queue on restart; failed calls wait for a new message.

The view is stored as ranges, not reconstructed from the log on startup. It contains only summary
text, or an explicit unsummarized placeholder, never partial raw messages. Its rendered UTF-8 size
triggers a merge batch above 128,000 bytes, targeting 64,000. Only built parents can merge. If a
batch lacks summaries it stays pending and continues as summaries arrive. One fixed-time heap
orders the batch by `(count - pairLastMessage) / childSize`, oldest first on ties. Newly exposed
siblings enter the heap immediately. There is no tree scan on each appended message.

`control-memory.test.ts` compares this order to rollback push at every t from 0 through 20,000,
and covers exact restart view preservation, crash rollback, leases, queue recovery, Unicode sizes,
paging and message kinds. On a local offline run the 20,001-prefix comparison took 82 ms; a
600-message storage/batch/reopen case took 515 ms. These are synthetic storage checks, not
provider streaming or whole-daemon responsiveness measurements. There is no old control store
to compare against. Full live-session responsiveness remains an integration check for the session.

## Background compaction

`ControlCompactor` admits at most eight calls, from the durable ready queue. A leaf starts only
among the first eight unbuilt leaves; a parent enters the queue only when both children exist.
Failures retry on the next message, not a timer. Shutdown races cancellation against the provider,
so even an uncooperative provider cannot hold daemon shutdown open. Storage closes after cancellation.

`ModelCatalog.compactControl` chooses the cheapest authenticated model in the turn's scope and
provider, never a cross-provider fallback. `control-context.ts` owns the stable system prompt and
tool/context construction shared with turns. Compactions declare the same tools but cannot execute
them. A 512-dash ruler and up to five correction retries enforce a 512-byte line. The shortest valid
line wins; oversized output is never silently truncated into memory.

A second persisted range list is the compaction view, merged from 32,000 to 16,000 bytes, or when
the main view merges. Its context ends at the target node (before a leaf), and stops at the first
unbuilt range, with no placeholders or partial messages. Four-line text blocks keep an append-stable
prefix; the Anthropic payload hook marks the last whole block and the request end. No keepalive
requests or artificial cache retention are used. Faux-provider tests cover retries, tools, same-provider
selection, concurrency, parent readiness, failure recovery, cache blocks and shutdown cancellation.

## Session and turns

`SessionManager.ensureControlChat()` creates one reserved identity, without starting a worker or
spending on a greeting. Production calls it after metadata load; `POST /api/control-chat` also returns
the same chat. It is Ask, project-less, permanently pinned and cannot be archived. Its internal
configuration directory is not exposed as a workspace. The native control profile constructs no
filesystem tools, repository readers, personal extensions, project context, MCP or shell.

One Harness conversation retains the transcript, input queue, tool execution, Stop and crash recovery.
Each run's first input submission anchors the turn. A request hook sends only the shared system/tools,
the pre-input persisted view, and that run's messages. Steering and tool rounds keep the same anchor.
The next run gets a fresh view. Idle model changes use the selected model on the next run. Harness
automatic and manual compaction are disabled for control. A dispatch guard fails closed if the
projection hook fails, rather than sending the Harness's original full history.

Committed entries drain incrementally, 32 at a time, into the log with stable entry/block keys and a
durable cursor. Thoughts and system scaffolding are excluded. The pre-input view is saved in both the
store's current-turn slot and the Harness's latest-only turn document, so retries and worker replacement
cannot accidentally include the input in its own view. Turn origin comes from the placed submission,
not action arguments. A recovered daemon defaults to notice restrictions until the turn is prepared.

Faux-provider tests check fresh calls, unchanged tool rounds, absent filesystem tools, thought exclusion,
restart deduplication, next-turn model selection and failed projections. No UI views are changed here;
the control-specific sidebar and Watching list are separate work. No visual check was performed.
The native adapter still mirrors the retained Harness transcript for SDK compatibility; the provider
request and log drain are bounded, but very-long-chat mirror cost is an unverified performance risk.

## Global reads

Only the control profile registers `pilot`. Every IPC call checks the supervised session's current
role again in pilotd. `status` uses session/project memory, cached Linear previews and a change-driven
mission snapshot. It never reads SQL or starts/subscribes to a worker from the tool path. Filters apply
to every resource family. Responses are capped at 24 KB with explicit totals and truncation.

`read` uses one bounded cold-history page, not a worker wake or an unbounded search for old replies.
It returns a last assistant result found in that page, or up to 40 tail messages, capped at 12,000
characters. Thoughts are omitted and content is explicitly labelled as quoted, untrusted data.

## Audited actions

`start` uses the existing project spawn path with task-model scope and price validation, or the
existing mission task-start admission (including user-set task preferences). `send` is a follow-up,
so busy targets queue it. Mission member targets route to the current coordinator unless `direct`
is true; a mission without a coordinator requires an explicit direct target. Self-send is rejected.

The supervised tool call ID keys an append-only audit intent before the effect and a terminal result
afterwards. Exact successful retries return the durable result; uncertain or failed requests are not
replayed. Audit SQL runs in the memory worker. Terminal records also enqueue passive control-chat
timeline activity, with stable delivery IDs. `GET /api/control-chat/audit` pages the durable history
(newest first, `before` sequence and `limit` 1..50), including intents left uncertain by a crash.

`mission_create(projectId, goal, brief?)` reuses the existing create service, waits for durable state,
then starts its coordinator through scoped, price-capped admission. Creation and coordinator start
have separate audit intents/results, so a failed start does not falsely claim the created mission
was rolled back. The action must report a user request or accepted suggestion, and pilotd separately
rejects it during a notice turn, regardless of those arguments. Draft briefs are capped at 32 KB.

`mission_attach` calls the same join/claim service as the session membership endpoint, behind a
synchronous idle guard. It rejects active/queued work, background agents, archived/failed chats and
configuration transitions. Same-project and task-owner checks remain in the shared join service,
before membership is changed. It requires an accepted suggestion, is forbidden during notices,
waits for durable membership and records the target, optional claim and outcome in the audit.

## Cross-project memory

Control declares `memory_wake`, `memory_recall`, `memory_zoom` and `memory_note`, each with a required
registered `projectId`. Ordinary chats retain their implicit project and cannot supply a project
override. The daemon checks the live caller role and registered project on every control call.
Read results are quoted as untrusted. Notes always use the supervised control chat as origin,
ignoring any supplied author, and use the same durable audit/timeline path as orchestration actions.
No forget operation is exposed. Corrections append new notes; existing log records remain intact.

## Watches and client contract

The control-only `pilot` tool exposes `watch(event, target, mode, note, filter?, expiresAt?)`,
`unwatch(watchId)` and `watches(after?, limit?)` over the shared worker-backed WatchService.
The saved note is an instruction authorized when the watch was requested; source event text is
separately quoted as untrusted data. A frozen notice uses its durable `watch-notice:<lastEventId>`
identity for idle-only input admission. The Harness deduplicates that identity across retries and
worker replacement. The event summary keeps the notice visible in the transcript, and the
OptChat drain logs it as an `event`, not a user request. It starts a fresh control turn.
Mission creation and attachment remain forbidden for the whole notice turn, including tool rounds.

The daemon binds the singleton sink before session recovery and reschedules it on lifecycle changes.
Control starts carry a durable input identity, as do explicit sends. The kernel reports origin only
when that input's run actually starts (or recovers), not when a busy chat queues it. It waits for the
watch worker's durable attribution acknowledgement before publishing completion. A subsequent
user-caused run replaces the attribution, so its result can wake the control chat normally.

Client wire types live in `packages/protocol/src/control.ts`, mirrored in `PilotCore/ControlChat.swift`.
`GET/POST /api/control-chat` return the existing SessionSummary shape (`control: true`);
ordinary session WebSocket frames carry its changes. `GET /api/control-chat/watches` pages in ID order
with `after` and `limit` (default 40, at most 100); `next` is omitted at the end.
`DELETE /api/control-chat/watches/:id` returns `{removed}`, including false for already-fired or
cancelled watches. Audit reads retain their newest-first sequence paging.
`watches.changed` and `control-audit.changed` on the shared socket invalidate those HTTP pages.
Clients refetch on reconnect rather than treating invalidations as a durable event stream.
Model changes use the existing session response and `reason: "model"` attempt shape, including
automatic cross-provider context rebuilds; no separate model-switch WebSocket channel is needed.
