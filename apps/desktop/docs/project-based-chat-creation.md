# Project-based Local chat creation

Use New chat, choose a configured Local project, then type the message and create
with Enter or the button. Search by name or canonical ID; duplicate names or
folders remain separate choices. The selected ID and cached configured path are
shown before creation. Ask remains the default; existing chat controls and
permissions are not inherited or promoted. Adding/importing projects is outside
this feature. The sidebar’s browsing scope never silently assigns a destination.

## Identity and private persistence

Each new private draft stores an optional `projectId`, without changing its file
schema version or importing Swift preferences. Old unsent cwd-only drafts retain
their text and folder, but no project is inferred from that folder. Choose a
project explicitly before creating. Already queued legacy operations retain their
exact original payload, operation ID, target, sequence and hash, even if they
contain only a cwd. Pending/unknown/created destinations cannot be retargeted by
selecting another project. Check/Retry still reconciles or reuses the existing
immutable operation; startup never automatically resends it.

The same single-owner interaction writer flushes native edits, checks the pinned
Local hello, then reads the bounded existing project catalog before preparing a
**new** creation attempt. It requires the chosen canonical ID and cached path to
still match. Removed, changed or unavailable choices fail before reservation and
POST; text/selection remain available. This read is not a new atomic filesystem
or project-path CAS. The daemon remains the authority for current project and
workspace resolution at admission.

The supported durable `chat-create` operation carries the existing SpawnRequest
`projectId`, message and mode, **without a cwd override**. The selected project,
not the title/path of an unrelated chat, determines association. There is no new
endpoint, backend/protocol change, project creation or legacy POST fallback.

## Native interaction and lifecycle

The app-owned FieldRow wraps the existing searchable Kit Select. Only the active
new draft owns a chooser; source-captured callbacks refuse stale events after
navigation. Search preedit blocks confirmation and navigation. Normal navigation
retires the popup and restores its trigger before moving focus. Current message
text is captured before a destination change. A loading, empty, invalid or failed
catalog blocks creation without erasing a draft or replacing a retained choice.
Catalog validation is derived from current catalog state, not stored as a save
error. After recovery, the same chosen ID/path and unchanged message can be
submitted explicitly, including after pressing Enter during loading or an error.
Recovery never creates an intent or submits automatically, and never clears an
unrelated private-write or unsaved-input fault.
Pending operation controls keep their original identity and cannot change mode or
project. A removed selection stays visible as unavailable, never falls back to a
similarly named/path-matching project.

Catalogs remain bounded to 256 projects; the existing 128-draft, 32-intent,
32-KiB-message and 16-MiB-private-snapshot limits, coalesced autosave and flush
protocol are unchanged. Catalog/chooser synchronization is keyed by Arc identity
and selected value, not repeated on each streaming update or render. The existing
worker performs project I/O; the UI adds no polling, worker or per-frame tasks.
This does not establish a measured scrolling/typing performance improvement.

## Synthetic verification and source mapping

All checks use owned faux loopback HTTP, temporary private state and synthetic
content. No real chat creation, send, Stop, approval, credentials, service install
or daemon reconfiguration is exercised.

The first standalone source `a4d960a49519a4e67a89634d14c2c9b41e797dcc`, tree
`240774058f1caa043c3b0d0eed63d8baa3d1d272`, passed strict all-target Clippy and
eight actual native composer/Select/courier cases (680/1100, light/dark, accepted
and lost-after-admission) with 16 captures. Job `bc6e982b-fc60-4e0e-9a1d-28fc8688543c`
emitted identical 21-file source/hash/diff receipts before and after. These older
receipts are not automatically transferred to the subsequently integrated source.

That private source was based on accepted `ecec6e8a…`. A later accepted main
`ed791a68dfb282c3fadf1ff447e379b4c2bc9c2d` introduced actual conflicts in three
native-registration files. Only this private feature was rebased to resolve those
conflicts, preserving both mission-conversion and project-creation probes. No
merged source or another topic was rewritten. Final integrated qualification is
recorded with the PR and its exact tested source, not inferred from the older pass.

The native harness mounts the actual production ChatEditor and Kit picker in an
explicit synthetic component frame, not a mocked HTML/SwiftUI rendering or a
claim of the whole LocalViewer. It drives actual pointer/keyboard search/selection
and Escape cancellation, empty/loading/error states, duplicate submission guards,
exact canonical-ID operation payload, faux HTTP canonical project readback, lost
reply reconciliation without a second create, and private Store reopen. Original
full LocalViewer shell/navigation probes separately cover integration and real
project-search preedit. Pure/transport cases cover legacy drafts and immutable
pending-envelope restart, removed/path-changed catalogs and stale picker events.
Offscreen captures do not prove OS IME, accessibility, visible animation, Linux
desktop or full Swift parity/performance acceptance.

## Completed integrated qualification

Exact source `0b46658c1ac4903e9f79b51e6a63d7434662f748`, tree
`b2a99dad9f86a6fa97ed7361bd0be7abb906b877`, based on accepted main
`ed791a68dfb282c3fadf1ff447e379b4c2bc9c2d`:

- `44f01105-c946-4031-9a67-7aad6983edbe`: formatting, visual worker build,
  strict all-target native-probe Clippy, **197 library tests passed** (three
  explicitly ignored workloads), **17 Settings-state tests passed**. Original
  `shell`, `navigation`, `workbench`, `settings` native targets passed, plus all
  **20 mission-conversion cases** and **eight project-creation cases**, with
  **16 fresh project-creation captures**.
- `7b7ee8ab-39a2-4aa2-a6ed-22277b3cbabe`: **46 CI inventory/orchestration
  fixtures passed**, including the combined native probe inventory and required
  project-creation invocation.
- Both jobs used actual repository verification-slot admission, with identical
  **22-file source/lock/hash and tracked-diff receipts before and after**.
  All checks terminated before adding this results-only documentation. The PR
  records that documentation-only and final commit metadata mapping explicitly;
  no executable/test/registration bytes change after qualification.

The original full shell probe’s removed folder-input portion now exercises the
actual project-search preedit, retaining its navigation, draft and late-receipt
assertions. Native project selection uses genuine pointer clicks on the passive
identified option child, bubbling to Kit’s real list selection, or Arrow/Enter;
it does not call a test-only choice setter. Mission regressions remain registered
and executed alongside project creation. No failures were hidden by reducing the
CI inventory or removing assertions. Initial compile failures were retained as
failed receipts; they are not passing native results.

Run the relevant checks under the real shared verification slot:

```sh
cd apps/desktop
bash scripts/cargo.sh clippy --locked --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked --lib -- --test-threads=1
bash scripts/cargo.sh test --locked --test settings_state -- --test-threads=1
PILOT_NEXT_PROJECT_CREATE_DIR="$PWD/target/project-creation" \
  bash scripts/cargo.sh test --locked --features native-probes --test project_creation
```

The native target is included in the existing check/CI inventory. No workflows,
runner roles, CI quarantine rules or release/default-switch behavior are changed.

## Transient catalog recovery regression

Pressing Enter during loading or a catalog error used to cache that derived
validation in the generic save-error field. Healthy publication and same-choice
reselection could not retire it without a message edit. The fix keeps validation
derived; it does not clear any error fields or change persistence or delivery.

The new pure recovery case and actual native component case both failed against
unchanged production code at source `8eb13f1eb17e340e4557a36c17ccdbc6ca2cce0d`,
tree `6ccdb028193fced59da2489e38676dc25bb8779a`. Failed job
`0f589803-5923-4c8b-877f-34c952f92c96` retained identical PRE/POST receipts.
The native failure was the still-disabled Create button after healthy publication
and same-ID/path reselection, with the unchanged message and no intent or POST.

Final source `9e805c546269e9e449627a71196123b6a0165e06`, tree
`15dd2dd8a7e982da12f5bd7b51adf9155a74c3c7`, based on accepted main
`4b89df9406930a51b0d0dd55112b69c2ac265cfd`, passed job
`e60f0c7a-0be8-4307-b50b-0abf8d043d4f` under actual shared-slot admission:

- Formatting and strict all-target native-probe Clippy.
- **199 library tests passed**, three existing explicitly ignored workloads.
  This includes original delivery/immutable-operation guards and new controls
  for real temporary snapshot write failure and oversized unsaved input. The
  write failure is projected through the normal editor `accept` entry point;
  catalog recovery/reselection leaves both kinds of fault fenced and unchanged.
- Original **shell**, **navigation** and **workbench** native targets passed.
- All **eight native project cases** passed (680/1100, light/dark, accepted/lost
  reply), producing **16 fresh captures**. Each captures a chosen project and
  message before error/loading, presses Enter without reservation or POST,
  publishes a healthy catalog, reselects the same canonical ID/path without
  editing the message, then explicitly submits. Duplicate input remains fenced
  to one operation/POST. Lost-response reconciliation and restart preserve the
  exact destination and never create a second chat.
- Source/tree/tracked-diff and all eight recorded file hashes were identical
  before/after. These results-only paragraphs were added after completion; the
  publication records that docs-only mapping. No executable/test bytes changed.

The earlier focused after run `b60a345d-794e-4e14-b220-4aca59847a84` also passed
15 composer tests and the eight native cases, but predates strengthening the
write-fault control. Only the final-source results above qualify that control.
Everything remains synthetic and offscreen, not live actions or full desktop,
OS IME, Linux, animation/performance or acceptance evidence.
