# Experimental automatic handoff

Enable **Settings → Chats → Automatic handoff (experimental)** in Pilot Next. The host-global
setting is off by default. It changes ordinary chats, including mission members, without
creating another chat or workspace. Mission coordinators keep their summary-tree memory.
The settings screen is daemon-backed, not a GUI-only preference or a pi settings edit.

## Trigger and continuation

At a native model-request boundary, after the current tool round has settled, handoff
starts when estimated context exceeds the lesser of 100,000 tokens and 70% of the current
model window. Windows smaller than the reserve also reduce the trigger. The native
usage measure combines the latest assistant's reported input, cache and output tokens
with estimates of newer context;
it is not an exact tokenizer prediction. There is no periodic wake-up or idle handoff.
Unknown windows do not enable threshold handoff. Native overflow recovery also uses the
handoff writer when a blocking context replacement is possible.

The writer is a tool-free request on the chat's current model and thinking level. It
gets processed active context, including the previous handoff and completed tool
evidence, with source entry IDs. It does not get a second deterministic checklist.
Historical images are represented by omissions, not transmitted as binary data, and
reasoning blocks are excluded. Long individual text fields use the existing bounded
history redactor and explicitly mark clipping; originals are never modified. The source
must fit the model window with room reserved for the handoff or the operation fails.
Historical image meaning can still be lost: `history_recall` returns text, not pixels.
Retained transcript/attachment storage is not a promise of model-side visual recall.

The output must be a clean, nonempty, tool-free stop, within 4,096 UTF-8 bytes after
the existing history safeguards redact credentials and neutralize framing. The writer
targets 3,000 bytes for headroom. A fully received, oversized draft gets one tool-free
rewrite request using that sanitized draft, provided it fits the model window. This is
not a replay of an interrupted request. Both calls count toward usage; neither can run
tools. A still-oversized rewrite fails with the actual byte count. Length-limited,
failed, empty or tool-calling output fails without another request. Text is never clipped.
Failure messages identify the rejection without exposing the draft or provider error text. These checks
do not prove semantic completeness, correct citations or absence of model mistakes.
The provider output-token ceiling is separate and adaptive, allowing room for the
current model's reasoning as well as the visible handoff.

The Harness commits one `pi.compaction` entry with `data.mode: "handoff"`. It discards
the processed context, not a fixed recent-token tail. Unconsumed user inputs remain
verbatim after it under their original entry IDs, including images. When a new tool
result contains images a model has not seen, its native assistant/tool-result round
also remains intact. The marker's head points to that original suffix, or to itself
when nothing needs retention. Nothing is copied, resubmitted or given a new identity.
The suffix must pass the native tool-safe cut check. Its content and image hashes
participate in ready recovery; a conservative fresh-context budget check fails without
dispatch or replacement when it cannot fit. These retained messages are excluded from
the writer request and follow the handoff directly, not as a lossy summary.
The next generation rebuilds the current system prompt and tool loadout and continues
the same durable run from the handoff. No native tools are executed by the handoff
writer, and no old tool calls or JavaScript stacks are replayed by the transition.

Conversation identity, workspace ownership, mission roles, permission state, pending
questions, jobs, subagent ownership, artifacts and drafts are not recreated from the
handoff text. They remain owned by their existing stores. Original entries remain in the
same fork-aware history and existing transcript pagination/`history_recall` boundaries.

## Failure, Stop and recovery

Before dispatch, a durable conversation document records a pending request identity tied
to the native compaction task, exact source, model, thinking level and output policy.
A returned handoff is recorded as ready before the Harness atomically places it and
settles the blocking compaction. Returned usage is counted even when output is rejected.
The pending marker remains in place throughout an optional rewrite. A crash during either
call therefore never replays it, even if the earlier draft was received completely.

- Stop cancels the native compaction and its model request. The old context stays in
  place if no handoff was committed. Stop still owns input withdrawal and tool drainage.
- A process reopening a ready handoff reuses that exact text without another writer call.
- A pending request after interruption is outcome-unknown. Recovery fails closed without
  resending it or falling through to the native summarizer. User recovery remains explicit.
- Invalid output, a missing model, insufficient window space or a changed mission/model
  scope fails the blocking request with the original context intact. No partial handoff
  is installed. A new explicit user retry may admit new work.
- Incoming steers and follow-ups stay in the Harness inbox while the writer runs. They
  are placed at their normal next boundaries after the handoff, exactly once.
- Turning the setting off changes future admissions. An already admitted writer may
  finish. When off, existing idle cold-cache and ordinary compaction policies return.
  Manual **Compact** retains its existing semantics, even while handoff is enabled.

The existing SQLite durability boundary is unchanged: process-crash recovery is tested;
this feature does not claim a new power-loss/fsync guarantee for conversation storage.
Model-call transport failures without returned usage remain unknown, not zero cost.

## Settings and compatibility

`GET /api/chat-settings` returns `{schemaVersion:1,autoHandoff,revision}`. An explicit
`PATCH` supplies exactly `{autoHandoff,expectedRevision}`. The daemon serializes CAS,
syncs a private replacement file and its directory, then publishes the new value to
current and starting workers. A stale revision is 409; malformed input is 400. A failed
or unconfirmed persistence result is 503, preserves the last confirmed runtime setting
and blocks more writes until the daemon reopens the store. A GET after restart confirms
the currently durable value, not the receipt of an earlier lost PATCH.

The native screen never assumes an unavailable setting is off and never reports Saved
from a missing/mismatched ACK. An older daemon without the endpoint is unsupported.
The feature needs the matching daemon/kernel/desktop build; this change does not update
an already running installation. The legacy Swift Settings UI is unchanged.

## Verification and limits

`auto-handoff.test.ts` uses faux providers to cover whole-context replacement, retained
history/recall, both queue modes, Stop, invalid outputs, current-role fencing, toggle
behavior, no native-effect replay and SQLite reopen from pending/ready/placed stages.
`model.integration.test.ts` exercises the real KernelSession/NativeAdapter at startup
and after a live setting change, including cold-cache ordering and coordinator exclusion.
Daemon settings, HTTP CAS and worker-initialization propagation have separate offline tests.
The selected Node gate covers handoff cases plus native model,
steering/held-input, coordinator memory, chat events, legacy compaction, comparison,
settings HTTP/storage, worker propagation and IPC suites. The gate clears inherited
`PILOT_*` variables so it cannot attach to the running app's credential or subscription
brokers. TypeScript typecheck and scoped Biome checks also pass; existing legacy server
formatting and warning-only lint findings are not rewritten as part of this feature.

The pinned pi-durable patch adds two hook decisions: explicit failure, which must never
fall through to default summarization, and full-context replacement, which is refused for
conversation-owned background/manual compactions. A synchronous host predicate rechecks
role admission inside the placement commit. Manual tail/output budgets remain independent
of the automatic handoff policy. The existing steer-first patch remains.

Source preparation yields every 64 entries so a large snapshot cannot monopolize the
kernel's event loop through the entire serialization, and yields after hashing each
retained image. A local synthetic measurement of
the underlying serializer on 2,000 entries / 759,014 JSON characters took 69–82 ms per
whole serialization after two warmups. Production preparation splits that work into
batches; no GUI streaming, end-to-end latency, paid-provider cost or memory-quality gain
is inferred from that measurement. The small earlier [screening](handoff-comparison.md)
does not establish long-session equivalence or production safety. Handoff stays experimental.
