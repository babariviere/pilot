# Coordinator summary-tree memory

Mission coordinators use derived summary-tree memory by default. This includes existing
coordinators at their next normal worker/compaction boundary. Ordinary chats, Ask and
Diagnostics keep their existing behavior. This does not restart workers or an installed
app, wake agents, import external history, or bulk-build trees at startup.

## Model role and authorization

Summaries use an explicitly named internal role, independently of the ordinary chat
picker's `enabledModels` filter, as existing background memory compaction does:

| Main provider | Internal summary model | Required API |
| --- | --- | --- |
| `openai` | `gpt-6-luna` | `openai-responses` |
| `openai-codex` | `gpt-6-luna` | `openai-codex-responses` |
| `anthropic` | `claude-haiku-5-5` | `anthropic-messages` |

The native runtime must report the exact chat model as authenticated/available. Same-ID
classifier models do not qualify. Picker scope is not rewritten or broadened; ordinary
model selection continues to enforce it. Provider configuration, broker admission,
subscription/connectivity gates and hard availability restrictions still apply. OpenAI
API-key and Codex OAuth providers are never interchanged. Other providers, missing
models/auth, invalid output or bounded-work failures retain existing safe compaction.
There is no cross-provider or expensive-main-model **tree** fallback. Existing ordinary
compaction still uses the main model when that is its established policy.

## Durable projection, not a second history

The Harness selects the old prefix and retains its existing 20k-token tool-safe tail.
Coordinators with a usable internal model start native background compaction near 96k
total input, when the main window is large enough. Native blocking/window safety is
unchanged. Actual placement still goes through the Harness, including busy-turn queued
writes and stale/reset handling. No request-local history deletion bypasses it.

Old prefix entries become source-referenced leaves with at most 512 UTF-8 bytes per
note. The 128k-byte memory view shrinks toward 64k through oldest-most-due binary sibling
merges. Node text and the last two prepared frontiers are durable conversation documents;
the active frontier is accepted only when its exact summary hash is actually placed in
the current context and its native cut, mission scope and structure validate. Preparing a frontier is
not proof it was placed. Cache documents do not inherit across forks. Reset selects a
new source prefix, not an old cached frontier. Context-edited projections fall back rather
than resurrecting edited-out originals. The SDK evicts unattached document cache entries.

Original entries remain in Harness storage. `history_recall` keeps its existing bounded,
fork-aware search/read interface; source entry bounds in the view aid that lookup. This
adaptation does not add a second public tree-zoom API. Summaries and recovered quotes
are historical, never new mission authority, consent or permission. Existing current
mission prompts/notices/tools and execution permission enforcement remain separate.

## Adoption, failure and work bounds

An existing placed summary is adopted as historical input, without scanning the history
behind it. An oversized uncompacted prefix uses existing compaction first, then can adopt
the resulting summary on a later boundary. No startup background rebuild is launched.

Each build bounds its source to 384k bytes / 2,048 selected entries, refuses an individual
source larger than 64k characters, and pages only after complete-entry privacy redaction.
There are at most 192 new pages, 256 model calls, eight concurrent calls and a three-minute
deadline. System/tool prefix size is bounded separately. A clean nonempty result must
fit the 512-byte limit; length-limited, oversized or tool-calling output is rejected,
not silently clipped. There are no automatic shortening/provider retries.

A durable pending marker precedes each request. Reopen never blindly resends an uncertain
node; batch preflight detects uncertainty before dispatching other nodes. Successful
nodes survive retries of the surrounding build. Abort and role/provider changes fence
publication, and all launched siblings join before fallback. Content-free fallback codes
appear in worker diagnostics; no source text, credentials or provider errors are logged.

Returned responses are added to `UsageDoc` before summary validation, including rejected
summaries. Cancellation or storage failure can prevent an aggregate commit; this is not
an exact-billing guarantee. The normal instrumented Models path retains usage-history
observations and compaction attribution. Transport failures without returned usage remain
unknown, not zero-cost claims.

## Cache and evidence boundaries

Main memory messages and compactor views use four-line text blocks. Anthropic adds a view
cache mark only when the existing marks leave room within the four-mark limit. Other
integrations' marks remain intact. Compactor requests include the resolved system/tool
prefix; caches remain partitioned by provider/model. No cross-model cache reuse is assumed.

This is a production adaptation, **not the identical benchmark replay**: it preserves native
background compaction, cuts, tool-safe tails and ordinary recall. The compactor's contextual
view is the most recent twenty frontier nodes (bounded below 32k bytes), not a second
continuously prebuilt tree. Earlier modeled savings are not a measured bill or quality
guarantee for this integration. Focused offline tests use faux providers and temporary
stores. Real-provider task quality, actual tokenizer/cost/latency and long-running usage
remain unmeasured here. No additional paid evaluation or installed-app replacement is
part of this change.

Implementation: `packages/kernel/src/coordinator-memory*.ts`, native adapter/session
wiring, and the shared idle-compaction focus constant. MIT attribution is retained in
`packages/kernel/COORDINATOR_MEMORY_LICENSE`.
