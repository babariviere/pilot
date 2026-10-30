# Everyday macOS parity inventory

Historical slice inventory. For current source-backed remaining work and proposed
ticket supersessions, use the [macOS finish checklist](../docs/finish-checklist.md).
The Missing/Partial labels below describe the original checkpoint, not today.

Compared with the retained Swift app, from desktop checkpoint fdbc4259. This is
a scoped feature inventory, not a full-parity/acceptance claim.

| Surface | Swift reference | Next before this slice | Direction |
| --- | --- | --- | --- |
| Home across projects | HomeView.swift, HomeOverview.swift | Missing | Implement loaded-Local overview/navigation now; full dashboard/composer remains partial. |
| Project selection/chat scope | SidebarScope.swift, Sidebar.swift, ProjectPage.swift | Missing | Reuse existing app-socket projects + session.projectId; no new endpoint or mutation. |
| Chat browse/search/archive visibility | Sidebar.swift | Partial, flat Local list/search | Preserve virtualized search and add exact project scope. |
| Navigation history/per-scope restoration | NavigationHistory.swift, SidebarScope.swift | Missing | Subsequent everyday slice; no new persisted settings in this checkpoint. |
| New chat/send/Stop/drafts | HomeView.swift, Composer.swift | Implemented scoped Local interactions | Preserve. Project-aware destination/model/branch/workspace choices remain partial. |
| Transcript/tools/history/selection | ChatView.swift, ToolViews.swift | Implemented subset | Preserve composer/history checkpoints and built-in fade; not full content parity. |
| Inbox | InboxPage.swift, Inbox.swift, NeedsYouReason.swift | Partial read-only loaded-summary view | Exact project filter, urgency and explicit reader navigation. No authoritative Inbox/private review counts or actions. See [Inbox evidence](inbox.md). |
| Missions, schedules, integrations | HomeOverview.swift, ProjectPage.swift, MissionSidebar.swift | Missing | Further scoped work; derived loaded-chat counts are not authoritative dashboard totals. |
| Settings/models/provider/MCP/usage | Settings.swift, ScopedModelsSettings.swift | Missing | Further scoped work; no privileged changes or invented routes. |
| Artifact viewer | VisualArtifactView.swift | Partial native subset | Separate follow-ups, not a gate for everyday navigation. |
| Project CRUD/permissions/approvals | ProjectPage.swift, Settings.swift | Missing | No new mutation/authority in this read-only shell slice. |
| Browser/shaders/terminal/iOS/Linux verification | Existing exclusions | Deferred | Unchanged; retain Swift and fail-closed guards. |
| Retired Control/devboxes | Historical only | Not implemented | Do not recreate. |

Paths above are under `apps/macos/Sources/Pilot/`. Next references are
`src/local_view.rs`, `local_client.rs`, `local_model.rs`, `chat_editor.rs`,
`transcript_view.rs`, `artifact_view.rs` and their focused/native tests.

## First delivery slice

Home/project/chat navigation using the current identity-pinned app WebSocket's
existing projects/session summaries. Bounded metadata only; no project settings,
environment, credentials or raw chat bodies enter the overview. Home remains
global, project filters use exact IDs rather than cwd heuristics. Preserve a
single current chat's editor/reading state across shell navigation; do not parse
hidden streamed transcript projections. New-chat interaction stays explicit and
global until project-aware creation is implemented safely.

The Local entry opens Home. The default network-free synthetic fixture remains
a conversation. Home presents loaded Local chat activity, up to five working
chats, eight urgency-ordered project previews and twelve ordinary chat links.
The virtualized sidebar exposes the full admitted catalog and chat list, with
exact project scope, existing search and archived visibility. All chats returns
to the current conversation/global list. Cmd/Ctrl-1 and Cmd/Ctrl-2 navigate Home
and All chats. This is not the full Swift dashboard or project page.

## Authority, drafts and reading

- The app socket already sends projects and session.projectId. No new endpoint,
  request type, authentication claim, host, dashboard subscription or canonical
  mutation is introduced. Only explicit chat opening uses the existing pinned
  Local reader. Existing backend subscription side effects are unchanged.
- Project data retains only ID, bounded name and absolute display path. Project
  defaults, environment, settings and permission are neither retained nor
  borrowed for creation. New chat remains global with an explicit Local folder.
- Home is global, not the selected project. Matching requires exact project ID,
  never cwd/name/path heuristics. Removing a selected project leaves an explicit
  unavailable page and exact filter; it does not silently expose another scope.
- Capture live textarea/cwd before navigation, refuse active preedit in either
  input, and retain private drafts. Creation adoption additionally requires the
  current chat page, exact draft key/revision/target and still-empty text after
  synchronous capture. Deferred receipts cannot navigate over Home/newer input.
- Keep one current transcript/scroller and text entities. While hidden, retain
  only the latest complete projection, replacing the previous pending snapshot,
  and apply it on return through existing identity/anchor logic. This deliberately
  retains one additional bounded source snapshot, not zero extra memory.
  New hidden publications do not enter Markdown parsers or transcript renders.
- Native clicks/search intentionally dismiss text selection as before; do not
  resurrect stale hidden selection. Message identity, manual reading, reselect/
  copy, Latest and visible per-message selection/streaming remain supported.
  Full per-destination restoration/back/forward is a subsequent slice.
- Leaving artifacts closes the pane/helper through the existing lifecycle.
  No hidden generated-source evaluation or new in-process execution is added.

## Bounds and checks

Catalog admission is atomic, at most256 projects,240-byte names and4096-byte
paths. Malformed/duplicate/over-capacity catalogs retain the previous valid
snapshot with an explicit error. Sessions retain the existing1000-summary limit;
overview counts say loaded chats, not authoritative totals. The overview is
cached and reprojects only when visible metadata/scope changes, not on body
deltas. Scope-only changes share the existing summary Arc, instead of deep-
cloning every session's strings; empty-query filtering avoids lowercase copies.
Private drafts keep their independent existing bound.

Native synthetic production-root tests cover680/1100 points, light/dark,
actual project/chat clicks, same-cwd/different-project membership, scoped search/
archives, removed catalog entries, current draft Unicode, textarea/cwd preedit,
deferred creation receipts/newer draft revisions, actual mounted text/copy,
manual reading and32 coalesced hidden stream publications. Faux reader/writer
channels observe no create/send/Stop/approval. Captures stay ignored/private;
only synthetic images are attached, separately from a static SwiftUI mock.

The focused native matrix passed four scenes and a dedicated1100-dark capacity
scene with256 projects,1000 canonical chats and1 private draft. It retained the
same summary Arc through32 scope changes over4,349,000 bytes of metadata string
payload, instead of duplicating that payload per scope change. This is a
structural reuse observation, not measured total allocation, RSS or CPU savings.
Mounted long project labels stay inside their actual button bounds. The full
gate also includes keyboard Home/All chats and explicit reader-backpressure
coverage, plus positive/negative current-empty-draft creation adoption tests.
Native overscroll must settle before sampling pixel anchors; ordinary UI clicks
and search intentionally dismiss selection, followed by native reselect/copy.

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib local_ -- --test-threads=1
bash scripts/cargo.sh clippy --locked --all-targets --features native-probes -- -D warnings
PILOT_NEXT_SHELL_DIR=evidence/local/shell-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test shell
bash scripts/check.sh
```

Full macOS `scripts/check.sh` passes: **124 library tests passed,1 ignored**,
strict app/helper checks, fixture/browser rendering,16 chrome /56 visual scenes,
720 disclosure frames, rounded/dither/composer lifetime checks, isolated slider
interaction, all8 history scenes and all4 shell scenes plus the capacity case.
The final shell scenes also verify Cmd/Ctrl-1/2 and a full four-slot faux reader
queue: a refused open retains the destination/draft and reports an error, rather
than presenting the previous chat as the requested one. The positive adoption
test confirms a valid empty current receipt remains eligible, while wrong
key/revision/target and a deferred native text change are rejected.

All-target native-probe Clippy, four mocked scaling-runner tests, locked app/
helper builds and direct engine-symbol separation pass. The separate helper
crate has zero Rust unit tests, not four; the four runner tests are the mocked
Python suite. The existing `block0.1.6` future-incompatibility notice remains.
Final full log exits0; earlier compile/fixture iterations are not current failures.

No real actions, visible launch,
backend/Swift change, service install, release/default switch or Swift removal.
Linux verification stays deferred and generated-source execution fail-closed.
Offscreen synthetic frames are not OS IME/macOS15 validation, user visual
acceptance, a scrolling benchmark, full parity or a general speedup claim.
