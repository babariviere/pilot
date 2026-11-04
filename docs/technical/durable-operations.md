# Durable operations

`DurableOperation` is transport independent. Origin/destination storage lineage, producer sequence,
operation ID, target ID, binding fence and exact UTF-8 payload/hash are immutable. An operation
journal reserves and fsyncs before invoking a registered handler. A handler must reuse targetId
and operationId when materializing metadata and admitting kernel input. This is at-most-one
allocation/admission with intact journals, not exactly-once arbitrary external tool effects.

HTTP exposes POST /api/operations and POST /api/operations/receipt. Missing receipts are unknown;
pending receipts are recoverable ownership, not failure. Only explicit OperationRejected errors
are final rejections. Other failures remain pending. Unsupported operation kinds cannot execute.
Recovery calls only registered idempotent handlers. The UI API never retries arbitrary mutations.

The async filesystem journal bounds payloads to 64 KiB, records to 4096, handler concurrency to 4,
and journal requests to 64. Storage faults fence the owner until recovery. Receipt retention has no
TTL. Only durable peer acknowledgment permits retire(); its persisted rejection floor precedes
deletion, so old IDs never become executable again. Full retention causes backpressure, not eviction.
One journal owner is required per data home. Restoration/cloning requires lineage repair.

`OperationOutbox` persists UI intents before exposure, retaining the same key after relaunch.
`HostClients.deliver` checks availability before reservation and reconciles by receipt first.
It returns the original operation and accepted/rejected/pending/unknown delivery. Consumers must
durably adopt the receipt and clear/transfer the owning draft and attachments before acknowledge().
Unknown or pending delivery must retain that ownership and must not create a fresh operation.

Existing local-only composer APIs are retained for older daemons. Unified remote UI must use deliver()
and explicit acknowledgment, rather than those legacy send/spawn calls. No cross-host offline chat-send queue
is enabled. Shared-context provisional write outboxes are separately allowed and may use the same
generic journal mechanics without sharing chat-send policy. The generic journal is available to
daemon couriers; cross-host context permissions/validation are not implemented by this primitive.

## Native Local delivery

New ordinary Next sends opt into recovery in the existing private `Book`. The
writer reserves immutable bytes, operation/target IDs, model/project choice and
attachment hashes before network preflight. Its FIFO owner services autosave and
Close while HTTP waits, then reconciles with bounded 1–30 second backoff. It never
constructs a replacement operation for an ambiguous outcome. Historical intents,
subagent one-shot sends and Stop are not silently opted in.

Receipt lookup precedes execution. Re-entering a pending journal joins its running
handler or recovers admission with the same kernel request ID. Acceptance dedupes
before extension input hooks, including detached attempts. Unknown receipts alone
are not proof of nonacceptance. Stop, model changes and attempt moves durably
advance `inputGeneration`; stale captures may settle an existing exact submission,
but cannot start new input. Native question replies atomically bind `questionReplyId`.
The hello capabilities are `durableInputGeneration:1` and `questionReplies:1`.

The kernel SQLite writer uses `synchronous=FULL` and `fullfsync=ON` before exposing
storage. This improves acknowledged WAL durability, not proof of physical power-loss
survival. A synthetic 1000 × 1 KiB commit probe measured 3.5–4.2 seconds with FULL
versus 50–70 ms with NORMAL; this is not an app-latency benchmark. Interrupted
external tools remain interrupted and are never made replay-safe by input dedupe.
An isolated missing-receipt scan measured median 0.02/0.46/1.93 ms for 1/256/1024
conversations (10 reads each). Pages retain at most 64 conversation rows; total
scan work grows with attempts. These are warm synthetic reads, not live recovery latency.
