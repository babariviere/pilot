# Proposed review preference memory

**Design only.** D20 selects app-owned scoped memory and automatic consolidation;
the contracts below are proposals, not implemented behavior or permission to run
a scheduler, create a memory store, generate skills, migrate data or change review
gates. [Native Review](mission-native-review.md) proposes the input records; its
human-authorship, submission and retained-annotation primitives do not yet exist.
[Review records](mission-review-records.md) are a dormant, separate agent-result
foundation. Neither is evidence of a deployed learning pipeline.

## Boundaries and input

The authoritative preference state is app-owned, outside worker workspaces and
Git. It contains scoped user guidance, not mission decisions, instructions to
refactor, or merge/review authority. Existing approved policy, task intent and
safety constraints take precedence. The #17 user-authored seed is preserved in
`packages/daemon/src/mission-review-seeds.ts`, not yet ingested as memory:
implicit coupling; layer-first folders; duplication; representable illegal states;
god files; shotgun surgery; layering violations; pass-through wrappers;
errors/validation away from boundaries; overly defensive code. Proposed import
records each as user-authored guidance with its source and original scope, not
as inferred findings or binding mission decisions. Until scope is explicitly
established, use only in the originating review context, never all projects. No
import assigns refactoring work. Applying any indicator requires concrete code
and cost, including counterevidence: legitimate adapters, boundaries, shared
infrastructure, independent rules and real I/O/durability recovery. Size, a
wrapper or duplication alone is not proof. Evaluate introduced/worsened versus
existing baseline separately.

Eligible inputs are host-authenticated, **submitted** user reviews and annotations,
ratings, explicit preference statements and later user corrections or retractions.
Retain #14's review/annotation IDs, exact retained comparison and side/path/range,
blob and excerpt identity where applicable, original text, rationale, project,
mission, intent and author provenance. A human's response to an agent finding is
human feedback, but the original finding remains agent-authored. Drafts, agent
suggestions, unverified authorship, opened items, silence and a single approval
are not user-endorsed general preferences. A revision's approval applies only to
that review; even an accepted correction is an example, not proof of a universal
rule. Do not infer historical task purpose from later allocation.

Capture the submitted review and a durable extraction/outbox entry atomically
before acknowledging submission. Preserve referenced retained snapshots and the
review independently of the workspace before any retirement; failure or unknown
durability blocks the relevant cleanup, not falsely marks it preserved. Pin both
the reviewed comparison and, when independently established, the eventual
accepted correction and its exact comparison, acceptance identity and rationale.
An asserted fix, later revision, disappeared line or coordinator disposition alone
is not human acceptance. Pending, declined, withdrawn and unavailable corrections
remain labeled. Workspace deletion never resolves references to live files.

## Proposed records and lifecycle

Use one transactional, versioned app-owned store with stable IDs and bounded,
paginated history. Reuse retained review and snapshot storage by reference rather
than copying content into a second vault. Records below are conceptual, not an
existing schema. Each write has a stable operation ID, authenticated actor,
payload digest, expected revision and durable receipt. Check current access
before receipt lookup; an exact retry returns the original receipt, while a
changed payload or actor conflicts. Supersession never rewrites historical source.

| Record | Minimum content |
| --- | --- |
| Evidence | Submitted review/annotation and authenticated origin; retained comparison and anchor; intent and scope; user reason; disposition and accepted-correction link when available. Missing source is explicitly unavailable. |
| Preference version | Stable ID/revision, statement, explicit user statement or inferred pattern, status, scope and applicability, rationale, evidence and counterexamples, provenance, timestamps, supersedes/retracts. |
| Consolidation job | Input event IDs and versions, extractor/version, idempotency key, state, attempts, bounded error category and checkpoint; no raw private transcript in logs. |
| Selection receipt | Context and selected preference IDs/revisions, omitted/conflicting/unavailable reasons and retrieval version. This records what was supplied, not that it was followed. |

Proposed statuses: **active explicit**, **candidate**, **confirmed pattern**,
**superseded**, **retracted**. Explicitly stated guidance can be captured and
activated at its stated scope automatically, with the original text and provenance
inspectable. Clear recurring evidence may be automatically consolidated into a
candidate, not a user-endorsed rule; candidate use is labeled as tentative review
context, never a mandate. #14 proposes inferred candidates require confirmation:
retain that boundary for promotion to confirmed patterns, without requiring user
approval for every obvious extraction. An ambiguous generalization, conflicting
scope or high-impact instruction stays a candidate or is excluded. No aggregate
count, confidence score or model output establishes user intent by itself.

Explicit user edits append a new version and override an older incompatible
version **only within the same scope and applicability**. A narrow exception
can coexist with a broader preference; distinguish their conditions. For
incompatible equally applicable guidance where precedence is unclear, expose
the conflict and omit the disputed directive, or ask when necessary. Never silently
resolve by timestamp alone. Retraction takes effect in retrieval immediately;
keep a minimal tombstone to prevent re-extraction from old evidence. User-facing
inspection must show origin, source links, exact scope, history, conflicting
evidence and selected/not-selected reason, and allow edit, narrow, retract and
mark false positive. Respect source retention/deletion and access policy; a
missing or unauthorized source displays unavailable, never a substituted excerpt.
Separate logical retraction from any future physical erasure policy.

## Consolidation and recovery

On durable submission enqueue eligible input, coalesce nearby work by scope and
process asynchronously with bounded concurrency and backoff. A later accepted
correction or user edit creates another versioned event. The worker reads an
immutable input set, proposes source-linked records, and commits results plus
processed-event checkpoint atomically with compare-and-swap against current
preference versions. On conflict, recompute from current versions; never overwrite
a user edit or resurrect a tombstone. Deduplicate by input IDs, extractor version
and operation identity, not text similarity. Validate provenance, scope and output;
unverifiable attribution or secret-bearing material is excluded or quarantined,
not guessed. Do not copy raw private sessions into Git or imply an external host.

On startup scan the durable outbox and resume expired leases; on a new submission
also discover older pending work. A bounded periodic catch-up could supplement
these triggers in a future implementation, not replace the outbox and not a job
authorized here. Failures and last successful checkpoint are inspectable; retries
are idempotent, with poison inputs quarantined and subsequent inputs allowed to
proceed. If the process dies before commit, retry the same event; after commit but
before ACK, look up the same operation, never create a duplicate. Missing retained
content yields unavailable/deferred evidence, not invented lessons. Explicit user
review capture remains durable even while extraction is delayed. No runtime
timer or service is installed by this proposal.

## Context selection and derived guidance

At builder or reviewer context assembly, admit the recipient and project first;
filter by active status, explicit scope and compatible intent, path/language when
known, then relevance to the actual assignment or reviewed comparison. Unknown
scope or authorization fails closed. Global/cross-project scope requires explicit
user intent; project guidance does not leak to another project. Limit result size,
prioritize explicit applicable guidance and concrete examples, and report
truncation or unavailable context rather than imply exhaustive coverage. Include
source links and versions, label candidate patterns and counterexamples, and pin
selection to the review result/context version. A newer correction makes an old
selection historical, not silently current. No preference grants a capability,
lowers review scrutiny, approves changes, waives checks or changes merge policy.

An optional generated scoped skill is a **disposable derived view**, tagged with
its source IDs/revisions and scope. Retrieval must check those versions and access
against authoritative memory; stale/retracted output is omitted or regenerated.
Never read generated text back as a second authority or silently overwrite a
user-authored skill. Any export into user files requires explicit user choice,
with conflict handling and no automatic replacement. No such skill is created here.

## Worked record paths and validation cases

These examples instantiate #14's proposed record shapes; they are hypothetical,
not claims that a real human review or accepted correction exists.

1. **Submitted review:** user annotates `src/adapter.ts`, after-side lines 12–16
   of retained comparison R1: “This wrapper adds no behavior; it forces two
   edits for one change.” The submitted annotation A1 has authenticated user origin,
   exact anchor/blob/excerpt hashes and task intent. Capture A1 and its outbox entry
   before workspace retirement. A draft or agent suggestion with identical words
   is ineligible. This single observation supports a tentative contextual candidate,
   not a blanket ban on wrappers. Review approval of R1 alone creates no preference.
2. **Correction:** R2 replaces the wrapper; a human explicitly resolves A1 or
   approves R2 and explicitly confirms that open thread under #14's contract.
   Link that accepted correction and R2 to A1, keeping R1 and the original reason.
   Coordinator “addressed” is reported evidence, not that human acceptance.
3. **False positive and correction:** a later submitted user note says an adapter
   at a trust boundary is intentional. Attach the counterexample to the scoped
   candidate; a user may narrow or retract it. Previously selected versions remain
   auditable, but future retrieval excludes the retracted version. A stale retry
   cannot restore it. A later specific exception must not erase a valid broader
   preference for unrelated contexts.
4. **Seed and relevance:** the #17 pass-through-wrapper seed is user-authored;
   it enters only its established review scope, with source and the legitimate
   adapter caveat. For an unrelated project or non-code intent it is not selected.
   A reviewer of a relevant change gets it as a prompt to examine evidence, not a
   finding or assignment to clean up existing wrappers.
5. **Interrupted processing:** submit A1, crash after durable capture but before
   consolidation, restart and drain the same outbox item. Crash after its atomic
   commit returns the same receipt on retry. Failed extraction is visible and can
   be retried; it neither loses A1 nor blocks unrelated inputs indefinitely.

Future implementation validation must exercise authenticated submission versus
draft/agent input, exact source access after retirement, R1/R2 and human disposition
identity, scoped seeds, conflicts, user correction versus in-flight consolidation,
retraction resurrection, duplicate/lost ACK, restart and poisoned jobs, selection
authorization/truncation, stale generated views and unchanged gate authority.
Storage ownership, trusted human-origin admission, source-retention/erasure,
scope UI and operational limits require implementation review before activation.
