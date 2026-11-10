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

## Upstream pin

- NSH **0.4.0**, upstream `main` HEAD `530b73170f61e5bf16380959de9e622f8ce130cd`
  (committed 2026-11-09T18:17:26+08:00), rechecked with `git ls-remote` on
  2026-11-09. This is 184 commits after the `7571948` pin of `apps/desktop/nsh`,
  which Day does not change.
- Every NSH crate, and the `nsh` CLI, comes from that one revision. No patches,
  forks, Cargo cache edits or WebViews. The CLI's generated workspace
  (`.nsh/rust`) adds `[patch]` entries that point at Cargo's own checkout of the
  same revision, so hosts and the app share one `nsh-core`. That checkout was
  compared with a fresh clone: no differences.
- `native/Cargo.lock` started from upstream's lock. Without it, Cargo resolved a
  newer `rolldown` that does not build with this revision.

## Run and test

Verification status: script dispatch tests and the real mbx/Cargo namespace
preflight pass. End-to-end NSH compilation through mbx, effective nested compiler
profiles/targets and native launch have **not yet been verified** on this path.

From the repository root (Rust 1.99.1 and macOS Command Line Tools installed):

```sh
bash apps/day/scripts/bootstrap.sh # once: checksum-pinned mbx 1.26.0 only
pnpm day run                      # opens the mock Day app locally
```

mbx is a **local compiler cache and build scheduler**, not a remote Mac build
service. Cargo still compiles cache misses on this Mac. No server address,
credentials, `mbx setup`, shell activation or service changes are needed.
If mbx 1.26.0 already exists in Day's `.tools/bin`, the desktop project's
`.tools/bin` or `PATH`, bootstrap is unnecessary. `NSH_DAY_MBX` can name its
executable explicitly. Missing or different-version mbx fails, never falls
back to direct Cargo. Bootstrap does not install Rust or change its defaults.

`nsh.sh` clones the pinned revision into `.tools/nsh` (ignored), refuses tracked
changes, then builds the CLI **through mbx** with upstream's lock unchanged.
`NSH_DAY_SOURCE` may name an existing unmodified checkout at the exact pin
(relative to the calling directory or absolute). An explicit source is borrowed:
the wrapper never clones, switches or writes build output into it. CLI output
goes to this Day checkout's `.tools/target/nsh-<revision>`, not the borrowed
source's `target`. The CLI runs in `apps/day`; entry paths are relative to it.
From any directory, `apps/day/nsh.sh <command>` works by its absolute path.
From the repository root, `pnpm day <command>` is the same entry point.

All four commands keep NSH's supported `CARGO` hook pointed at
`scripts/cargo`. This adapter uses mbx's own Cargo-shim dispatch, covering
native check/test, metadata, generated declarations/describe runners,
headless test runners and the macOS host, including development rebuilds.
It does not wrap UI execution in a compiler reservation. The CLI, describe and
test executables, TypeScript checking and native UI all run locally. This is
not CLI-only caching and does not patch NSH or Cargo's source cache.

Day uses the existing `gpui-fixture-mbx-v1` cache and CPU2/4GiB scheduler pool.
An explicit `MBX_CACHE_DIR` remains explicit. mbx 1.26.0 is required to avoid
cross-version cache migrations. Target adoption/views and automatic collection
are off, so Day does not move targets or delete other worktrees' caches. Remote
cache access and Blaze are off. Scheduler admission is an estimate, not an OS
CPU/RSS limit. Private targets still need free disk; caching is not a speedup
promise. Do not share a writable target with another running build.

Rust defaults to Day's 1.99.1 pin for both CLI and app; explicit
`RUSTUP_TOOLCHAIN` and real `CARGO` selections are kept. App `CARGO_TARGET_DIR`,
profile variables and command arguments are kept. The CLI always uses its
separate dev target. To reduce initial disk use, set
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0` for the command. No global Cargo
config is changed. Non-macOS builds and cross targets are not qualified here.

```sh
cd apps/day
./nsh.sh run                     # the decisions world, in a native window
./nsh.sh run Trouble.tsx         # also Actions.tsx, Asks.tsx, Quiet.tsx, Large.tsx, Pulse.tsx, Offline.tsx, Unreadable.tsx
./nsh.sh run FirstUse.tsx        # start and end of day: also Evening.tsx, Quiet.tsx, Trouble.tsx
./nsh.sh run Interview.tsx       # planning: also NewMission.tsx, Wayfinder.tsx, Review.tsx, PlanTrouble.tsx, Held.tsx, Long.tsx, PlanOff.tsx
./nsh.sh run Changes.tsx         # kept changes: also ChangesTrouble.tsx, ChangesEmpty.tsx, ChangesOff.tsx, ChangesLarge.tsx
./nsh.sh check && ./nsh.sh build # types against the Rust declarations, class check
./nsh.sh test App.test.tsx       # headless flows, boundary and sandbox (26 tests)
./nsh.sh test Ritual.test.tsx    # start and end of day and standup notes (9 tests)
./nsh.sh test Plan.test.tsx      # New, interviews, maps and review, and the planning boundary (19 tests)
./nsh.sh test Changes.test.tsx   # Changes: list, exact reopen, Later, lost answer, unavailable, boundary (10 tests)
./nsh.sh test Attention.test.tsx # agent questions, unavailable help, drafts and links that report nothing (4 tests)
./nsh.sh test Native.test.tsx --target macos  # native captures and input, in output/
(cd native && ../scripts/cargo test --locked) # Rust rules through mbx too
```

Script-only checks need neither Cargo nor NSH and never open a window:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/day/scripts -p test_nsh.py
shellcheck -x apps/day/nsh.sh apps/day/scripts/{cargo,build-env.sh,bootstrap.sh}
```

The fake-executable tests cover dispatch, quoted arguments, source/target
isolation, missing/wrong mbx, failures, local execution and runtime signals.
They do not by themselves prove upstream subprocess coverage or native acceptance.

Before qualifying a build path, inspect **actual owned compiler subprocesses**,
not just the launching shell's environment or Cargo metadata. Record the parent
Cargo command/manifest and toolchain, rustc's `--out-dir`, `-C debuginfo` and
`-C incremental` for both the native crate and generated `.nsh/rust` runners.
Include the CLI's separate target. NSH may select a different target from the
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
today" and finishing a ritual stop Today offering it for that date; Escape
leaves it unmarked. These marks are screen state for this run of the app, not
saved across restarts, and no schedule is created or turned on.
The native host now has a separate [saved ritual progress seam](../../docs/technical/day-ritual-progress.md):
`RitualFeed` reads per-profile/user/date/zone marks, explicit visits and qualified
kept-change evidence from the existing ledger. Production ritual UI wiring is
still separate; the mock screens do not use or migrate those records.

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

A Wayfinder mission also shows where it should end up, questions that need the
user's answers, research with its state and sources, prototypes as not
available (until the prototype contract exists), and a folded Fog of war with
why each area matters, when it is ready and what it became. A topic interview
answers only its topic. A proposed plan shows in full (problem, solution,
stories, how it is built and tested, what is left out, its tasks with their
order and owners, and what is still unknown) above the review question. A plan
that changes during review closes that review. "From answers to work" keeps
submission, continuation, approval, publication and starting work as separate
steps; starting work is never on this page.

`PlanFeed::from_host` (Rust only) binds the planning screens to the native
host's saved interview reads, saves, submission and exact receipt checks
(`native/src/plan_host.rs`, with the backend's own question digests). There,
Native New can create an interview; standalone chat start stays unavailable.
The default entry remains mock-only.
"Pilot continues planning" follows a bound planning worker's phase and says it is
not connected otherwise; "Work started" stays unavailable (no agreement or build
admission). Earlier rounds show every submitted round and its saved answers in order,
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
read-only `DiffView` (one column, changed words marked, only rows in view
made; no hunk actions). Rust shows the patch only when its bytes match the
saved digest and every part of the read names the snapshot asked for.
"History" lists saved reviews (an approval is of that snapshot, at that
time), landing checks, review requests and, on request, the full snapshot
identity. The review request is current at the read; a landing is the last
time Pilot saw the exact commit on the default branch, never a promise
about today, and "not checked" never means "never landed". Reopening
approves nothing. Later (or L) puts a waiting review off and Bring back
returns it, each naming the request and revision shown; neither approves,
reviews or resumes anything. A lost answer stays unconfirmed until "Check
again" reads the saved operation; nothing is sent twice.

Changes' default entry runs on mock data shaped as the daemon's v1 kept-change contracts
([landed-changes.md](../../docs/technical/landed-changes.md)), read through
serde mirrors (`native/src/changes_contract.rs`) and one projection
(`changes_project.rs`). `ChangesFeed::from_host` is a Rust-only factory for
the trusted native host. It reads every oldest-first page across the selected
project's retained sessions, then publishes a complete feed. Limits or unreadable
sources produce Unavailable, never a successful partial or empty feed. Exact
reopen, revision-fenced Later/Bring back and lookup-only recovery use the existing
daemon routes and private native journal. The bootstrap still needs to supply this
feed; native refresh/currentness UI remains follow-up work. Writing review feedback
from Day is not built. The mock "Read more" adds the next page; native `more`
queues a new complete read and does not acknowledge its completion.

Not built yet: the day switcher, Automations, the sky
dither, bootstrap selection for the delivered native daemon host and
opening a chat from the mission overview. The default entries use mock worlds.
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

TSX imports three classes, `TodayFeed`, `PlanFeed` and `ChangesFeed`, from `pilot-day/native`. Their generated
declarations (`.nsh/types/pilot-day/native.d.ts`) are the whole contract:

- Read: `snapshot(): Today`, `onChange(listener): () => void` and
  `mission(missionId): MissionPage | null`. TSX mirrors the model in one signal
  that only the listener sets, and reads a mission page again on each change.
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
  `more` reads the next page. Rust records the operation before sending. A
  changed request is `stale`; nothing here approves or reviews.

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
