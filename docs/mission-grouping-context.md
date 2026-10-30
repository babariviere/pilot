# Mission grouping and contextual decisions

**Docs-only validation of D21, not adoption or an implemented context gate.** The coordinator owns
planning and adoption. This proposal does not change the brief, decisions, criteria or authority,
and does not adopt the detailed mechanics in [#2](mission-interview-approval.md) or
[#5](mission-authority-review-policy.md). Examples are conceptual tasks, not work assignments.

## Smallest useful model

| Concept | Existing contract | Recommended interpretation and gap |
| --- | --- | --- |
| Topic or label | No separate structured task topic in the [task contract](../packages/protocol/src/index.ts). Task title/body can name a workstream. | Optional organizational hint only. Start with a short convention in task text, including multiple names for cross-cutting work. It is not reliably machine-filterable or a source of applicable decisions. If structured multi-topic filtering later proves necessary, a small optional set of task labels is the only addition to evaluate, not a hierarchy or authority model. |
| Phase | Stable mission-scoped `phaseId`, name, goal, order and derived completion. `milestone` is its legacy name alias. The existing `group` operation bulk-assigns a milestone/phase, not an independent topic. | Use phases only when the mission needs stages; tasks may be unphased. Do not overload a phase as a parallel workstream: one task has at most one phase and phase gating can affect admission. |
| Dependency | `dependsOn` names task IDs, deduplicated and checked against the mission; self-dependency is rejected. | Add an edge only for an actual prerequisite, even across topics or phases. Metadata can contain cycles; start validation rejects cycles. Deleting a task currently removes its incoming references, so preserve/replan affected prerequisites explicitly rather than treating deletion as success. |
| Display order | Task `order` is a mission sort key. Phase order also orders phases. | Task display order alone creates no prerequisite or authority. Phase order is not merely decorative when phase gating is enabled. |
| Decision pin | `decisionIds` identifies mission decisions pinned to a task. | An explicit relevant-context reference, not a complete applicability calculation or an independent grant. Pins do not make unrelated preferences or findings binding. |

The existing-field mapping is enough to validate the default without a schema change. Its tradeoff is
that a text convention cannot reliably select all cross-group tasks or survive rename automatically.
If that limitation actually matters, structured optional multi-label membership could address it;
it must not replace phases, pins or dependencies, and its identity, editing and deletion semantics
remain open. There is no need to invent group records, nested phases or a generic planning engine.
A small mission can have no labels and no phases.

## Existing execution semantics

With `phaseGating` off, phase membership does not gate admission. When enabled, earlier incomplete
phases derive a blocked status for later phased tasks; unphased tasks are not phase-gated. Empty
phases and phases containing only done/dropped tasks are complete, and reopening a task can reopen a
phase. Phase reordering changes this gate. Existing supported user-only phase override is explicit,
not inferred from a label. Removing a phase unassigns its tasks. See
[phase tests](../packages/daemon/src/phases.test.ts).

The current multi-start path rejects unfinished dependencies outside its selected set, including
dropped prerequisites; it permits selected dependent tasks together, ordering them topologically,
and rejects cycles at start. Given order breaks ties rather than task display order. This is not a
universal claim that every claim or write path enforces dependency completion; see
[multi-start tests](../packages/daemon/src/mission-service.test.ts). Grouping adds no dependency,
start permission, review waiver, criterion change or execution authority. Existing gating and
explicit overrides remain in force, not replaced by the conceptual mapping here.

## Context applicability and ownership

Proposed packet construction separates three kinds of information:

1. **Applicable mission constraints** are non-filterable for affected work, regardless of topic,
   phase or missing pin. The approved mission envelope, relevant decisions and applicable safety,
   authority, checks and criteria remain binding; selecting context must never silently omit them.
   Exact trusted approval and applicability machinery are not implemented by this proposal.
2. **Relevant task context** includes the assignment intent, scope and criteria, explicit task
   dependencies and their state, and full text/identities of relevant pinned decisions. A pin makes
   a decision visible for that task; it is not proof that unpinned constraints do not apply. Include
   the union of relevant context for a cross-group task. Conflicts, missing decision content and
   ambiguous applicability go to the coordinator; affected consequential work waits for resolution.
3. **User/project preferences and findings** are separately identified guidance and evidence with
   provenance, scope and uncertainty, not mission decisions, permission or review waivers. A label
   cannot promote them to authority. Applicable approved constraints take precedence; escalate a
   conflict instead of silently discarding either source.

Today [mission context](../packages/daemon/src/mission-service.ts) selects `all` audience decisions,
coordinator-audience decisions for the coordinator, and pins on a member's open owned tasks. This
selection is not an implemented semantic completeness check for every applicable constraint. The
[#1 planning foundation](../packages/daemon/src/mission-planning.ts) separates revisioned assignment
from execution; it does not implement this proposed applicability gate. Workers should receive the
current bounded assignment, applicable constraints, relevant pins and dependencies, and separately
identified relevant guidance, with missing or uncertain context visible. Workers report findings,
blockers and proposed changes, not alter their own scope or acceptance.

The coordinator, or user where required, changes grouping and pins within authorized planning;
workers propose changes. Existing decision editing remains user-only on supported paths. A rename,
move, label removal or phase deletion is organizational only if it preserves applicable constraints,
explicit edges and criteria. Reassess affected work before applying a consequential change; changed
scope, prerequisites, criteria or authority needs explicit replanning and any required user approval.
Unpinning or deleting a decision cannot itself withdraw a binding constraint. Do not infer authority
from a former owner, a previous group or a re-created label. Reassignment requires revalidating the
new owner's current assignment and applicable constraints, not transferring old grants.

For future consumers, compare assignment revision/content, actual owner and existing
`sharedDefinitionRevision`, plus an appropriate brief/decision/context fence, before using a
context-dependent action and again at consumption. Owner release/reclaim ABA can change definition
revision even if assignment and owner look identical. Existing dormant review records retain a
conservative context fence; see [review records](mission-review-records.md). These are reuse
candidates, not atomic grouping/pin/approval enforcement or proof of live freshness. A label or phase
change may require additional coverage: do not assume every proposed change is already fenced. On
stale, missing or ambiguous inputs, retain history and re-evaluate rather than revive an old grant.

## Scenarios

| Situation | Conceptual mapping | Consequence |
| --- | --- | --- |
| Parallel workstreams | Backend: persistence; UI: presentation. Both have optional text topics and may share a Build phase. | No edge or special permission follows from either topic or shared phase. |
| Vertical slice | A task spans backend and UI topics, with one phase if useful. | Include all applicable constraints and relevant pins from both areas; conflicts go to the coordinator. |
| Cross-phase prerequisite | UI delivery in Ship explicitly depends on backend contract in Build. | Preserve the named edge. With phase gating enabled, earlier incomplete phases also gate admission; neither rule is a review waiver. |
| Small mission | One ungrouped, unphased documentation task, no dependencies. | No organizational setup required; applicable constraints and criteria still apply. |
| Move, rename or delete | Move a task or rename/remove a label or phase; delete a prerequisite or pin. | Reassess affected context and gates. Never silently weaken a constraint or accept removed prerequisite as done; replan explicitly when meaning changes. |
| Owner returns | A task goes from A to B and back to A. | Previous context/grants stay historical; revalidate owner, assignment, definition and relevant context. |

## Recommended default and unresolved choices

Keep D21's optional topics, explicit dependencies and existing phases. Begin with text-only topic
hints and explicit task decision pins; avoid phase gating unless deliberately needed. This validates
the model, not an implementation choice for future structured labels. Do not infer sequencing from
task order or topic membership. The coordinator determines relevance and resolves uncertainty within
the approved envelope; workers receive bounded context and can escalate.

Open choices for later validation: whether structured multi-label filtering is needed and how label
identity/rename/deletion works; how applicable constraints are identified and checked completely;
how context changes invalidate or revalidate running work; and which existing revisions can safely
fence those changes. Approval transport, amendment mechanics and review/merge policy remain separate
proposals, not settled by this document.
