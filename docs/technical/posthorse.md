# Posthorse context management

Pilot bundles `pi-posthorse@0.10.10`. It replaces the automatic-handoff writer and
the optional deterministic-compaction implementation. There is no Pilot handoff
toggle or environment flag. Existing transcripts, compaction records and settings
files are not deleted or rewritten. The old `autoHandoff` setting is inactive.

## Policy and ownership

Posthorse supplies the actual recovery-record compiler, tool-safe recent-tail
selection, task notes, context-budget guidance and checkpoint reminders. Pilot
adapts its extension API in `packages/kernel/src/posthorse.ts`. Loading the package
directly would not work: Pilot's Pi session is an in-memory mirror, not the owner
of the durable conversation or model loop.

pi-durable remains the single writer and scheduler. It owns input admission,
original entry IDs, queued messages, tool outcomes, Stop, context placement and
restart recovery. Posthorse cannot reconstruct permissions, mission membership,
pending answers or tool authority from historical text.

Ordinary Build chats, including mission members, use the package at blocking model
boundaries. Mission coordinators keep their existing summary-tree memory. Legacy
Ask, explorers, diagnostics and Insights do not gain writable Posthorse tools.
This bridge covers durable Pilot chats. Native SDK subagents keep their existing
context policy; their separate execution loop is not replaced by this migration.

Pi's effective `compaction` settings control automatic rollover. Per-model
`reserveTokens` and `keepRecentTokens` are honored. Background compaction is off:
the current tool round settles before the next request rolls over. Idle time or
provider-cache expiry does not start a summary request. Manual **Compact** keeps
its existing model-summary semantics. As documented upstream, windows with fewer
than 10,000 usable tokens after the reserve use native compaction as a fallback.

Supported automatic rollovers compile a recovery record and keep a tool-safe
recent tail without a summary-model request. Pilot refuses a cut that would lose
unconsumed input or unseen tool images. Invalid records or a changed role/model
leave the original context intact. This does not guarantee semantic recall,
provider acceptance of arbitrary input, lower bills or fewer cache misses.

## Tools and compatibility boundaries

- `new_context({handoff?})` requests a deliberate clean reset. The package validates
  its draft; Pilot stores the intent before acknowledging the tool. The Harness
  commits it at the successful foreground round's boundary and continues that run.
  Failed siblings, an unsuccessful enclosing codemode call, Stop or a changed role
  prevent the reset. A request receipt is not proof of committed replacement.
- `get_context_remaining()` uses the current model window and effective settings.
  It is an estimate, not an exact provider-sized request budget.
- `notes` uses the package's note store. Pilot keeps it under the session's private
  `posthorse/<conversation-id>/.pi/notes/` directory, not the code checkout or shared
  project memory. Ownership and note provenance survive worker restart. Each chat
  attempt has a private store; a fresh fork does not adopt another attempt's notes.
  Earlier note content remains recoverable through that attempt's kept transcript.
  Note updates are limited to 64 KiB and reads to 1 MiB. Foreign scopes and links
  outside the private chat store are refused. Notes are plaintext, not encryption.
- `history` uses Pilot's existing kept-history backend, not Pi JSONL discovery.
  It searches only this chat's fork-aware originals, including compacted entries.
  It returns limited, redacted text, not reasoning or image pixels. Cross-chat
  `all:true` and foreign scopes are refused. Search uses Pilot's word-prefix ranking,
  not upstream literal matching. Use numeric `entryId` values for reads and
  `nextBefore` as the next search's `cursor`; the existing `history_recall` tool
  remains available. Both tools exclude their own lookup traffic.

The adapter labels historical inputs with unverified authorship instead of
inferring owner approval from a stored user role. It redacts credentials,
neutralizes framing, and redacts again before returning quoted text. The kept
original transcript is unchanged.

## Recovery and verification

Explicit reset intents are tied to their original assistant/tool round. Direct
calls require their successful committed result. Nested calls additionally need
the SDK's finalized successful nested outcome, plus the enclosing successful root
result. The reset and generation transition share one Harness commit. Reopening
does not replay tools, JS stacks or old reset requests. Automatic record compilation
uses no provider side effects and can be retried before atomic placement.

The small pi-durable compatibility patch adds a post-tool reset decision. It checks
all foreground results, cancellation, current role/model/settings and queued-input
capacity at placement. Existing tool controls keep
their prior behavior when no host decision is supplied. Existing persisted handoff
text remains readable; new automatic boundaries use neutral rollover terminology.

Focused offline tests cover actual package loading and compilation, direct and
nested reset, sibling failure, retained history and privacy, note restart recovery,
read limits, role restrictions, queued input and Stop. Tests use synthetic data and
faux providers. No live account, release installation or user-session migration is
part of verification. SQLite process-crash recovery and atomic file publication do
not add a power-loss durability guarantee.

Local checks passed: 567 fast-suite tests, 161 kernel regression tests plus the
queued-capacity case, nine chat-settings daemon tests, seven Rust chat-settings
tests, eight automation-hook tests and scoped Clippy. The hidden native Chats
settings probe passed at 680/1100 points in light/dark, including keyboard input,
exact save acknowledgments, conflicts, unknown outcomes and older-daemon handling.
The broader daemon sessions run passed 182/183. Its reentrant execution-drain
assertion at `packages/daemon/src/sessions.test.ts:787` also fails on frozen parent
revision `11f756d459dc`; this migration does not suppress that baseline failure.

A synthetic warm `.sync()` probe used 1,000 entries (about 105,000 estimated tokens).
Three changed-view samples had median wall/CPU times of 53.70/53.73 ms, with a
median RSS increase of 96 KiB. One hundred repeated unchanged-view calls had a
0.00050 ms median and 0.023 ms maximum. The disabled current-code bypass measured
0.001 ms on changed views. This isolates adapter projection with a stubbed initial
document transaction, not full NativeAdapter streaming, a historical baseline,
provider latency or live GUI responsiveness. Changed-view projection remains
linear; its worker CPU cost is a verification limit, not a claimed speedup.

Upstream: <https://github.com/fitchmultz/pi-posthorse> (MIT). The package is pinned;
updates require renewed compatibility checks. Pilot suppresses duplicate personal
copies so competing compaction policies do not load accidentally.
