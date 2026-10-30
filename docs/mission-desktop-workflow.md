# Coordinator-first desktop workflow

## Screen and flow inventory

Lightweight interaction proposal for **apps/desktop**, not implementation or a visual redesign.
The companion native artifact contains a flow map and six structural wireframe vignettes:

Companion artifact: **Coordinator-first desktop: flow and wireframe vignettes**, ID
`e6068cfb-aa48-4605-9b10-74a7ac7ef5d5`, revision 1, attached to the design task.

| Vignette | Existing home | Job and proposed addition |
| --- | --- | --- |
| Interview and approval | Coordinator conversation; mission brief workspace | Establish the outcome, inspect findings, then explicitly approve an exact brief/authority package. New approval sheet, not a new destination. |
| Oversight and tasks | Mission Overview / Tasks; conversation mission inspector | Show what needs a decision, what continues and why. Disclose effective authority and exact task evidence without managing worker conversations. |
| Inbox to Review | Inbox; mission Review tab | Open the exact required review, with a return path to the filtered Inbox. Request-backed attention and deep links are future work. |
| Help and recovery | Coordinator conversation; mission Overview | Explain the blocker and smallest human action. New request detail within the existing page, not a worker-chat queue. |
| Worker history | Mission Members disclosure; archived-chat filter | Find retained deliveries, revisions and conversations after workers retire. Proposed history detail extends existing browsing. |
| Guidance and provenance | Review Details; mission Overview menu | Optionally inspect what guidance was supplied and correct its scope or interpretation. New on-demand inspector, not a learning dashboard. |

The user manages outcomes and exceptions through the coordinator. Worker chat links remain available
as evidence, never required steps for approval, feedback, task routing or routine completion.
All new placements/actions below are proposals. Bracketed actions in wireframes are design notation,
not enabled controls or API contracts. Opus refinement remains deferred.

## Implemented versus proposed

Source inspection baseline: `f17eea3d8fb5e5250b49a99af793d38abcf0b7a2`, not a runtime observation.
This includes landed caller-impact exploration and the non-code acceptance prerequisite plan;
neither adds retained before/after analysis or activates acceptance gates.

| Capability | Status at this baseline |
| --- | --- |
| Missions browser, Overview, Tasks, brief workspace, members, conversation context | Existing desktop surfaces. Brief saving is editing, not approval. Native standalone creation creates a mission without an agent, not an interview. |
| Mission Review tab | **Implemented, read-only**, using retained comparisons and Kit Diff. Current worker selection, comparison paging, Unified/Split, file selection, Before/After retained source, Details and optional reported evidence exist. |
| Eligible-worker capture | **Implemented host checkpoint**, only newly created managed `planningVersion: 1` builder bindings. Saves eligible committed layers separately from reading Review. No live working-copy capture, automatic stacks or complete contribution inventory. |
| Legacy mission capture | **Unavailable**. Reading, reopening or observing existing work does not enroll or backfill it. Missing comparisons never mean no changes. Existing retained records require valid current custody to read. |
| Revision-bound submissions, allocation and agent review records | Internal foundations, not an active acceptance/review pipeline. Readable reported records do not attest checks, independence, freshness or acceptance. |
| Multi-root static caller impact | **Landed** `code_impact`: bounded TS/JS caller investigation over one host-selected source, with opaque observed-revision receipts. Not retained before/after analysis, runtime tracing or complete impact. |
| Non-code acceptance prerequisites | **Landed plan**, not active gates. Policy/explain-only, attributable checks/reviews, bounded inventory/freshness and acceptance activation remain separate implementation prerequisites. |
| Interview approval, authority-package UI, amendments | **Future**. Current brief revisions and role metadata do not supply trusted user approval or build admission. |
| Human annotations/submission; changed retained static paths | **Future**. No review write or retained-path analysis is installed by this proposal. Native Review currently reports changed paths Unavailable. |
| Request-backed Inbox attention and help/takeover | **Future**. Current loaded-chat Inbox is not a durable review-request service. Existing `ask_user` remains until reliable replacement exists. |
| Preference learning, inspection/correction; automatic retirement | **Future contracts**, not deployed services, enabled actions or authorization. No migration, cleanup or gates activate here. |

Use [native Review](mission-native-review.md) and [capture](review-snapshots.md) for current behavior;
the later proposal sections in those documents must not be mistaken for implemented controls.
The separate [code evidence capture](code-evidence-capture.md) is disabled/synthetic-only, not an
alternate production capture path for legacy missions.

## Information architecture and navigation

Keep the existing hierarchy: **Home watches; Inbox acts; Missions browse; Overview orients**.
Do not add a top-level Review badge, worker management screen or mandatory topic hierarchy.

| Surface | Keep visible | Reveal on demand / navigation |
| --- | --- | --- |
| Home | Mission outcome and working/attention reason | Open mission or coordinator. No new review counter or learning feed. |
| Inbox | One actionable request and short reason | Exact review, approval package or help detail; retain project/kind/mission filters and return position. Proposed request kinds share one attention source. |
| Mission Overview | Outcome, next required action, Working now | Open coordinator, brief, Tasks, Review; Findings, Members/history, Decisions, Activity and Authority through existing disclosures/menu patterns. No permanent metadata wall. |
| Coordinator conversation | Interview, explanations, decision questions | Approval package, cited explorer report/artifact, mission context inspector. The conversation is the planning contact, not the authoritative receipt for every action. |
| Tasks | Intent, status and blocker when relevant | Selected task details: scope/criteria, owner, actual dependencies, optional phase/topic, authority reason, contributions and criterion-linked evidence. No new task endpoint is assumed. |
| Review | Worker/subject, exact comparison, relevant warnings and diff | Details: full identity, historical task purpose, reported evidence, analysis limits. Future requests add intent, required action and authored walkthrough before the diff. |
| Changes companion | Live workspace inspection for the open chat | Future explicit link to retained Review when an exact subject exists. Keep live source separate; no implicit conversion into review or approval. |
| Members / history | Active work first, finished/archived disclosed | Retained deliveries, every known owned change, historical revisions and Open conversation. No Restore workspace shortcut after deletion. |

Existing sidebar mission threads still open the coordinator, with an Open mission action; collapsed
members and finished-member disclosure stay navigable. This proposal does not remove access to
workers or automatically hide live failure evidence. Future coordinator routing should consolidate
mission requests by their authoritative identity, not suppress all worker-origin attention by role.
Standalone chat attention and its current behavior remain unchanged until separately implemented.

Only four additions need new interaction containers: exact-package approval, request detail,
retained worker-history detail, and scoped guidance inspection. Reuse existing dialogs, page detail
and companion patterns; none requires a new global destination. Detailed annotations belong to
[the native Review design](mission-native-review.md), not this document.

## Normal path

1. **Describe the outcome.** The proposed interview entry opens a coordinator conversation in the
   selected project. Keep today's no-agent creation distinct until a separately authorized entry
   exists. No ordinary Create mission click silently starts an interview or worker.
2. **Investigate only consequential unknowns.** Coordinator uses purpose-bound explorers within
   supported read-only capabilities. Findings appear as concise claims, source links, uncertainties
   and consequences in the interview and an optional Overview Findings disclosure. No explorer
   inbox, launch approval per explorer or invented research budget. Coordinator owns synthesis.
3. **Approve the package.** Open the brief workspace, inspect outcome, non-goals, criteria, material
   unknowns and the effective authority package, then use a proposed explicit approval sheet.
   Show the exact immutable brief, decisions/references and policy versions. Balanced describes
   T1 targeted independent review, T2 full independent review, T3 specialist plus human review;
   checks mandatory and force OFF. Authority details name permitted actions and delivery mode,
   exclusions and escalation thresholds. Approval is not Save, assent inferred from chat, worker
   admission, task acceptance or merge. Missing trusted approval/enforcement keeps this unavailable.
4. **Delegate without babysitting.** Coordinator decomposes/assigns within the approved envelope.
   Overview shows the next meaningful outcome and working tasks, not chat activity as a scoreboard.
   Task details expose effort, difficulty and risk separately; model advice grants no authority.
   Use existing phases and explicit dependencies, with optional text topics and decision pins per
   [grouping/context](mission-grouping-context.md). No labels-as-permissions or new hierarchy.
5. **Review only when needed.** Agent-only policy work continues quietly after its required gates;
   future human-required requests enter Inbox. Opening the item selects the exact worker-owned
   change/comparison in Review. Multiple changes remain individually selectable within one request.
   Opening, source inspection or Viewed does not approve anything. Today the equivalent browse path
   is Missions → mission → Review, with no Inbox request, human verdict or acceptance action.
6. **Assess delivery separately.** Coordinator checks each criterion against exact evidence,
   limitations and required reviews/checks; later allocation identifies selected assessment scope,
   never historical task purpose. Acceptance, eligibility, integration and worker-finished approval
   remain separate. PR-less code uses retained comparisons; non-code uses exact artifact/report/brief
   revisions, not a fabricated diff, PR or commit. See [delivery evidence](delivery-evidence.md)
   and [allocation](contribution-allocation.md). The landed
   [non-code acceptance prerequisite plan](non-code-acceptance-prerequisites.md) separates proposed
   policy/explain-only, checks/reviews, inventory/freshness and activation slices; it implements none
   of those gates. Missing active gates stay unavailable.
7. **Retire quietly, retain access.** Only the future [retirement contract](mission-worker-retirement.md)
   can archive and immediately begin workspace deletion after complete inventory, all applicable
   gates, all worker-created PRs verified merged (or proven zero with equivalent delivery), final
   coordinator approval, preservation and verified quiescence. No retention timer. Overview becomes
   quiet; Members/history still opens exact deliveries and conversations. New work gets a fresh
   scoped worker linked to history, not a resurrected deleted workspace.

## Structural wireframes

Illustrative content below is not a live mission, retained capture or approval. These fragments
use the existing native hierarchy, not new colors, typography or component geometry.

### Interview / approval package (future)

```text
Coordinator: Import compatibility                 [Open mission]
What should happen when an older file is opened?
Finding: parser recognizes version 1. [Report, revision 2]
Uncertain: whether partial imports are acceptable.
                          [Review brief and authority]

Approval sheet: Import compatibility
Brief revision 4 | Policy revision 2 | [Included decisions]
Outcome / non-goals / success criteria / deferred unknowns
Authority: Balanced; permitted delivery and exclusions
Checks required. Force off. No automatic authority expansion.
[Request changes]                     [Approve this package]
```

The package is the decision, not its title. A concurrent revision returns to a difference view;
an unconfirmed approval says Unknown with same-operation recovery, not Approved or automatic retry.

### Oversight / selected task (future additions to existing pages)

```text
Import compatibility                         [Open coordinator]
[Overview]   [Tasks]   [Review]               [More]
Needs decision: Must partial imports roll back? [Open request]
Working now
  Read legacy header      Investigating an independent criterion
[Open brief workspace]   [Findings]   [Members and history]

Task: Reject unsupported versions
Intent / scope / criteria               [Effective authority]
Depends on: version contract            [Delivery evidence]
Evidence by criterion: reports, retained comparisons, limitations
Original task purpose: Unknown. Later allocation: selected scope.
```

Authority is an inspectable explanation first. Proposed Change authority creates a new package
for required approval, not an instantly effective dropdown. Within-envelope refinements retain
their rationale and revision lineage. A material expansion or weakened criterion blocks affected
work pending approval; unaffected continuation needs the contract's validated applicability rule.

### Inbox → Review (future request, existing read-only diff)

```text
Inbox                                      [Project filter]
Needs you
  Import compatibility  Review revised parser changes
  Import compatibility  Decide partial-import behavior

[Back to Inbox]  Import compatibility / Review
Intent and reason human review is required         [Details]
Authored walkthrough (future): what changed and why
[Changed static paths: unavailable today]
Worker: Parser worker     Subject: Header validation change
Saved revision: This change vs parent              [Other changes]
Retained comparison; newer capture does not replace selection
[Unified / Split] [File] [Before / After retained source]
                           PINNED KIT DIFF
```

Read-only Review currently chooses comparisons by worker, with change/scope identity inside the
choice, rather than this proposed subject rail. Group the future rail by worker, then full jj change
identity, then saved comparison/revision. Include all known owned changes, multiple layers and prior
revisions; one selected task/allocation or active workspace never defines the whole inventory.
Unknown discovery coverage is visible. Summary, walkthrough and paths must not delay raw diff reads.
No Submit, Approve or annotation controls are implied in the implemented view.

### Human help / Stop (future request detail)

```text
Import compatibility / Help with conflict
Why this needs you; attempts; exact remaining action and risks
Affected task remains blocked. Partial work retained.
Writer quiescence: Unknown. Shared-workspace takeover unavailable.
[Inspect retained work]    [Answer coordinator]    [Open coordinator]
Stop remains reachable for active work, independent of the question.
```

Help, takeover, human completion and approval are different actions. Overlapping edits require
verified quiescence and explicit custody, then explicit hand-back with resulting revision/evidence.
No timeout, answer, closed request, Stop ACK or empty job list means writers stopped or work finished.
Unknown safety offers read-only inspection/information, not an enabled unsafe takeover.

### Retained worker history (future extension)

```text
Import compatibility / Members                 [Finished and archived]
Parser worker                                  Archived
Workspace: deletion unconfirmed                 [Cleanup details]
Deliveries: exact reports and comparisons       [Open delivery]
Changes: each known owned subject and revisions [Open retained Review]
[Open conversation] [Artifacts and evidence]
```

Archived is not Retired. Only confirmed archive **and** deletion receipts earn Retired; failed deletion
leaves an archived cleanup exception. History must survive deletion with access checks, not live-file
links. Current Review lists current members with valid custody, not a general retired-worker catalog:
durable historical roster/admission and navigation are prerequisites for this proposed route. A moved
or revoked worker's retained bytes are not automatically accessible. Never manufacture an empty diff.

### Optional guidance inspection (future)

```text
Review Details / Guidance used                  [Open scoped guidance]
Selected: explicit project guidance, version 3
Not selected: unrelated project / retracted / unavailable

Guidance inspector
Avoid behaviorless wrappers in this context.
Explicit statement / candidate / confirmed pattern (distinct)
Scope and applicability; original wording; rationale
[Submitted review] [Original comparison] [Accepted correction, if proven]
Counterexample: trust-boundary adapter is intentional.
[Edit] [Narrow scope] [Retract] [Mark false positive] [History]
```

Use [preference memory](mission-review-preference-memory.md) as the contract. Submitted authenticated
human feedback is captured with an outbox before ACK, then consolidated quietly outside workspaces.
Drafts, agent prose, opened items, silence and one approval are not generalized user preferences.
Explicit guidance can activate at its stated scope; inferred candidates stay tentative and need
confirmation before confirmed-pattern promotion. No confirmation chore for every extraction.
The inspector is optional, reachable from Review Details and Overview More → Review guidance.
It shows origin, exact scope, source review/annotation and comparison, counterexamples, version
history and selection/omission reasons. A selection receipt proves supplied context, not obedience.
Keep original human feedback separate from agent findings and coordinator disposition; an asserted
fix is not an accepted correction. Missing/unauthorized sources say Unavailable. No private transcript
or secret export, global scope inferred from project feedback, automatic skill overwrite or authority
promotion. Corrections append versions; retraction excludes future use and prevents resurrection.
Delayed extraction stays quiet unless it loses/prohibits a required action; inspect processing errors
here. A failed explicit user correction remains visible beside that action with exact-operation recovery.

## Explorer findings and source-linked review

Findings use a short claim, source identity/version, producer, observed/inferred distinction, limits
and a concrete consequence for the brief/task. Optional View source and Open report preserve that
source; coordinator synthesis does not turn a hypothesis into a decision. Findings stay separate
from mission constraints and learned preferences. Relevant task context is bounded and scoped under
[grouping/context](mission-grouping-context.md); pinning alone proves neither applicability nor authority.

Current [exploration findings/limits](code-exploration.md): literal search and TS/JS declaration/call
tools supply source hashes/locations and explicit partial coverage; live scans are not atomic snapshots.
Landed `code_impact` investigates 1 to 8 exact callable roots within one host-selected source and shared
scan, not across independently authorized workspace roots. Each possible-affected caller gets one
deterministic shortest source-edge witness to a nearest root, not every affected root/path. Unknown
calls stay unassigned and counts stay non-exhaustive. Observed-revision receipts and `expectedRevision`
can reject a changed observation; they are not a freshness lease, atomic snapshot or retained bytes.
Caller relationships remain source-inferred, not executed paths. Retained Review analysis cannot
silently reuse a live-workspace graph: structural comparison and retained before/after analysis are
still absent. The landed [public exploration-pattern study](empryo-code-exploration-evaluation.md)
distinguishes callable witnesses from file-import inference and historical co-change; those weaker
relationships must not be relabeled as call paths or acceptance evidence. Its recommendations are
source-inspected proposals, not new capabilities or comparative/runtime qualification. No explorer
was started for this design deliverable.

[diffmap README, inspected at `ed18ee23248ec0d42cdbd215b6731619a52dbf34`](https://github.com/tanishqkancharla/diffmap/blob/ed18ee23248ec0d42cdbd215b6731619a52dbf34/README.md)
is inspiration only. It describes linked walkthroughs, ordered changed files with other files folded,
and a shared source/diff panel. No external code/skill was copied, installed or run; no comparative
performance or runtime validation is claimed. Adapt the ideas natively:

| Idea | Pilot interpretation and truthful boundary |
| --- | --- |
| Explain before diff | Concise **Authored explanation**, with author/revision and uncertainty. It is a narrative, not a generated fact, call graph or gate result. Raw diff remains directly accessible. |
| Source-linked walkthrough | Steps target exact snapshot, before/after side, logical path, hash and range. Invalid/omitted anchors show Unavailable, never latest/live source. |
| Important-first folding | Findings and relevant changed roots/files first; unchanged context faint; other files/branches explicitly expandable. Folding never changes review coverage or hides blocking findings/omissions. Provide an all-files path. |
| Synchronized navigation | Selecting a step/frame focuses its pinned source/diff range; explicit source/diff switch retains comparison, position and Back. Multiple targets require a visible choice. No silent revision switch or workspace Open file. |

Distinguish three evidence types in words: **Authored explanation**, **Static source relationships**
(body versus edge changes, inferred/unresolved edges and coverage), **Observed runtime evidence**
(only if independently recorded, with producer, tested identity and limits). No animation, graph edge,
retained source, screenshot or worker narrative proves execution, impact completeness or acceptance.
Changed paths remains Unavailable until analysis of both retained sides exists. Follow D29's
summary → expandable changed static paths → pinned diff, without making a graph prerequisite to reading.

### Exact comparison identity

An action targets the retained `snapshotId`, physical repository, full jj change ID, capture operation,
explicit layer/stack scope and full base/head commit identities from **that manifest**. Source adds
side/path/blob SHA-256/range. Keep readable saved-revision labels in the main view; expose full values
through keyboard-reachable Details/Copy. A layer uses its exact direct parent; a stack its explicit
retained ancestor. No default branch, merge-base, active workspace, current HEAD or latest fallback.

Illustrative identity in the native artifact comes from `native_review_fixture.rs::comparison(1, "layer")`,
not a real capture: snapshot `0000000000000000000000000000000000000000000000000000000000000001`,
base `cccccccccccccccccccccccccccccccccccccccc`, head `dddddddddddddddddddddddddddddddddddddddd`.
The fixture's repository is 64 `a` characters, change is 32 `k` characters, base change 32 `l`
characters and operation 128 `b` characters. These are synthetic wire identities only, not Git/jj
object-existence or ancestry proof. Real UI must read validated manifest fields, never these examples.
Retained identity is historical content identity, **not live freshness, runtime proof, task-purpose
attribution, independence, passing checks, acceptance, integration or permission**. Refresh keeps the
selected comparison; a newer capture offers an explicit switch with old drafts/history retained.

## One attention flow, scope still open

Proposed request-backed attention: worker → coordinator triage → user only for required human review,
out-of-authority decision or genuine help. Coordinator answers ordinary factual questions itself.
Unavailable/failed coordinator leaves an actionable durable routing/recovery exception, not silent
approval or a demand to inspect every worker chat. Existing fallback remains until that path works.

Inbox and Overview show the **same request**, not independent acknowledgements. One row per logical
request lineage, not per change/capture/message; distinct review and scope/help requests stay distinct.
The row names mission, intent and next action; worker identity is secondary. New revisions update the
existing lineage without stealing selection. Opening/reading/dismissing does not resolve required
action. Authoritative submission, answer consumption, withdrawal or completion resolves the relevant
request under its contract, not an arbitrary read flag. No new attention source is activated here.

Human-required review becomes actionable only with its required retained inputs and ordered
prerequisites; waiting for capture/check/agent review stays quiet in Overview/Review unless user
intervention is actually required. Human-review ordering versus parallel review remains undecided.
Automatic retirement success and routine learning create no Inbox chores. Cleanup exceptions go to
the coordinator first, then the user only when their action/authority is needed. Preserve urgent
failure and Stop/recovery paths independently of batching; no new timing/SLA is selected.

| Review scope option (not selected) | Benefit | Cost / constraint |
| --- | --- | --- |
| Mission-specific Review only | Matches existing implemented tab/custody and preserves task context | Cross-mission review requires navigation; Inbox must still link directly to exact targets. |
| Project-wide Review browser | Compare all proven worker-owned subjects in a project | Requires new admitted cross-mission discovery/history; risks a second required queue. Unknown legacy ownership cannot be filled in. |
| Inbox across projects plus mission Review; optional project browse later | One action queue, exact mission context, no new mandatory destination | Deep links/return state still need implementation; a later project browser needs explicit scope and custody design. |

**Recommendation, not a binding default:** the third option. Retain current mission-scoped browse;
add exact Inbox entry when request primitives exist, then validate whether optional project browsing
is needed. Preserve visible project/mission filters and the originating scope on Back; do not silently
broaden missing/unauthorized targets or let a filter hide the fact that more requests exist elsewhere.
The artifact illustrates an exact mission target, not a selected global review-scope policy.

## Meaningful exceptions and recovery

| Condition | Visible result and safe next action |
| --- | --- |
| Interview outcome/authority unresolved | Draft with named uncertainty; investigate or ask the coordinator. No affected builder admission inferred. |
| Brief/policy changes during approval | Preserve displayed package and user input; show changed content, require current explicit approval or validated in-envelope amendment. |
| Approval/submission/correction ACK lost | Unknown, preserve exact immutable intent and drafts, reconcile same operation. No new grant/write identity or JS effect replay. Existing legacy endpoints without lookup cannot promise this recovery. |
| Worker blocked; coordinator busy/absent | Retain blocker, attempts and exact requested action; continue only demonstrably independent authorized work. Coordinator recovery/replacement, not worker self-approval. |
| Scope expansion or weakened criterion proposed | Affected work waits for coordinator planning and required new user package approval. Preferences never authorize it. |
| Human edit help requested | Takeover pending until proven writer quiescence and preservation; explicit custody/hand-back. Unknown safety blocks overlapping editing, never Stop. |
| Stop during question, capture or recovery | Stop remains reachable through existing active-chat control; future request detail may link it without new send permissions. Stop is not cancel-request, completion or child-join proof. Late answers do not restart work. |
| Crash/reconnect or manual pause | Retain exact pending operations, requests, stopped state and partial work; restore before admission. Reconcile outcomes, then explicitly continue only under current fences. Never replay uncertain commands. |
| Legacy/ineligible worker or no saved comparison | Unavailable/not enrolled, or No saved comparison yet with coverage reason. Never No changes; no capture button, automatic adoption or enrollment-on-read. |
| Capture pending/failed with older comparisons | Keep exact older selection plus visible pending/failure notice. Reading/Refresh does not trigger capture; host checkpoint retry is separate. |
| Partial/binary/conflicted/corrupt/omitted input | Explain affected content/coverage and safe inspection; no clean/pass claim, live fallback or future approval on missing required inputs. |
| New revision, changed assignment/owner/context | Old evidence remains historical/outdated. Revalidate actual owner, assignment and shared-definition fences, including A→B→A; new capture/allocation is not automatic acceptance. |
| Read refresh fails/offline | Proposed general recovery retains only admissible same-scope content with a stale/error label and explicit retry. Current Review clears comparison content on ordinary read failure (optional-record unavailability is separate); do not mock retained failed-read content as already implemented. Scope/custody changes clear inadmissible content. |
| One reviewed change, others unknown/unreviewed; several PRs | Keep each subject and all contribution/PR coverage visible; no worker-finished or retirement from one green diff/merged PR. Unknown inventory is not zero. |
| Agent finding disputed or preference conflicts | Preserve authored opinion/counterexample; route correction through coordinator. Omit unresolved disputed guidance or ask when consequential; do not lower gates. |
| Archive confirmed, deletion failed/Unknown | Archived with cleanup exception and exact known outcome. Preserve workspace/records, coordinator reconciles same attempt; never falsely Retired or unsafe restore. |
| History/source inaccessible after retirement | Unavailable with reason and coordinator route, not substituted source or empty history. A new task uses a fresh worker; access still requires current custody. |

## Keyboard, focus and ownership contract

- Keep existing native Tab/Shift-Tab, list Up/Down, Enter/Space activation, Escape dismissal and
  Command-[ / Command-] history. Tasks select canonical task IDs; links never resolve by title.
- Existing Review Selects are keyboard/query accessible. Kit Diff owns selection/copy; Option-Up/Down
  moves between changes. Escape goes source → diff → Overview. Future Inbox deep links restore the
  originating row, filters and scroll on Back. Do not overload Escape to approve, stop or withdraw.
- New disclosures/actions have visible labels or accessible names; all important warnings, scope,
  pending/Unknown and recovery remain visible without hover/color alone. Long names/Unicode stay
  readable through selection/copy and detail, not identity inferred from clipped labels.
- Proposed approval/request/guidance sheets restore a mounted invoking control when closed. IME
  preedit blocks submit/navigation before blur; no Enter grant while composing. Native annotation
  editing shortcuts, anchor persistence and submission details remain owned by the Review design.
- At narrow widths, show one main task, comparison or source at a time with named Back; replace a
  subject rail with a Select. Do not squeeze chat, authority, graph and diff into permanent columns.
  Keep stable sizing and virtual diff/list owners; source/walkthrough selection must not reset scroll.
- Conversation/composer drafts, pending Send and Stop retain their existing owners. Mission pane owns
  tab/task identity and readers; Review pane owns exact selection/read generations; future durable
  domain services own approval/request/review/learning/retirement receipts. Rendering never sends or
  captures. Cancel obsolete reads; admitted writes still settle against their original immutable owner.
- Preserve explicit Save and current limitations: brief and creation drafts are process-local, not
  magically restart-durable. Proposed durable review drafts/requests require their own implementation.
  No synthetic native check, wireframe or artifact establishes OS IME/AX, smoothness or user acceptance.

## Validation and remaining decisions

Preparation checks: source/reference audit, local Markdown link/fence/whitespace checks and native
artifact validation across its flow/vignette controls. No application code changes or runtime tests
are warranted by this documentation-only proposal. These are design checks, not production probes.

Future walkthrough obligations: outcome → explicit package → delegated work → exact required review
→ coordinator acceptance/integration → preserved history; keyboard-only traversal; multiple changes
and PR-less evidence; legacy capture unavailable; new revision stays pinned; pending/error/Unknown
at every write; blocked human takeover with unknown writers; Stop during wait/recovery; cleanup
failure after archive; optional scoped guidance correction without routine confirmation chores.
Use owned synthetic fixtures before live adoption; dedicated Review owns detailed annotation tests.

Unselected choices: project versus mission Review browsing; review prerequisite ordering; trusted
user-action transport and exact-package amendment UI; historical roster/custody reads; request
withdrawal and optional snooze rules; scope-inspector placement/details and safe takeover support.
Recommendations here select no new policy, schema, endpoint, review write, gate or migration.
Publication of this design is not activation. No UI code, Swift work, worker starts, live capture,
automatic attention, learning job, merge, archive/delete, release or restart is authorized here.

## Source and contract anchors

- [Interview/approval](mission-interview-approval.md), [authority/review](mission-authority-review-policy.md),
  [escalation/handoff](mission-escalation-handoff.md), [roles](mission-roles.md),
  [coordinator wakeups](mission-coordinator-wakeups.md), [grouping/context](mission-grouping-context.md).
- [Retirement](mission-worker-retirement.md), [review preference memory](mission-review-preference-memory.md),
  [native Review](mission-native-review.md), [retained snapshots](review-snapshots.md),
  [delivery evidence](delivery-evidence.md), [allocation](contribution-allocation.md).
- [Desktop design system](../apps/desktop/docs/design-system.md),
  [mission creation](../apps/desktop/docs/standalone-mission-creation.md),
  [brief workspace](../apps/desktop/docs/mission-brief.md),
  [Tasks](../apps/desktop/docs/mission-tasks.md),
  [context inspector](../apps/desktop/docs/mission-inspector.md),
  [navigation](../apps/desktop/docs/contextual-navigation.md).
- Source: `apps/desktop/src/mission_browser_view.rs::{choose_tab,tab_bar}`,
  `mission_overview_view.rs::{needs_you_view,working_view}`, `mission_tasks_view.rs`,
  `native_review_render.rs::Pane::render`, `native_review_view.rs::{refresh,back}`,
  `native_review.rs::CaptureStatus`, `native_review_fixture.rs::comparison`, `inbox.rs::Inbox`,
  `workspace_changes_view.rs`. Source names locate inspected surfaces, not an attestation of a live app.
