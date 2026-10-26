# Read mission decisions

The selected mission overview's **Read decisions** disclosure uses its existing
Local hello-gated detail GET. No endpoint, subscription, fanout or write is added.
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

## Source and coverage

Rendering requires the exact selected home/mission and a matching canonical Local
catalog home/project source. Async route/generation checks remain in the Browser;
disclosure/copy callbacks additionally require the exact retained snapshot Arc and
generation. Selection changes clear disclosures before rendering the next source.
Old callbacks cannot copy or expand a replacement snapshot. No foreign-home or
project fallback. The source disclosure names mission, project and home and states
that the snapshot generation is not a decision revision/CAS token.

The existing detail wire limit remains 2MiB. Each collection scans at most128
records, retains at most128 decisions/pending proposals and reveals8 more at a
time. Decision/proposed text is capped at16KiB, reason at4KiB, with a shared256KiB
retained-text budget. UTF-8 clipping is explicit; Copy copies the exact bounded
display payload, never the preview or hidden tail. Missing, empty, capped,
malformed and retained/offline/refresh-failed states have different explanations.
No load-all endpoint or pagination is invented. A missing/removed/unreceived target
is unknown rather than reassigned by decision number.

Native Kit buttons provide Tab/Return operation; source, individual decision text
and proposal details are progressively disclosed. Copy remains explicit. Sibling
marked input is guarded on mouse-down before a button can blur preedit and again
on state-changing callbacks. No inputs, drafts, timers or scroll owners are added.

## Verification scope

The focused `mission_decisions` library filter maps bounded projection and actual
GET-only reader behavior; the same-named native target mounts the production
Browser offscreen in light/dark at680/1100. Matching scoped Clippy and compilation
cover the additive Browser/model/reader seams. CI retains the complete suites.
This is synthetic macOS rendering, not live data mutation, OS IME qualification,
performance/motion acceptance, Linux support or replacement-app approval.
