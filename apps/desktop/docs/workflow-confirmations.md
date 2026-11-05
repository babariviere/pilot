# Workflow confirmations

Mission Overview's **More** menu offers four purpose-specific sheets for a
coordinator-planned (planningVersion 1) active Local mission: **Approve plan…**,
**Revoke plan approval…**, **Reviewer consent…** and **Revoke reviewer consent…**.
Legacy missions never show them; nothing adopts a mission.

## What the sheet shows

Opening is one passive `GET /api/missions/:id/approval-package` or
`reviewer-consent-package` (`action=approve|revoke`). The sheet parses the host's
package strictly and shows a compact summary: brief revision and decision count, the
named coordinator (title and exact session ID), its fixed powers, exclusions, limits and
expiry, and a short package digest. **Show brief** and **Show decisions** disclose the
complete saved brief and every active decision text of the same package in limited
scroll boxes. The text is never clipped, re-read or replaced by a later read; an open
attempt shows its own saved bytes. Unknown keys, widened powers, `force`, relaxed checks or a mismatched
mission, project or coordinator make the package malformed; nothing is filled in.

Consent shows the host's own disclosure: data scope, provider, model, non-secret
account, terms, the $20 mission and $4 per-task allowance counted across revisions and
rechecks within shared limits, retention, expiry, and no account/model switch, paid
fallback or refill. Long provider, model, account or terms values are clipped in the
compact rows with an ellipsis, and **Show full disclosure** shows each complete value
from the same package. No Local installs a disclosure configuration yet, so consent shows
the host's refusal and offers no Confirm. A revocation with no earlier record shows
"nothing to revoke".

The caption states the assurance plainly: confirmation in Pilot does not verify who
confirmed and does not guard against other apps the user runs.

## Delivery and recovery

Confirm (button or Cmd-Enter) captures the package on screen. A later read cannot
retarget it. The private writer saves the exact envelope (purpose, mission target,
payload bytes and hash) in the delivery store before one `POST /api/operations` with
the existing native host-action capability. One attempt is retained per purpose and
mission; an open one blocks a new Confirm for that purpose.

- A lost reply, timeout or closed connection is **Unknown**. **Check** sends only
  `POST /api/operations/receipt`, without the capability. It never resends, and a
  matching package read never counts as acceptance.
- Check settles Accepted, Pending (the host entered the effect but has not finished) or
  Rejected (for example "The plan changed since this opened"). **No record** is absence at
  that read only: the original request may still arrive. The attempt stays Unknown and
  open with its exact saved envelope. It is never pruned or replaced, and no fresh Confirm
  or Review again is offered for that purpose. A later Check settles it if the original
  arrives. Pending without a host entry checkpoint stays blocked the same way.
- An older saved "absent" state decodes as Unknown, so it reopens as an open attempt.
- Closing or reopening the sheet does not cancel or resend a request in flight. An open
  attempt reopens from its own saved bytes, across app and daemon restarts.

## Scope

This is native confirmation and recovery only. It does not start workers, reviews or
spend, activate gates, or submit review dispositions (global Review owns that UI).
Accepted records are history for later host consumers; the sheet never claims current
authority from them.

## Scoped checks

- `python3 scripts/check-scoped.py --unit workflow_confirmation`: strict package
  parsing, verbatim payload, disclosure completeness, exact receipt adoption, and
  saved-once/settled-once storage across reopen.
- `python3 scripts/check-scoped.py --test workflow_confirmation`: production
  LocalViewer against `packages/daemon/src/testing/workflow-host.ts`, which runs the
  real daemon routes, OperationJournal, native capability and `missions.sqlite` in a
  temporary home behind a proxy that can hold, drop or kill one request and restart the
  daemon. Its brief and first decision are longer than any compact summary, with
  meaningful tails. Journeys: passive open with the complete brief and decision texts
  disclosed and Escape with a draft kept, REST without the
  capability refused, stale held package (still showing its frozen decisions) rejected
  then reviewed, held dialog closed and reopened with one send and its saved texts
  disclosed, lost ACK settled by Check only, killed request across app and daemon restart
  kept Unknown after a no-record Check with its saved texts disclosed, a request held past the client
  timeout kept open through no-record Checks, ⌘Enter, reopen and app restart, then
  settled by Check once the original arrives (one original operation), and lost ACK
  across restarts settled from the journal. The Overview entry and the consent disclosure
  layout (680/1100, light/dark; compact clipped rows, then complete long values) use a
  labelled synthetic faux Local; they are not live qualification.
  `PILOT_NEXT_WORKFLOW_DIR` saves screenshots.

Coordinator metadata in the host fixture is faux. No provider, reviewer, worker or
real profile is used, and no live approval or consent is made.
