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
