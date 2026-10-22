# Bounded window navigation and scope restoration

References: retained Swift `NavigationHistory.swift`, `AppModel.swift`
focus/moveThroughHistory, `SidebarScope.swift` and `KeyboardCommands.swift`.
This extends the scoped Home/projects delivery, not full app parity.

## Semantics

- Back/Forward buttons and Cmd/Ctrl-[ / ] use at most100 window-local ID
  destinations. Consecutive duplicates do not add entries. A new destination
  truncates only the forward suffix. Removed project/chat/draft destinations are
  skipped, never reinterpreted by name/cwd or another identity.
- Read admission is transactional: preedit or a full reader command queue leaves
  the destination/history cursor intact. Resolve metadata/eligibility from the
  current pinned Local catalog, not old permission/title/path snapshots.
- The project sidebar restores that scope's last valid chat/overview. A first
  visit or invalid saved selection opens that same project's Overview. Home
  cards and the explicit Overview button always open Overview. Home stays global;
  All chats keeps its prior current-conversation/global-list meaning.
- At most64 recently visited scopes retain search, archived visibility,
  selected row ID and sidebar/overview offsets. Capture the live native query,
  not just a deferred search callback. Preserve its existing240-character search
  prefix/case; this is not an unbounded text cache or persisted app preference.
  Cancel pending query scroll resets before restoring offsets. Geometry changes
  may clamp old offsets to the new content bounds.
- Returning to the same current chat preserves its one transcript/scroller,
  loaded history cursor and text entities. Cross-chat history uses the existing
  pinned reader, never cached transcripts. At most100 message-ID/offset/follow
  tokens restore a marker only if it is in the newly admitted page. If not,
  explain that Earlier can load older messages; never silently drain history.
  Generation/owner fences reject stale publications; Latest overrides a pending
  marker. Restoration itself does not manufacture a scroll/history request.
- Draft destinations select an existing private key, never the new-chat action.
  Capture live composer/cwd; refuse composer/cwd/search preedit. No history entry
  contains text, a delivery intent, permission, a view or a feed. History never
  dispatches Submit/Stop/approval or repeats a canonical creation request.
  Existing private draft autosave/receipt safeguards remain authoritative.

All state is window-local and bounded. Restart intentionally forgets navigation
and UI filters, not durable drafts/outbox. Stored ID locations remain qualified
by this viewer's fixed Local daemon/lineage; there is no host switching/fanout.

## Scoped dependency seams

Tracked exact-edit specifications expose native query value/preedit and an
opt-in immediate-query restore without selection/scroll reset; a virtual-list
offset restore that cancels an obsolete queued jump; a caller-owned handle on
the existing scroll/bounce wrapper; and an admitted reader-anchor restore that
does not emit a user-scroll notification. Defaults remain unchanged. Original
archive checksums, exact preimages and generated-source verification stay
fail-closed. No registry or generated `.patched` content is edited/committed.

## Verification

Seven focused model/controller checks and strict all-target native checks pass.
Four production-root native scenes pass at680/1100×600 points, light/dark.
The shorter window ensures the overview really overflows before testing scroll
restoration; a fitting document has no meaningful negative scroll offset.
Native production-root tests
with synthetic summaries and faux reader/writer channels cover narrow/wide,
light/dark, back/forward, exact scopes, search/archives/positions, preedit,
current transcript/cursor reuse, cross-owner generation fences, full reader
queue, forward truncation and existing-draft reuse. Source remains on the same
retained transcript/cursor/text entity when possible. Different-chat reads use
exact fresh generations; a stale publication cannot consume the pending marker
or issue Earlier. A last scoped chat whose project membership changes falls
back to that same project's Overview, never another scope. The final focused
matrix also passes the outside-loaded-page notice/Latest regression. Captured
frame review exposed a stale project keyboard highlight; restoring the native
ListState selected index now keeps the highlight aligned with the exact scope.
The final complete macOS gate passes after that fix: **127 library tests passed,
1 ignored**, strict app/helper/native checks, fixture/browser rendering,
16 chrome/56 visual scenes,720 disclosure frames, rounded/dither/composer and
isolated slider checks,8 history scenes,4 Home/shell scenes plus the capacity
case, and all4 new navigation scenes. Four mocked Python runner tests, locked
app/helper builds and direct engine-symbol separation also pass. The helper
crate has no Rust unit tests. The existing `block0.1.6` future-compatibility
notice remains. The final full log exits0; interrupted earlier runs are not
substituted for these results.

Exact specification hashes: Base29 edits,
`e841a77806be3fb86c9b2189f6420e438d0771a6f90d4acead1dceccde0b48e7`;
Component23 edits,
`5b53d1b281a1aa692f3cc709900104b3cd6ad6b69f0e5c4026813d6a8317287a`.
These are scoped API seams, not cache-threshold/parser/backend changes.

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib navigation -- --test-threads=1
PILOT_NEXT_NAVIGATION_DIR=evidence/local/navigation-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test navigation
bash scripts/check.sh
```

No real actions, credentials/private content, visible launch/restart, backend or
Swift changes, installs, release/default switch or full parity claim. Linux
verification stays deferred and source execution fail-closed. Native synthetic
frames do not establish OS IME/macOS15/user acceptance or a general performance
win. Actual GPUI captures and any static SwiftUI mock are separately labelled.
