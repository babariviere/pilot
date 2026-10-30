# Proposed native Review and durable diff annotations

**The read-only slice described below is implemented for apps/desktop (D33). The remaining
review/annotation/request contracts are design proposals, not active behavior.** The coordinator owns planning and adoption. Nothing here starts
captures, creates Inbox attention, records reviews, consumes gates, merges, cleans up or migrates
missions. Swift is out of scope (D2). D33 authorizes the bounded Sol/Terra read-only implementation;
later Opus refinement remains separate.

## Implemented read-only slice

Mission detail has **Overview / Tasks / Review**. Review is mission-scoped browsing, not a required
queue or an Inbox attention source. Choose a current worker, then one exact retained comparison.
The choice includes the full jj subject, immutable head/base revisions and `layer` versus `stack`;
Exact revision details exposes repository, snapshot, operation and creation IDs. A refresh keeps the
chosen comparison, including when a newer comparison is listed. Switching worker, mission or host
clears previously admitted content and fences/cancels obsolete reads. Escape returns from
retained source to the diff, then to Overview. Source's Back control returns to the diff; existing
navigation history is unchanged. Native Selects retain their keyboard and query focus;
Kit Diff owns selection/copy/navigation, with Option-Up/Down for previous/next change.

The summary distinguishes proven worker creation, enrollment task scope and historical task purpose
(Unknown). Optional agent dimensions and reported evidence load only on explicit disclosure, after
raw diff. Their exact profiles and task intent are displayed separately, never as an overall score.
The default view is intentionally only worker, selected comparison and diff controls. Provenance,
full IDs, analysis limits, evidence and source inspection are disclosed in **Details**, not persistent
status prose. Actual partial/unavailable/error warnings remain visible. Comparison choices use
human-readable layer/stack and capture labels; exact base/head identities remain in Details.
Recorded outcomes remain **Unavailable** for current applicability unless structurally **Outdated**:
this reader does not re-resolve arbitrary context, attest producing agents, or prove independence,
checks, acceptance or live-source freshness. A selected allocation is assessment scope only, not final
acceptance or original task purpose. No human rating, annotation, approval or submit control exists.
Changed paths explicitly remains Unavailable until retained-input analysis exists.

The diff is the existing virtualized Kit 0.8.1 `Diff`, not the live Changes renderer. Unified/Split,
file navigation and Before/After source all refer to the same retained comparison. Source previews
are capped at64 KiB with an explicit incomplete-preview notice; source reads remain bounded to2 MiB.
Binary/unsupported sides are not decoded as text. Missing patches, partial manifests, unsafe paths,
hash/length failures, unsupported/conflicted/truncated Kit input and patch/inventory disagreements
are explicit, never clean or Pass. Kit cannot reconstruct absent context; full source never comes
from the workspace, HEAD, another layer or the top of the stack. An empty store explains that no
capture/enrollment/migration has occurred. No synthetic fixture data enters production reads.

### Local transport and admission

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
Capture and record-write APIs remain host-only/dormant, with no new trigger or agent tool.

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
These probes are not OS IME, performance, screen-reader or accessibility acceptance, and install
nothing. Human review writes, capture policy, attention, active gates, cleanup and Opus refinement
remain separate work.

## Remaining design proposal

Binding inputs: D14 (dedicated Review, per-worker jj changes, native annotations), D15 (Inbox
integration), D29 (summary → changed static call paths → exact pinned diff), D31 (later coordinator
allocation is selected assessment scope, not original task purpose), D18/D19 (Balanced tiers, force
OFF, checks never waived) and D32 (this design start). Foundations reused: [jj ownership](jj-ownership.md)
(#13), [retained snapshots](review-snapshots.md) (#20), [delivery evidence](delivery-evidence.md) (#18),
[review records](mission-review-records.md) (#17), [contribution allocation](contribution-allocation.md)
(#22), the [authority/review policy proposal](mission-authority-review-policy.md) (#5), the
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
| `src/workspace_changes_view.rs` | Live `GET /api/sessions/:id/changes` inspector. Renders each file as `SelectableText` literal patch, **not Kit Diff**. "Open file" reads the live workspace. No annotations | Not a Review base. Reuse only its bounded reader, cancellation and honest unavailable copy. Never reuse live "Open file" in Review |
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
- **Review request:** a coordinator- or policy-created requirement for human review of an exact set
  of comparisons tied to exact submissions (and, once recorded, a #22 allocation). It creates attention.
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

**Recommendation: Needs review in Inbox is the primary entry for required human review.** The
"Review tab" of D14 is a dedicated main-pane page, `Page::Review(ReviewTarget)`, opened by exact
deep link. A mission-detail **Review** section lists that mission's subjects for browsing.

Evaluation of Needs review as the primary entry:

- For: one attention place (brief: Inbox with Needs review, Needs decision, Needs your help), the
  existing "opening is not reviewing" contract, project filter and keyboard paths already exist, and
  required review never competes with a second mandatory queue.
- Against: a flat list loses mission/task context and makes several related changes feel like
  separate chores. Mitigation: one item per review request (not per change or revision), the item
  opens the full Review page, and Review offers "Next review" to continue without returning.
- Not chosen: a top-level Review sidebar destination with its own counts. It would duplicate Inbox
  attention and invite a second required queue. An optional project-wide "All changes" browser may
  come later as browse-only, without counts or dots.

Proposed defaults (open for coordinator/user choice): Inbox Needs review spans all projects like the
current Inbox, honoring its project filter; mission Review lists current revisions of that mission
only, with "Show completed" off.

## Inbox integration

**Attention trigger.** Only a human-required review creates Needs review: effective tier T3, or an
explicit authorized mission/tier override requiring human review. Optional agent reviews and
coordinator curiosity do not. Proposed: the item becomes actionable once the request's ordered
prerequisites hold (complete retained comparison for every selected subject, plus any checks or agent
reviews the policy orders before human review). Before that it appears only in mission Review as
"Waiting for agent review", not in Inbox. Whether humans may review in parallel is an open choice.

**Identity and deduplication.** Key items by `reviewLineageId`: the first request for a task's
human review; re-requests after changes extend the lineage. One live item per lineage, whatever the
number of changes, revisions or wake notices. Several tasks sharing a contribution create one request
under the strictest tier, listing all tasks (never the most convenient one).

**Lifecycle.** Opening, scrolling or marking files viewed never changes it.

| Event | Inbox item | Drafts |
| --- | --- | --- |
| Request becomes actionable | Needs review: "Review revision 2 · 3 changes" | n/a |
| New revision captured while open | Stays, reason becomes "Revised: revision 3" | Kept on revision 2, carry-forward offered (below) |
| Review submitted for current revision | Leaves Needs review; history shows verdict | Become part of the submitted review |
| Request changes, then re-request | Returns under same lineage: "Revised after your review" | Prior review stays read-only history |
| Withdrawn by coordinator (dropped, reassigned, rescoped) | Leaves with "Withdrawn: reason" in history | Kept, labeled not submitted; may be submitted as non-gate feedback |
| Task completed or superseded elsewhere | Resolves only on the authoritative record, never on open | Same as withdrawn |

**Acknowledgement versus approval.** "Viewed" file marks and "Seen" are private progress. They
reset for files that change in a new revision. Approval is only the explicit submitted verdict
"Approve revision N" on the exact request. Neither is coordinator acceptance or merge authority.

**Filters.** Reuse the Inbox project filter; add an optional mission filter and kind filter (All,
Needs review, Needs decision, Needs help) sharing the same records. An active filter stays visible;
section counts describe the filtered set and say so.

**Exact deep links.** `ReviewTarget { missionId, requestId?, repositoryId, changeId, snapshotId,
anchor? }` with `anchor` either an annotation ID or `{side, path, line}`. A link opens that exact
revision. If newer revisions exist it shows "Revision 3 is newer" with a switch action, never a silent
redirect. Unauthorized or missing targets show Unavailable with the retained text, no guessing.
Links reuse the existing exact-ID link guard and navigation history.

## The Review page

Reading order follows the task's requirement: intent, worker/task and exact comparison, evidence and
gates, findings and required action, then call paths and the diff. One primary action: **Submit
review**. Everything else is quiet or disclosed.

1. **Header.** Assignment intent (one line from the frozen assignment), task link(s), worker chat link,
   effective tier and why human review is required. Comparison line: "Revision 2 · This change vs
   parent" or "Stack vs trunk @ 3f2a…", with the full IDs in a details disclosure.
2. **Provenance.** "Created by Worker A (proven)" from #13. Task purpose: "Allocated to #14 by
   coordinator (selected scope)" when a #22 record is current, otherwise "Task: Unknown". Never
   "made for #14". Enrollment scope appears only in details as assignment scope at start.
   An allocation covers only its selected contributions; it is not an inventory of the worker's
   changes. Other owned changes stay listed separately and are never implied reviewed or covered.
3. **Evidence and gates.** One compact list, each row with its layer and revision: checks (reported
   versus observed, observed currently Unavailable), agent reviews per dimension, human review (this
   request), coordinator acceptance (Not recorded / Accepted revision N / Outdated) and integration
   (Unavailable until observers exist). Unknown, pending, skipped, stale or missing never reads as passing.
4. **Findings and required action.** "You need to: review 3 changes in revision 2. 1 blocking finding."
   Blocking findings first, then by dimension; each links to its exact anchor and shows its status.

**Multiple changes.** A subject rail (wide) or a Select (narrow, 680pt) groups changes by worker chat
in stack order, parent first. Each row: first description line, short change ID (full in tooltip and
details), its revision and review state. Per subject a segmented choice selects **This change**
(layer) or **Stack** when both are retained. Each is its own snapshot; annotations stay with the one
they were made on. Approval covers the request's whole comparison set; per-subject marks are progress.

**Work without PRs.** Code delivered without a PR is reviewed identically from snapshots; integration
is a separate row. Non-code deliveries show the pinned artifact/report/brief revision in the existing
artifact viewer with summary and artifact-level annotations, plus non-code evidence. No PR, hash or
diff is invented for them.

## Changed call paths (D29)

Between the summary and the diff, a compact **Changed paths** disclosure, collapsed when long:

- Roots are changed callables: added, removed, **body changed** (own source span bytes differ) or
  **relationship changed** (outgoing source call edges differ). A callable can be both; labels say which.
- Each root expands into caller and callee context. Added/removed edges are emphasized; unchanged
  callers are faint and never labeled modified because a callee changed. Unrelated branches stay
  collapsed as "+4 unchanged callers".
- Ambiguous and unresolved edges are explicit rows ("Unresolved call: dynamic dispatch"), never dropped.
- Selecting a frame scrolls the pinned diff to its exact before/after line (`scroll_to_line`).

Analysis must read both retained sides of the same snapshot. Today `code_call_paths` reads live
workspaces or an Ask-pinned commit and supports TS/JS only, so snapshot-sourced analysis is a #21
prerequisite. The section states coverage ("TypeScript only; 2 Rust files not analyzed", "Partial:
graph limit"). It is source-inferred navigation, not a runtime trace, complete impact or behavioral
equivalence. It is optional: loading, failure or absence never blocks or delays the raw diff.

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
- **Submit** sends all current drafts, optional dimension ratings and a verdict (Comment, Request
  changes, Approve revision N) as one durable operation through `OperationOutbox`/`HostClients.deliver`
  with a stable operation ID. States: Submitting → Submitted (receipt) | Rejected (explicit, drafts
  editable again) | **Unknown** (drafts locked, "Checking…" reconciles the same operation receipt).
  Unknown is never resubmitted with a new ID and never shown as Submitted.
- **Approval is gated by facts**, not hidden: it is unavailable for partial/unreadable comparisons,
  outdated revisions or withdrawn requests, with the reason shown. Gate effect needs the missing
  trusted human-origin primitive (below); until then it records feedback only.
- **Coordinator mediation.** A submitted review creates one coordinator wake reason (#27's proposed
  durable reasons). The coordinator triages each thread: scoped follow-up assignment for the same or a
  fresh worker citing annotation IDs and the snapshot, an answer, a reasoned decline, or a user
  decision request. Workers never receive raw drafts and do not post in review threads; they answer
  with a new revision and evidence. Human text forwarded to workers is quoted with provenance.
- **Thread dispositions:** Open, Addressed in revision N (coordinator-asserted with evidence), Declined
  (coordinator reason; the human can reopen), Resolved by you, Outdated, Withdrawn by you. Only the
  human resolves their own thread; an approval on a later revision covers threads still open only when
  the human explicitly confirms them in the submit dialog.

## Durable annotation contract

Proposed record domain, append-only, in the daemon's app-owned storage beside mission records:

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
| Worker change inventory | #13 internal ledger reads | Admitted read transport; per-mission subject listing |
| Exact comparisons | #20 `capture/get/read/diff` | Capture trigger policy (proposed: on worker submission), admitted reads, paging for large manifests |
| Submissions, judgement, allocation | #18, #22 dormant records | Transport; active acceptance (#19) |
| Agent assessments | #17 profiles/results | Reviewer execution, observed producer, **independence proof** |
| Human reviews/annotations | None | Record domain, **trusted human-origin authorship**, exact retry/lookup |
| Review requests and attention | Inbox loaded-summary view | Request records, attention source, lineage dedup, withdrawal authority |
| Submit delivery | `OperationOutbox`, durable journal | Registered idempotent review handler and receipt reconciliation |
| Coordinator follow-up | Proposed wake reasons (#27), escalation proposal | Durable reason lifecycle and dispositions |
| Gate effect of human approval | None | #5 policy activation and #19 gates; nothing here grants it |
| Call paths over snapshots | `code_call_paths` (live/Ask, TS/JS) | Snapshot-sourced analysis, body/edge diffing (#21) |

Lost acknowledgements of any write stay Unknown until exact reconciliation. No one-shot send,
comment, judgement or review is replayed under a new identity.

## Staged implementation

Foundations precede consumers; each slice is separately verified and published.

1. **R0 read transport (non-UI).** Admitted, bounded GETs for mission subjects (#13), snapshot
   manifest/patch/blob (#20) and #17/#18/#22 records, with session/project/membership checks.
2. **R1 read-only Review (Opus).** `Page::Review`, mission Review section, deep links, header,
   evidence/gates, assessments, Kit Diff of retained patches, every state in the table above.
3. **R2 human review records (non-UI).** Drafts, annotations, submitted reviews, trusted user origin,
   exact retry/lookup, durability before ACK.
4. **R3 annotate and submit (Opus).** Kit annotations, editor, keyboard, submit with Unknown handling.
5. **R4 requests and Inbox (both).** Request records, Needs review projection, lineage dedup,
   withdrawal/completion, coordinator wake on submission and thread dispositions.
6. **R5 revisions.** reanchor-v1 projection, Outdated disclosure, optional changes-since view.
7. **R6 changed paths (after #21 snapshot analysis).** D29 section; diff unaffected when absent.
8. **R7 learning inputs (#12)** and, only with #5/#19 activation, gate consumption of approvals.

**Native acceptance probes** (production root, hidden 680/1100 windows, light and dark, faux daemon):
open from Inbox to the exact revision; pointer and keyboard range selection → draft → restart →
draft restored; synthetic preedit blocks save; submit with lost ACK → Unknown → receipt → Submitted;
new revision with same/moved/outdated anchors; layer/stack switch; partial, binary, unavailable and
conflicted subjects; withdrawn request; 4,096-path/4 MiB patch subject within bounded memory without
stalling input; accessible names on rows, findings and annotations. Synthetic probes are not OS
IME, accessibility, smoothness or performance acceptance; visible measurement needs user approval.

## Open choices for the coordinator

1. Placement: confirm Inbox Needs review as primary entry plus mission Review section, and whether a
   browse-only project-wide All changes view is wanted.
2. Default filters: all projects (current Inbox) versus current mission when opened from a mission.
3. Ordering: human review after required agent reviews/checks (recommended) or in parallel.
4. Draft storage: daemon-side private store (recommended) versus desktop-local.
5. Approval coverage: whole request (recommended) versus per subject.
6. Who may withdraw a request (coordinator only, recommended) and whether humans can snooze items.
7. reanchor-v1 context size (two lines proposed) and whether moved comments need human confirmation.
8. Trusted human-origin action and independence standards (shared with #5/#2), required before any
   approval has gate effect.
9. Keyboard bindings after a conflict audit against existing app shortcuts.
