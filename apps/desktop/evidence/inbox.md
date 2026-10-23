# Local loaded-summary Inbox

This is a partial read-only Inbox, not an authoritative dashboard or approval
surface. Swift remains the full Inbox. No new endpoints, backend/Swift changes,
permissions or host capabilities are introduced.

## Reference and supported semantics

Actual references: `apps/macos/Sources/Pilot/InboxPage.swift`,
`PilotCore/Inbox.swift`, `NeedsYouReason.swift`, `SessionSignal.swift`,
`SidebarScope.swift` and `NavigationHistory.swift`, plus `DESIGN.md`.
Swift combines bounded authoritative Needs you/Ready to merge sections with
missions, schedules, Linear and Slack and private review marks. Those data and
actions are not reconstructed from chat summaries here.

The new sidebar Inbox uses the already loaded, identity-pinned Local sessions
and configured-project catalog. A virtualized list groups supported chat
attention under Needs you, then Ready to merge. Failures precede questions,
public scheduled-start failures, then other supported public reasons, retaining
canonical order within each urgency. Normal work, background jobs, scheduled
replies and pauses suppress stale outcomes, while explicit live job/MCP/stall
attention wins. Archived, continued and retired-control summaries and private
drafts are excluded. Existing sidebar signal/action eligibility is unchanged.

Reasons use the shared Swift vocabulary. Only the first nonempty public reason
line, bounded to200 Unicode scalars, is retained, with a full row tooltip and
built-in accessibility label. Public `outcomeReason` supplies ordinary failure
or question detail when no explicit compatible reason is present. Raw errors,
provider fields, reasoning and history are not read for this projection.
Known explicit reason kinds are supported; unknown kinds do not become invented
approvals or review counts. Finished outcomes alone never imply unread. A
reported primary open PR explicitly marked ready can appear as one chat row,
never as an attention badge, inferred merge permission or all-PR total.

The searchable project menu filters exact `projectId`, not checkout paths.
Fresh Inbox entry presets the currently focused project and does not remember
a manually chosen filter. Explicit Back/Forward entries do retain that filter;
sidebar project focus while in Inbox presets the new exact project. The filter
does not change sidebar scope. A removed project remains explicitly unavailable,
not silently reinterpreted as All projects; loaded matching chat identities can
still be shown. Missing project names remain unavailable, never path-inferred.

Rows open the existing reader only on explicit click or keyboard confirmation.
Pointer activation pins the rendered chat ID, not a changing urgency index;
keyboard selection is preserved by ID during refresh. Navigation captures
draft/preedit transactionally and keeps the current reader when owner is the
same. History remains bounded under the existing100-destination/64-scope rules.
Nothing marks reviewed, changes status/archive, sends, retries, approves or
merges. Readiness/attention clear only when their public evidence changes.
Explicit opening retains the existing Local reader contract, including possible
server-side PR refresh on subscription, not authentication or side-effect-free
backend subscription claims.
Late confirmations from an unmounted Inbox are ignored. A project removed
before menu confirmation cannot become a new destination.

## Bounds and remaining gaps

At most1000 loaded canonical summaries and256 configured projects are admitted
by the existing reader. Inbox additionally caps indexed rows at1000. Its lists
and project search are virtualized; only rendered rows create corner entities.
Metadata and urgency indexes are bounded and corners are pruned by an O(n)
eligible-ID set. Existing shared paint-leased dither clocks apply, no new timer
or polling. Hidden Inbox receives no synchronization/projection work. Hidden
transcript publications still coalesce without rendering/parsing; one retained
Inbox metadata snapshot is not a transcript cache. No general CPU/RSS speedup
is inferred from these structural observations.

No full Inbox endpoint, badge, authoritative totals, private unread/held marks,
mission/schedule/integration collections, PR-level deduplication across chats,
secondary-PR readiness expansion, subscription-limit inference/reset clocks,
server ordering/recency reconstruction or privileged Inbox actions. No empty
view says All clear: it only reports no supported attention in loaded summaries.
Source errors retain last received data and existing connection feedback.
macOS-first; Linux validation, browser/shader/terminal/iOS, release/updater and
default switching remain deferred. No real automated actions, visible app launch,
private content or user state in tests/captures.

## Verification

Focused projection/privacy/priority and exact-scope/capacity tests, followed by
native production-root checks at680/1100×600 in light/dark. The native fixture
uses synthetic summaries, fake reader commands and a recording writer, never
Local. It exercises actual project-menu search/keyboard confirmation, filter
history and fresh scope presets, pointer chat opens, preedit refusal, retained
draft/current reader, absent auto writes, missing/error/empty/loading states,
32 hidden metadata publications and1000-summary/256-project capacity.
The wide native check caught a real Select hit-target mismatch: its width style
refined the inner input, not the Base wrapper. An explicitly bounded surrounding
view now makes both220pt; actual search/confirmation and mounted-bounds assertions
pass in the focused four-scene matrix. No dependency patch was required.
The final gate also checks stable selection across changed urgency and rejects
late hidden-page chat/filter confirmations.

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib attention:: -- --test-threads=1
bash scripts/cargo.sh test --locked --lib inbox:: -- --test-threads=1
PILOT_NEXT_INBOX_DIR=evidence/local/inbox-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test inbox
bash scripts/check.sh
```

Actual synthetic GPUI frames and the static SwiftUI mock are labelled separately.
Offscreen checks do not establish OS IME, macOS15 hardware, visible interaction,
performance or user acceptance.

Final complete macOS gate passed: **130 library tests passed,1 ignored**, strict
app/helper/all-target native checks, native fixture/browser rendering,16 chrome
and56 visual scenes,720 disclosure frames, rounded/dither/composer and isolated
slider checks,8 history scenes,4 Home/shell scenes plus capacity,4 navigation
scenes and all4 Inbox scenes with the selection/late-event supplements. Four
mocked Python runner tests and locked app/helper builds passed; direct engine
symbols are absent from the UI and present only in the helper. The helper has
no Rust unit tests. Existing `block0.1.6` future-compatibility notice remains.
Earlier failing diagnostic iterations are superseded by this exit0 full gate.
No dependency/spec/lockfile changes; the existing exact patch specifications
are unchanged.
