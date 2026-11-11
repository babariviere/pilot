# Pilot Day

The source of the upcoming Pilot desktop app, written in Native Shell (NSH)
TSX, with its read model and rules in a Rust crate (`native/`). It started as
the Today spike in `experiments/nsh-day` and now lives here as the only Day
app source.

Status: Today still runs on **mock data**. Its missions, agent reports and
Pause controls arrive as the daemon's v1 contracts
([mission-controls-reports.md](../../docs/technical/mission-controls-reports.md)),
read by a mock daemon. The Rust-only [native host seam](../../docs/technical/day-native-host.md)
now supports real authenticated reads and journaled mission controls in isolated tests.
The Rust-only planning host also binds New interview creation to authenticated profile discovery
and the same durable command ledger, with exact receipt recovery. Native selection and the CLI's
mock constructor remain separate; no live creation profile is enabled.
The default entry still connects to no daemon, account or user data. It is not the default app, it is not packaged or released,
and it does not change the GPUI or Swift apps or their build. Those apps stay
the shipping desktop apps until Day passes native acceptance and cutover.

The native crate now also contains the Day-owned `pilot-desktop` executable
(`macos-host` feature). It embeds the unchanged release's public AppView and
keeps screens in TSX. Close and Quit save/seal forms and join the native root
before stopping the engine. It requires verified packaged resources and an
explicit native selection; it is not a new `apps/day/nsh.sh run` entry or a signed
release. Its app-only controller now joins the existing READY/COMMIT protocol
to that owner and verifies receipt-only successor restore/startup. Missing signed
payloads remain unavailable. Source-matched packaging and real signed replacement
acceptance remain separate. See [the executable handoff](../../docs/technical/day-executable-handoff.md).

## Upstream pin

- NSH **v0.4.0**, peeled release commit
  `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`, not upstream `main`.
  Tag resolution was checked on 2026-11-10. The annotated tag is unsigned:
  this verifies release identity, not a signing identity.
- Every NSH dependency, including declarations and testing, names that exact
  Git commit. The installed CLI must report `nsh 0.4.0 (e626a8d)`. No local
  `nsh-cli` builds, patches, forks, Cargo cache edits or WebViews.
- The release CLI's generated workspace (`.nsh/rust`) points its hosts and
  the app at the same resolved release checkout. Keep the real Cargo locks;
  never relabel a lock from the former `530b7317` main snapshot.
- [Release source qualification](../../docs/technical/day-nsh-release.md)
  records provenance, API coverage and remaining native acceptance gaps.
  Day does not change `apps/desktop/nsh`'s pin.

## Run and test

For a user-launchable, separate demo installation, see
[Local Pilot Preview](../../docs/development-preview.md). Its builder uses
the installed NSH packager and `Preview.tsx`, not the production bootstrap.
It never opens a visible window during its checks.

Verified on macOS arm64 with the installed v0.4.0 CLI (2026-11-10): `check`,
`build`, App (26), Plan (19) and Attention (4) headless tests, plus 49 native
library/boundary tests. The native crate checks all targets. All ran offline
through mbx with private dependencies/cache/targets, debug info and incremental
off, one Cargo job. No CLI build or visible window. Native host injection,
window constraints, IME, live updates and packaging are not accepted by these
checks. See the [qualification report](../../docs/technical/day-nsh-release.md).

Historical main-snapshot evidence on macOS arm64 (2026-11-10, `530b7317`,
**not release qualification**): the CLI, native crate and generated
describe/headless runners compiled through mbx. The former wrapper passed
`check`, `build`, App's 26 headless tests and Attention's 4 tests. Direct native
library/boundary checks pass 49 tests. No visible window was launched; macOS
window-host compilation, live development rebuilds and packaging remain unverified.

From the repository root (Rust 1.99.1 and macOS Command Line Tools installed):

```sh
mbx --version                    # mise-managed tool on PATH
apps/day/nsh.sh run               # opens the mock Day app locally
```

mbx is a **local compiler cache and build scheduler**, not a remote Mac build
service. Cargo still compiles cache misses on this Mac. No server address,
credentials, `mbx setup`, shell activation or service changes are needed.
The wrapper uses mise-managed `mbx` on `PATH`. `NSH_DAY_MBX` can name an
executable explicitly. Missing mbx fails, never falls back to direct Cargo.
The repo does not download mbx or prefer old copies in `.tools/bin`.

`nsh.sh` uses an **installed** CLI: `nsh` on `PATH` (including Homebrew),
otherwise the official distribution at `~/.nsh/bin/nsh`. `NSH_DAY_CLI` can name an explicit
installed executable. It must report `nsh 0.4.0 (e626a8d)`; another version or
the unrelated `nuta/nsh` command shell is refused. Keep the whole installed
distribution together, since the CLI finds runtime resources beside itself.
The wrapper never builds `nsh-cli`, clones/switches source or installs tools.
`NSH_DAY_SOURCE` is no longer used. Cargo runs offline; missing dependencies
are a setup blocker, not permission to download or change shared caches.
The CLI runs in `apps/day`; entry paths are relative to it.
Fresh generated workspaces are seeded from `runner.Cargo.lock`, the release
runner's real resolved lock. Existing workspace locks are never overwritten.
This keeps upstream's locked, now-yanked crypto dependency usable without
editing NSH or the registry index.

The v0.4.0 config does not support the newer `window` key. For an isolated
preview at the former size, use `apps/day/nsh.sh run --window-size 1100x820`.
Minimum-size and custom window-title configuration remain a native host gap;
no visible preview is run by checks.
From any directory, `apps/day/nsh.sh <command>` works by its absolute path.
Avoid `pnpm day`: pnpm can switch versions before the wrapper starts.
For the repository TypeScript check, run `apps/day/scripts/typecheck.sh`.
It requires the existing workspace compiler and never installs dependencies.
For `nsh.sh check`, the wrapper passes that compiler as `NSH_TSC` and refuses
`--tsc` overrides. NSH 0.4.0 otherwise downloads TypeScript from npm itself.
The NSH wrapper disables package-manager version management, lifecycle scripts,
and Corepack network access for children. These settings do not control tools
launched before the wrapper or arbitrary downloads by other programs.

A prior `pnpm typecheck` switched to pnpm 12.18 and ran node-pty and
protobufjs lifecycle scripts in workspace-private node_modules despite the
ignore-scripts-only authorization. This does not establish shared-system impact
or prove cleanup.

All four commands keep NSH's supported `CARGO` hook pointed at
`scripts/cargo`. This adapter uses mbx's own Cargo-shim dispatch, covering
native check/test, metadata, generated declarations/describe runners,
headless test runners and the macOS host, including development rebuilds.
It does not wrap UI execution in a compiler reservation. The CLI, describe and
test executables, TypeScript checking and native UI all run locally. This is
not CLI-only caching and does not patch NSH or Cargo's source cache.

Day uses the existing `gpui-fixture-mbx-v1` cache and CPU2/4GiB scheduler pool.
An explicit `MBX_CACHE_DIR` remains explicit. Mise owns the mbx version;
the repo does not pin or install it. Target adoption/views and automatic collection
are off, so Day does not move targets or delete other worktrees' caches. Remote
cache access and Blaze are off. Scheduler admission is an estimate, not an OS
CPU/RSS limit. Private targets still need free disk; caching is not a speedup
promise. Do not share a writable target with another running build.

Rust defaults to Day's 1.99.1 pin for app compilation; explicit
`RUSTUP_TOOLCHAIN` and real `CARGO` selections are kept. App `CARGO_TARGET_DIR`,
profile variables and command arguments are kept. The installed CLI is not
compiled. To reduce initial disk use, set
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0` for the command. No global Cargo
config is changed. Non-macOS builds and cross targets are not qualified here.

```sh
cd apps/day
./nsh.sh run                     # the decisions world, in a native window
./nsh.sh run Trouble.tsx         # also Actions.tsx, Asks.tsx, Quiet.tsx, Large.tsx, Pulse.tsx, Offline.tsx, Unreadable.tsx
./nsh.sh run FirstUse.tsx        # start and end of day: also Evening.tsx, Quiet.tsx, Trouble.tsx
./nsh.sh run Interview.tsx       # planning: also NewMission.tsx, Wayfinder.tsx, Review.tsx, PlanTrouble.tsx, Held.tsx, Long.tsx, PlanOff.tsx
./nsh.sh run Changes.tsx         # kept changes: also ChangesTrouble.tsx, ChangesEmpty.tsx, ChangesOff.tsx, ChangesLarge.tsx
./nsh.sh run Update.tsx          # updates: also UpdateTrouble.tsx, UpdateRefused.tsx, ServiceAbsent.tsx, ServiceDenied.tsx, ServiceOffline.tsx, ServiceNewer.tsx
./nsh.sh run Connected.tsx       # the connected entry: without a native root it says it is not connected
./nsh.sh check && ./nsh.sh build # types against the Rust declarations, class check
./nsh.sh test App.test.tsx       # headless flows, boundary and sandbox (26 tests)
./nsh.sh test Ritual.test.tsx    # start and end of day and standup notes (10 tests)
./nsh.sh test Plan.test.tsx      # New, interviews, maps and review, Today's Planning, and the planning boundary (21 tests)
./nsh.sh test Changes.test.tsx   # Changes: list, exact reopen, Later, lost answer, unavailable, Read again, diff selection and scroll, boundary (13 tests)
./nsh.sh test Update.test.tsx    # updates and registration: save, pause, restore (help, ritual, question), selective resume, stale, lost answer, refusals, boundary (10 tests)
./nsh.sh test Attention.test.tsx # agent questions, unavailable help, drafts and links that report nothing (4 tests)
./nsh.sh test Native.test.tsx --target macos  # native captures and input, in output/
(cd native && ../scripts/cargo test --locked) # Rust rules through mbx too
```

`native/tests/connected.rs` runs `Connected.tsx` headless on the released host channel, through
one `Bridge` over the canonical `DayRoot`. One test needs no daemon (an unreadable selection and the
flush answer); the journey test uses an isolated daemon with a forked faux kernel
(`packages/daemon/src/fixtures/day-planning-enrollment.ts`, so it needs the repository's Node
dependencies). After its restart, Today's Planning row opens the saved interview. Three more tests
play the root with a scripted channel of the same exact names and its change-notice gate (no
daemon): Today's planning list when it is empty, refused, over the limit or changed, Read again,
invalidations that never read the service, a page older than the list, and an answer saved to its
own mission after another mission was opened, then flushed. All are part of the native `cargo test`
above.

`native/tests/connected_update.rs` plays the same root for updates with native-shaped `ServiceView`
values (no daemon or updater): uncounted agents say Unknown, a prepared app guard and a refused or
unavailable prepare are never "Updated", a flush carries the exact saved view and answers only the
newest generation, a refused save answers no flush, and a cold restore shows its view once and
sends nothing else.

`native/tests/connected_ritual.rs` sends the ritual calls through one real `Bridge` over a root
with a test clock (reads write nothing; exact context and revision; another day, zone or user is
refused; a lost write is Unknown and not replayed after a cold reopen; saves wait during a flush),
then plays the root for `Connected.tsx`: one visit after Today shows, steps resumed after a
reopen, Done and Skip saved, Escape saving nothing, a lost save never resent and no clock said.
The joined fixture also runs Connected.tsx on the real Bridge, NativeHost and journal with
readable synthetic HTTP/WS Today and an injected clock. No providers or Node services run.

Script-only checks need neither Cargo nor NSH and never open a window:

```sh
shellcheck -x apps/day/nsh.sh apps/day/scripts/{cargo,build-env.sh,typecheck.sh}
```

The build wrappers use the installed tools directly. There is no separate
Python wrapper-test suite or mbx probe to run before normal builds.

The historical main-snapshot checks used mbx 1.26.0, Rust 1.99.1, offline dependency resolution,
debug info off, incremental off and one Cargo job. Owned subprocess observations
confirmed mbx's `mbx-rustc` wrapper, the CLI's separate target, and native plus
generated `.nsh/rust` check/describe/test commands writing to private targets.
Actual rustc arguments matched debug-zero/no-incremental settings. Tracked source
and Cargo.lock bytes stayed unchanged; the final command sequence exited zero
and its remaining children drained. Logical growth, including the copied CLI
cache, stayed under 8 GiB, with more than 97 GiB free. These are build-path
checks, not native product acceptance or a cache-hit/speedup claim.

A copied target is not a promise of a fresh build: this run still scheduled
dependency work through mbx. A scheduled compiler wrapper alone proves neither
a cache miss nor a cold build. The linker also reports a large `__eh_frame`
compact-unwind warning; exception-unwinding performance was not measured or
worked around. The status-bar capability warning remains expected in the mocks.

Before qualifying a build path, inspect **actual owned compiler subprocesses**,
not just the launching shell's environment or Cargo metadata. Record the parent
Cargo command/manifest and toolchain, rustc's `--out-dir`, `-C debuginfo` and
`-C incremental` for both the native crate and generated `.nsh/rust` runners.
Do not build the CLI. NSH may select a different target from the
one expected; a parent environment value is not proof that a child used it.
For a debug-zero, incremental-off verification, unexpected debug/incremental
flags or an output directory outside the approved private targets stop the
owned build. Stop and join its children before another build or publication.
Do not patch NSH or a dependency cache to fix a profile mismatch.

## Fixtures

`fixtures/` holds optional evidence that is not part of the app. No app entry
point, script or build uses it, and `tsconfig.json` excludes it.

- `fixtures/rust-today/`: the same Today screen written in Rust only, for the
  stack comparison. It depends on `native/` and `theme.json` as plain Rust and
  shares the `Desk::pulse` update workload. It is its own Cargo workspace.
  [fixtures/rust-today/README.md](fixtures/rust-today/README.md) has its
  parity matrix, hooks and commands.

## What it shows

### The connected window

`Connected.tsx` is Day on a real Pilot service, kept apart from the default mock entry. Its native
owner opens one `NativeHost` for an explicit selection, wraps it in the canonical `DayRoot` and a
`Bridge`, and gives the window that bridge's host channel
([released host boundary](../../docs/technical/day-public-bridge.md)). `bridge.ts` adapts the
exact JSON calls to the same shapes the screens already use (`feeds.ts`): `ConnectedToday` and
`ConnectedPlans` mirror the latest read in one signal each, read again on `day.changed` (which
carries no data), and send each intent once. A lost reply is Unknown and only Check looks it up.

Today's Planning lists every mission in planning from the root's complete, passive inventory, those
that wait for the user first. The window reads it once (`day.plan.inventory`) before Today shows,
and Read again reads it again. An invalidation reads only the root's cached list
(`day.plan.inventorySnapshot`), so reading never causes another invalidation. A complete empty list
hides the section. A list that could not be read, was over the limit, changed during the read or is
no longer current shows no rows and says so, apart from having none. Read again is not offered when
the service changed or Pilot is closing. A row opens that mission's saved interview and plan. A
planning page read before a later list that names a newer interview revision or round, or one a
change reached without a new read, says it is an older read. Saves, the submission and its check go
to the mission whose page shows that interview, never to whichever mission is open now. Back on
Today, the scroll offset comes back and the row that was opened takes the keyboard focus. Nothing
here starts work.

Help, link opening, direct chat start, Start, budget grants and continuation after a human action
stay unavailable here and say so. The screen never names a profile, port, path or credential.
Without a native root (`nsh run`, `nsh test`), the window says it is not connected instead of
showing examples; a first read that fails says why. "Mock data" shows only on mock entries.

On `day.flush` (the lifecycle owner's request before a close or an update), the window saves every
waiting interview answer and Today draft, waits for each answer, and only then sends
`day.flush.ack`. If any save was refused it sends nothing, so the owner never closes on a guess.
The native owner still has to capture attached inputs and preedit, stop the engine and await
`Bridge::close`; Drop is not that. Nothing selects a root for the user yet, and the stock runner
is qualification only. The connected window's `nsh.json` must declare exactly the bridge's method
names (the tests copy the entry with one); the default app's `nsh.json` stays deny-all.

The mission path runs through four screens without a sidebar: Today, New, the mission's planning
(interview, proposed plan and the separate steps from answers to work) and the mission's overview
(reports, Plan, Pause, tasks, working chats). The overview's "Interview and plan" opens the
planning, and the planning's "Mission overview" goes back once Today's read has the mission. A
mission without a saved interview says so on its planning page. Opening an overview asks Rust to
read that mission's detail again (`TodayFeed.openMission`); it sends and settles nothing.

### Motion

`motion.tsx` holds the one motion treatment, built only from upstream NSH motion, layout
animation and transitions. It has three moves and nothing else:

- **Arrive** (180 ms fade with a 6-point rise, easing out): a screen, the card in front of
  "Needs you" (after J/K or when an item leaves), an interview question and the answers page.
- **Glide** (180 ms layout animation): items that arrive or leave Today, missions that change
  group, the next card coming forward, help panels, the Pause and direct-start confirmations, and
  the interview card between questions. Collapsible sections keep `nsh/base`'s own reveal.
- **Ease** (150 to 200 ms color and opacity transitions): buttons and state marks.

Rules: motion follows what Rust already published and never stands for a send, a save or an
answer; there is no motion on success. Controls are live from the first frame, so Stop, Pause and
Submit are never delayed. Nothing loops, flashes or bounces. A new motion interrupts the one
playing and transitions start from what is on screen. Focus, text selection and scroll position are
not moved by motion; a glide only animates frames the update already changes. When the user asks
for less motion, Arrive lands at once (NSH's own rule) and glides are skipped; the short color
eases stay.

Not verified yet: headless tests cannot show motion, so how it looks, its frame rate, interruption
under fast J/K or typing, and layout stability need a visible native check (not authorized). The
`Pulse.tsx` workload may glide on every group change; its cost is unmeasured.

### Today

Today follows the selected D design: the coordinators' headline, one item
under "Needs you" in front with "Up next" below it, missions split into Moving
and Not moving, results since the user last looked, and what is coming up.

A decision card has "Say it simpler", "More context", "Show me" (a small chart
with the artifact revision it comes from) and questions answered inside the
card. A question shows as asking until its answer comes; a lost answer stays
unknown and only "Check again" reads it. An answer to a decision that changed
since the question says so. Help never picks, sends or approves. The user
picks an option (Pilot's recommendation is preselected) and presses Decide,
Confirm or Approve, or puts the decision off with Later. A pick belongs to the
revision it was made on: if the decision changes, the user picks again.

An action card is for something only the user can do outside Pilot, such as
the Chrome Web Store upload in `Actions.tsx`. It says "Action for you", never
Approve, and shows the one next step, why Pilot needs the user, the exact file
(name, version and digest), where it goes, its link and the chat that asked.
The user saves progress, puts it off with Later, or reports it done in their
own words. Opening the link or the file reports nothing. A report is kept as
the user's word: Today says Pilot has not checked the store. If the agent
replaced the file first, the report is refused as stale and the draft stays.
A lost answer stays unknown until "Check again" reads the receipt; nothing is
sent twice.

Keyboard triage works while Today shows: J and K bring the next or previous
item forward, 1 to 9 pick an option, S, C, V and Q open simpler words,
context, the chart and a question, L puts the item off and Command-Return takes
its one next action (Decide, Confirm, Approve, Check again or Mark done). After
the user's own triage the focus lands on the card in front: the chosen option,
else its first help, or Later on an action card. Letters and digits type into a
question or report instead; Escape leaves the field, keeps its draft and
returns to the card. Drafts, picks and open help are kept per item.

Worlds: `decisions` (default), `quiet`, `trouble` (a lost confirmation, an
unconfirmed push, a lost answer to a question, a paused mission, a lost Pause
answer and a Pause that does not finish everywhere), `actions` (one decision
and the Chrome Web Store upload: the zip is replaced before the first report,
and the next report's answer is lost), `large` (204 missions, 123 results),
`offline` (the last read, 6 minutes old), `unreadable` (nothing read),
`firstUse` (the user's first look: nothing to catch up on) and `evening`
(nothing waits, three results since the afternoon) and `asks` (one agent
question that takes the user's own words, with no help available).

Start and end of day. Today's date line quietly offers "Start the day" in the
morning and "End the day" in the evening, and always "Standup notes". The part
of day, the local date and whether the user looked before (`part`, `date`,
`visit`) come from Rust's `Today`; when they are unknown, Day offers neither
ritual. The start of day has three short steps with visible progress: what
happened since the user looked (or, on a first look, that there is nothing to
catch up on), where they left off and the latest results; what needs them; and
each mission's next step in its agent's own words, with what is scheduled.
"Decide now" only brings Today's first item forward. The end of day is one page:
results since the user looked, what still waits (it stays on Today), missions
that are not moving or have no current report, what keeps moving, and, after
"Close the day", where tomorrow starts. Standup notes list Done, Next and
Waiting as selectable plain text. Every result names what it rests on (an agent
report, a landing Pilot saw, or the user's acceptance: `DoneEntry.basis`, an
agent report unless known), every plan its report's age and currentness, and a
read that is not live says so. Rituals read Today only and send no intent:
skipping, leaving or closing one answers, approves and starts nothing. "Skip for
today" and finishing a ritual stop Today offering it for that date once the
mark is saved; Escape leaves it unmarked. Next and Back save the step, so the
start of day resumes there. No schedule is created or turned on.
The connected window saves these marks, the step and Today's visits through
the root's [saved ritual progress](../../docs/technical/day-ritual-progress.md)
(per profile, user, date and time zone, in the existing ledger). A lost save is
never resent: Today says it is not confirmed until Read again confirms it.
Without a native clock the window says rituals are not available. Mock entries
keep marks in memory for the run and save nothing.
The production macOS root now binds the OS wall clock and system timezone,
not a screen date or development override. It refreshes on focus and a local
30-second worker tick (including after wake); unavailable time stays unavailable.

Missions come only from agent reports. A current report that says moving puts
a mission under Moving; one that says not moving, or a Pause, under Not
moving. A mission with no current report (none yet, an old one, or one that
could not be checked) goes under "No current report", never under Not moving.
Working chats and task counts are shown as facts, not as movement. Rows show
who reported and how long ago; named evidence is marked as not checked.

A mission row opens the mission overview (Escape or "‹ Today" goes back): its
latest report, tasks with their agents' reports, the chats working now, and
the Pause control. Pause asks first, shows Pausing until the service returns
a receipt that says paused, and lists each member chat. A Pause that does not
finish everywhere stays Pausing and names what needs a look. A lost answer
stays Unconfirmed; only "Check again" settles it, and it only reads. Resume
names the exact Pause it resumes. Pause and Resume need a live read: offline,
the last read stays on screen and the controls are off. `Pulse.tsx` runs the large world with the
shared update workload: `Desk::pulse` moves the next moving mission on every
100 ms, adds a result every fourth time, and publishes the whole read model,
300 times. `TodayFeed.pulse` is for measurements only, not a user intent.

New (the button on Today, or Command-N) asks what the user wants done. "Plan a
mission" starts a mission whose questions come first; "Start as one chat"
starts one Build chat directly, after the user confirms the exact words,
project, model and access. A mission's planning page shows its interview. Pilot
saves the whole question list first; the interview card shows one question at a
time, starting at the first without an answer. Back, Next (or "Skip for now"),
"All answers" and "See all questions" reach any question. Suggested answers carry
their number key (Pilot may mark one Recommended): 1 to 9 picks one, and pressing
it again clears it; 0 opens one text field for the user's own words or detail
to a pick; Return moves on and Escape leaves the field. A later round holds new
questions only; earlier rounds stay as read-only history with their answers,
apart from the plan's approval. Answers save as drafts, in any order, and come back
after leaving; switching a suggestion keeps the text. A recommendation, a
skipped question or a blank draft is never an answer. The last page lists every
answer by section with the one Submit, which stays off until every question of
the round is answered; saving, moving or See all never submits or continues
anything. A question that changed after it was answered shows the earlier
answer and needs a new one. A round whose plan changed keeps its answers but
cannot be submitted. A lost submission stays unknown until "Check again" reads
it. A later round holds new questions only. Answers together have a limited
room (12 KiB, the daemon's limit); a quiet note shows when it runs low, and a
save past it is refused with the text kept. One round holds at most 40
questions (`Long.tsx`).

A Wayfinder mission also shows its map: where it should end up, the saved map
revision, a one-line count, what is open now, what waits and for what, folded
settled questions, a folded Fog of war (why each area matters, when it is ready
and what it became) and the agreement with its published tasks. Each question
names its kind (Needs your answers, Needs research, Needs a prototype) and opens
to its record: the exact question, its sources, the fog it came from, a
prototype's finding with what it left open, and, for a question settled in an
interview, that round's submitted answers. A cited decision or Knowledge entry
that changed or went away since Pilot mapped it says so; Pilot updates the map,
and nothing on the page answers, approves or starts anything. The rows read the
daemon's shared `view.map` projection, the same object the planning
coordinator reads (`native/tests/plan_map.rs`). A Wayfinder mission's overview
shows the map in one line. Making prototypes stays unavailable. A topic interview
answers only its topic. A proposed plan shows in full (problem, solution,
stories, how it is built and tested, what is left out, its tasks with their
order and owners, and what is still unknown) above the review question. A plan
that changes during review closes that review. "From answers to work" keeps
submission, continuation, approval, publication and starting work as separate
steps. In the connected entry, a published plan offers a separate Start work confirmation.
It names one ready task and the resolved model. Only Start task admits that background worker;
approval, publication, opening the page and cancelling start nothing. Other tasks do not auto-start.

`PlanFeed::from_host` (Rust only) binds the planning screens to the native
host's saved interview reads, saves, submission and exact receipt checks
(`native/src/plan_host.rs`, with the backend's own question digests). There,
Native New can create an interview; standalone chat start stays unavailable.
The default entry remains mock-only.
"Pilot continues planning" follows a bound planning worker's phase and says it is
not connected otherwise. Native Start binds the exact published revision, digest, task and current
project/owner. "Work admitted" is not running, progress or acceptance: the existing mission overview
shows the agent's report. A lost acknowledgement offers Check Start only, including after reopen.
Stopped/reconfigured owners, paused missions and unavailable authority cannot Start. This reuses
the existing Build/model/price-cap/lifecycle policy; it adds no Build spending cap or grant.
The CLI mock does not start a real worker. Earlier rounds show every submitted round and its saved answers in order,
including after reopening. They are read-only, not current answers or approval.
A mission without a saved interview says so instead of
showing an empty plan.

Changes (the Changes button on Today) lists finished work Pilot kept a
snapshot of: "To review", "Later" and "Earlier", each newest first. Only
kept snapshots show, not every change in the project. A kept change that
could not be read keeps its place as a note; it is never counted as none.
When kept changes cannot be read at all, Changes says so and never shows an
empty list. A row reopens one exact snapshot: the date it was kept, its head
and base commits, what was not kept, and a link to a newer snapshot of the
same change when there is one. "Diff" shows the exact kept patch in NSH's
read-only `DiffView` (one column, changed words marked, long lines wrapped,
each file under its own header, only rows in view made; no hunk actions). The
diff has no frame of its own and fills the rest of the page under the
snapshot's facts, which stay in place while the diff scrolls. A line number
selects its line with a see-through tint, so the code stays readable. Rust
shows the patch only when its bytes match the saved digest and every part of
the read names the snapshot asked for.
"History" lists saved reviews (an approval is of that snapshot, at that
time), landing checks, review requests and, on request, the full snapshot
identity. The review request is current at the read; a landing is the last
time Pilot saw the exact commit on the default branch, never a promise
about today, and "not checked" never means "never landed". Reopening
approves nothing. Later (or L) puts a waiting review off and Bring back
returns it, each naming the request and revision shown; neither approves,
reviews or resumes anything. A lost answer stays unconfirmed until "Check
again" reads the saved operation; nothing is sent twice.

"Read again" (on the list, and on the unavailable note) reads the whole list
again. It sends nothing and settles no unconfirmed answer; only "Check again"
does. A reopened snapshot that cannot show now says why and offers to read
that same snapshot again. A list stopped by its read limit says more exist
and shows none of them, never a partial list.

Changes' default entry runs on mock data shaped as the daemon's v1 kept-change contracts
([landed-changes.md](../../docs/technical/landed-changes.md)), read through
serde mirrors (`native/src/changes_contract.rs`) and one projection
(`changes_project.rs`). `ChangesFeed::from_host` is a Rust-only factory for
the trusted native host. It reads every oldest-first page across the selected
project's retained sessions, then publishes a complete feed. Limits or unreadable
sources produce Unavailable, never a successful partial or empty feed. Exact
reopen, revision-fenced Later/Bring back and lookup-only recovery use the existing
daemon routes and private native journal. The bootstrap still needs to supply this
feed. Natively, `refresh` and `more` both queue one new complete read: a refusal
known at once (no current access, a closed host, a busy queue) says so, and
otherwise the answer only says the read started. Writing review comments from
Day is not built: the daemon keeps private review drafts with line anchors, but
the native host does not reach them yet. The mock "Read more" adds the next page.

Updates (the top bar's "Update ready", "Register Pilot" or "Update not
confirmed", shown only when Pilot's service needs the user) open one page:
whether the service is registered and answering, this app's and the
service's versions, the offered update and the agents it touches. "Update…"
asks Rust for a one-use confirmation that names the exact versions, how
many working agents pause and how many paused by the user stay as they are.
A count Rust could not take says so ("Pilot cannot count them yet"), never
zero. Confirming first saves every form to its own store (Today's drafts and
interview answers); a refused save stops there and keeps the text. Then
Rust gets one exact `SavedView`: the screen under the page, New's unsent
goal, the item in front, open help, each interview's question and See all,
the ritual on screen and its step, scroll offsets and the last focused
field with its selection. After the restart the window starts fresh, shows
that view again without sending anything and acknowledges it once. The
acknowledgement only says the view was shown: the service resumes the agents
it paused on its own, and a ritual comes back only on the same date. A lost
answer shows "Update not confirmed" and offers only Check again, which reads.
A refusal before anything started says so and leaves nothing unconfirmed. A
stopped run says what was not changed and what to do. Restoration limits
(preedit, late-loading screens) are listed in the update pipeline.
Registration is explicit and its lost answer is only looked up. The default entry runs
mock rules (`native/src/update.rs`). The connected entry now reaches the independent
native updater through exact HostChannel methods and the existing root worker/journal.
A confirmation saves a capture request; only the native owner can seal the final form-save
generation and enter the trusted controller. App guard preparation is not replacement,
and a restore ACK resumes nothing. Production signed Day packaging, controller/startup handoff
and joined update acceptance remain unavailable (see
[the update pipeline](../../docs/technical/day-update-pipeline.md#day-update-controls)).

Not built yet: the day switcher, Automations, the sky
dither, selecting a root for the user's own daemon (the connected entry takes one from its
native owner) and opening a chat from the mission overview. The default entries use mock worlds.
Decisions, actions, help answers, results and Coming up come from mock worlds,
not from contracts. The
mock help and action services in `native/` follow the attention contracts
([decision-assistance.md](../../docs/technical/decision-assistance.md)).
`TodayFeed::from_host` (Rust only) binds the cards to the native attention transport: agents'
ordinary questions and human actions, saved drafts (picks, own words, questions, notes) for the
exact revision shown, the user's Later, exact receipts and lookup-only checks
([attention cards](../../docs/technical/day-native-host.md#attention-cards)). An agent's question
takes the user's own words (0 opens the field) and preselects nothing; `Asks.tsx` shows that shape
on mock data. Help that the daemon reports unavailable is said once on the card and its keys send
nothing. Dependent-work continuation stays unavailable, and a report never starts work. Links stay
text unless the native root supplies its permission-checked opener; then "Open link" opens only the
daemon's pinned link and reports nothing. The default entry still uses mock data.

## Boundary

| Owner | What |
| --- | --- |
| Rust (`native/`) | The `Today` read model, every rule for changing it (`Desk`), revisions, delivery state (idle, sending, unknown, checking), the v1 contract mirrors (`contract.rs`) and their projection (`project.rs`), control commands, and mock services used by fixtures |
| Trusted native host (`native/src/host.rs`) | Explicit profile/home/project selection, authenticated loopback reads, invalidation-only WS, private control journal, exact receipt lookup and joined close. Not activated by the mock entry. |
| Rust planning (`native/src/plan*.rs`) | The planning read model and intents (`plan.rs`), the mock rules (`plan_desk.rs`), mock worlds (`plan_world.rs`) and `PlanFeed` |
| TSX | Layout, copy, and screen state: picked option, open help, question drafts, the decision in front, unsaved answer text and picks |

TSX imports `TodayFeed`, `PlanFeed`, `ChangesFeed`, `RitualFeed` and `UpdateFeed` from `pilot-day/native`. Their generated
declarations (`.nsh/types/pilot-day/native.d.ts`) are the whole contract:

- Read: `snapshot(): Today`, `onChange(listener): () => void` and
  `mission(missionId): MissionPage | null`. TSX mirrors the model in one signal
  that only the listener sets, and reads a mission page again on each change.
  `openMission(MissionRef)` asks Rust to read one mission's detail again; it only reads.
- Connection: `Connected.tsx` uses the root's exact JSON calls through `bridge.ts`, adapted to the
  same `DayFeed`/`PlanningFeed` shapes (`feeds.ts`). TSX cannot name or change the service.
- Intents: `decide(DecideIntent)`, `later(DecisionRef)`, `check(DecisionRef)`,
  `ask(AskIntent)`, `checkAnswer(AnswerRef)`, `saveProgress(ProgressIntent)`,
  `actionLater(ActionRef)`, `complete(CompleteIntent)`, `checkAction(ActionCheck)`,
  `pause(PauseIntent)`, `resume(ResumeIntent)` and
  `checkControl(MissionRef)`, each returning an `IntentOutcome` (accepted,
  stale, rejected, unknown). Intents are `#[prop(exact)]`: an unknown key or a wrong type is a
  `TypeError` in the call, before Rust acts.
- A Pause names only the mission and the control revision shown; a Resume
  also names the Pause shown. Rust adds the home, project, coordinator and a
  new operation ID, and records the command before sending. TSX cannot supply
  them (`native/tests/boundary.rs` checks the declarations).
- Decision and action intents, questions included, name the revision shown.
  An action request also carries a new operation ID and digest that Rust adds
  and records before sending (`native/src/actions.rs`). A changed decision is `stale`. A
  second send is refused. A lost confirmation leaves the decision `unknown`; only
  a read-only check can settle it, and nothing resends.
- Planning (`PlanFeed`): `snapshot`, `onChange` and `page(missionId)` read, and
  `open(missionId)` asks Rust to read one mission's saved planning;
  `plan` and `start` name the goal and the setup digest shown; `saveAnswer`
  names the interview, its question-list revision, the question and its digest
  as the user saw them when they typed or picked; `submit` names the saved
  answers' revision and, for a review, the plan's digest; `checkSubmit` only
  reads. Rust adds owners, fences and operation IDs. A save never submits and
  never continues the coordinator; a second submission is refused.
- Changes (`ChangesFeed`): `snapshot`, `onChange` and `change(snapshotId)`
  read; `open` reads one exact snapshot; `later` and `bringBack` name the
  snapshot, request and request revision shown; `checkAttention` only reads;
  `more` reads the next page and `refresh` reads the list again. Rust records
  the operation before sending. A changed request is `stale`; nothing here
  approves or reviews.
- Updates (`UpdateFeed`): `snapshot` and `onChange` read; `prepare` names
  the kind and revision shown and returns a one-use confirmation; `confirm`
  names that confirmation and carries the exact `SavedView`; `cancel` drops
  it; `check` only reads; `restored` acknowledges a saved view once. TSX
  never names a target, version, service, profile or process.

`nsh.json` declares `"capabilities": {}`, so the screen's VM may not use the
network, sockets, files, processes or host calls. `BoundaryProbe.tsx` tries a
loopback `fetch`, a socket, a file read and a process; the test checks that all
four fail with `ERR_ACCESS_DENIED`.

`pilot_day_native::fixture::today(Scenario)` and `Desk` are plain Rust. A
Rust-only Today screen (`fixtures/rust-today`) renders the same read model.

## Findings from the spike

- **Feasible.** Typed read models and intents cross with no NSH changes:
  `#[class]`, `#[derive(JsObject)]`, `#[derive(PropEnum)]`, `Callback` posts and
  `Stop` cover the boundary, and `nsh check` type-checks TSX against Rust.
- **Capabilities must be declared.** Without a `capabilities` key, TSX has
  unrestricted network access, including the loopback daemon. Sockets, files,
  processes and host calls are denied either way.
- **Entries must sit next to `nsh.json`.** The bundler reads capabilities and the
  theme from the `nsh.json` beside the entry. An entry in a subdirectory
  silently ran with network allowed and the default theme. All entries here
  are at the app root.
- **The sandbox fences screen code, not the crate.** Rust exports are the
  authority. A production boundary must keep the export list small and free of
  transport, paths or credentials (`native/tests/boundary.rs` checks this).
- **Whole-model updates.** Each change posts the full `Today` to TSX. Today
  keeps at most 20 results, so this stays small here; the cost with live,
  frequent updates is unmeasured and belongs to the comparison.
- Every test run warns that the status bar is not granted. It is harmless on
  the desktop.
- Headless tests prove behavior, not the look. Captures from
  `--target macos` are mock captures, not production acceptance. Hardware
  keyboard, IME composition and real scrolling were not exercised.
