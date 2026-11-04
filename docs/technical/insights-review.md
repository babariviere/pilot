# Bounded review orchestration (internal)

## Status

Trusted host seam and synthetic verification only. This change does not expose routes, create a
grant, activate a weekly schedule, read private histories, run a selected provider or authorize fixes.
Native setup/lifecycle confirmation and schedule dispatch are separate integrations. Read the
[history and backlog boundary](insights-history.md) first.

## Dispatch contract

`SessionManager.dispatchInsightsReview(reportSessionId, request)` accepts an existing enabled,
currently admitted Insights chat, never a generic chat or model-supplied grant. `request` contains:

- `runId`: a fresh lowercase UUID reserved by the trusted caller for this attempt.
- `windowStart`, `windowEnd`: ordered ISO date/time strings. They label review context, not a
  since/until query or a certified coverage interval.
- `bounds`: `inventoryPages` 1–4, `historyPages` 2–8, `entriesPerPage` 1–20. Actual discovery and
  history reads return at most four rows/entries each, and remain subject to the reader's scan and
  byte limits. Boundary probes count against the history-page budget.

Reservation closes overlap synchronously before durability. Another active run conflicts. An exact
existing run ID with identical payload/binding is **status lookup only**, never another input send.
Changed payloads conflict. `insightsReviewStatus(reportSessionId, runId)` is the passive lookup seam;
it rechecks admission and waits for durability. No source worker is started.

States: `preparing` -> `ready` -> `sent` -> `partial`. `sent` is input placement only. `partial`
means one bounded report and host positions were persisted atomically, not comprehensive review,
delivery, approval or verified benefit. Failure before placement becomes `interrupted`; uncertain
placement becomes `unknown`. Stop/revocation mark active runs `cancelled`; shutdown and startup
recovery mark active runs `interrupted`. Terminal states never automatically replay. Do not map
scheduler sent/started to report completion, or reuse a terminal run ID for a retry. A distinct,
separately admitted run carries unfinished source positions and exposes unresolved old windows.

Input uses persisted `insights-review:<runId>` with idle-only placement. Delivery rechecks active
state, so queued input cannot replay after Stop, uncertainty or restart. A private metadata fence
blocks direct `insights_history` reads during the bounded turn, including after worker/daemon
restart. Only a subsequent explicit input ends that turn fence. Stop reaches the kernel before
waiting for terminal durability; its ACK still waits for that durability. Revocation closes future
admission, not an already-admitted model turn or already-disclosed text.

## Durable source context

`missions.sqlite` retains run reservations, prepared sanitized packets, inventory continuation,
source queue/positions, normalized pattern identities and context-access receipts. Startup recovery
runs before the in-memory replica opens. There are no separate receipt files or timestamp-only
watermarks. Source inventory is mutable and local, not an atomic cross-project snapshot.

Discovery queues source IDs before report generation. Finish advances inventory and source
positions in the report transaction only. Failed/interrupted reports leave positions unconsumed.
Unvisited and unavailable sources rotate through the queue, so one offline source does not starve
other queued chats. An unfinished newest-to-oldest sweep continues in a later run rather than
resetting at the requested weekly boundary; newer activity may be deferred until that sweep ends.

The host validates qualified reader targets, entry refs/order, exclusive cursors and bounds.
Continuation with an anchor first probes that prior boundary and its excerpt hash. Changed
stream/boundary resets to newest with an explicit gap; unknown identity and unavailable/partial
envelopes retain the unfinished position. Scan-only pages can advance within a known stream.
`conversation:<id>` is a reader stream label, **not storage-incarnation proof**. An identical
replacement with the same label/anchor cannot be distinguished. Truncated excerpts stay unreviewed
and disclosed even when their surrounding page advances. Persistently truncated envelopes can
prevent a source or inventory page from advancing; this is a visible gap, not evidence of absence.

`insights_backlog({action: "review_context", cursor})` returns one excerpt part per call, its
reader receipt, gaps, prior-report references, queued-source count and unresolved-run summary.
Follow `nextCursor` to exhaustion. Split parts preserve original page metadata, so
`pagination.returned` describes the original reader page, not the single displayed excerpt.
All parts must be accessed before saving the exact run-key report. Access receipts prove neither
semantic inspection nor delivery. Direct artifact/source/attachment inspection remains unavailable.

## Report and finding discipline

The restricted prompt ranks repeated corrections, failures, workarounds and UI/artifact/workflow
friction by observed impact/recurrence. It requires citations, affected projects, distinct
observation/inference/proposal, uncertainty, prior-finding progress and coverage limits. Repository
guardrail state is unknown without admitted evidence. Cost proposals distinguish measured,
estimated and unknown baselines, assumptions, quality/safety trade-offs and later verification.
No monetary saving is invented from transcript repetition alone.

Authors page previous findings with list/get/evidence, then amend recurring patterns. During an
active review, writes require a stable target/mechanism `patternKey`, not a run/week identifier.
Whitespace/case normalization and mission-scoped uniqueness reject a new UUID for the same label,
returning the existing key. Finding `get` returns its normalized `patternKey` for reuse in later runs.
The identity is immutable once assigned. Semantic equivalence across
different labels still needs reviewer judgement; matching labels do not certify a real pattern.

Save one `partial` report under the exact run ID, with the dispatched window and revision zero.
Host-derived checkpoints and a coverage appendix replace completion claims and preserve limitations.
Report/finding operation receipts remain lookup-only evidence of persistence after lost ACKs.
Shipped stays distinct from Verified. Nothing approves changes, starts implementation, edits source
chats/AGENTS.md/checks or changes models, budgets, grants or schedules.

## Synthetic checks and limits

`insights-review.test.ts` covers multi-run cursors, boundary probes, empty scan pages, unknown streams,
partial/unavailable reads, inventory carryover, queue rotation, restart, exact identity, normalized
pattern reuse, bounded output and invalid receipts. `sessions.test.ts` covers idle-only dispatch,
overlap, Stop/revocation during preparation, held cancellation durability, lost placement ACKs and
the persisted read fence. Kernel role tests check the report rubric and closed tool profile.
These tests use synthetic data/faux workers, not private histories or live provider processing.
They do not certify report quality, end-to-end schedule/native delivery or realized benefit.

The reconciled 13-file Node selection passed 451/452 tests. Its sole failure, `a new execution drain
is busy even during a reentrant idle worker factory notification`, also fails on extracted parent
`b36cc011`. Subsequent review/backlog checks pass 16/16 and Insights session checks pass 28/28,
including the added changed-boundary and automatic-input fence cases. Typecheck passed before
reconciliation; concurrent upstream `18f11df9` adds a type error at `workspace-setup-manual.test.ts:87`
(undefined assertion predicate), outside these edits. Scoped Biome checks pass (existing shared-file
warnings/schema-version notice remain). No local Swift/native
build, production performance benchmark or live model review is claimed.
