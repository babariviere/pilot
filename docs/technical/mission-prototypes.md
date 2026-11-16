# Mission prototypes: prototype chats

Status: steps 1 to 4 are built. Step 5, the live check, is next. Where the build differs from the first plan,
this document says what was built and why.

## Problem

The planner can put a **prototype** question on the map (`kind: "prototype"`), but nothing makes the prototype.
[Native planning](day-mission-planning.md#prototype-exploration-contract) says "Automatic prototype execution is not
implemented", and Pilot Day shows "Prototypes are not available yet". The planner's instructions still tell it to
wait for prototype evidence and the user's feedback.

On 2026-11-15 and 16 the Pilot Day mission stopped three times on one item, "Prototype a clear Today update-error
experience", which the user asked for. Each time the planner ended its turn with "Planning awaits Today
recovery-prototype evidence and feedback". Unstick offered Continue, and Continue only started the same wait.

## Already built

- **The prototype question contract** (`PlanQuestion.prototype`): `context`, `experimentType` (`ui` or
  `logic-state`), `smallestExperiment`, `maxMinutes` (1 to 480) and `maxCostUsd` (0 to 10).
- **`plan-prototype-result`**: the planner saves the evidence against the exact question and map context.
  The evidence names one artifact revision linked to the mission, observations, a verdict and unresolved questions.
  It goes stale when the question or the map context changes (`prototypeCurrent`).
- **NSH artifacts from Ask chats**: an Ask chat can publish an NSH artifact (one TSX file). The artifact tool
  writes only that file, in the chat's own `scratch/artifacts/` ([NSH source](nsh-artifact-source.md)).
  Nothing else in the project changes.
- **A safe preview in Pilot Day**: NSH revisions run in an isolated engine with no host capabilities, network,
  files or credentials (`ArtifactPreview`, `artifact_runtime.rs`). The mission's artifact shelf already uses it.
- **Mission artifact links** (`MissionStore.linkArtifact`, table `artifact_links`), pinned to a revision.
- **Research chats**: a dispatcher that starts read-only explorer chats for ready questions, claims the question,
  reads the chat's last answer and passes it to the planner (`reconcileResearch` in `planning-workers.ts`).
- **A mockup of the flow**: `apps/day/fixtures/prototype-wayfinder` (a prototype chat works, saves a finding,
  then the user reacts to it).

## Decision

A **prototype chat** is a research chat with a different message. It is an Ask-mode explorer chat in the
mission. It needs no new role, mode or permission. It publishes one NSH artifact that holds the variants behind a
variant switcher, with mock data and state kept in memory. When it ends, Pilot links that artifact revision to the
mission and tells the planner. The planner saves the evidence with `plan-prototype-result` and asks for the
user's feedback in a normal interview round. In that round, Pilot Day shows the prototype in its isolated preview.

The prototype is evidence for one named uncertainty. It is not production code, acceptance or permission to
build. The user's feedback, in the interview, is what settles the question.

## User flow

1. The planner saves a prototype question, as it does today. When the question's dependencies are settled, the
   map shows it as ready.
2. Pilot starts a prototype chat for it. The map and the chart show "A prototype chat is working", with a link to
   the chat. The user can read the chat, as with research.
3. The chat ends. Pilot links its prototype to the mission and passes it to the planner.
4. The planner asks about it in an interview round. Above the questions, **The prototype** shows its card. The prototype
   opens below the question, in the isolated preview, and the user switches between the variants.
5. The user answers (picks a variant, combines parts, or asks for changes) and submits as usual.
6. If the user asks for changes, the planner can unclaim the question. Pilot then starts one more prototype chat,
   which reads the earlier prototype and the feedback.

## Daemon

### Dispatcher

Add prototypes to `reconcileResearch`, beside research. Keep the same records (`PlanningWorkerState.research`,
by question ID) and add `kind: "prototype"`, so restart, claims and failures behave the same.

- **Starts:** a ready, unclaimed `kind: "prototype"` question on the frontier, when the planner is not working
  and no review is open (the same conditions as research).
- **Chat:** `sessions.spawn` with `mode: "ask"`, role `explorer` and `mainView: true`. The model is the one the
  planner chose for the question (`prototype.model` and optional `prototype.thinking`). A question without a
  model waits for the planner to choose one. Pilot checks the model when the map is saved and refuses the save with the allowed
  models. The title shows the limits: "Prototype: <title> (up to 30 min, $3)". The mission's worker cap applies, as for research.
- **Claim:** `plan-claim` with the chat's session ID, as for research.
- **Message:** the question, its prototype metadata and these rules:
  - read `pilot-artifacts` and its NSH guide, and the upstream prototype `UI.md` or `LOGIC.md`;
  - publish one NSH artifact with every variant behind a switcher, using mock data that looks real and state kept
    in memory;
  - use no live data, credentials, network or real actions;
  - end with a short report: what each variant shows, what the user should compare, and what stays open.

### When the chat ends

1. Pilot reads the chat's NSH artifacts from the artifact store. It takes the newest one and its latest revision.
2. Pilot links that revision to the mission (`linkArtifact`, actor Pilot). The chat is a mission member, so the
   existing check passes.
3. Pilot keeps the chat's last answer (at most `RESEARCH_REPORT_LIMIT`) and sends it to the planner in the same
   `plan-research-result` input as research findings, with the artifact pin (`sessionId`, `artifactId`,
   `revision`). Reusing that input needs no change to the planning worker's input kinds; the text tells the
   planner what to do with a prototype.
4. If the chat published no NSH artifact, the input says so and passes the report. The planner decides: unclaim
   for one more attempt, change the question, or ask the user without a prototype.

### Limits

These follow the "Limits" rule in `CODING_STANDARDS.md`.

| Limit | Value | What it protects | Why this number | When reached |
| --- | --- | --- | --- | --- |
| Prototype chats per mission at once | 1 | The user's attention: they review one prototype at a time | One round asks about one prototype | The next one waits. The map says "Waits for the prototype before it" |
| Attempts per question | 2 | Cost, and a loop with no progress | The same as research: one first try, one after feedback | The planner gets "Pilot made 2 prototypes for this question; ask the user how to go on" |
| Time | The question's `maxMinutes` | Cost | The planner sets it for this experiment (1 to 480, already checked) | Pilot stops the chat and passes what it published, with "stopped at its N-minute limit" |
| Cost | The question's `maxCostUsd` | Spend | The planner sets it (0 to 10, already checked) | Shown on the map, in the round and in the chat title. Not enforced (decided by the user) |

The worker cap and Pause, Stop and dispatch holds still apply. Pilot never starts a prototype while the mission
is paused.

### Round fingerprint

Linking an artifact adds an `artifact` event to the mission, and `artifactEventId` is part of the held round's
fingerprint. A prototype chat that ends while the user answers another round would then stop that round's submit,
as research chats joining did (fixed in `9064dae2`). Leave `artifactEventId` out of the round fingerprint
(`authority(binding, true)`), with a test.

## Planner

Change the prototype paragraph in `packages/kernel/src/mission-planning-skills.ts`. Keep it short:

- Pilot makes a prototype for each ready prototype question in a separate chat. Do not wait for evidence in the
  same turn; end the turn.
- On the prototype result: save `plan-prototype-result` with the given artifact pin and observations from the
  report, then ask the user with `plan-ask` (`topicId` = the prototype question ID). Settle the question only from
  the user's answer.
- With no artifact or weak evidence: unclaim once (`plan-claim` `claimedBy: null`), or ask the user how to go on.

Remove "This profile cannot create/execute previews" and keep the rules that a prototype is not acceptance or
permission to build.

## Pilot Day

- **Map and chart:** set `prototypes.available` from the daemon, and remove the "not available yet" line.
  A running prototype chat shows like a research chat ("A prototype chat is working"), as the chart already
  supports (`ExpeditionChart.tsx`).
- **Interview:** when the round's topic is a prototype question with current evidence, its questions show
  **The prototype** above its questions, with its limits (`RoundPrototype.tsx`). Pilot Day reads the pinned revision through the mission artifact read and shows it in
  `ArtifactPreview`, one at a time, as the artifact shelf does. If evidence is stale or the preview is not
  supported, it shows "This prototype is out of date" or the source, and the user can still answer.
- **Keys:** not built. The card is a normal focusable button.

## Unstick

- A prototype chat works for the mission: **moving**, "A prototype chat is working on <title>."
- A ready prototype waits for its slot: **moving**.
- The planner is idle, and the only open items are prototypes that already used both attempts: **stuck**, with fix
  `continue` and the note "Ask the user how to go on with <title>." This fix sends a planner note, not a bare
  Continue, so it cannot loop like today.

## It never

- changes project files, runs commands or uses credentials (Ask mode);
- answers for the user, settles a question or treats a prototype as acceptance;
- starts build work or tasks;
- starts while the mission is paused, or more chats than the worker cap allows.

## Steps

Each step ends with tests and, for user-visible steps, a capture from fixtures.

1. **Daemon dispatcher and planner input.** Prototype entries in the research records, the start, claim, link and
   the prototype result input, the time limit and the round fingerprint change. Tests in
   `planning-research.test.ts` style: a ready prototype starts one chat; its artifact is linked and passed once;
   no artifact; time limit; restart during a run; a held round still submits when a prototype ends.
2. **Planner instructions.** The prompt change and a test that the skills text names the prototype result.
3. **Pilot Day.** `prototypes.available`, the round's **The prototype** card and the preview. Tests with a
   fixture mission; captures in light and dark.
4. **Unstick.** The three rules above and their tests.
5. **Live check.** With the user's permission, let the Pilot Day mission make its waiting prototype
   ("Prototype a clear Today update-error experience").

## Decisions

- **Model:** the planner chooses it per prototype question (`prototype.model`). A question without one waits:
  Unstick says so, and Continue asks the planner to choose. There is no default.
- **Writes:** a prototype chat is an Ask chat. It writes only its artifact file, in its own
  `scratch/artifacts/`, which is safe for every agent. No new role or permission.
- **Cost:** shown, not enforced. The time limit stops a chat that runs long.
- **One artifact per chat:** a prototype chat publishes one NSH artifact with every variant in it. Pilot links
  the newest one.

## Risks

- **Preview support.** The isolated preview runs on macOS only. On other clients the user sees the source. Step 3
  shows a plain message, and the user can still answer.
- **Weak prototypes.** A chat in Ask mode cannot run the app or take screenshots. The prototype is a mock in NSH,
  not the real screen. The interview says so.
- **Cost.** Each prototype is a full chat. The one-at-a-time limit and two attempts keep this small. The time
  limit stops a chat that runs long.

