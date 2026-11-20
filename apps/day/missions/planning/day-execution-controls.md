# Native execution controls

Day's published-plan runner continues dependency-ready tasks after the user's first Start. It is distinct from
the legacy coordinator continuation policy described in [mission-continuation.md](../../../../packages/daemon/src/missions/lifecycle/mission-continuation.md).
This changes no model, spending, provider, installation or cutover authority.

## Coding admission and queues

`SessionManager.codingCapacityReason` checks live coding work, synchronous startup reservations, open task
owners and uncertain durable starts. It excludes the target identity, not its siblings. Project path identities
are resolved off-thread; aliases of a registered source share capacity. Limits are two per isolated-copy project,
four across the app and one writer for a direct-folder project. Existing interrupted allocations are recovered
as existing work, not new grants; an over-capacity recovered inventory blocks new starts rather than stopping
other work silently. Ask/planning/coordinator chats do not consume coding slots. Helpers inside a coding
worker remain that worker's responsibility, not independently scheduled task allocations.

Queued ordinary inputs remain in the existing durable outbox. Admission reserves a slot before yielding.
State and mission events coalesce queue reconciliation; blocked queues have no polling or self-message loop.
Published starts check capacity before creation, at the first creation effect and before initial input.
The mission detail exposes a passive v1 `execution` queue. Day shows up to 40 rows and the total, matching
the existing bounded native overview. It never uses the queue read as permission or an admission receipt.

## Owned scopes and combined checks

Reviewed `PlanSlice.files` contains exact repository-relative files or directory prefixes, not globs, absolute
paths or traversal. At most 100 paths of 512 characters protect saved planning/model context. The review
shows them and the published task body carries them. A source mismatch loses the declaration rather than
borrowing stale ownership. Missing scopes run alongside other writers; conflicts show at merge. Case-folded prefix
overlap waits until the prior task is checked done. Distinct declared scopes can proceed within capacity.
An earlier blocked unpinned task does not block an independent disjoint task; explicit pinned order still wins.
Workers must check the combined changes before reporting ready, and the user checks the result before
releasing dependent work. These are scheduling declarations, not a filesystem sandbox or permission to write
outside the agreed task. They do not qualify symlink aliases or manual edits as safe parallel work.

## Uncertainty and user control

Automatic starts save their operation and target before worker effects. Absent metadata, failed reads and missing
kernel receipts preserve the original attempt and its slot. Recovery only looks up that attempt. Only
`PublishedStartRefused`, minted by the host before the first creation effect, can release a refused attempt.
Unknown work does not prevent disjoint dependency-ready work when capacity remains.

Existing mission Pause checkpoints save the member inventory and block new work before interruption.
Pausing/Unknown is not a completed save. Resume preserves independent holds.
Confirmed [Interrupt](../../../../packages/daemon/src/missions/threads/thread-chats.md) is separate from a queued ordinary thread comment and never creates
an agent. The question's Open discussion reads recent original context and keeps its existing reply/draft;
it does not create another question, worker or notification.

Ask a question sends one tool-free clarification through that original worker's metered model runtime.
It does not submit an answer, enter the normal inbox or release the question hold. The same request stays
in Needs you until the user answers it explicitly. Later clarifications include whole recent exchanges;
older context may be omitted. The main work does not resume. A parked worker may reopen the same durable
conversation, never a second agent. Stop, Pause and close cancel and join the side reply.

Clarifications use the existing allowance and physical-send funding checks, no fallback or automatic provider
retry. Unsupported output bounds still refuse. Replies are limited to 1024 model output tokens; a 32 KiB
prompt limits request cost and includes at most 16 KiB of whole recent context/exchanges. Intent and result
receipts survive restart. An uncertain reply only permits exact lookup, not another send or another
clarification of that question. The user can still explicitly answer the original question.
Legacy unmetered chats cannot acquire new allowance authority through clarification. The existing explicit
limits-off setting remains in effect; it does not bypass the verified output bound.

## Verification limits

Faux-provider service tests, native DTO/operation validation and headless UI fixtures cover these contracts.
Native fixture captures are not live-provider billing, packaged daily-use, IME, Linux or cutover acceptance.
