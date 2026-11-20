# Day Insights native handoff

The native window owns the operation envelope. `prepare` returns a short-lived,
single-use token, and `confirm` accepts no other argument. Rust journals the
frozen envelope and reserves space for its terminal decision before sending.
Check uses only that saved envelope at the receipt endpoint. A server-reported
uncertainty without this window's journal record blocks new effects without
offering a fabricated Check.

- `day.insights.prepare` returns `snapshot: null` and a fixed local `reason`
  for recognized daemon refusals. It issues no token and clears the earlier
  review, if any. The daemon only returns allowlisted reason codes, and Rust
  never displays backend text verbatim. Unknown reasons retain the generic notice.
- `day.insights.models { binding, projectId }` returns a snapshot of
  `{ projectId, models }` for that exact project. The main snapshot keeps
  `models: []`; it does not guess a catalog from window focus.
- `day.insights.history { binding, cursor }` returns the same passive legacy
  projection as `snapshot.legacy`. Keep the opaque `nextCursor` until it is
  null. Merge pages by key. A page may have no rows for the current tab and
  still have a next page.
- The main snapshot projects `executionProjectId`, `running`, and `nextAt`
  as nullable fields. It exposes USD allowance only when both amounts are
  known. Zero is a known amount, not a substitute for missing data.
- `SavedView.insightsDraft` is optional JSON text. It keeps incomplete local
  settings but no token or operation. Draft identity includes home, project,
  saved and applied settings, and a dedicated `settingsRevision` if supplied.
  Without that revision, re-saving identical settings keeps the same binding;
  pause, run, and notice-only changes do not invalidate drafts.
- Returns use `snapshot`, `pending: [{ id }]` on Read/Confirm/Check, and a
  sanitized operation `outcome.state` of accepted, rejected or unknown.
  An unavailable refresh can accompany a known operation decision.
