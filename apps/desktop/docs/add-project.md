# Add an existing Local folder

## Native workflow

`workbench_view.rs` exposes **Add project…** beside project browsing. The same
action in `chat_projects.rs` remains available when the new-chat catalog is
empty. `project_add_navigation.rs` captures existing input without changing page,
chat, selected project, permissions, delivery payload or reader/editor entities.
Preedit and unsaved/private-write faults refuse new registration. A retained
receipt can be inspected read-only after a fault without clearing that fault.

The sheet uses shared `ui` header, text, notice, rule and actions. Its left-aligned
reading column, existing Page/Card/Tray/text/metadata tokens and system family
follow `design-system.md`, including the existing light/dark palette. One primary
action confirms registration; folder choice and read-only refresh are secondary.
No new palette, nested card grid, new animation or controls cleanup is included.
This deliberately extends project browsing, not the Jump palette or Settings.

**Choose folder…** uses GPUI's native `prompt_for_paths`: directories only, files
off, multiple off. Cancellation sends no HTTP request and keeps any prior choice.
The returned single absolute Unicode path is bounded to 4096 UTF-8 bytes. Folder
results carry a sheet epoch, so closing/reopening cannot adopt a late result.
Only **Add project** (or Command-Return) queues a mutation. Escape closes; closing
after submission cannot undo the request. The background courier owns its result.
No folder is created, repository cloned, agent started, chat created or message sent.

After acknowledgment, the catalog is refreshed. The user must explicitly select
the canonical project in browsing or the new-chat chooser; neither an old cwd-only
draft nor an immutable pending envelope is inferred/rebound by path or name.

## Audited contract and outcomes

- Swift `Settings.swift::addProject` calls native `chooseFolder`, then
  `PilotClient.createProject(ProjectRequest(path: …))`.
- `packages/protocol/src/index.ts::ProjectRequest` supplies `path`. This slice
  sends **only** that field to the existing `POST /api/projects` endpoint.
- `packages/daemon/src/server.ts` returns201 after `ProjectStore.create`.
  `projects.ts` requires a directory, normalizes the path, checks duplicates,
  assigns canonical ID/name/path, pushes into memory, then awaits persistence.
- This is **not** an operation/idempotency API. A failed/lost response, malformed
  or oversized201, or non2xx can follow mutation. Generic status/error strings
  never authorize automatic resend or a claim that nothing was created.

`project_registration.rs` pins existing Local hello identity/protocol before
bounded catalog preflight, then uses one path-only POST after durable private
Unknown admission. No proxy, redirect, Origin/auth fallback or request retry.
The loopback source comes from existing Local discovery, never an input URL.
The standard private writer captures/flushes edits before admission. Responses
are bounded before JSON decode (64KiB registration,2MiB catalog, including chunked
bodies). Catalog validation retains the existing256-project limit; a duplicate
current path refuses a new POST but does not prove a previous attempt's creation.
Existing source-qualified chat WebSocket behavior is unchanged.

A valid201 canonical project identity/path is an acknowledgment, not proof of
future availability or stronger daemon filesystem durability. A private receipt
settlement failure does not roll it back: the worker also retains that known ID in memory
for display after closing/reopening the same process's dialog, including a pre-I/O
16 MiB capacity refusal. The notice compares this memory acknowledgment against the
actual private record and warns when its receipt remains unconfirmed. It does not
mistake an unrelated later write error for loss of an already saved receipt.
If receipt persistence truly failed, process restart restores only the original durable
Unknown, not the lost memory ID, and still never replays it. The cap, retained data and
original pending delivery envelopes remain unchanged. Private I/O faults fence further writes. Refresh
errors retain previous project choices and are shown separately from registration
acknowledgment, never as a successful catalog refresh.

## Private recovery and bounds

The existing host-pinned, locked, atomic private Book retains an optional/default
`project_registrations` map (at most32). Unknown is stored before the sole POST.
Restart only loads it, never replays it. The same raw selected folder cannot be
submitted again under a different attempt ID while its record remains. At
capacity only an acknowledged receipt may retire; no Unknown is evicted. Full
Unknown capacity fails closed and keeps existing data.

Read-only catalog refresh observes current availability, not a creation receipt,
and cannot settle Unknown. Another explicitly chosen folder requires another
confirmation. The daemon remains canonical for paths and duplicate checking;
this client does not invent alias equivalence, claim cross-app exactly-once
creation or silently clear uncertainty. Preflight/validation failures before
private admission permit an explicit safe retry, not automatic retry.

Network work and private fsync remain on the existing single interaction worker,
with bounded5s HTTP timeouts and its bounded command/edit mailboxes. A submitted
registration may temporarily serialize later courier work while it awaits Local;
UI/native text remains live and unsaved edits remain retained in its mailbox.
There is no new always-on thread, subscription, poll, timer or render-time I/O.

### Capacity settlement regression

The focused follow-up reproduces a legal snapshot whose pre-POST Unknown fits at
`STATE_CAP - 8`. A canonical 36-byte UUID adds 34 encoded bytes, so local settlement
fails before I/O without setting `Store.is_faulted`. The actual interaction worker
must still retain the one faux 201's known ID through read-only refresh. Disk remains
Unknown, an unrelated original pending operation is byte-identical, and a restarted
store refuses resend even after the observed catalog is cleared. Dialog owner tests
separately distinguish same-process close/reopen from a fresh owner with no memory ID.
The existing atomic-write-fault case remains covered. No cap/schema/eviction or writer
change is needed; no live service/account actions were used.

Negative control `c9a59bd8-6809-4ce3-bbc1-6aa40f42e4a8` failed exactly at
`Err("Private state is full. Nothing was discarded.")` versus acknowledged `Created`,
on frozen `786a192c29f9bc7178635954e15da33abaadb3dc`; the earlier missing test-helper
borrow compile failure is a separate retained receipt, not reproduction evidence.
`e2efac33-c41d-4523-93cc-3a90db8fa023` passed matching lib Clippy and all six registration
plus four dialog tests on `a81968ef7d4b6ee5d291b4fbf0a14bb4a75d6b91`. The final notice
copy correction retains unrelated errors without mislabelling a saved receipt:
`16bc8185-d45e-4b11-a9ff-018ab946a013` passed matching lib Clippy and the four affected
dialog tests on `eb3b0a9ea0e7ab85629a41529b9c95ea0693621f`, tree
`fb150924255d887b66a14fa072d2a832ef660198`. Its 12-input PRE/POST snapshots were identical;
registration/store/writer inputs remain byte-identical to the qualified six-case run.
Only this results documentation follows those checks. D46 uses scoped tests, not a
full-suite/native sweep. The shared notice and layout are unchanged; no new native
pixel, OS dialog/IME, motion, performance, Linux or release acceptance is claimed.

Composition qualification after accepted bundled-runtime delivery preserved its 16
file blobs and the previous model-selection source. Only these six receipt-fix files
were applied atop `295ad854f3db1f7e9564bb71ffa00fc26e8d810c`, with an identical binary
feature delta to the earlier `1ed94276` candidate. No foreign dependents existed.
`927aa4de-2626-4adf-af36-953102e9075c`, EXIT 0: matching lib Clippy, six registration
and four dialog tests, frozen head `2abb8cd45c1e4d6895af9a030e877aad5c927bd9` /
tree `4a0dcd7465b0d58ff8c36a0da29eaa86015197e1` (empty checked child `e94c9725`).
The 28-input composition PRE/POST snapshots were identical, with diff digest
`cf8c296536ff05a26a7820dd2f91093278111f290fd665be5aa8493610c61510`.
Only this receipt paragraph follows the composition checks. No broader gate was run.

## Synthetic qualification

`project_registration_tests.rs` uses an owned faux loopback server and temporary
private state. It covers exact one POST, identity/catalog/path admission, lost
response, malformed/header-oversized/chunked-oversized bodies, non2xx after faux
mutation, retained Unknown after restart/current-GET changes, private admission
fault zero POST, known201 after private finish fault, and full Unknown retention.
`project_add_view_tests.rs` covers injected folder cancellation/error/bad paths,
late folder epochs/replies, duplicate confirmation, closed/unknown/private-fault
receipt handling and safe explicit preflight retry. These do not open OS dialogs.

The `project_add` native target mounts production LocalViewer, editor, sheet and
private writer at680/1100 in light/dark, injects folder outcomes, uses actual native
pointer/keyboard/preedit, checks contained mounted bounds, zero on cancellation,
exact one explicit registration and canonical refresh without chat/draft adoption,
and drains the private writer before fixture deletion. Captures are offscreen
actual GPUI, not SwiftUI mocks or visible animation, OS IME, Linux, performance or
full Swift parity acceptance. Existing navigation/reader/delivery regression
targets remain registered and must accompany final qualification.

Use shared admission and `scripts/cargo.sh`, not direct Cargo/global dependencies.
Fresh remote CI is separate; no real user folder/action, account, service/restart,
production auth, release, default switch or backend/permission change is tested.

### Completed source receipts

Final executable/test source `afee4b04a58a773b226cce9d75d91352391e730a`,
tree `4d5fcdc562b7c6ab0bb623dd67bedb356e398c70`, based on accepted
`1e251e4b6a6aec3ae96eee144eb392ea01b8801d`:

- **EXIT0**, job `37cefde8-911d-4b89-8ea5-24bca18c3b61`: actual shared serial
  admission and the complete existing `scripts/check.sh` wrapper. Visual-worker
  build/lint, formatting and desktop lint, **227 library tests passed** (three
  existing ignored workloads), **17 settings-state tests passed**, and all
  **20 registered native targets** completed, including existing input, reader,
  history, navigation, workbench, Settings, conversion and project guards.
  The four new width/theme cases each observed cancellation zero POST, exactly
  one explicit registration, canonical refresh, unchanged editor/reader/draft
  identity, preedit refusal and private flush. Eight fresh captures were retained.
- **EXIT0**, focused job `6525572d-1c4a-4c44-a8da-0aa815f86a3a`: strict all-target
  native-probe Clippy, five transport cases, three form cases, the actual
  LocalViewer private-fault/oversized-input guard, and all four native cases.
- **EXIT0**, inventory job `a4162f48-9331-4c99-89f7-099aff5c0110`: all **46 Python
  CI fixtures**, actual Node admission, after formatting and independently of
  the native gate. Existing `missions` and new `project_add` inventory retained.
- Each retained identical source/tree/tracked-diff and **29 file hashes** PRE/POST.
  This results-only addition followed terminal completion; the publication
  receipt maps tested source to documentation-only and then metadata-only commit.
  No executable, test, registration, dependency or wrapper bytes changed afterward.

Failed receipts remain failed: initial compile/test-import/unused-variable
issues, a native entry point missing production keyboard bindings (Escape's
assertion was retained), and job `43d9e0d1-f4f9-4496-b14d-32d86788ce0f` with
224 library passes/three visual-worker busy failures/three ignored. That last
invocation incorrectly omitted the repository wrapper's required
`--test-threads=1`; the complete passing wrapper above uses it without changing
production worker limits or visual-runtime code. No pass was transferred across
source changes or claimed for a failed invocation. Fresh remote CI remains separate.
