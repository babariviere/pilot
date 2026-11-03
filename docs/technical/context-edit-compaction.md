# In-place context edits for compaction (design note)

Status: proposal. Nothing here is implemented. It compares the compaction model in
[Shelley's post](https://blog.exe.dev/compaction) with Pilot's current deterministic digest
([context-compaction.md](context-compaction.md)) and proposes a first step that reuses the part that fits.

## Shelley's model

- At about 200k tokens the harness nudges the model and offers a compaction tool.
- The tool shows an index of messages by sequential id. The model asks to (a) truncate specific tool outputs and
  (b) "squish" ranges of history into shorter rewritten segments that point back to the originals.
- A linter rejects compactions that shrink too much or too little; the model usually succeeds on its second try.
- The log stays append-only. Compactions are stored as special messages, and the harness substitutes them when it
  builds the request. Originals stay in SQLite, and a skill tells the model how to query them.
- It is one continuing conversation, not a new generation that starts from a summary.

## What Pilot already has

pi-durable 1.3 provides the same storage model, so no new data model is needed:

- Any entry can carry `edits: [{ target, action: "replace" | "omit", messages }]`. When the Harness derives
  context (`pi-durable/dist/harness/context.js`), the newest edit per target wins. Original entries stay in
  storage. `packages/kernel/src/model-rebuild.ts` already writes such entries.
- A write that carries `edits` is placed at the next boundary, like a steer, or at once when the chat is idle.
- Tool pairing is repaired at render time: `orderToolResults` drops results without a call and synthesizes
  missing ones. Edits that keep `toolCallId` never trigger either.
- The native SDK mirror rebuilds from `view.messages` (`native-adapter.ts`), so it sees edited context.
  `review-history.ts` already discloses entries with edits as `context_edits_originals_retained`.
- `history_recall` searches and reads original entries by id, which plays the role of Shelley's SQLite skill.
- The digest folds original entries, not edited ones, so its checks, failures and files stay complete.

## Options

| | Digest (current, opt-in) | Trim tool output (proposed) | Model squish (Shelley) |
| --- | --- | --- | --- |
| Model calls | None | None | One or two rounds per compaction |
| Mechanism | `pi.compaction` head marker at a cut | Entry with `replace` edits on old tool results | Entry with `replace`/`omit` edits over ranges |
| What the model loses | Everything before the cut except the digest | Bodies of large old tool results | Detail inside squished ranges |
| Conversation text | Folded into the digest | Kept verbatim | Rewritten by the model |
| Trust risk | Bounded: extraction rules, redaction, no grants restated | Low: stubs are Pilot-generated | Model text could restate approvals or leak secrets; needs the digest's redaction and grant rules in the linter |
| Prompt cache | Lost from the cut | Lost from the first edited entry | Lost from the first edited entry |
| Complexity | Exists | Small: selection, stub, placement | Tool, index, linter, retries, prompt text |

Tool results are usually most of the context, so trimming alone may recover most of the savings while keeping user
and assistant messages exact.

## Proposal: deterministic trimming (phase 1)

Behind its own opt-in flag, next to `PILOT_DETERMINISTIC_COMPACTION`. Ordinary chats only; Control keeps its
OptChat memory and stays out of scope.

### When

Trimming busts the prompt cache from the first edited entry, so it runs in batches, never per turn:

1. **Cold cache before user input.** The existing idle path in `auto-compaction.ts` already waits for an expired
   cache. Trim there first; edits cost nothing extra on a cold cache, and the write is placed at once while idle.
2. **Target threshold.** When the Pilot policy's target regime fires, trim instead of compacting if trimming alone
   brings the estimate under `maxAfterRatio` of the trigger. Otherwise fall through to the digest. Window safety,
   overflow and manual compaction keep their current behavior.

### What

- Only `toolResult` messages in entries before the protected tail (`keepRecentTokens`, as the Harness cut uses).
- Only results above a size floor (starting point: 2,000 estimated tokens). Small results cost little and often hold
  the facts later turns rely on.
- Never user messages, assistant text or tool calls. Calls stay, so the model still sees what it ran.
- A `replace` edit swaps an entry's whole model. Tool result entries hold one message each (`appendToolResult`),
  so an edit touches only that result.
- The replacement keeps `role`, `toolCallId`, `toolName`, `isError` and `timestamp`, and its text is a stub such
  as `[Trimmed: 48 KB of bash output. history_recall read #812 returns the original.]`, optionally with the first and
  last few lines. Images become the same stub. Whether `details` must be kept for the native mirror's metadata is
  to be checked.
- One write entry per batch, `kind: "pilot.context-trim"`, `model: []`, the `edits`, and content-free `data`
  (count, bytes, tokens before and after).

### Prerequisite: the threshold measure

`estimateContext` starts from the provider usage of the newest assistant message and adds estimates of later
messages. After a trim, that usage still describes the untrimmed context, so the next request would cross the
threshold and compact anyway. Two fixes:

- **Preferred, upstream in pi-durable:** when an entry newer than the measured assistant carries edits, estimate the
  whole view instead of trusting the stale usage (or subtract the removed estimate).
- **Interim, in Pilot's `beforeCompact` hook:** in the target regime, when a trim entry is newer than the measured
  usage, decline without backoff and record it. The next request reports the trimmed size.

### Interactions

- A later digest compaction folds the original entries, so a trimmed result still counts as check evidence or a
  failure. Trim edits before the new head marker are dropped along with their targets.
- The Harness model-summary fallback reads edited messages. It already truncates tool results to 2,000 characters,
  so it loses little.
- The transcript UI renders entries, not model context, so nothing changes there. The context meter drops after
  the next request.
- `compaction.jsonl` gets an outcome `trimmed` with counts and estimated before and after tokens.

### Validation

- Extend `context-compaction.bench.ts` with trim-only and trim-then-digest runs: number of compactions, largest
  prompt, simulated prompt tokens and the existing retention probes.
- Replay the frozen real transcript used for the digest (chat 243fa14f) the same way.
- Like the digest, default rollout waits for real-provider validation, including cache behavior after a trim.

## Phase 2, only if trimming is not enough: model squish

Same primitive: an entry whose edits replace the first entry of a range with a rewritten message and omit the rest.
It needs the parts Shelley describes plus Pilot's constraints:

- An index view (entry id, role, estimated tokens, short preview) and a `compact_context` tool, offered only at the
  threshold so its description does not load on every turn.
- A linter: shrink within bounds, ranges outside the protected tail, whole tool call and result pairs, no text the
  redactor would change, no restated grants or approvals (the digest's rules), and no references past the range.
- Fallback to the digest when the model fails twice, so compaction never depends on the model succeeding.
- Cost accounting for the extra rounds, which run on a mostly cached prefix.

## Open questions

- Threshold: Shelley compacts at about 200k, Pilot targets 100k. Trimming keeps more text, so a higher target may
  pay off; it changes cost and needs measurement.
- Size floor and whether stubs keep head and tail lines.
- Upstream estimate fix versus a local patch of pi-durable.
- Whether some tools (`history_recall`, mission tools, `ask_user`) should never be trimmed.
