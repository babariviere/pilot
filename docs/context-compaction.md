# Ordinary-chat context compaction and history recall

Pilot Next also exposes an off-by-default [automatic handoff](auto-handoff.md) setting.
When enabled, ordinary chats replace processed model context with a prepared handoff
at blocking model boundaries, retaining unconsumed inputs and unseen tool-image rounds
under their original IDs instead of using the automatic policies below. Manual
compaction and coordinator summary-tree memory keep their existing behavior.

Status: opt-in. Default rollout stays blocked until the digest is validated with real providers. Set
`PILOT_DETERMINISTIC_COMPACTION=1` in pilotd's environment (kernels inherit it) to enable it; otherwise ordinary
chats keep pi-durable's default thresholds and model summaries, and `history_recall` is available either way.

[context-edit-compaction.md](context-edit-compaction.md) proposes trimming old tool output in place with
pi-durable context edits, as an addition to the digest.

When enabled, ordinary chats (Build, Ask, diagnostics and mission chats) compact with a deterministic digest. Control is
unchanged: it keeps its OptChat memory hierarchy and has Harness compaction disabled. Project memory remains
the only cross-chat memory store; compaction never writes to it.

## When compaction runs

`packages/kernel/src/compaction-policy.ts`. pi-durable's generation preparation checks every model request
boundary, including between tool calls, and blocks on a threshold compaction above
`contextWindow - reserveTokens`. Its measure is total input: the last provider usage (which counts the system
prompt and tools) plus estimates of newer messages. Pilot sets that threshold per model window:

| Parameter | Default | Notes |
| --- | --- | --- |
| Target | 100,000 tokens | Applies on any window large enough |
| Window reserve | 20% of the window, clamped to 2,048–16,384 | Smaller windows compact at `window - reserve` instead |
| Recent context kept verbatim | 20,000 tokens, at most 25% of the trigger | The Harness never splits a tool call from its result |
| Digest budget | 5,000 tokens, at most 6% of the trigger | About 3.4 characters per budget token |
| Required shrink | after ≤ 60% of before | Otherwise a target compaction is declined |
| Backoff | +20,000 tokens | After a decline, the trigger waits for growth, never past window safety |

The Harness reads the policy on every resolution, so a model switch to a smaller window applies at the next
request. Background compaction is off: the digest is cheap, so the request waits for it instead of paying for
one more oversized request. The existing idle cold-cache compaction before user input
(`auto-compaction.ts`) also produces a digest.

## Digest

`packages/kernel/src/context-digest.ts`. The section design is adapted from
[pi-blackhole](https://github.com/k0valik/pi-blackhole) (MIT), itself derived from pi-vcc. It is a
re-implementation over pi-durable entries; the Pi extension is not installed, and none of its model workers
(Observer, Reflector, Dropper) are used.

The digest is a pure fold over the chat's original entries, from the start (or the latest reset) to the cut.
Earlier summaries, system prompts and `history_recall` traffic are never folded, so repeated compactions
rebuild from originals rather than summarizing a summary. The fold is cached per conversation and extended
incrementally; a restart rebuilds it with the same result. Sections, each item with its source entry (`#N`):

- Goal (task sentences of the first request, enumerations split) and the user's requests, newest last; the
  latest request with a task sets the current scope.
- Operating limits the user stated: restriction clauses ("no installs, PRs …", "NO source changes", "do not
  push", revocations), near-verbatim and labeled historical. Pilot's permission state stays authoritative.
- Questions: assistant `ask_user` questions and user questions, each marked answered (with the reply's
  first words) or "no reply before #cut".
- User directives and corrections, near-verbatim. A correction marks earlier items naming what it negates as
  superseded; "X, not Y" counts as a correction only when it supersedes something.
- Decisions, including question → answer pairs.
- Checks with explicit results: a test, typecheck or lint command passes only with evidence in its own output
  (counts with no failures, `exit 0`, "No fixes applied" without errors). "Found 1 error", "× Some errors were
  emitted", a failing count or a non-zero exit is a failure. Background job launches, `echo` lines and outputs
  shared by two checks of the same kind are not recorded.
- Failures seen, each "recovered at #N" only when the same command later succeeded, otherwise "no identical
  successful retry seen". Codemode script or guardrail errors are tool-usage mistakes and only counted.
- Files read, modified, created or deleted, from tool arguments and patch headers written directly in a call.
  Paths quoted inside other strings (test fixtures, examples), patch content lines and template placeholders
  are ignored.
- Commits and pushes only from commit or push commands; links only from `gh`/push output. Repository status
  (`jj st`, `git log`) is shown separately as state, never as a commit.
- Tool facts from successful, non-inspection output; the latest long assistant report (untrusted).
- Recent activity: one line per message or tool call, newest kept, filling the remaining budget. Read-only
  inspection calls are counted, not listed.

Historical approval or permission wording never appears as authority. A grant about an operational action
("you may push") is dropped; other approval wording is replaced with "[approval omitted]" so the task it scopes
survives; mixed sentences are split so their restrictions are kept. The same rules apply to assistant text.

Rendering reserves a bounded slot for the latest long assistant report before admitting file lists, tool facts
or recent activity. The slot uses at most 20% of the available body (up to 900 quoted characters), with a minimum
source-linked omission when a useful excerpt cannot fit. User restrictions are admitted before other sections;
when a section cannot fit in full, whole newest items take precedence, without leaving an empty heading.
Reports stay explicitly untrusted, never become check evidence or permissions, and newer original messages
supersede the digest. Budgets retain the compiler's existing 400-token minimum.

### Estimated and provider tokens

The trigger uses the Harness measure: the last provider-reported usage plus pi-ai estimates of newer
messages. pi-ai estimates 3.5 characters per token, which undercounts code-heavy chats. Each kernel measures
its own chat's ratio of provider prompt tokens to the estimate (sampled from requests, or from the context's
last usage at compaction time), clamped to 1–2.5, and scales the tail and digest budgets and the after-size
estimate by it. No ratio is assumed: before a measurement it is 1. The replay of one real chat measured about
1.54–1.66; that number is specific to that chat.

## Validation and fallback

`packages/kernel/src/deterministic-compaction.ts` supplies the digest from pi-durable's `beforeCompact`
hook. The Harness still selects the range and places the summary entry atomically; nothing changes context
until the digest passes validation: it must start with its marker, fit its budget, contain no text the
redactor would change, contain no framing tags, and reference no entry past the cut.

| Situation | Outcome |
| --- | --- |
| Valid digest, enough shrink | Digest placed |
| Target compaction with an invalid digest or too little shrink | Declined with backoff; the request proceeds |
| Window-safety, overflow or manual compaction with an invalid digest | Harness model summary (previous behavior) |
| Manual compaction with explicit instructions | Model summary, unless the last model summary failed |
| Model summary failed earlier | The next compaction uses the digest again |

## History recall

`packages/kernel/src/history-recall.ts` (`history_recall`, ordinary Build and mission chats). `search` ranks by
relevance (BM25 over the scanned window; scores within 20% of a group's best keep newest first, so later
corrections lead) or returns newest-first entries containing every word (`order: "recent"`). `read` pages one
entry. Scope is structural: the fork-aware history of this chat's conversation in its own session storage, with
no session, project or host argument. Bounds per search: 5,000 entries, 8 MB of text, 8 results. Matching and
output use redacted copies; results are neutralized, labeled untrusted and never grant permissions.

## Project memory (OptMem) integration

Existing capabilities reused: one-line notes with session provenance, `replaces` for explicit corrections
(`replacedBy` on read), duplicate rejection, a bounded regex recall in an isolated, time-limited worker, and
the wake view. Narrow kernel-side additions in `memory-tools.ts`:

- `recall` accepts `query` words: an escaped word regex goes to pilotd, and the kernel ranks its bounded page
  (rarer words weigh more; replaced notes sink below live ones; provenance fields are kept).
- Notes containing credentials are refused before they reach pilotd.
- The tool and the wake prompt state that notes are untrusted and never grant permissions.

Compiler output is never promoted into project memory. Known blockers, not bypassed:

- pilotd returns only its newest 96 matches (20 KB) per recall, so query ranking covers that page only.
  Ranking the whole store needs a pilotd/worker change.
- The credential check runs in the kernel tool. Notes written through the app or shared-memory replication
  are not checked; enforcing that in pilotd needs a shared redaction module or a protocol change.
- There is no semantic (embedding) retrieval; adding one would need a new index, which this change does not add.

## Instrumentation

Each kernel writes content-free records to `compaction.jsonl` in the session's storage directory: the same
private, capped (256 KB, two segments, mode 0600) writer as `performance.jsonl`, disabled by
`PILOT_PERF_TIMINGS=0`. Records hold only numbers and closed enums:

- `compaction`: regime (`target`, `window`, `overflow`, `manual`), outcome (`digest`, `declined`, `model`), the
  measured provider-to-estimate ratio,
  reason for a decline or fallback, whether a model summary failed before, window, trigger, safety, kept,
  overhead (system prompt and tools), digest and estimated before/after tokens, folded entries and time.
- `compaction_usage`: the estimate after a digest, next to the first provider usage afterwards (input,
  cache read, cache write, output).

Model summary retries remain pi-durable's; their failures appear as `priorFailure` on the next record.

## Benchmark

```sh
node packages/kernel/src/context-compaction.bench.ts [--seed=20261019] [--chats=24] [--scale=10000] [--json]
```

Offline and deterministic per seed: no network, account, paid model or private transcript.

Measured with the default seed (`--seed=20261019 --chats=24 --scale=10000`), Node `v24.21.0`, on the
development Mac under other load. Non-timing output was identical across two runs.

**Digest retention** on 24 synthetic chats (290–440 entries each), at the 5k-token budget, against a
budget-matched tail of the Harness-style transcript:

| Planted item | Digest | Tail baseline |
| --- | --- | --- |
| Goal, directive, changed file, commit | 24/24 each | 0/24 each |
| Unresolved failure (line deep in a 40 KB output), test evidence, deep successful tool fact | 24/24 each | 0/24 each |
| Correction, stale fact marked superseded, answered question as decision | 24/24 each | 0/24 each |
| Pending question, revocation | 24/24 each | 0/24, 22/24 |
| Leaked grants / secrets / raw injection tags / notices as directives | 0 / 0 / 0 / 0 | 6 / 44 / 22 / 0 |

Digest size: median 2,568 estimated tokens (max 2,976); no digest failed validation; fold and render took a
median of about 8 ms per chat.

**Harness runs** (real pi-durable scheduling, faux provider, 12 turns of six 48 KB tool results):

| | Pilot policy | pi-durable defaults, scripted model summary |
| --- | --- | --- |
| Compactions | 10 digests, all at the 100k target, no model call | 6 model summaries |
| Largest simulated prompt | 96k tokens | 155k tokens |
| Simulated prompt tokens (input + cache read) | 3.99M | 6.79M |
| Illustrative weighted input (uncached 1.0, cache read 0.1, summarizer input 1.0) | 1.18M | 1.56M |
| First goal in every compaction summary | 10/10 | not comparable (scripted summary) |

The faux provider counts uncached prompt text twice (input and cache write), so the ratio the kernel measures
from it is inflated and its post-digest estimates read high (0.67–0.88 of the faux prompt). On a 32k-window
model, 17 compactions all ran in the window-safety regime and the largest prompt was 12k tokens.

**Recall**: every planted file, commit, failure, deep fact and correction was in the top five in both
`relevance` and `recent` order (MRR 1.0 for both, so these synthetic queries do not separate the two).
Ranking with distractors is covered by unit tests only. There were no secret, secret-query, cross-chat or
raw-tag leaks. Median search was 23 ms (p95 39 ms) on in-memory storage.

**Disk-backed scale** (SQLite, 10,000 entries, 20.8 MiB): cold fold of 9,799 entries 68 ms, incremental fold of
201 entries 2 ms, render 10 ms, digest 4,851 tokens with the first goal kept. Finding the oldest fact took two
bounded searches (at most 5,000 entries each, up to 356 ms each); reading one entry took under 1 ms.

## Real-transcript replay (chat 243fa14f)

Evaluation artifacts live outside the repository in `/tmp/pilot-eval-243fa14f/` (private). The input is this
implementation chat's own transcript, frozen through a read-only SQLite backup and exported with every string
redacted (482 entries, 237 requests, up to 601,171 provider-reported prompt tokens; the live chat never
compacted). The replay runs the implementation on a disk-backed Harness and compacts at each original request
whose total input, calibrated from the chat's own provider usage, passes 100k. The same chat also exercised the
automatic threshold path: with real usage kept, the Harness itself compacted at the next turn boundary.

| | Before fixes (8 boundaries) | After fixes (7 boundaries) |
| --- | --- | --- |
| 20 recoverability probes at the last boundary: digest / tail / recall / missed | 11 / 4 / 5 / 0 | 13 / 2 / 5 / 0 |
| Operating limits present in digest or tail at the last boundary | 3 of 5 | 5 of 5 (3 digest, 2 tail) |
| False assertions at any boundary (grants restated, status as commit, pass with errors, tool errors as failures, fixtures as changes, answered question as open) | 5 kinds | 0 |
| Cited items matching their source entry | 30/30 | all checked (19–33 per boundary) |
| Digest size (estimated tokens) | about 4,850 | about 2,900, scaled by the measured ratio |

The kernel measured 1.54–1.66 provider tokens per estimated token on this chat; the scaled 12k-estimate tail and
3k-estimate digest correspond to roughly 20k and 5k provider tokens. Projected prompt tokens over the 237
requests drop from 79.2M (96.7% cache reads) to 13.3M. This is a projection from calibrated estimates, not a
billed saving: cache behavior after each compaction was not modeled.

An independent model (`openai-codex/gpt-6.1-sol`, as a blinded subagent) answered the same 12 questions for
paired before/after packets (summary plus verbatim tail) at the same cut points, without being told which was
which. Usefulness scores were 2, 2, 2 before and 4, 4, 3 after in round one (cuts #197, #758, #959) and
2, 2, 2 before and 4, 4, 4 after in round two (cuts #89, #197, #959, after the round-one findings were fixed).
After the fixes it answered "may the agent push, open PRs, merge or deploy?" with "no" in every packet; the
before packets gave "unclear" in four of six. Its remaining notes (exact-command failure recovery can look like
an open failure; check output appearing as a tool fact) were addressed after round two and verified only with
the deterministic probes. The judge is another model reading prompts written by the implementer, not a human
review, and it saw one chat.

### What this does and does not show

- Measured: Pilot's deterministic code paths on synthetic inputs, real pi-durable scheduling and storage, and
  wall-clock timings on one machine.
- Simulated: all token usage and caching come from pi-ai's faux provider. They are not provider usage or bills,
  and the "illustrative weighted input" is a made-up price ratio.
- Not measured: how well a model works from a digest compared with a model-written summary, real-provider cache
  behavior, and real chats' wording. The pi-durable comparison uses a scripted fixed summary, so it shows cost
  shape, not summary quality. No Blackhole worker or other external system was run or compared.
- Known gaps: extraction is pattern-based, mostly English, and can mislabel directives or miss corrections that
  do not name what they replace. Pilot's question detection still reads only the last few entries of a run, so a
  question followed by many tool calls in the same run can be missed (unchanged behavior).
