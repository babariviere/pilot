# Day structural audit and ownership redesign, November 2026

## Status and scope

Audit complete. The parent authorized the scoped Day implementation after the
repository audit. The parent owns the full Node baseline. This document makes
no passing-test or native qualification claim until verification is recorded.

The implementation scope is `apps/day`. The daemon/native agent owns the
cross-language router test. `apps/power` findings below are recorded for the
repository audit, not authorized work for the Day agent. No visual redesign,
installation, profile access, daemon restart or power operation is proposed.

Sources: repository and Day instructions, `CODING_STANDARDS.md`, the NSH skill
and its Coding Guides and mixed-mode reference, and the Rust review guidance.
Rust keeps service authority, business rules, revisions and durable operations.
TSX keeps presentation and view-local state. Components run once; reactive
bindings and keyed identity must survive the restructuring unchanged.

Line references describe the audited working copy and can move after changes.

## Audit findings and decisions

### 1. Repeated navigation resolution: address

`apps/day/DayScreen.tsx:91–230` chooses screens through nested conditions.
`apps/day/nav.ts:71–88` repeats their precedence in `shown()`, then
`nav.ts:91–146` chooses Back. `apps/day/planning.ts:56–58` independently tests
whether Today is shown using fewer destinations. `planView.ts:93–109` closes
mission state while opening planning state.

One resolver should describe the destination and its identity. Rendering, Back,
header state and the Today animation predicate should consume that decision.
Keep existing route signals and transition functions initially. Replacing them
with a new route store or navigation stack is unnecessary for this benefit.

### 2. Saved-window handling knows feature internals: addressed

`apps/day/updateView.ts:10–105` imports feature state broadly.
`updateView.ts:307–376` resets it directly and `updateView.ts:388–430` restores
routes, drafts and disclosure state directly. Writable signal exports in
`view.ts:18–101` and `planView.ts:15–81` make this possible.

Ordinary window capture/save/restore is separate from update-page state. Concrete
feature-owned capture/restore/reset operations remove cross-module map writes
without changing `SavedView`. Screen signals stay public where screens use them.
No plugin registry or full signal-privacy migration is introduced.

### 3. Failed connection attempts have implicit ownership: address first

`apps/day/connection.ts:243–315` creates feeds, listeners and pending reads
before saved-window admission at `connection.ts:316–335`. A refusal returns at
`connection.ts:323–333`; retry at `connection.ts:352–386` can construct another
graph without explicit disposal of the failed graph. This is an ownership risk,
not a measured claim that every object leaks.

Give each attempt a concrete resource owner with an idempotent close operation.
On refusal or invalid identity, close the unadmitted graph. On success, transfer
that same graph to the connected window. Do not reorder startup reads merely to
make ownership easier: their order has flush and restoration consequences.

### 4. Day combines feature attachment and cleanup: address only as needed

`apps/day/day.ts:25–86` is a bag of optional features. Its constructor takes nine
positional feature arguments at `day.ts:89–101`, its close path lists selected
resources at `day.ts:122–133`, and connection attaches more controls afterward
at `connection.ts:308–313`.

Use named inputs if connection ownership needs to change this call site. Keep
the screen-facing `Day` shape and fixture compatibility. Put connection-owned
cleanup in the attempt owner, with a clear rule against closing a child twice.
Do not introduce a dependency container or change optional-feature semantics.

### 5. Mock mode and native fixture exports: preserve, defer separation

`view.ts:64–65` exports the mock/pilot mode. `Connected.tsx:9–11` and
`mockFeeds.tsx:29–32` set it. `Incoming.tsx:732–739` and `Chrome.tsx:157` branch
on it. `feeds.ts:8–35,43–75` derives screen contracts from native classes and
adds optional connected features. Native scenario support remains exported at
`native/src/lib.rs:37,78–86`; `native/src/feed.rs:190–245` supports scenarios
alongside native execution.

These are real links, but separating the adapters is not needed for the chosen
ownership changes. Preserve native exports, fixture constructors, mock labels,
optional methods and the connected entry's no-example behavior. No fixture
retirement, feature gating or public-interface replacement in this pass.

### 6. Generic bridge calls and repeated contracts: defer

`bridge.ts:93–126` lets callers select an arbitrary response type and method
string. `deliveryBridge.ts:47–55` casts extra fields. The native method allowlist
lives separately at `native/src/bridge.rs:20–138`. Power view fields are repeated
in `power.ts:8` and `native/src/host/power.rs:9–12`. Feedback and thread limits
are repeated in TSX and Rust (`feedbackFeed.ts:33–37`,
`native/src/host/feedback.rs:28–33`, `threadFeed.ts:250`,
`native/src/host/threads.rs:24`).

No public bridge, RPC generator, schema framework or broad limit consolidation
is proposed. A later change needs a concrete call-site benefit and must keep
byte counts distinct from UTF-16 units. Keep input validation, exact method
grants, stale-write checks and receipt identity checks.

### 7. Router test parses Rust implementation: delegated

`packages/daemon/src/connected-intake-routes.test.ts:8–26` reads Rust files,
regexes URI templates and slices a method body to inspect header calls.
Formatting or helper extraction can fail it without changing behavior; matching
source does not prove the compiled client sends those requests.

The parent daemon/native agent owns replacement: explicit router-contract tests
and compiled native-client requests against a local recording server. Preserve
native authentication, browser-origin rejection, exact project selection,
unavailable-source distinctions and no provider polling during passive reads.
The Day agent must not edit that test or duplicate the work.

### 8. Recovery tests append probes to an entry: improve after characterization

`native/tests/support/connection_recovery.rs:7–26` appends test-only imports and
listeners to a temporary entry to invoke `readAgain()` and mutate host identity.
The retry-exhaustion case waits through the real exponential schedule.

These tests exercise behavior and remain useful characterization. Keep them
while establishing the ownership change. A narrow internal connection owner
can later take a scheduler and channel adapter for deterministic cases. Retain
real QuickJS/HostChannel tests for capability refusal, startup, restoration and
flush ordering. Do not replace all integration coverage with a state-machine fake.

### 9. Power backend protocol duplication: outside Day scope

`apps/power/src/protocol.rs:6–57` shares framing, while `runtime.rs:169–210`
and `linux.rs:153–183` parse the command vocabulary separately. State output is
typed in `runtime.rs:30–69` and inline JSON in `linux.rs:116–122`.

Record a possible shared typed decoder, but preserve malformed-input behavior
and platform-specific policy. No Day-agent edits. Do not force KDE and macOS
into one reactor.

### 10. Guardian lifecycle is spread across threads: outside Day scope

`apps/power/src/macos.rs:303–307,342–406,480–490` distributes child input,
reply reading, child waiting, shutdown and process exit across shared optional
pipe state and threads without locally held join handles.

A private guardian connection module could hide this lifecycle, but blocked
authorization and child-death behavior need characterization first. Keep sleep
acknowledgment independent of authorization and preserve conservative restore.
No Day-agent edits or native power qualification.

### 11. Swift differential test: keep migration evidence

`apps/power/src/tests.rs:761–810` compiles legacy Swift support and compares
grant bytes and generation behavior. It couples routine Rust tests to legacy
sources and Swift tools, but supplies deliberate coexistence evidence.

Record a future split between fixed Rust expectations and an explicit parity
suite. Keep the parity check while coexistence acceptance needs it. No deletion
or legacy retirement in this work.

### Comments: change only beside changed logic

`day.ts:1–3` and `planning.ts:1–4` say feeds have no transport, although connected
adapters use the host bridge. The important distinction is lack of service and
credential selection in TSX. `feeds.ts:1–3` says screens never know the adapter,
although Incoming branches on mock mode. `Connected.tsx:1–4` repeats README entry
behavior; simple open/close comments in `planView.ts:93–109` add little.
`native/tests/support/connection_recovery.rs:320` names NSH 0.4 while local
instructions pin 0.5.0; check the error-code rationale before updating wording.

Correct these only when touching their logic. Keep comments that explain lost
replies, restore without intent, generation matching, FFI safety, conservative
lid protection and independent authorization/sensor threads. No comment sweep.

## Smallest coherent Day redesign

### Authorized decisions before code changes

- Implement one navigation precedence decision without changing route storage,
  destination keys, overlay lifetime or view composition.
- Extract saved-window operations from update-page state. Preserve compatibility
  imports and the saved schema; avoid a whole-feature signal-privacy migration.
- Give each connection attempt explicit cleanup before any acquired resource can
  be abandoned. Keep subscriptions and read-once startup state window-owned.
- Characterize existing lifecycle behavior first with scripted host replies.
  Keep test cleanup until after the behavior change is verified.
- Preserve native fixture exports and public wire contracts. No RPC overhaul.
- Delegate the source-parsing router replacement to `audit-daemon`. Any compiled
  actual-client test changes need coordination with that agent.
- Do not start native compilation while `audit-native` owns the compiler lane.
  Use Node/scripted-host and installed TypeScript checks first.

### Navigation resolution

Extend the existing navigation module with one resolved destination, including
the IDs needed by the renderer. Preserve its current precedence:

1. Update, then ritual.
2. Chat, settings, feedback.
3. Delivery, Linear, artifacts.
4. Change/list, New/plan.
5. Mission thread, mission overview, Today.

Optional feature presence still gates the same destinations. Full-window
artifact presentation stays separate. Derive `shown()` and Back from the same
resolved result. Use the same result for the planning glide predicate without
introducing reads that cause navigation side effects.

Keep stable mission/topic/delivery keys and current component lifetime rules.
Explicitly characterize any current difference between the shell and animation
predicate before deciding whether correcting it belongs in a separate change.

### Saved-window module

Extract `captureView`, `shownKey`, `saveForms`, `startFresh` and `restoreView`
from update-page state into a window-state module. Migrate all repository
consumers directly. There is no external published TSX interface that needs
forwarding exports. Update-page flags, messages and actions remain in the update
module.

Keep the existing saved-place mapping: it intentionally differs from visible
navigation because not every transient overlay is a durable place. Keep exact
draft bytes, UTF-16 selection positions, scroll locations, schema defaults and
fallback rules. Neither capture nor restore submits intent.

### Connection attempt owner

Keep `connection` and `readAgain()` as the entry-facing interface. Internally,
one concrete attempt owns the adapters, listeners and pending work it creates.
An admitted attempt becomes the connected window's resource graph. A refused
attempt closes without publishing it. Late completions cannot publish after
identity invalidation or attempt disposal.

Register cleanup as resources are acquired. Audit each existing `close` and
`dispose` method before composing them. If a pending task has no cancellation,
guard its completion rather than inventing a cancellation guarantee. Preserve
the existing module lifetime across screen hot updates.

The window lifetime, not an attempt, owns pinned identity, initial startup
read-once state, invalidation/flush subscriptions and retry budget. Preserve
the installed-before-first-await flush listener, highest generation rule,
opening catch-up refresh and no repeated startup calls after a passing failure.

## Characterize lifecycle before restructuring

After authorization, add or identify tests against the current implementation
before changing ownership. Use isolated fixtures and faux native replies only.

| Case                                              | Required observation                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| First read offline, then recovery                 | Startup-only calls remain once; no overlapping reads                              |
| Saved-window read refused after feed construction | No forms admitted; retry retains saved drafts; failed graph cleanup is observable |
| Identity changes during each startup await        | Old completion cannot publish or ACK                                              |
| Flush before first read settles                   | No empty ACK; highest pending generation wins                                     |
| Flush after failed opening                        | Saved view returns unchanged; unreadable saved view never ACKs                    |
| Refused draft save                                | Close stays blocked; exact draft remains                                          |
| Old flush completes after a newer request         | Old generation cannot ACK                                                         |
| Invalidations during startup                      | One catch-up read after admission; no startup loop                                |
| Open-window read fails                            | Same admitted graph, route and draft remain                                       |
| Repeated Read Again                               | No queued duplicate attempts or extra listeners                                   |
| Retry exhaustion                                  | 1, 2, 4, 8, 16 seconds; warning only after automatic retries stop                 |
| Updater restore versus ordinary reopen            | Preserve distinct ACK paths and do not submit intent                              |
| Navigation overlay/back/home                      | Same parent, key, draft and confirmation behavior                                 |
| Capture/restore round trip                        | Exact Unicode, whitespace, selection and durable place                            |

Reuse `native/tests/support/connection_recovery.rs`, `Navigation.test.tsx`,
`Palette.test.tsx`, `Update.test.tsx` and the relevant native update/window tests.
Add deterministic clock tests only at the new internal seam, not a public test
API. Keep integration cases that prove actual host grants and VM behavior.

## Execution gates

1. Parent completes all repository audits and evaluates its Node baseline.
2. Parent authorizes the scoped Day implementation.
3. Characterize connection/flush/navigation lifecycle on the old implementation.
4. Add explicit attempt cleanup and rerun lifecycle tests.
5. Consolidate navigation resolution with unchanged keyed rendering.
6. Extract window state without changing saved schema or fixture exports.
7. Run `apps/day/scripts/typecheck.sh`, matching NSH tests through `nsh.sh`,
   and native tests through `scripts/cargo` as relevant. Check/build use the
   pinned NSH distribution; do not repair setup by changing dependencies.

This is structural work. Headless behavior checks do not prove native focus,
scrolling, IME or appearance. Report any unverified native interaction risk.
Do not claim a measured performance gain without a before/after measurement.

## Implemented scope and remaining decisions

- Navigation: the shell now computes `nav.shown` once in an NSH `computed` and
  passes that result through its existing nested view composition. Back/header
  use the same resolver. Capability gates and keyed mission/topic/result mounts
  remain unchanged. No replacement route store, stack or new public interface.
- Persistence: `windowState.ts` composes saved-window operations, not the feature
  state itself. All internal consumers import that module directly;
  `updateView.ts` has no forwarding exports. Feature-owned methods now encode,
  reset and restore the coherent state groups. The saved schema, overlay
  exceptions and restore defaults are kept.
- Connection: private `OpeningFeeds` owns partial construction and admission.
  Failure closes partial graphs in `finally`; identity invalidation closes an
  admitted graph. Existing mirrors take over their source's cleanup without
  double disposal. Shared startup ritual reads remain window-owned.
- Feed cleanup: Today and Planning stop queued refresh work after disposal.
  Planning also clears its stale-page timer. Late entered operations are not
  reinterpreted as unsent, retried or cancelled.
- Construction: `mirrorDay` now takes named optional features instead of nine
  positional arguments. Its four real call sites are updated, including the
  fixture that previously needed three `undefined` placeholders. Native exports
  and fixture constructors are unchanged.
- Feature persistence: Today, New/planning, interview, Changes, delivery,
  feedback, ritual, preferences, Linear, thread and kept-position owners now
  encode their own coherent groups. `windowState.ts` performs no direct signal
  writes or feature-map enumeration. Today draft-save iteration belongs to
  `commands.ts`; planning owns the pending-answer count. Public reactive signals
  remain available to screens; this is not a full signal-privacy overhaul.
- Animation: remove `planning.ts`'s separate Today predicate and its UI/navigation
  imports. `DayScreen` owns an `animatePlanningList` subscription, implemented in
  the window navigation module, using the surface's already-resolved destination.
  Cleanup stops that subscription. Visible Today keeps the same shape-triggered
  glide; settings/chat/feedback and the other covering places no longer request
  hidden-list animation. One shape comparison per publication replaces two.
- Mock mode and bridge generation: unchanged. Mock mode controls two existing
  fixture presentation paths and native scenario exports have concrete fixture
  consumers. Removing them would require wider adapter changes. Generic bridge
  typing is not required for this concrete lifecycle repair. Validation and exact
  grants remain in place.
- Recovery probes: keep the existing temporary-entry integration probes. They
  test real QuickJS grants and repeated recovery calls after a button disappears.
  New deterministic Node characterization covers retry timing without replacing
  that transport coverage or adding a production-only test API.
- Comments: the touched Today mirror description now explains native authority
  instead of claiming that every feed has no transport. No unrelated comment
  sweep or power changes were made.
- Router work: daemon source parsing is delegated. Day adds a compiled-client
  integration case in `native/tests/intake.rs` that calls both read methods
  through the released bridge and real isolated daemon router, checks project
  binding and denied reads, and asserts zero external/session/write activity.

### Fixed wire composition versus feature policy

Follow-up authorization: complete concrete feature-owned capture, restore and
reset operations now. Keep screen signal exports and the fixed `SavedView`
composition. Preserve restore ordering, especially the planning place before
Changes' passive read, form drafts before focus restoration, and the update
overlay last. Do not add a generic state registry or forwarding exports.

`SavedView` is an existing fixed native wire schema. Some module must compose its
named fields, distinguish durable places from transient overlays, and apply the
existing fallback and compatibility rules. Keeping that explicit mapping in
`windowState.ts` is intentional. Replacing it with a generic feature registry or
an arbitrary serialized state bag would not remove the wire obligations and
would add another interface. The wire schema does not need to change here.

That schema does **not** require the composition module to know each writable
signal. The follow-up implementation removes that coupling: `startFresh()` and
`restoreView()` call concrete owner operations instead of resetting maps or
writing signals. Encoding rules for help kinds, scoped questions, project
choices, pinned delivery notes, feedback JSON, ritual dates and thread identities
live with those features. `kept.ts` owns scroll/selection capture and restore.

The composition still reads public route and scalar visibility values to choose
the existing durable place/key and assign wire fields. That is intentional
window-level wire mapping, not a claim that feature state is private. Adding a
new SavedView field still requires updating the fixed native schema and its
composition. Adding or changing an internal reset rule does not require a
central map write. New/mission place restoration precedes Changes' existing
passive read; all feature drafts precede focus restoration; update visibility
is restored last. No restoration action submits user intent.

## Verification recorded so far

Before the lifecycle edit, the new scripted-host characterization passed against
the original connection implementation. It also passes against the pristine
tracked snapshot supplied by the parent. Navigation precedence, exact saved-draft
round trips, save refusal and retry-budget tests also pass against that snapshot.
New disposal assertions cover the repaired behavior rather than asserting source
text. No old behavioral integration tests were removed.

Commands completed:

```sh
node --test scripts/day-connection.test.ts scripts/day-refresh.test.ts
node_modules/.bin/tsgo -p apps/day/tsconfig.json
```

Result: 17 Node tests pass. Standalone Day TypeScript and the final workspace
typecheck wrapper both pass. The parent owns the full Node baseline and final
repository gate.

The whole Node test now lives in `scripts/day-connection.test.ts`, with types,
so routine Node discovery runs it in the portable integration gate. No forwarding
wrapper or discovery exception was added. `node scripts/test.ts --list` confirms
discovery. It scripts only NSH signals, the host channel, clocks and non-rendered
presentation helpers. It cannot prove the native reactive graph or keyed
rendering behavior. Disposal checks cover every disposable connected adapter,
late feedback completions, shared ritual reuse and a successfully admitted graph
that survives invalidations/flush before closing once on identity change.
Additional tests cover every hidden destination's animation suppression,
visible-list animation and unsubscribe behavior, and rich feature round trips
with Unicode, scoped question IDs, reminders, notes, feedback, thread drafts,
scroll and exact selection offsets. The rich round-trip case also passes against
the pristine pre-change snapshot.

### Modest before/after synthetic measurement

Five alternating runs used the same current test harness against the pristine
snapshot and the working copy. Node v26.13.1, macOS, no live service. Each run
warms the same navigation loop, holds a Today reply for 10,000 invalidations over
a 5,000-mission snapshot, then resolves it and performs 100,000 navigation
decisions. Imports and warmup are outside the measured interval.

| Measurement                      | Before median | After median |
| -------------------------------- | ------------: | -----------: |
| Measured elapsed                 |      2.128 ms |     2.103 ms |
| Process CPU during interval      |      2.626 ms |     5.307 ms |
| Process RSS at end               |    59.738 MiB |   58.300 MiB |
| Host reads / published snapshots |         2 / 1 |        2 / 1 |

Elapsed ranges were 2.036–2.235 ms before and 2.018–2.432 ms after. Process CPU
includes all V8 threads, not just the measured function; import-graph changes and
background JIT work can affect this short interval. Do not claim a speedup or a
heap improvement from these process-level samples. Elapsed ranges overlap.
Coalescing and publication counts are unchanged. GUI frame costs, typing,
scrolling, IME and retained view lifetime still require native verification.

The same five alternating runs also measured 200 planning publications over
1,000 rows after warming the stream. The old mirror owns animation in the
baseline; the new surface-owned subscription does so in the working copy.
Both produce 200 visible-list glides and the same final mirror. Elapsed median
was 11.159 ms before (11.053–11.321) and 5.755 ms after (5.538–6.037). CPU medians
were 11.286 and 6.129 ms; RSS medians were 62.895 and 63.160 MiB. Computing one
list shape instead of two reduces this synthetic projection cost. This does not
measure native animation frame time or establish GUI smoothness.

Reproduce the baseline measurement with `DAY_AUDIT_ROOT` pointing to the supplied
pristine repository and `node --test --test-name-pattern=synthetic
scripts/day-connection.test.ts`; omit that variable for the working copy.

### Native and NSH checks

After the parent released the compiler lane, these completed:

```sh
apps/day/nsh.sh build
apps/day/nsh.sh check
apps/day/nsh.sh test Navigation.test.tsx
apps/day/nsh.sh test Update.test.tsx
apps/day/nsh.sh test Palette.test.tsx
apps/day/nsh.sh test App.test.tsx --filter 'a large world'
apps/day/nsh.sh test Thread.test.tsx --filter 'a long message'
(cd apps/day/native && ../scripts/cargo test --locked --test intake --test connected --test connected_update)
(cd apps/day/native && ../scripts/cargo test --locked --test intake)
```

Headless results: Navigation 8, Update 12, Palette 9, large world 1 and long
thread 1 passed (31 total). Native results: connected 25 and connected update
11 passed. The new intake test initially used a route-specific fixture denial
that deliberately does not deny intake. The test was corrected to revoke the
actual private fixture credential permissions, then restore them; both intake
tests pass on rerun. No production code was changed for that test assumption.

The inherited feature-gated dead-code and debug linker unwind-table warnings
remain visible. The build reports the intentional default deny-all host grant;
fixture runs also report their ungranted status bar. No capabilities were widened
to quiet warnings. No native compilation ran while another agent owned the lane.
No visible redesign is intended. Native focus, scrolling, IME, real service use
and GUI frame responsiveness remain unqualified; headless results are not visual
acceptance. No mock artwork is added or claimed as acceptance evidence.

After the final feature-owner and animation changes, the build was repeated,
and Navigation 8, Update 12 and InterviewView 1 headless tests passed. Native
connected 25 and connected_update 11 were also rerun against the final TSX
sources and passed. The intake tests' native source is unchanged from its passing
run. Final standalone Day/workspace typechecks, targeted Node 17 tests, Biome
and whitespace checks pass. Source is stable for the parent's full gate.

### Upstream thread merge and deterministic test clock

The parent rebased onto `747e8e23` (keep reading position through live updates).
The only conflicting concern in the shared fixture was its import owner; the
fixture now imports window persistence from `windowState.ts`. Production thread
sorting, reading anchors and scrolling are untouched by this work.

Combined-tree checks passed ThreadBridge 3 headless tests and ThreadNative 3
actual AppKit tests through `apps/day/nsh.sh test ThreadNative.test.tsx --target
macos`. Those mock-only native cases cover reading-position changes and keyboard
send/back behavior, not IME or broad connected-app qualification.

The first full Thread headless run passed 27 of 28. Its gap-order assertion at
the upstream `Thread.test.tsx:268` failed with `82 < 61`. Untouched tracked TSX
from `747e8e23`, extracted to `/tmp/pilot-day-upstream-747e8e23.HTBh3J` and run
with the same pinned native engine, failed identically. The host had crossed
midnight: seeded demo rows use today's 09:10 and 09:18, while newly appended
replies use `Date.now()`, which was around 00:56. The "new" reply therefore sorted
before the seeded morning messages. This was an upstream time-dependent fixture
failure, not a persistence or scrolling regression.

The user authorized one test-only correction. `Thread.test.tsx` now supplies
`clock: { time: new Date(2026, 10, 16, 12) }` in its existing desktop open options.
This is the supported NSH manual clock: both seeded local morning rows and new
reply timestamps use the same fixed day, with new replies starting at noon.
No retry, sleep, skip, sorting change or weakened order assertion was added.
All 28 upstream tests remain. The failing case and then all 28 pass with the host
still past midnight (00:58 CET). Day and workspace typechecks, Biome and whitespace
checks also pass. The native three-test source and fixture are unchanged from
their successful combined-tree run. Production source remains frozen for the
parent's final Node gate.
