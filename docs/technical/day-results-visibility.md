# Mission results and problems

## Source audit

Checked against `d76be830` and the focused changes described below. Task titles
and agent reports are not proof of delivery, release or human acceptance.

| Existing slice | Canonical source and native consumer | Coverage and precise gap |
| --- | --- | --- |
| Reports and controls (#4), Today/mission overview (#9) | `packages/protocol/src/mission-reports.ts`, daemon `mission-reports.ts`, native `contract.rs`, `project.rs`, `desk.rs`, `MissionScreen.tsx` | Saved reports include currentness, provenance, next step and evidence. Activity/task counts do not prove movement. The task row hid next step/evidence. This change exposes them as agent assessments. |
| Durable attention (#44) | `attention_host.rs`, `attention_feed.rs`, `ActionCard.tsx`, `DecisionCard.tsx` | Saved decisions and human actions already preserve revisions, drafts and Unknown/lookup-only recovery. They do not cover host failure rows. No answer, completion, retry or permission grant is added here. |
| Mission outputs (#99) | `MissionDetail.resources/artifacts`, native `project::outputs`, `MissionScreen.tsx` | Already separates actual linked PR state from release. URLs and PR observation/check-health metadata were hidden. This change shows the canonical URLs as selectable text and saved observations with their ages. Missing checks stay explicit. |
| Verification (#104/#109/#105) | `DeliveredWork`, `UserVerificationLookup`, native `host/delivery.rs`, `deliveryFeed.ts`, `DeliveryScreen.tsx` | Existing exact-delivery/revision CAS, matching outer/domain receipts, Done/Send back/Reopen and cold-reopen Unknown are reused. Completion commit/checks are agent claims, not independent landing proof. Direct publication is not invented when a PR is absent. |
| Host failures | `ProjectDashboard.needsYou`, daemon `project-dashboard.ts`, `needs-you-reason.ts` | DayOverview already includes complete local attention. Native Dashboard discarded it. This change projects that section into passive Today and mission problem rows. Only rows the canonical host says need humans are included, not failures inferred from report prose. Unread results are excluded. |

## Presentation and authority

Problems show the source cause, a conservative next step, and diagnostic chat
address/mission navigation. The record does not prove which unfinished effects
or drafts were saved, so the UI explicitly says that state is not verified.
Reading, copying or opening mission detail never retries work, grants permission
or acknowledges completion. Coordinator recovery stays under existing authority.

The canonical report's optional `delivery {commit, checks, issues}` is shown as
a scoped worker claim, including its report currentness. It does not transition
the task, create a canonical delivery for user verification, or establish a PR,
publication or release. Quiet schedule notices do not become human-needed rows.

Missing/incomplete host attention cannot look like an empty inbox. Last-good
problem rows survive a stale/offline read; the UI labels them earlier observations.
A later successful complete read clears resolved rows. Reopening reads canonical
records again, with no separate failure tracker or dismissal store.

The stale-only Old report mark uses a muted 16-point folded document, keeping its
label and currentness meaning. Unreported, unavailable and failure marks do not
change. UI rows reuse the approved hierarchy/tokens/controls; no new interaction
or primary-action design is introduced.

## Kept limits

- Historical first-delivery listing and its cutoff remain #112. No scanning,
  new list endpoint or inferred cutoff is added.
- Completion, worker delivery, direct publication, linked PR state, release and
  user verification are separate. Production stays `not_tracked`.
- PR health has observed timestamps, not a live-check promise. Readiness reasons
  contain check names but no per-check URLs. The actual canonical PR URL remains
  inspectable; no CI URL is synthesized.
- Diagnostic chat URLs and overview output URLs are selectable text, matching
  existing origin details. No new generic URL opener/host capability is added.
- Headless behavior is not native visual/focus/IME acceptance. Visible launches,
  production data, external writes, retries, updates and activation are not tests
  of this slice.

## Focused verification

- `native/src/project.rs` tests host failures, blocked coordinators, permission
  attention, stale report claims, scoped worker delivery, quiet notices,
  missing/incomplete reads, offline/reopen and PR check observations.
- `native/tests/host.rs` drives a real isolated daemon through failure,
  native-host close/reopen and resolution without reading a chat or sending a
  retry. A WS invalidation may make a passive refresh Stale; the test still
  waits for the authoritative problem state.
- Existing `delivery.rs`, `delivery_today.rs`, attention and boundary tests keep
  exact receipt pairs, Unknown/no replay, drafts, user verification and access
  denials separate. Test navigation uses the current Back control, not an old
  label claiming every Back returns directly to Today.
- `Visibility.test.tsx`, `App.test.tsx`, `Delivery.test.tsx` and
  `Attention.test.tsx` cover the established native components, false publication
  claims, direct commit versus PR, old/missing checks and the stale-only mark.
- The document SVG was rasterized at its actual 16-point size to inspect the
  fold and strokes. Its shared muted token has 5.40:1 contrast in light and
  6.62:1 in dark against the page. This is asset inspection, not visible NSH
  acceptance; the attached visual is a mockup.

Projection adds one linear pass over already-read local attention, with no new
network reads or polling. Large-session streaming performance was not measured.

See [user verification](day-user-verification.md) and
[mission reports/controls](mission-controls-reports.md) for existing contracts.
