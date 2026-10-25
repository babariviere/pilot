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
write fault does not roll it back: the worker also retains that known ID in memory
for display after closing/reopening. Private faults fence further writes. Refresh
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
