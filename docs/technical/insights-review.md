# Bounded review orchestration (internal)

## Status

Trusted host seam, recurring fixed-chat dispatch and synthetic verification only. No real grant,
weekly schedule, private-history read, selected-provider review or fix is activated by this code.
Native setup/lifecycle confirmation is described separately. Read the
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

## Recurring schedule integration

Existing native recurring **Send to a chat** rules targeting an Insights chat use
`dispatchInsightsReview`, never generic `send`. No new target kind or schedule editor is required.
The saved message remains editable but is not forwarded as review instructions; the host's bounded
review prompt governs the turn. One-time messages remain ordinary follow-ups, not review dispatches.
The host records the fixed session/project/mission intent when a rule is created or first dispatched;
same-chat edits cannot silently downgrade it. Admission still comes from the current private grant,
not the rule, its stored intent or its text. Missing/revoked/moved authority fails without fallback.

The existing occurrence CAS reserves `insightsReview: {sessionId, request}` before effects.
Each attempt has a fresh UUID; the dates label the previous scheduled occurrence through this due
time, not actual coverage. Conservative code bounds are one inventory page, two history pages and
four entries per page. These are ceilings for synthetic integration, not approval of real activation
or a cost budget. Confirm timing, selected model and coverage/cost settings separately before enabling
a real weekly rule. Larger or configurable bounds need a separate change.

The ten-entry run history retains `{runId,state}`. Restart repairs an interrupted claim into the usual
failed occurrence with that exact identity. After SessionManager loads, the scheduler performs only
passive `insightsReviewStatus` lookup, including after a lost dispatch ACK. Absence or refused lookup
stays `unresolved`, visible as failure, never permission to send again. Terminal interrupted,
cancelled and unknown states likewise become ordinary schedule failure notices. `sent` retains its
placement-only meaning; `partial` resolves only bounded persistence, never complete review or delivery.
An idle chat with placed input but no persisted report is unresolved, not successful completion.

Durable report/Stop/revocation changes and report-chat idle events wake passive reconciliation,
including while scheduling is disabled, paused or offline. No polling or source subscriptions are
added. Newer notices are not overwritten, and dismissed failures do not reappear unchanged. Existing
working-chat overlap skips, network/power gates, recurrence coalescing, missed periods, late markers,
pause/resume and host capability/CAS semantics are unchanged. Late review information stays in
schedule run/Inbox metadata rather than modifying the restricted review prompt. A future distinct
occurrence may review unfinished source positions; it does not resolve the old run or its window.

`schedules-insights.test.ts` checks the scheduler seam with synthetic clocks and durable schedule
storage: identity reservation, restart, terminal lookup, lost ACKs, denied/different bindings,
pause/disable, overlap skips, late/missed/coalesced runs and dismissal. `sessions.test.ts` also exercises
a real admitted fixed-chat schedule against the restricted worker and MissionStore: bounded evidence,
partial report persistence, exact mission binding, Stop and daemon reload without source wake/replay.
Kernel role tests separately verify the closed tool list. None is live weekly activation or semantic
review-quality/benefit verification.

The schedule regression selection also exposes two pre-existing creation-contract failures at
`schedules-create-contract.test.ts:206,235`: cached rows contain `recurrence: undefined`, whereas HTTP
JSON omits it. Both reproduce when loading the exact parent `schedules.ts` from `4a95d13c`; those
unrelated assertions and the known session idle-drain/typecheck failures below remain unchanged.
The reconciled 16-file scheduler/review/kernel Node selection passed 297/300, with only those three
baseline failures. All new scheduler and admitted-review cases passed. Scoped Biome and whitespace
checks passed; typecheck still reports only `workspace-setup-manual.test.ts:87`. No native UI change,
production performance measurement, private-history access or live recurring activation is claimed.

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
During an active dispatched review, another report key is rejected before any report or receipt
commits. Outside dispatched reviews, legacy model-authored report records remain claims only.
Host-derived checkpoints and a coverage appendix replace completion claims and preserve limitations.
Report/finding operation receipts remain lookup-only evidence of persistence after lost ACKs.
Shipped stays distinct from Verified. Nothing approves changes, starts implementation, edits source
chats/AGENTS.md/checks or changes models, budgets, grants or schedules.

## Synthetic checks and limits

### Integrated daemon/security review (2026-11-04)

These are isolated synthetic checks, not activation. The native layout is being revised separately;
the earlier access-dialog probe is evidence for that earlier surface, not final Tasks-tab acceptance.
No real grant, private-history access, provider turn or recurring activation was used.

| Boundary | Evidence and result |
| --- | --- |
| Source admission | Insights cases in `sessions.test.ts`: cross-project and archived discovery, real committed synthetic cold storage, credential/reasoning/attachment withholding, missing storage, bounds, cancellation and no source wake or writes. Supervised identity, exact mission, membership/project/host/worker replacement and revocation are rechecked before disclosure. |
| Closed capabilities | `insights-role.integration.test.ts`: hostile project/personal extensions and context do not load; spoofed tools cannot replace the closed history/backlog tools; reload retains restrictions. Malformed starts fail before storage opens. Ordinary workers and forged IPC remain denied in session tests. |
| Native authority | Native HTTP cases in `sessions.test.ts`: explicit capability required before operation reservation, versioned disclosure and exact setup target/model, stable same-operation receipts, changed-payload conflicts, lifecycle CAS, passive GETs/receipt lookup and no worker start from decisions. A recovery call after a committed effect returns its receipt, not a second effect. Missing receipts remain Unknown. This checks the daemon API, not an actual user's confirmation. |
| Two cycles | The admitted weekly-schedule session test drives context/findings/report calls through synthetic worker IPC, then reloads the manager and schedules. Both reports survive; the second cycle probes the saved boundary and continues below the exclusive cursor instead of starting the old sweep over. It amends two stable findings and retains Shipped separately from Verified. Store-level review tests additionally close/reopen `missions.sqlite`. |
| Proposals, not authority | The two-cycle fixture proposes another project's `AGENTS.md`/check/tooling change and a separate tool-economy change. Only the admitted backlog gets tasks; the foreign backlog stays untouched, generic mission calls stay unused and no source worker starts. Unknown baseline/pricing/later benefit remain unknown. A conditional call-count estimate is not measured or monetary savings. |
| Report identity | Review tests reject the wrong run key and window without committing an effect receipt; all prepared parts must be accessed. Model `completed` is replaced by host `partial`; access/persistence is not semantic review or delivery proof. The wrong-key assertion reproduced a bypass before its bounded fix. |
| Restart/uncertainty | Review, backlog, session, scheduler and operation-journal tests cover durable positions/receipts, Stop/revocation, lost input ACKs, passive exact-ID lookup, terminal no-replay, changed immutable identities, overlap, pause/disable, coalesced/late/missed runs, unavailable destinations and failure dismissal. A future occurrence is distinct, not recovery proof for an old window. |

Run the focused Node files explicitly (two per invocation, `--test-concurrency=2`,
`--test-force-exit`); `pnpm test file.ts` does **not** select that file. Unset inherited `PILOT_*`
variables. The relevant selections are:

- `insights-review.test.ts` + `insights-backlog.test.ts` in `packages/daemon/src`.
- `schedules-insights.test.ts` + `schedules.test.ts` in `packages/daemon/src`.
- `insights-role.integration.test.ts` + `diagnostics-role.integration.test.ts` in `packages/kernel/src`.
- `diagnostic-context.test.ts` + `operation-journal.test.ts` in `packages/daemon/src`.
- `node --test --test-force-exit --test-name-pattern='Insights|insights' packages/daemon/src/sessions.test.ts`.

These five selections passed 97/97 tests (17 store/review, 34 scheduler, 3 kernel-role,
12 reader/journal, 31 Insights session/API cases). Scoped Biome and whitespace checks pass.
Native Tasks-tab acceptance and final user-facing guidance remain pending separately.

Current-main baseline checks remain separate from feature-only passes. Typecheck fails at
`workspace-setup-manual.test.ts:87` (undefined assertion predicate); the session reentrant idle-drain
assertion still fails. Schedule HTTP/passive/creation-contract fixtures currently fail earlier at
`server.ts:2544`: their old SessionManager fakes omit `piReload.onChange`. This reproduces before
these verification edits and masks the previously reproduced cached `recurrence: undefined` versus
HTTP omission failures. The assertions and unrelated fixtures are unchanged. Desktop registration
also fails for `insights` plus six unrelated targets; the Insights portion is routed to native UI
ownership. Scoped Biome reports the existing schema-version notice. These are not green full-suite
or runtime-security claims.

Coverage remains bounded: scheduled dispatch uses one inventory page, two history pages and four
entries per page. Inventory is mutable; boundary/stream receipts are not storage-incarnation proof;
old sweeps can defer new activity; truncated/offline/partial content and unresolved windows stay gaps.
Artifact source/rendering and attachment bodies are not inspected. Redaction cannot guarantee all
sensitive business text is removed. No synthetic fixture establishes live report quality, OS input,
IME, VoiceOver, real-account/provider processing, production performance or realized benefit.

### Earlier implementation checks

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
