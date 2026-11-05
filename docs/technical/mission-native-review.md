# Native Review and durable diff annotations

**D56/D57 select global change/revision-centered Review and agent-first human actionability.**
One global view shows all pending changes across accessible projects; review happens there. Chat
shortcuts open the same exact target. Remove mission Review and replace the Changes sidebar,
preserving Files/artifacts. Custody stays internal, never navigation ownership. #88 implements the
global read surface; #70 supplies authoritative waiting/request state; #60/#65 submit there; #79
links from Inbox without duplicate review state.

The backend feedback implementation below does not activate native submission UI, attention or gates. The historical
read-only implementation below is pinned to `cc51bb4af2ddc094618a9e8fb3514891705f76d9`;
#98/#88 may advance separately. D54's practical native action and D55's bounded reviewer consent
are [selected separately](mission-authority-review-policy.md#selected-policy-46-and-47). This
docs-only update creates no code/UI artifact, review, provider spend, live approval, attention,
gate, migration, cleanup, release or restart. Swift is out of scope; #44/#45 polish stays deferred.

## Backend human feedback

`human-reviews.ts` implements the `QualifiedReviewDispositionSource` used by the existing
`WorkflowConfirmations` handler. One global store shares `missions.sqlite` and its replica/durability
lane. It does not invent a mission, task, request, required approval, worker attribution or gate.
Native UI remains separate. No live data was migrated or submitted during implementation.

- Draft revisions are private native-user drafts. Saving does not dispatch or enqueue extraction.
  A submission names the exact draft revision/content, when used. A changed or already submitted
  draft cannot be consumed again. Drafts and original reviews have no worker/mission deletion cascade.
- The host builds the exact selected comparison and immutable package digest. It binds feedback,
  selected-set prior history, **each target's** prior history/open threads/change requests, current
  custody/access, authoritative requirement identity and approval prerequisites. Different and
  overlapping selections cannot bypass per-target fences. The transaction repeats synchronous
  access, custody, requirement, prerequisite and prior checks. Capture/browsing/feedback never
  supplies authoritative request status. #70 owns that producer.
- Approve needs complete retained input, known current requirements, passing required checks and
  fresh independent agent review. The latter producers are **not installed**. Production therefore
  refuses Approve. Comment and Request changes remain possible before readiness. A later Comment
  does not clear a Request changes or a thread. Record-level supersession must cover every original
  selected target. An annotation belongs only to its exact anchor target, not every target of its
  submission; edits/resolutions need that target selected and leave other targets and record-level
  Request changes untouched. Explicit native-user resolutions close their own threads. Approval cannot silently
  resolve threads, including newly submitted annotations. No approval applies to a future revision.
- Submitted records, original comments/anchors and one extraction outbox item commit atomically,
  before acknowledgment. The outbox starts no extractor, coordinator wake, provider or Inbox work.
  Finding feedback is a human opinion referencing an agent record, not a change to its authorship
  or qualification. Explicit edits/supersessions append history and preserve the original bytes.
- Native capability admission uses the existing practical D54 boundary, not verified human presence
  or OS isolation. Agent text and opening/dismissing items are not submission paths. Ordinary agent
  tools receive no draft/submission capability. Draft and feedback routes, including disposition
  Check, require the existing native capability and fresh retained project/custody access.
- Existing `review-disposition` operations and their journal own delivery. Feedback stores no second
  journal or confirmation receipt. Recovery looks up only the exact complete operation after its
  entered checkpoint. Missing/unreadable rows stay Unknown; recovery never prepares a new package,
  calls prerequisites or repeats record. Historical acceptance is not current gate authority.

Native backend routes, all under `/api/review-feedback`, are `POST target` (project/session/snapshot
selection to a host-built exact target), `POST prepare` (complete disposition payload; initial digest
may be zero), `GET/PUT drafts/:id`, `POST history` (`target`, `after`) and
`POST annotations/:id/projection` (`target`). Preparation/read routes create no submission.
Submission still uses `/api/operations`; Check uses `/api/operations/receipt` with the **same exact
operation** and native capability. Pending remains pending until exact journal reconciliation. A
missing feedback row cannot be replaced by current matching state or a different operation.

Feedback is optional. Omission stays omitted for old operations and exact recovery. Its strict schema
allows at most 100 annotations/findings/resolutions and 24 KiB total feedback. Feedback-bearing
payloads are limited to 48 KiB; omission keeps the existing journal limits and payload bytes.
Body text is limited to 16 KiB. Original anchors keep snapshot, side, path, source line range, blob,
excerpt and two-line context hashes. Bytes keep BOM/CR/newlines. Save validates retained text;
binary/unavailable files support file anchors only. Read-time `reanchor-v1` projections keep originals,
show same/moved only for exact matches and manifest renames, and report ambiguous/outdated instead
of guessing. Cross-side ranges carry only with unchanged blobs. Source validation/rewrite matching
uses the existing retained worker, not the daemon event loop. Daemon-owned ledger mutation fences
are repository-scoped; they do not claim exclusion against external Git writers.

Focused tests cover restart/durability failures, exact lost ACKs, overlapping selection CAS/blocks,
stale prerequisites/requirements/custody at commit, private drafts, current access after workspace
loss, original anchors/supersession and native-only HTTP admission. Native UI/IME/visual acceptance,
request production, reviewer execution, learning, attention and gate activation remain separate.

## Implemented read-only slice

This section describes the pinned historical implementation below, not the selected product scope.
D56 supersedes D48's project-owned/chat-first destination and the old mission placement. The
following mission UI/transport description is historical shipped behavior to replace, not the
selected destination. Necessary per-project/chat access checks remain internal to global Review.

Mission detail has **Overview / Tasks / Review**. Review is mission-scoped browsing, not a required
queue or an Inbox attention source. Choose a current worker, then one exact retained comparison.
Choices use readable worker titles and saved-revision/layer/stack labels; full jj subjects and immutable head/base revisions live in Details;
Exact revision details exposes repository, snapshot, operation and creation IDs. A refresh keeps the
chosen comparison, including when a newer comparison is listed. Switching worker, mission or host
clears previously admitted content and fences/cancels obsolete reads. Escape returns from
retained source to the diff, then to Overview. Source's Back control returns to the diff; existing
navigation history is unchanged. Native Selects retain their keyboard and query focus;
Kit Diff owns selection/copy/navigation, with Option-Up/Down for previous/next change.

The summary distinguishes proven worker creation, enrollment task scope and historical task purpose
(Unknown). Optional agent dimensions and reported evidence load only on explicit disclosure, after
raw diff. Their exact profiles and task intent are displayed separately, never as an overall score.
The default view is intentionally only worker, selected comparison and the full diff. Provenance,
full IDs, analysis limits and evidence are in the **Revision details** dialog, not persistent
status prose. Actual partial/unavailable/error warnings remain visible. Comparison choices use
human-readable layer/stack and capture labels; exact base/head identities remain in that dialog.
Recorded outcomes remain **Unavailable** for current applicability unless structurally **Outdated**:
this reader does not re-resolve arbitrary context, attest producing agents, or prove independence,
checks, acceptance or live-source freshness. A selected allocation is assessment scope only, not final
acceptance or original task purpose. No human rating, annotation, approval or submit control exists.
Changed paths explicitly remains Unavailable until retained-input analysis exists.

### Layout (Files changed)

Review reads like a pull request's Files changed page. One toolbar holds Worker, Saved revision,
a Revision details (info) button and Refresh; narrow panes give the worker its own row. Below it
sit only real warnings (errors, capture, partial, newer revision). Then "N files changed +A −D",
an optional Jump to file (two or more files; it scrolls, then returns to its placeholder),
Unified/Split, and every file of the exact retained comparison in one continuous Kit Diff. Each
file header has View file, which opens that file's retained source (after side, or before for a
deletion) with Back and a Before/After switch; an absent side is disabled, and Back cancels a pending
side read. Revision details is a dialog bound to the revision
shown when it opened: missing content, capture limits, provenance, evidence, analysis limits,
keyboard keys and the exact IDs. When there is no diff, the diff area says why: loading, no
workers, choose a worker, no saved revisions yet, or choose a saved revision. Nothing is selected
automatically, and a newer capture never replaces the revision being read.

Before: a full-width file dropdown sat above the diff, so it read as one file at a time; Details
pushed IDs and caveats above the diff; Refresh could slide under a scrollbar; an optional evidence
failure disabled choosing another revision; and the diff area was blank before a selection.

The diff is the existing virtualized Kit 0.8.1 `Diff`, not the live Changes renderer. Unified/Split,
file navigation and Before/After source all refer to the same retained comparison. Source previews
are capped at64 KiB with an explicit incomplete-preview notice; source reads remain bounded to2 MiB.
Binary/unsupported sides are not decoded as text. Missing patches, partial manifests, unsafe paths,
hash/length failures, unsupported/conflicted/truncated Kit input and patch/inventory disagreements
are explicit, never clean or Pass. Kit cannot reconstruct absent context; full source never comes
from the workspace, HEAD, another layer or the top of the stack. An empty store explains that no
capture/enrollment/migration has occurred. No synthetic fixture data enters production reads.

### Local transport and admission

Project/chat read adapters also expose `GET /api/projects/:projectId/review?missionId=` as
`{projectId,chats:[{id,title,missionId?}],more}`. It returns at most100 current same-project,
non-coordinator chats with retained bindings, including archived chats that retain current membership.
The optional mission filter only narrows this list. No binding is created by discovery.
`GET /api/sessions/:sessionId/review?after=<sequence>` returns the existing
`{comparisons,next,unavailable?,capture?}` page; `/:snapshotId` and its `patch`, `source` and `records`
subresources retain the bodies below. Project and current membership come from host metadata, not
query assertions. Standalone/coordinator/unbound chats return an explicit empty not-captured page;
they cannot read retained snapshots without current custody. Standalone capture is not enabled by
these adapters. Related records remain optional and exact-mission scoped. The mission routes below
remain compatible; these reads do not migrate consumers or records.

Session Review reads accept optional `expectedProjectId` as an equality precondition only. It must
match the host-derived current chat project at admission and every existing recheck; stale, empty,
invalid or duplicate values refuse. It never selects custody or changes response bodies. Omission
retains legacy behavior; `projectId`/`missionId` query assertions still grant no scope.

The session-only `/:snapshotId/call-changes` subresource runs the existing bounded retained TS/JS
comparison over that exact saved pair. Optional `path`, `limit`, `offset` and `expectedRevision` forward
only the existing retained query fields; `expectedProjectId` is still equality-only. Duplicate/unknown
keys refuse. Positive offsets require a matching revision and an in-range retained row. Results retain
the original pair identity, original-byte spans, unknown/partial coverage, resource omissions and
bounded pagination. Missing, unavailable, corrupt or revoked retained inputs fail explicitly without live
fallback. Unsupported syntax and partial scan coverage can return HTTP 200 with unsupported/omitted
counts and partial reasons. Neither input errors nor partial results imply a clean empty success or
complete impact coverage.
This is source-inferred review navigation, not runtime/impact proof, a UI implementation, a public
agent tool or approval/write authority. There is no mission-level analysis endpoint. See
[retained comparison limits](code-exploration.md#internal-retained-tsjs-comparison).

`GET /api/missions/:missionId/review` lists up to100 current same-project non-coordinator members.
`.../review/:workerId?after=<sequence>` returns a keyset page of up to20 retained comparisons and
an explicit continuation. The scope is derived from the mission's current project, current durable
membership, session metadata, the exact managed workspace binding and the ownership ledger.
The user supplies IDs, never filesystem grants or repository roots. Binding lookup works after
workspace/repository loss without statting or reading those source trees. Unknown/colliding/currently
changed custody denies retained content. Frozen ownership is creator provenance, not revision authorship.
Legacy missions may browse already retained records with valid custody; reading never adopts them.

`.../:workerId/:snapshotId` returns the validated, path-sanitized manifest projection. Its `patch`,
`source?side=&path=&sha256=` and `records` subresources are read-only. Snapshot/subject/repository/
worker/manifest identities must agree; source keys and hashes must occur on that exact retained side.
Valid UTF-8 source responses preserve the original BOM, CRLF and Unicode, so hashing their UTF-8 text
matches the retained blob hash and exact source spans. Malformed UTF-8 and binary content fail explicitly;
the server never substitutes replacement characters, normalized text or a fabricated digest.
Admission is repeated after asynchronous reads. Errors contain no retained content or host paths.
Raw source/patch storage and SHA-256 checks run in the existing snapshot worker. Before hydration,
SQLite checks manifest length (8 MiB), exact blob length (2 MiB source,4 MiB patch); desktop limits
wire JSON to24 MiB before decoding (including JSON escaping), validates required records and parses
patches off the UI thread. The store's existing eight-RPC bound remains. Discovery is scoped SQL,
not global snapshot/store enumeration, and an absent database is not created by discovery/reads.

Optional related reads select only exact snapshot references, at most8 records of each kind, each
at most256 KiB before hydration. This first reader supports single-comparison results/submissions/
allocations. Multi-source or additional context/preference custody is explicitly Unavailable rather
than inferred; it does not block initial diff loading. Results have no current-review/gate authority.
The underlying `review-snapshots.sqlite` and `jj-ownership.sqlite` live in daemon home, outside workspaces.
Capture and record-write APIs remain host-only. The [creation-only lifecycle checkpoint](review-snapshots.md#eligible-worker-checkpoint)
saves exact committed layers for eligible new workers, separately from this read-only transport.
Empty/loading/failed/ineligible states distinguish missing saved comparisons from actual code changes.
An empty unusable revision selector is hidden; a retained selection stays pinned on refresh.
Failed/pending capture notices remain visible even when older saved comparisons exist.

These endpoints use existing daemon loopback and browser-origin admission. They do **not** authenticate
an OS user or a particular agent session. Same-UID processes and agents with unrestricted shell/REST
access are not isolated adversaries; this change is not a new authentication architecture. Membership
revocation is rechecked at finite read boundaries, not atomic hostile-process revocation.

### Verification boundary

`native-review*.test.ts` covers admitted HTTP reads, denied writes/origins/cross-scope references,
required-record rejection, revocation during reads and exact source after workspace/repository loss.
`native_review_tests.rs` covers wire identity, malformed/truncated/partial/binary input, pre-hydration
byte caps and cancelled obsolete reads. The hidden `native_review` target mounts the production
LocalViewer and real Kit controls at680/1100 light/dark, testing mission entry, exact layer/stack,
new-revision pinning, source/back, keyboard, resize and empty/refused states against owned faux HTTP.
It pins and asserts the theme after the window opens, checks the loading and choose/empty prompts,
opens Revision details with Tab and Space and closes it with Escape without leaving Review, shows
a three-file comparison continuously (jump, View file on a deletion) and keeps a long worker title
inside its control at both widths.
These probes are not OS IME, performance, screen-reader or accessibility acceptance, and install
nothing. The hidden journey also consumes real jj/SQLite lifecycle-captured comparisons over owned
fixture HTTP, preserving selection across newer captures and exercising saved source, failed capture
and missing custody. Human review writes, attention, active gates, cleanup and Opus refinement
remain separate work.

## Supporting annotation design (not installed)

Binding inputs: D14 (dedicated Review, per-worker jj changes, native annotations), D15 (Inbox
integration), D29 (summary → changed static call paths → exact pinned diff), D31 (later coordinator
allocation is selected assessment scope, not original task purpose), D18/D19 (Balanced tiers, force
OFF, checks never waived) and D32 (this design start). Foundations reused: [jj ownership](jj-ownership.md)
(#13), [retained snapshots](review-snapshots.md) (#20), [delivery evidence](delivery-evidence.md) (#18),
[review records](mission-review-records.md) (#17), [contribution allocation](contribution-allocation.md)
(#22), the [authority/review policy](mission-authority-review-policy.md) (#5), the
[escalation/handoff proposal](mission-escalation-handoff.md) and [durable operations](durable-operations.md).

## Design starting point (before the read-only slice)

These observations motivated the design. The implemented read-only slice above supersedes the
absence of reads/Kit Diff noted here; proposed write/request contracts below remain inactive.

| Surface | What it actually does today | Consequence for Review |
| --- | --- | --- |
| `gpui-kit = "=0.8.1"` → `gpui_kit::component::diff` | Read-only virtualized patch view: `DiffState` (files, `DiffMode::{Unified,Split}`, folding, `set_selected_lines`, `scroll_to_line`, `scroll_to_file`, `next_change`/`previous_change`, `DiffEvent::Selection*`), `Diff` builder (`annotations`, `render_annotation`, `on_add_annotation`, `on_line_click`, `on_line_hover`, header slots, soft wrap) | Render with Kit, no custom renderer. Parse/install retained patches only |
| `DiffAnnotation` | Only `line(id, DiffLinePosition)` (one side, one-based source line) or `file(id, path)`. No range annotation, no summary slot | A range annotation is an app record displayed under its **end** line, with its range shown in text and re-selected via `set_selected_lines` on focus |
| `annotation_content` | Compatibility alias of `render_annotation` in 0.8.1 | Use `render_annotation` in new code |
| `on_add_annotation` | Shows an add button on the hovered line and at the end of a selection; passes `DiffLineRange` (may end on the other side in patch order) | The handler opens an app-owned draft editor; it creates nothing durable itself |
| Kit Diff key bindings (`Diff` context) | Arrows, PageUp/Down, Home/End, Shift-Up/Down extend selection, Cmd/Ctrl-C copy, Cmd/Ctrl-A select all. No Return, next-change or add-comment binding | App binds review commands in its own context (proposal below); verify keyboard line placement in a probe |
| `DiffFile` | `parse`/`parse_with`, `status` (incl. Renamed, Copied, Unchanged, Conflicted), `is_binary`, `is_truncated`, additions/deletions; never reconstructs missing context | Missing context or bytes stay visibly unavailable; never filled from live files |
| `src/workspace_changes_view.rs` | Historical live `GET /api/sessions/:id/changes` inspector. Literal patch, not Kit Diff; "Open file" reads the live workspace | Remove the Changes sidebar, not unrelated Files/artifacts. Retained View file stays snapshot-only. A separate Open current file may leave Review for the existing live-chat FilePane under current guards; never substitute live bytes for retained evidence |
| `src/inbox.rs`, `src/attention.rs` | Read-only loaded-summary Inbox with Needs you and Ready to merge, project filter, exact-ID chat activation. Opening does not mark reviewed | Add Needs review as a data-backed source; keep "opening is not acknowledgement" |
| #13, #20, #18, #17, #22 | Dormant host-only Store/Service APIs. No HTTP/IPC/tool transport | Every Review read and write below needs new admitted transport |

Before the slice, no apps/desktop code used Kit `Diff`. The earlier concept artifact said Kit 0.8.0; the pinned
version is 0.8.1 and both versions have the same annotation shape.

## Vocabulary and authority layers

- **Review subject:** one worker-owned line of work, repository instance + full jj change ID, proven
  by #13, or a non-code delivery (pinned artifact/brief/report revisions). Unknown/borrowed ownership
  is shown as Unknown and is not reviewable as a worker contribution.
- **Comparison:** one immutable #20 `snapshotId`: `layer` (direct parent) or `stack` (explicit
  ancestor), with retained before/after bytes, patch and manifest. Review never reads live files.
- **Revision:** the next retained comparison for the same subject and comparison scope, in host
  capture order (displayed as Revision 1, 2...). A stable change ID is a line of work, not stable bytes.
- **Review request:** an authoritative waiting/request record for exact changes/comparisons, with
  internal project/custody and optional chat/mission/submission/allocation context. Required review
  and optional suggestions differ; no chat or mission owns the global screen or grants authority.
  #70 persists it; capture alone creates no waiting state. Request writes/attention are not installed.
- **Review:** one human's submitted set of annotations, ratings and a verdict on exact comparisons.
- **Annotation:** a human comment anchored to a summary, file, line or range of one comparison.

The page keeps five sources visibly separate. They are never merged into one status.

| Layer | Source | Example wording | Cannot stand in for |
| --- | --- | --- | --- |
| Reported evidence | Worker submission (#18), reports, captures | "Worker reports: 12 tests pass" | Observed checks, review, acceptance |
| Agent assessment | #17 results per profile/dimension | "Security review: Fail, 1 finding (revision 2)" | Human review, independence, acceptance |
| Human feedback | This design's reviews/annotations/ratings | "You: Request changes" | Coordinator acceptance, merge authority |
| Acceptance | #18 coordinator judgement, #22 selected allocation | "Coordinator accepted revision 2 for #14 (selected scope)" | Checks, required reviews, original task purpose |
| Integration authority | Future #5/#19 policy and observers | "Delivery: not eligible (checks unavailable)" | Anything above; nothing here grants it |

## Placement and entry points

**Selected by D56:** one global change/revision Review, not chat Review, project Review or mission
Review destinations. Chats, coordinator suggestions and Inbox open the same exact change there.
Replace the Changes sidebar while retaining Files/artifacts and unrelated inspection capabilities;
do not turn live workspace Files into retained review evidence. Continuous full-file diffs remain
D43's presentation. Provenance, full IDs and custody checks stay internal or in Details, with real
warnings visible. #44/#45 visual polish is deferred.

**File inspection in #88.** Retained **View file** opens only the selected exact snapshot's source.
A clearly separate **Open current file** in retained-source view may navigate outside Review to
the existing live-chat FilePane, subject to current home/project/chat/path guards. Keep Back to the
exact global target, including its retained comparison and position. This is an explicit live-file
navigation action, not a fallback after a retained-read failure or review evidence. It does not
restore Changes or chat-owned Review, and adds no browser/editor scope. Missing or denied live
access must not retarget the retained comparison or weaken its guards.

## Request and disposition decision (#47)

**Selected by D57, not the earlier mock/D48 defaults.** All pending changes remain visible,
including those waiting on capture, required checks or agent review. Agent-first means **human
approval actionability**, not hiding the waiting queue until it is ready.

- **Timing:** required checks and agent reviews must be current/passing before human approval is
  actionable. Browsing and comments are possible earlier. Missing capability, skipped/stale/partial
  evidence or an unknown requirement set is not passing and never silently becomes parallel approval.
- **Coverage:** each disposition explicitly lists only the selected changes and exact comparisons/
  revisions, including layer/stack scope. Never infer coverage of a chat, unseen change, unselected
  ancestor or future revision. Multiple selected changes may be submitted together only with that
  exact displayed coverage; unselected items remain pending. Viewing files is progress, not approval.
- **Dispositions:** Comment records feedback and leaves required approval pending. Request changes
  blocks. Approve records human approval of the selected exact set only, after its prerequisites.
  None supplies coordinator acceptance, agent review, checks or landing. New content/base/context
  requires current review; there is no inherited approval. Generated text stays attributed as
  human-submitted rather than necessarily human-authored.
- **Permissions:** snooze and withdrawal are user-only and never waive an underlying gate. The
  coordinator may retire its own optional suggestion or a request made obsolete by authoritative
  cancellation, never user-required approval. Workers may propose, not impersonate these actions.
  Preserve exact target/history/reason; withdrawing attention does not turn a requirement green.
- **Threads:** humans resolve their own threads. Coordinators may report Addressed with evidence
  or Declined with reason, not resolve/retract the user's thread. Approval does not silently close
  other threads or dismiss agent findings. Drafts dispatch nothing.
- **Suggestions:** a coordinator's exact-change link is optional, not a new human gate or automatic
  Inbox obligation. Real scope/authority determines any required request, not the presence of a link.

### Filters, exact links and Back

The global entry spans accessible projects, not the focused chat/mission. Optional project, chat,
mission, waiting/actionable and history filters narrow that same view; keep active scope visible.
An actionable-only filter is an explicit choice, never a default that hides all other pending work.
Filters do not create state, grant access or infer request membership. No automatic mission filter.

A chat shortcut may narrow to its changes, but opens the same global target and makes that filter
visible/removable. Exact deep links preserve the requested revision even when history filters would
otherwise hide it. A newer capture offers an explicit switch, never silently replaces selection.
Back restores the invoking global list/Inbox/chat with its filters, selected row and scroll; retained
source Back first returns to its exact diff. Scope changes fence obsolete reads; drafts and pending
submissions remain bound to their original target. Missing/unauthorized targets show Unavailable
without widening to another project/chat/revision. No mission detour or worker selection is required.

Conceptual link identity carries project/access context, exact repository/change/comparison and
optional request/anchor, with chat/mission only where genuinely bound. It is not a wire schema or
an invented global-access grant. Full pins remain internal/Details, not top-of-page technical clutter.

## Inbox integration

#70 is the authoritative waiting/request source; #88 is the global read surface over it. **Captured
does not mean waiting, reviewed or landed.** Retained discovery is not a request inventory. If the
waiting source is absent, unsupported, partial or failed, show Unavailable/incomplete coverage,
not an empty queue or “nothing waiting.” An empty result needs successful authoritative coverage.
Known captures may be browsed without fabricating requests or a review status.

#79 links Inbox to the same exact #70 request/change in global Review, not a second review-state
store. Inbox attention and Review visibility are distinct: pending prerequisites remain visible in
Review even when no human action is available. This contract does not activate automatic attention.

**Identity and history.** Deduplicate by authoritative request lineage and exact target, not by
chat, task, file, capture or wake. Optional mission/chat context is not ownership. A selection or
request may cover several explicitly named changes; later revisions retain history, not approval.
Cross-project access is checked per target; an inaccessible one cannot silently disappear from a
submitted selection and thereby alter coverage.

| Event | Authoritative meaning |
| --- | --- |
| Required checks/agent review pending | Item remains visible; approval unavailable with reason; browse/comment possible |
| Prerequisites become current/passing | Human approval becomes actionable for that exact selected scope |
| New comparison captured | Historical selection/drafts stay pinned; capture alone creates neither a request nor fresh approval |
| Comment submitted | Feedback saved; required approval remains pending |
| Request changes submitted | Blocking outcome on selected revisions; next action belongs to responsible work |
| Approve submitted | Exact human disposition saved; other gates and unselected changes remain separate |
| User snoozes/withdraws | Attention suppressed/withdrawn with history; underlying gate stays unsatisfied |
| Authoritative cancellation makes a request obsolete | Eligible coordinator retirement records the actual cancellation, never waives user-required approval |
| Open/read/Viewed/Back | No request, review or gate mutation |

### Normal multiple-change and standalone example

Standalone Build chat **Improve search** has proven changes A (query parser) and B (ordering).
A shortcut to A1 opens A1 in global Review; no mission, coordinator or PR is invented. The user can
remove the visible chat filter and see pending C1 from **Billing**, a different accessible project,
in the same queue. Selecting A1+B1 for a disposition covers exactly those revisions, never C1 or A2.
The same change reached from Inbox or a coordinator link is the same target/history, not a duplicate.

If #70 says A1 is waiting on agent review while B1 is actionable, both remain visible. The user may
browse/comment on A1; cannot approve it yet. Approving B1 does not approve A1 merely because they
share a chat/request. Once both are actionable, an explicit A1+B1 selection may be submitted together;
its displayed targets are the scope. A later B2 preserves B1 drafts/history and needs current review.
Missing retained A1 shows Unavailable; missing waiting source never reads as zero pending items.
D53/#98 standalone creation-only capture is separate from waiting/request creation and review gates.

In a mission-linked chat with A and B, its coordinator can suggest “Please look at ordering” and
link directly to B1 in global Review, without mission Review or a worker-selector step. This optional
suggestion creates no required approval. If policy really requires A1+B1, #70 records that obligation
and human approval still waits for its required checks/agent reviews. The coordinator can report a
fix or retire its own optional suggestion, not resolve the human's thread or clear user-required
approval. Submitted feedback may route through the real coordinator, or to the standalone owning
chat where no coordinator exists; routing is not review ownership.

## The Review page

The selected structure is change-first: one global waiting list and the selected exact comparison,
with continuous full-file diffs. Keep the change title, meaningful state/warnings and next action
visible. Provenance, task/mission/worker links, full pins, reported evidence and optional walkthrough/
paths belong in disclosure, not a mandatory worker/task header or a technical metadata wall.

#60/#65 add explicit Submit review for the selected exact set. The confirmation shows its changes/
revisions, disposition and unmet prerequisites; it never targets “this chat” or unseen changes.
Multiple changes remain individually inspectable; grouping/filtering by project/chat is navigation
only, not inherited coverage. Layer and stack are distinct retained comparisons and keep separate
anchors/dispositions. No per-file viewed marker implies partial approval.

Code without a PR uses the same retained comparisons; integration remains separate. Research/plans
use exact local brief/artifact revisions when original bytes/kind/custody are supported, not an
invented diff, hash or PR. D55 selects that initial non-code domain, not a universal artifact viewer
or current review-write implementation. Missing historical kinds/bytes remain explicit gaps.

## Changed call paths (D29)

Between the summary and the diff, a compact **Changed paths** disclosure, collapsed when long:

- Roots are changed callables: added, removed, **body changed** (own source span bytes differ) or
  **relationship changed** (outgoing source call edges differ). A callable can be both; labels say which.
- Each root expands into caller and callee context. Added/removed edges are emphasized; unchanged
  callers are faint and never labeled modified because a callee changed. Unrelated branches stay
  collapsed as "+4 unchanged callers".
- Ambiguous and unresolved edges are explicit rows ("Unresolved call: dynamic dispatch"), never dropped.
- Selecting a frame scrolls the pinned diff to its exact before/after line (`scroll_to_line`).

Analysis must read both retained sides of the same snapshot. The session-only `call-changes` read
now supplies bounded retained TS/JS comparison; #55 is the separate native presentation consumer.
It must not reuse live `code_call_paths` output as retained evidence. State coverage ("TypeScript
only; 2 Rust files not analyzed", "Partial: graph limit"). This is source-inferred navigation, not a
runtime trace, complete impact or behavioral equivalence. It is optional: loading, failure or
absence never blocks or delays the raw diff.

## Diff and annotations

- **Modes.** Unified by default below a proposed 900pt pane width, Split available when wider. The
  user's choice persists as a view preference, never in review records.
- **Annotation kinds.** Summary (review-level), file (Kit file annotation, also for binary or
  omitted files), line, range (single side, or cross-side in unified patch order as Kit reports it).
- **Creation.** Pointer: Kit's add button. Keyboard: select with Shift-Up/Down in the focused diff,
  then **Return** opens the draft editor for that range. Proposed app bindings in a `ReviewDiff`
  context: Return (comment on selection), Option-Down/Up (next/previous change via Kit
  `next_change`), Cmd-Option-Down/Up (next/previous annotation), Cmd-Shift-Return (open Submit).
  Check for conflicts with existing app bindings before adoption.
- **Editor.** Kit `Input` inside the annotation slot with existing IME/preedit guards. Cmd-Return
  saves the draft; Escape closes, keeps unsaved text as a draft and restores diff focus and the
  original selection. Saving is disabled during preedit.
- **Focus order.** Header links → required action → findings → changed paths → subject list → diff
  body → annotations in document order → Submit. Focusing an annotation re-selects its range.
- **Visual distinction.** Human drafts (quiet "Draft" word), submitted human comments, agent findings
  (dimension + "Agent") and coordinator replies use words and existing tones, not color alone.

**Missing, partial and unsupported states.** All appear beside what they affect; none says "no changes".

| State | Shown as | Review actions |
| --- | --- | --- |
| No retained comparison yet | "Waiting for a retained comparison"; no diff | Not actionable in Inbox |
| Working-copy/unsaved source | "Unsaved edits weren't captured. Review the last committed revision." | Committed revision only; no HEAD substitution |
| Partial snapshot | Banner with omitted files and reasons ("2 MiB file limit") | Comment/request changes; Approve disabled with reason |
| Binary, mode-only, metadata-only | Kit summary row; mode/size/hash in details | File annotations |
| Symlink, submodule content | "Content not retained (symlink)" | File annotations |
| Conflicted jj comparison | "Conflicted changes aren't supported for review" | Not actionable |
| Retained read/hash failure | "Couldn't read retained content", never live fallback | File annotations; Approve disabled |
| Truncated Kit parse | "Part of this file's patch is missing" | Annotate visible lines only |
| Call-path analysis absent/partial | Notice inside Changed paths only | No effect on the diff |

## Drafts, submission and coordinator follow-up

- **Drafts** are private to the human, bound to an exact `snapshotId`, never visible to agents and
  never dispatch work (brief). Proposed store: daemon-side app-owned review store outside workspaces,
  so drafts survive app restarts and workspace deletion. Draft saves show failure beside the draft.
- **Submit** sends the selected exact targets' drafts, optional dimension ratings and a verdict
  (Comment, Request changes, Approve) as one durable operation with a stable operation ID. Reuse
  the native durable-operation ownership/receipt pattern, not the legacy Swift outbox names.
  The review handler/records remain #60/#65 work. States: Submitting → Submitted (receipt) | Rejected (explicit, drafts
  editable again) | **Unknown** (drafts locked, "Checking…" reconciles the same operation receipt).
  Unknown is never resubmitted with a new ID and never shown as Submitted.
- **Approval is gated by facts**, not hidden: it is unavailable for partial/unreadable comparisons,
  outdated revisions or withdrawn requests, with the reason shown. Required checks/agent reviews
  must pass. D54 purpose-specific native action, durable records and eventual gate consumers still
  need implementation; this document records neither feedback nor live approval.
- **Coordinator mediation.** A mission-linked submitted review creates one coordinator wake reason (#27's proposed
  durable reasons). The coordinator triages each thread: scoped follow-up assignment for the same or a
  fresh worker citing annotation IDs and the snapshot, an answer, a reasoned decline, or a user
  decision request. Workers never receive raw drafts and do not post in review threads; they answer
  with a new revision and evidence. For standalone chats, the explicit submission routes to the
  owning chat instead; no coordinator is invented. Human text is quoted with provenance.
- **Thread dispositions:** Open, Addressed in revision N (coordinator-asserted with evidence), Declined
  (coordinator reason; the human can reopen), Resolved by you, Outdated, Withdrawn by you. Only the
  human resolves their own thread; an approval on a later revision covers threads still open only when
  the human explicitly confirms them in the submit dialog.

## Durable annotation contract

Proposed record domain, append-only, in project-owned app storage outside workspaces; optional
mission context must not own or gate standalone reviews. Exact storage design belongs to #60:

```text
Anchor v1 =
  summary { requestId | subject }
  file    { snapshotId, side?: before|after, logicalPath, blobSha256? }
  lines   { snapshotId, startSide, start, endSide, end,           // one-based source lines
            logicalPath, beforeBlobSha256?, afterBlobSha256?,     // per side used
            excerptSha256,                                        // exact bytes of the anchored lines
            contextSha256: { before2, after2 } }                  // two lines each side, exact bytes
Annotation v1 = { annotationId, reviewId?, anchor, body, authorOrigin, createdAt,
                  supersedes?, state: draft|submitted|withdrawn }
```

- **Identity.** `annotationId` is stable for life and becomes the Kit `ElementId`. Lines split on
  `\n`, CR bytes kept. The host validates at save that the range exists in the retained blob and the
  digests match. `logicalPath` is the #20 manifest inventory key; the app keeps the mapping between
  manifest change records (including exact renames) and Kit `DiffFile::path`.
- **History survives deletion.** Anchors reference only retained snapshots, so workspace deletion,
  jj rewrites or object pruning never affect them. Edits append a superseding record; the original
  text and author remain. #8 cleanup must treat unsubmitted drafts as a warning to the user, not a
  reason to delete them.
- **Revision changes (reanchor-v1, deterministic and versioned).** Originals stay bound to their
  snapshot. A later revision shows a read-time projection labeled "From revision 1":
  1. Same side, same logical path (or manifest-exact rename) and identical blob hash → same lines.
  2. Blob changed: the excerpt bytes occur **exactly once** on that side and both context digests
     match there → moved to the new line numbers, labeled moved.
  3. Anything else → **Outdated**, listed in an Outdated disclosure with a link to the original revision.
  No fuzzy, whitespace-normalized or cross-file matching. Cross-side ranges carry only under rule 1.
  File annotations carry when the path or exact rename remains; summaries stay with their revision.
- **Layer versus stack.** The after side of a layer and a stack with the same head has identical
  blobs, so rule 1 shows after-side comments in both, labeled with the comparison they were made on.
  Before-side comments differ by base and normally do not carry.
- **Changes since revision N** (later stage): a derived view diffing two retained after-sides of the
  same subject, labeled as such. It never substitutes for the full comparison under review.
- **Authorship.** `authorOrigin` must come from host-admitted explicit user action, not payload
  fields, coordinator transcription or an agent claim. That primitive does not exist yet.

## Assessments and human ratings

- One row per dimension: Correctness, Security, Maintainability/Slop, Human attention. Each shows its
  latest result **for this revision** with execution state and outcome: Not assessed, Pending,
  Completed (Pass/Fail or Low/Medium/High attention), Failed to run, Timed out, Inconclusive,
  **Outdated** (exists for an earlier revision; link to it) or **Unavailable** (no profile, model or
  retained input). History per dimension is a disclosure listing exact revisions.
- No overall score, average or "safe" badge. Any Fail, unresolved blocking finding or High attention
  stays first. Repeated runs of one profile on one revision show as "3 runs, same profile and
  revision" and add no independence. Low attention never satisfies a required human review.
- #17 citations are UTF-8 byte ranges in retained text; Review converts them to line spans for display
  only, keeping the original citation.
- **Human ratings** are separate records in "Your review": per dimension No concerns / Concern / Not
  checked, with a reason and optional example annotations, plus "Would want to review similar changes"
  / "Fine to delegate similar changes". They never overwrite or merge with agent results. Marking an
  agent finding "Not an issue" requires a reason and stays a human opinion, not a dismissal record.

## Inputs proposed for preference learning (#12)

Only from **submitted** reviews, never drafts or opened items. Each input keeps provenance
(reviewer origin, review/annotation IDs, retained excerpt reference, project, mission, language,
path) and outcome (fixed in revision N, declined with reason, retracted).

- Annotations tagged with a dimension or a #17 Slop seed pattern, with the human's reason.
- Human ratings and "fine to delegate" answers, for calibrating review depth per intent (D12), never
  for automatic authority changes.
- Agent-finding feedback ("Not an issue here", "Missed this") as false-positive/miss calibration.
- Explicit "Remember for this project" on a comment → explicit preference candidate. Everything else
  is an inferred candidate needing confirmation. Default scope is the project; wider scope needs an
  explicit user action. Counterexamples and later retractions travel with the candidate.

## Existing APIs versus missing primitives

| Need | Exists | Missing (prerequisite, not designed away) |
| --- | --- | --- |
| Diff rendering, selection, line/file annotations | Kit 0.8.1 `Diff`/`DiffState` | Multi-range highlight; verify keyboard line cursor before adding a binding |
| Worker change inventory | #13 ledger and admitted project/session/mission retained discovery | Global change navigation (#88), authoritative waiting inventory (#70); capture discovery is not waiting state |
| Exact comparisons | #20 bounded retained reads and creation-only checkpoint for eligible mission builders | #98 standalone creation-only capture and #88 global consumer; no existing-chat enrollment on read |
| Submissions, judgement, allocation | #18, #22 dormant records | Transport; active acceptance (#19) |
| Agent assessments | #17 profiles/results and optional observed-agent producer | Restricted host reviewer, attributable execution and independence qualification |
| Human reviews/annotations | No installed submission | #60/#65 record domain and exact retry/lookup through #52's D54 native action, not verified human presence |
| Review requests and attention | Inbox loaded-summary view | Request records, attention source, lineage dedup, withdrawal authority |
| Submit delivery | Native immutable operation/receipt pattern (`interaction.rs`, `interaction_delivery.rs`) | Registered exact review handler, records and receipt reconciliation; existing handlers do not submit reviews |
| Coordinator follow-up | Proposed wake reasons (#27), escalation proposal | Durable reason lifecycle and dispositions |
| Gate effect of human approval | None | #5 policy activation and #19 gates; nothing here grants it |
| Call paths over snapshots | Session-only retained TS/JS `call-changes` read, with partial/unknown coverage | Native path presentation (#55), not runtime or complete-impact proof |

Lost acknowledgements of any write stay Unknown until exact reconciliation. No one-shot send,
comment, judgement or review is replayed under a new identity.

## Staged implementation

Consumer scopes for the selected D54–D57 policy, not new scaffolding milestones or activation:

1. **#88 global read surface:** replace Changes, remove mission Review, preserve Files/artifacts,
   full-file diffs and exact selection; consume #70 waiting state without capture-as-request inference.
2. **#60/#65 submission:** change/revision-centered private drafts, exact selected dispositions,
   #52 native assurance, durable lookup and annotations/submit in global Review. No approval carry-forward.
3. **#70/#79 requests and links:** #70 persists authoritative waiting/request lineage, D57 permissions
   and actionability; #79 links Inbox there with preserved Back state, not duplicate review state.
   These dependency scopes do not activate attention or gates.

Reanchor details and keyboard conflict audit are implementation details within #60/#65. Changed paths,
learning and visual polish remain their existing separate tasks, not prerequisites added here.

**Native acceptance probes** (production root, hidden 680/1100 windows, light and dark, faux daemon):
open from Inbox to the exact revision; pointer and keyboard range selection → draft → restart →
draft restored; synthetic preedit blocks save; submit with lost ACK → Unknown → receipt → Submitted;
new revision with same/moved/outdated anchors; layer/stack switch; partial, binary, unavailable and
conflicted subjects; withdrawn request; 4,096-path/4 MiB patch subject within bounded memory without
stalling input; accessible names on rows, findings and annotations. Synthetic probes are not OS
IME, accessibility, smoothness or performance acceptance; visible measurement needs user approval.

## Qualification gaps, not reopened policy

D54–D57 close assurance/consent/global placement/timing/disposition policy. #52 native admission,
#60/#65 human records/submission, #70 authoritative waiting state and #79 Inbox linking still need
implementation/qualification. #88 must not use capture discovery as proof of pending state or
require mission-owned navigation. #98 creation-only standalone capture advances independently.
No old mock, D48 default, historical proposal link or handoff 23368 proves current acceptance.

Source check: `cc51bb4af2ddc094618a9e8fb3514891705f76d9`,
`packages/daemon/src/server.ts:1447-1620` exposes project/session/mission retained GETs, not
human dispositions or an authoritative waiting queue.
`apps/desktop/src/mission_browser_view.rs:1827-1830` still exposes historical mission Review;
`workspace_changes_view.rs` is a live inspector,
not retained Review. `packages/protocol/src/critical-review.ts:1-3` separates critical review from
chat read marks. The D56 replacement is #88's implementation scope, not claimed shipped here.
No UI artifact was produced: this is selected-contract documentation, not new UI or acceptance
of the old visual mock.
