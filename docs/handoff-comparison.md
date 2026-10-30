# Ordinary-chat handoff comparison

This is an offline evaluation harness, not an auto-handoff implementation or rollout.
Production compaction, the deterministic-digest opt-in and coordinator OptChat-inspired
memory remain unchanged. The harness itself makes no model requests, authenticates no
accounts, reads no live chats and has no network fallback. Model generation requires
separate confirmation; the screening below was explicitly approved.

## Question

Does a source-linked deterministic checklist help a model prepare better continuation
handoffs than the previous handoff and new original messages alone?

| Arm | Handoff writer receives |
| --- | --- |
| `handoff` | Its own previous handoff and originals since the last boundary |
| `handoff-with-facts` | The same inputs plus a checklist rebuilt from originals through this boundary |

The checklist reuses `context-digest.ts`, excluding the free-form assistant report and
rolling activity transcript. It still contains heuristic historical interpretations,
not verified facts or permissions. Each arm gets the same instructions and 4,096-byte
output ceiling. The checklist's additional input is counted, not hidden or compensated
by withholding history from the baseline. Neither successor receives a second summary:
only its own generated handoff is carried to the next writer.

Each arm evolves independently. Both must finish a boundary before either successor is
exported. Later originals, probe questions and expected answers never enter generation
requests. Request hashes bind the exact prompt, instructions, arm and output policy;
changing a predecessor invalidates its successor's old response.

## Offline commands

Run from the repository root with the locked dependencies installed:

```sh
# Export the first six generation requests, without calling any models.
node packages/kernel/src/handoff-evaluation.bench.ts > /tmp/handoff-requests.json

# Exercise all 24 request/response transitions with explicitly scripted dummy text.
node packages/kernel/src/handoff-evaluation.bench.ts --smoke > /tmp/handoff-smoke.json

# Replay explicitly supplied handoffs and export the next ready requests.
node packages/kernel/src/handoff-evaluation.bench.ts \
  --responses=/tmp/handoff-responses.json > /tmp/handoff-next.json

# Focused tests, also included by the normal portable integration test discovery.
node --test --test-timeout=120000 packages/kernel/src/handoff-evaluation.test.ts
```

`pending` contains request IDs, system instructions, prompts and estimated input tokens.
Use those exact inputs with tools disabled and identical model, effort, temperature and
generation limits for each pair. The harness checks the reported model/effort match;
it cannot authenticate externally reported settings or prove which model generated text.
Keep provider request receipts and actual input/output/cache usage separately. A UTF-8
output cap is not a provider token limit; oversized responses are rejected, never clipped.
Do not cherry-pick an oversize retry in one arm: record it and repeat the pair under the
same predeclared retry policy.

The responses file starts as:

```json
{
  "version": 1,
  "responses": [
    {
      "requestId": "COPY_THE_64_CHARACTER_ID_FROM_PENDING",
      "handoff": "The exact generated handoff, including source references.",
      "model": "provider/model-id",
      "effort": "medium"
    }
  ]
}
```

Append each response without changing its predecessor or ID, then rerun. A partial pair
waits for its partner. Duplicate, stale, malformed, empty, unsafe-framed or oversized
responses fail closed. The CLI is stateless, so a failed replay never updates a live
conversation or sends a request again. Response files and exported review material belong
outside the repository; commit only synthetic fixtures, never private model transcripts.

## Fixtures and review

Three synthetic tasks each cross four successive replacements:

- Billing export: original compatibility/no-push constraints, a region correction,
  unrelated versus identical-command test recovery, and a rejected implementation.
- Delivery recovery: lost acknowledgement, misleading status, non-idempotent replay
  risk, and a background job that has not finished.
- Native composer: draft/focus/IME invariants, hover and keyboard access, rejected
  input replacement, static versus native evidence, and an unanswered question.

`measurements` reports estimated input tokens, output bytes and literal term/source
presence. These are diagnostics, not a semantic grade: a negated or incorrect claim can
contain every expected word. Estimated tokens are not billed usage or cache savings.
Dummy smoke responses test the pipeline only; they cannot favor either strategy.

For a semantic review, give the reviewer only the `review` array. Candidates use opaque
IDs and hash-sorted ordering without arm, model, prompt or measurements. Each contains
the exact handoff, originals through its cut, and source-linked questions/expected
answers. Do not give the reviewer the generation manifest or arm mapping. This removes
explicit labels, but wording can still reveal the strategy, so blinding is best-effort.

For each candidate and probe, record correct, incorrect or unknown, the handoff quote,
and supporting/contradicting source IDs. Additionally review:

1. Can a successor name the exact next unfinished step without guessing?
2. Are user constraints and newer corrections preserved without invented authority?
3. Are failed, pending and unknown outcomes still represented honestly?
4. Are reasons/rejected approaches carried forward, not just filenames and commands?
5. Does the handoff contain an unsupported success, verification or permission claim?

Do not collapse safety failures into an average score. Compare paired boundaries,
especially the fourth replacement, and note recovery from an earlier omission.
For real model comparisons, repeat pairs with reversed execution order and a fixed
generation/retry policy before selecting a default. This harness does not simulate
task execution, recall use, crash recovery, GUI continuity, Blackhole's full memory
workers or OptChat's tree. Those need separate evaluations.

## Decision boundary

No quality winner is established by building this harness or running smoke fixtures.
The next step is a separately approved model run of the exported requests and a semantic
review, followed by successor-task trials if the packet comparison is promising. Do not
enable deterministic compaction or replace ordinary-chat compaction from literal scores.

Related: [existing compaction](context-compaction.md),
[coordinator memory](coordinator-memory.md).

## Approved screening, 2026-10-30

Ran one screening with 24 fresh Pilot subagents configured as
`openai-codex/gpt-6.1-sol:medium`, in an empty temporary working directory. Each received
the exported text plus identical no-tools instructions. Read-only inspection of their
own durable histories found zero tool calls and confirmed the reported provider/model.
All 24 outputs fit the 4,096-byte ceiling without manual regeneration or clipping.

A separate fresh Sol instance reviewed the 24 opaque-ID candidates without the arm
mapping or generation prompts. Its complete candidate/probe coverage was checked against
the manifest before unblinding. The reviewer judged semantics, not literal diagnostics.
It was model review, not human review or a successor executing the task.

| Writer metric | Handoff only | Handoff plus facts |
| --- | ---: | ---: |
| Completed handoffs | 12 | 12 |
| Model-graded checkpoint probes correct | 51 / 51 | 51 / 51 |
| Model-flagged unsafe claims | 0 | 0 |
| Model-graded clear next steps | 12 / 12 | 12 / 12 |
| Harness-estimated input tokens, all boundaries | 20,245 | 24,063 |
| Provider-reported input tokens, returned usage | 71,501 | 78,097 |
| Provider-reported output tokens, returned usage | 6,300 | 5,975 |
| Returned cache-read/write tokens | 0 / 0 | 0 / 0 |
| Total handoff UTF-8 bytes | 31,537 | 30,303 |

The checklist added 18.9% to harness-estimated input and 9.2% to the returned writer
input usage in this run, with no observed semantic-probe improvement. The estimates
exclude the host prompt/tool-schema overhead, while provider usage includes it. Smaller
output in one sample is not evidence that the treatment is systematically more concise.
Usage in the table excludes the reviewer and any attempt without returned usage; it is
not a subscription bill or a controlled cache/cost comparison.

**Protocol deviation:** the host automatically retried one provider-overload error in
the facts arm at billing boundary two. Its failed-attempt usage is unknown, not zero.
No manual retry or choice between competing successful generations occurred, but the
predeclared no-auto-retry policy was not enforceable through this host. There were 24
successful writer generations, one additional failed writer attempt, and one reviewer
run comprising ten successful model requests (including its file-read turns). Do not
present this as a strict no-retry benchmark.

The facts-only checklist omitted the explicit “Skip archived tenants” sentence at
billing boundary two. Both writers retained it from original #15, and both chains kept
it through boundary four. This is an observed limitation of this checklist projection,
not evidence that the full production digest or every handoff loses that requirement.

Limitations:

- Three small, curated synthetic tasks, four boundaries, one sample per arm. Both arms
  hit the scoring ceiling. This does not establish equivalence or robustness under
  genuinely long sessions, high context pressure or repeated subtle corrections.
- A same-family model judged the packets; no human review, negative-control calibration
  or successor-task trial was run. Its absence of flags is not proof of safety.
- The reviewer saw all candidates and each scenario's originals with checkpoint-cut
  instructions, so it was not isolated from later scenario material. Explicit arm labels
  were hidden, but references to checklists could reveal strategy.
- Host instructions and tools remained available, though writer histories recorded no
  tool calls. These are not bare API completions with an independently controlled system
  prompt. Reported model identity was checked; effective reasoning settings were not
  independently verified.
- Pair submission order alternated by scenario/boundary, but the whole comparison was
  not replicated in reversed order. No wall-time or production cache claim is justified.

**Decision:** this screening found no reason to add the checklist by default. Prefer
handoff-only as the next experimental candidate, keep coordinator memory unchanged,
and test longer, harder histories plus real successor work before a production rollout.
The deterministic digest remains opt-in; auto-handoff is not implemented by this change.

Full request/response, unblinding and returned-usage evidence is session-local at
`/tmp/pilot-handoff-evaluation.P25DbB/`, not committed. Temporary-file persistence is not
guaranteed. The repository contains the synthetic inputs, harness, tests, protocol and
aggregate findings only.
