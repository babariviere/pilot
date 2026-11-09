# Native mission planning

Backend and trusted kernel profile, with authenticated native saved-state reads and human answer
ingress through the [Day host](day-native-host.md#saved-interviews-and-planning). Creation-only enrollment,
worker-profile IPC and planning-only continuation are implemented for explicitly enrolled new flows.
Desktop New/bootstrap, build admission, automatic research dispatch and live activation remain
unavailable. Existing missions and running work are not enrolled, restarted or changed.
Transport fixtures are not native screen acceptance.

## Audit and reuse

The interview/agreement delivery already supplies `MissionInterviews`, append-only
`MissionInterviewStore`, `WorkflowConfirmations` and `OperationJournal`.
[Its boundaries](day-mission-agreements.md) remain in force. Saved selections and exact custom
text are not submission; submission is not workflow approval or worker admission.
The source coordinator already has fresh read scope, the normal Pi resource loader and a
host-captured skill-reader allowlist. Runtime packaging already copies the whole kernel skills tree.

The missing pieces were native map/fog records, planning-specific routes and a capability-limited
adapter for upstream publication instructions. Those now share `missions.sqlite`, its existing
transaction/replica and `durable()` barrier. No parallel tracker or markdown output is created.

## Actual upstream sources

`packages/kernel/skills/mission-planning/UPSTREAM.md` pins mattpocock/skills commit
`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` with MIT attribution. Wayfinder, its explanatory
reference, to-spec, to-tickets, research, prototype and prototype references are byte-exact.
Required grilling/domain-modeling resources remain in the existing interview bundle at that commit.
No setup skill, global installation or personal skill overwrite is needed.

`NativeAdapterOptions.missionPlanning` is a trusted `NativePlanningPort`, not a model flag.
It requires the existing non-read-only coordinator source profile, loads the real resources,
refuses missing/shadowed entries, installs `mission_plan` and appends an explicit native adapter.
Paths resolve relative to the runtime module after packaging/relocation.

The dedicated profile denies generic mission writes, shell/file tools, jobs, subagents, updates
and all MCP tool calls, including nested codemode calls. Its only mutation surface is the bound
native planning port. Upstream Notes, tracker instructions, local-file fallbacks, research branch
instructions and ready-for-agent labels cannot expand this surface. The host still checks scope,
permissions, lifecycle and journal identity independently. Trusted extensions are not a sandbox
for arbitrary hostile extension code.

## Native records and routes

`MissionPlans` is the daemon adapter. The host binds `NativePlanningPort.read` to `view` (or exact
historical `read`), `knowledge` to the linked same-project Knowledge reader, and `write` to journaled
`admit`. It must keep a complete durable envelope per call ID. A new envelope after an uncertain
call is not recovery. Bind `receipt` to passive exact-envelope journal lookup within this mission;
the tool's `check` action cannot invoke a handler. `PlanningWorkers` now binds that port through
versioned private worker IPC. The native human ingress cannot impersonate this coordinator port.

- Use Wayfinder for unclear multi-session routes. Bounded work uses the existing grill-with-docs route.
- `plan-map` saves destination, source locators, precise planning questions and coarse in-scope fog.
  Questions have human/research types, real dependency edges, saved choices/recommendations and claims.
  The view exposes Needs grilling and Needs research separately. These are not implementation tasks.
- Existing active decisions are reused by exact record digest, without asking the user again or
  creating another decision. Resolved questions cannot be rewritten or silently removed.
- `plan-claim` uses exact CAS and current mission membership. The frontier is unresolved, unclaimed
  questions whose precise dependencies resolved. It grants no execution permission.
- Fog saves area, why it matters, readiness/dependency cues and source locators. It is distinct from
  exclusions, decided facts and precise questions. `plan-promote` atomically links one or more precise
  questions and marks the fog inactive. Historical snapshots keep its original meaning and provenance.
  Stale promotion and double promotion refuse. Fog itself never becomes an automatic blocker.
- `plan-ask` opens one unblocked Needs grilling topic as a saved, topic-specific full-list round.
  The coordinator supplies the complete current question list, suggestions and free-text slots for
  that topic. The round pins its topic and context digest; it cannot answer another topic.
  Human selections or
  custom text use the existing native-only answer/submission seam. The agent tool cannot save or submit
  human answers. Partial drafts stay saved. Question meaning, option identity, destination/context and
  question-set revisions fence reuse. New dependent questions require a new full-list round.
- `plan-resolve` accepts an exact submitted human round or explicitly linked settled decision for human
  choices. Research uses linked, revision-pinned Knowledge and cannot resolve a human choice. A saved
  recommendation is never an answer. Knowledge readers preserve provenance and checked/unchecked status;
  a linked research result is not independent verification of its claims.
- `plan-propose` saves upstream to-spec sections and to-tickets vertical slices. Slices need acceptance
  criteria, story traceability, real acyclic dependencies and explicit Opus UI/Sol backend ownership.
  This validates structure, not the truth of a model's claimed agreement or verticality.
- `plan-review` binds the full proposal digest to a saved review round. The integrating native UI must
  show the complete spec, test seams, task breakdown, dependencies, ownership and unresolved fog beside
  that round, not merely the digest. Human revision feedback does not approve publication. Exact explicit
  approval selection plus complete submission is required. Any proposal/map amendment clears this review.
- `plan-publish` writes the existing brief record and ordinary native `todo` tasks in one transaction.
  Slice-to-task IDs and spec revision are saved in the immutable snapshot; tasks link stories, acceptance
  criteria, ownership and real native dependency IDs. Existing tasks are unchanged. No workers start.
  Unresolved fog stays explicit in the spec, never guessed or converted into automatic dependencies.

The exact submitted review remains in interview history. Workflow confirmation binding also records
the native planning publication identity and includes the exact published brief. Changed briefs,
questions, answers, owners and context invalidate approvals through the existing admission fences.
Publication is not approval/admission. Existing model/permission/review/delivery gates still apply.

## Durability, concurrency and recovery

`mission_plans` is append-only, with per-mission monotonic revisions and complete operation identities.
Reads pin state and authorization across durability. Writes recheck owner, membership, mission evidence
and expected revision after journal I/O, then atomically save native effects and their receipt snapshot.
Replies follow durability. Concurrent promotions, claims and publication cannot overwrite each other.
Owner transfer/ABA refuses instead of inheriting authority.

Entered recovery is exact lookup only, including restart. Missing snapshots/checkpoints or failed
durability remain pending (Unknown), never replay. Lost publication ACKs cannot create duplicate tasks.
Fresh publication operations refuse after the first committed task publication, even after a new proposal;
reviewed amendments to already-published tasks need a separate update adapter, not duplicate creation.

## Worker enrollment and return boundary

`planning-enroll` is a purpose-bound, native-capability-authenticated operation on the existing
operation endpoint. Its exact payload names a fresh owner ID, project, title, requested goal/model,
profile source/version and current project-configuration digest. It creates only a new
planningVersion 1 mission and a new coordinator. It cannot adopt an existing chat or mission.
Authenticated `GET /api/projects/:project/planning-profile` supplies that versioned profile and
backend digest without enrollment or model work. Native clients must keep this digest, not hash a
Rust/UI serialization. `PlanningEnrollment` in `planning-workers.ts` is the exact creation payload.
The [native New binding](day-native-host.md#new-interview-creation) now keeps that exact payload in
the host command ledger. A Rust-selected source/model and an authenticated, current prepared setup
are required. Existing-mission reads keep `enrollment: unavailable`; they cannot enroll or adopt work.
The mock CLI is unchanged. This API is not live activation or permission to enroll existing work.

The transaction saves an **empty, unsubmitable bootstrap**, not invented human questions. The new
session's metadata pins its enrollment, owner, project, exact home/daemon lineage and upstream profile
before worker startup. `KernelSpec.planning` loads the actual trusted skills and binds only native
planning IPC. Generic mission writes, MCP writes, ordinary chat sends, model-continuation transfer,
shell fallback and builder admission are not alternative paths.

The profiled worker saves its complete first list with `mission_plan` action `questions`. Later
`questions`, `plan-ask` and `plan-review` operations save whole new rounds. `planning_workers` saves
a provisional hold **before** the round operation can enter effects. After the exact snapshot is
durable, the tool returns that round and saves the matching hold in the worker's durable Harness.
Its outer tool result terminates the turn; there is no promise waiting for human answers.
Recovered held work never reconstructs a lost tool stack or consumes a historical input.

Every question in the current list needs an explicit option selection or nonblank custom answer.
Skipped questions and displayed recommendations do not count. Limits are **40 questions, 12 KiB for
the question list, 8 options per question, 12 KiB for answers and 4,000 UTF-8 bytes of custom text per
answer**. Oversized lists refuse rather than silently drop questions. Presentation can show one
question or all questions; navigation and autosaves have no continuation effect. Later rounds contain
new clarification questions only. Reusing a previously submitted question ID or exact prompt refuses;
skill guidance requires specifically framed follow-ups rather than semantic repetitions. The host
does not claim to detect every paraphrase. Append-only interview snapshots keep earlier submissions.

Explicit complete submission saves its exact continuation envelope in the **same SQLite transaction**
as the answers/agreement snapshot. Only that fresh submit may request one planning-only continuation.
The adapter waits for the previous turn's idle boundary, checks current owner/membership/allocation
context, model/permission configuration, Stop generations, pause/input controls and lifecycle gates,
and invokes the exact guard inside native input admission after asynchronous preparation. The native
hold, exact operation receipt and one Harness input commit together. It does not clear Stop, drain
someone else's queued inputs, grant workflow/review approval or start builders. Build admission still
needs its independent approval, assignment, permission and review adapters.

Call envelopes are kept by exact tool-call ID. Pending/entered recovery and lost ACKs use exact
saved-effect/native receipt lookup only. Restart, GET, receipt checks and duplicate submissions never
resend historical inputs. A missing receipt remains Unknown. Newer Stop/holds, owner changes,
replaced rounds, changed context and uncertain admissions refuse without replay. A provably rejected
round operation with no saved effect may release only its own provisional hold. Storage is limited
to 512 kept call envelopes and 128 native planning admissions per enrolled flow; full stores refuse.
Close aborts idle waiters, joins entered tools/admissions and drains writes before storage closes.

## Integration gaps

- Day's planning screens (`apps/day`: New, one-question interview with See all, Wayfinder map, full
  proposal review) run on mock worlds and, through `PlanFeed::from_host`, on the native host's saved
  human ingress ([apps/day/README.md](../../apps/day/README.md)). The screens are not native acceptance.
- Native bootstrap/New binding and screen acceptance remain Day host/UI integration work. The worker
  adapter makes no native visual changes or acceptance claim. Human reads report `preparing` with no
  editable view until questions exist, and answers are unavailable until the round hold is saved.
- The typed research frontier is passive in this delivery. Automatic linked research execution needs
  a qualified event-driven scheduler/session adapter with Autopilot, permission, budget, Stop/pause,
  lifecycle and exact-operation receipts. No live research automation is activated or implied.
  Research admission is a separate integration task. Its records can bind the exact question ID,
  question digest and enclosing monotonic plan revision, dependencies and linked evidence. No extra
  build-task conversion or second tracker is needed for these planning records.
- Research/prototype creation remains separately authorized work. This profile cannot create branches,
  external issues, files or prototypes. It reads and links authorized Knowledge evidence.
- This does not rename Brief to Spec in UI/API/storage, write a glossary, change settled decisions,
  deploy, restart, release, cut over or remove legacy apps.

## Focused verification

`mission-planning-skills.test.ts` exercises the normal loader, trusted reader, exact upstream hashes,
relocation, collision refusal, native port surface and direct/nested external-write denial.
`mission-plans.test.ts` covers persistence/restore, fog promotion races/history, frontier/dependency
changes, settled-decision reuse, explicit human versus research evidence, saved choices/text, stale
rounds/revisions, traced publication, spec invalidation, permissions, owner ABA and Unknown/no replay.
Existing interview, workflow, journal and coordinator source suites remain the regression gates.
