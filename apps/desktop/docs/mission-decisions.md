# Read mission decisions

The selected mission overview's **Read decisions** disclosure uses its existing
Local hello-gated detail GET. No endpoint, subscription or fanout is added. The only
write is the explicit withdrawal response below.
The Browser retains its scroll owner and mounted task/brief/metadata entities;
the chat's composer and transcript remain with their existing owner.

## Contract audit

Swift `MissionTabs.swift` displays binding decisions before the brief, with number,
audience, full text and the first pending proposal for each present decision.
`DecisionProposalView.swift` can also resolve/edit a suggestion when given a
callback. This feature intentionally does not adopt those management callbacks,
strikethrough the binding text, or hide proposals whose target has disappeared.

`packages/protocol/src/index.ts` supplies decision `id`, `number`, `audience`,
`text`, author and timestamps, and proposal `id`, `decisionId`, `kind`, optional
`text`, `reason`, `status`, author and timestamps. Decisions have no revision or
CAS token. The UI makes no author/chronology inference or claim that current text
is the exact revision captured by a proposal. Missing audience is unknown, not a
guessed default. Only explicit `pending` proposals appear, separately labelled
unadopted and untrusted. Accepted/rejected records count toward scanned records,
not pending rows. No suggestion changes binding authority.

## Retired decisions and withdrawal

A decision with `replacement {id, number, at}` or `withdrawn {at, reason, proposalId}`
leaves **Current decisions** and appears behind **Show retired** labelled
**Replaced by D…** or **Withdrawn**. Original text stays readable; a withdrawal reason
shows only when the row is opened. **Go to D…** opens a successor listed in the same
snapshot; a missing successor shows only its number, never a body. Both fields
together, malformed times/identities or a successor whose number disagrees fail the
section closed. Legacy rows omit both and stay current.

Proposal kind `withdraw` (optional `operationId`, no text) is **Proposed withdrawal**,
never hard **Remove**. Pending and rejected withdrawals leave guidance current; only
the durable `withdrawn` field marks it Withdrawn. Opening the proposal offers
**Withdraw D…** and **Keep D…** for that exact proposal ID. Each requires a current,
online, canonical snapshot and no response in flight, then rechecks the Local home,
catalog and the same pending proposal (ID, target, reason) and posts once to the
existing `decision-proposals/:id/accept|reject` route with `{}`. Only a matching
200 response (ID, target, kind, status) is success. Errors, lost or mismatched
responses are **Outcome unknown**; that proposal is never resent, retried or settled
by a GET. Edit/Remove proposals stay read-only, and there is no coordinator or
delegated withdrawal control.

## Source and coverage

Rendering requires the exact selected home/mission and a matching canonical Local
catalog home/project source. Async route/generation checks remain in the Browser;
disclosure/copy callbacks additionally require the exact retained snapshot Arc and
generation. Selection changes clear disclosures before rendering the next source.
Old callbacks cannot copy or expand a replacement snapshot. No foreign-home or
project fallback. The source disclosure names mission, project and home and states
that the snapshot generation is not a decision revision/CAS token.

The existing mission-detail transport reads the whole snapshot. Each collection scans at most128
records, retains at most128 decisions/pending proposals and reveals8 more at a
time. Decision/proposed text and reasons retain exact received content, including legacy
values above current authoring limits. Copy copies the full received text, never
the preview. Write limits are not reused by read decoding. Missing, empty, capped,
malformed and retained/offline/refresh-failed states have different explanations.
No load-all endpoint or pagination is invented. A missing/removed/unreceived target
is unknown rather than reassigned by decision number.

Native Kit buttons provide Tab/Return operation; source, individual decision text
and proposal details are progressively disclosed. Copy remains explicit. Sibling
marked input is guarded on mouse-down before a button can blur preedit and again
on state-changing callbacks. No inputs, drafts, timers or scroll owners are added.

## Verification scope

The focused `mission_decisions` library filter maps bounded projection and actual
GET-only reader behavior; `mission_decision_resolve` covers the withdrawal response
fences. The same-named native target mounts the production Browser offscreen in
light/dark at680/1100 and the withdrawal journey at 520/1100. Matching scoped Clippy and compilation
cover the additive Browser/model/reader seams. CI retains the complete suites.
This is synthetic macOS rendering, not live data mutation, OS IME qualification,
performance/motion acceptance, Linux support or replacement-app approval.
