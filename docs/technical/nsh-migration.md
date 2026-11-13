# Native Shell production migration

Source audit: **2026-11-06**, production parent
`39a4913c302436abbe73338ef29ccb5e3cb71e51`. Task numbers are internal
coordination records, not GitHub issues. This is the implementation map for
D132–D134, not product acceptance or a new architecture prerequisite.
Only this document changes. The first chat slice (#563) proceeds in parallel.

Plan alignment: brief revision **186**, read after initial publication. The
coordinator's #564–571 workstreams are the execution plan; #161/#162 are NSH
acceptance and #572 owns separate Linux qualification. A–F below are source-map
sections, **not a competing task hierarchy**. The old-task tables preserve the
initial audit snapshot. Legacy references are now delegated to replacements;
#55/#82/#240/#302/#435 were dropped as superseded, **not delivered**.

## Scope and evidence

Replace framework-specific views with Rust/native NSH. Keep the approved design,
existing daemon/kernel/protocol/storage contracts, and the current GPUI app usable.
Keep Swift and GPUI implementations until replacement acceptance. No live data,
model/account calls, service operations, installation, default switch, release,
feed/signing changes or visible benchmarks are part of this work.

Read this map with [DESIGN.md](../../DESIGN.md), the
[design system](../../apps/desktop/docs/design-system.md), and the older
[finish checklist](../../apps/desktop/docs/finish-checklist.md). The latter is
historical evidence, not an up-to-date list of missing features: later deliveries
include schedules, memory search, MCP sign-in, diagnostic repair, Slack triage
and one-shot lifecycle/delivery recovery. Revision/default-model/energy tasks
also delivered useful contract audits, not the UI named in their titles.

Method: inspect the production root/module graph, reachable shell/Settings routes,
reader/courier/store sources, native integration and updater, the unmodified
prototype, all remaining open task bodies and the completed-task inventory.
Cross-check umbrella claims against later delivery records and current source.
Existing tests/probes below identify reusable checks; this audit did not rerun
them. A source file, completed task or successful prototype is not NSH parity.

### Upstream reference, not a permanent “latest” claim

- Starting reference: [experiments/nsh-pilot](https://github.com/babariviere/pilot/tree/632281f47cadecf29e87d590114ab3cecda12daa/experiments/nsh-pilot)
  at the audited production parent. NSH **0.4.0**, exact revision
  `3e302abf0cbba712896fc938ca48360fc08c14bb`; all four runtime dependencies and
  `nsh-testing` share that pin. No patches or source-cache edits.
- Read-only upstream HEAD observation, **2026-11-06T17:29:29Z**:
  `0e4a20bd41ee72a35515cecbf9a7fba88742d911`, workspace version **0.4.0**.
  This is newer than the prototype. #563 owns latest-pin verification and its
  manifest/lock changes. Recheck upstream at implementation time; this document
  neither changes the pin nor certifies that revision's runtime behavior.
- Upstream source references below use that observed revision in
  [longbridge/nsh](https://github.com/longbridge/nsh/tree/0e4a20bd41ee72a35515cecbf9a7fba88742d911).
  Never use patches from the [historical nsh-chat experiment](https://github.com/babariviere/pilot/tree/c3318a6f39fab3a56ef44673ec18947cf42b931c/experiments/nsh-chat), fork NSH, edit Cargo's cache, or
  add WebView/TSX/QuickJS for app UI without approval. The existing isolated
  native-visual worker is a separate, already delivered artifact contract.
  The historical experiment's [findings](https://github.com/babariviere/pilot/blob/c3318a6f39fab3a56ef44673ec18947cf42b931c/experiments/nsh-chat/FINDINGS.md)
  record selection, input and scroll limitations; they are not Day acceptance.

## Ownership and reuse rules

In tables, `S/` means **`apps/desktop/src/`**. Names ending in `.rs` are exact
files there. `U/` means **`apps/desktop/updater/src/`**. These are source seams,
not a request to create one crate per row or a second service/store.

| Layer | Keep | Replace or reconnect |
| --- | --- | --- |
| Read transport | `S/local_client.rs`: `LocalOptions`, `LocalClient::start`, `Presentation`, private runtime, coalesced publications, GET/control/chat sockets, paged history, cancellation and pinned daemon/lineage hello. `S/response_json.rs`, `S/close_on_drop.rs`, `S/model_scope_access.rs`. | Subscribe from an NSH-owned lifetime; send selection/page commands through the same client. Drop/cancel old reads, apply only current generation. Local loopback identity pinning is not authentication. |
| Projection | `S/local_model.rs`, `S/model.rs`, `S/attention.rs`, `S/chat_order.rs`, `S/state_mark.rs`, `S/subscription_pause.rs`, `S/automatic_input.rs`. Preserve incomplete/stale versus empty, eligible roles and live question attention. | Framework-specific text/render types must not become transport authority. Some modules mix pure projections with GPUI; move only the needed pure boundary. |
| Mutations | `S/interaction.rs`, `S/interaction_delivery.rs`, `S/interaction_links.rs`: courier, immutable captured operations, durable dedupe/reconciliation, edit mailbox and FIFO writer. `S/database_access.rs`, `S/question.rs` preserve exact requests. | NSH event handlers dispatch existing commands and consume `WriteState`. Do not replace the courier with direct button HTTP or use timeline/GET as acceptance proof. |
| Draft/outbox storage | `S/delivery_store.rs`, `S/delivery_diagnostic.rs`: one private Store owner, Book/Draft/Intent/Operation/Host identity, exact saved text, recovered input and diagnostics. | Reuse schema/path/lock behavior. Root owns the writer across navigation; native cells must not own it. Do not open a second writer while GPUI owns the same profile. |
| Preferences | `S/settings_state.rs`, `S/settings_worker.rs`: `SettingsState`, `SettingsStore`, save receipt, private `preferences-v1.json`, post-rename durability uncertainty. | Rebind committed appearance/fonts and separate preview edits to NSH. Keep pending/dirty/unconfirmed saves distinct; close cannot turn an unconfirmed write into success. |
| Navigation/local memory | `S/navigation.rs`, `S/sidebar_memory.rs`, `S/sidebar_folders.rs`, `S/sidebar_tree.rs`, `S/sidebar_fold.rs`, `S/chat_order.rs`, `S/reader_zoom.rs`. | Rebind route/history/reader-mark and sidebar view state. `sidebar-v1.json` holds local last-seen/activity/folders/folds/width, not daemon read status. Navigation marks are not durable drafts. |
| Feature adapters | Existing `*_reader.rs`, `*_transport.rs`, worker and pure model files listed below. Most use `LocalOptions` plus serde JSON and private async lanes. | Replace Entity/Context/Render/FocusHandle/Subscription plumbing, not wire protocols. “Reader” is not automatically UI-free: `native_review_reader.rs` currently uses Kit `DiffFile`. |
| Native runtime | `S/bundled_runtime.rs`, `S/linux_bundled_runtime.rs`, `S/running_identity.rs`, updater and `apps/power`. | Reconnect app startup, menus, window termination and update checkpoints. GUI replacement and daemon lifecycle remain separate. |

Concrete reusable dependency sets, from
[Cargo.toml](../../apps/desktop/Cargo.toml): serde/serde_json (`rc`,
`float_roundtrip`), async-channel, tokio, reqwest and tokio-tungstenite for
transport; sha2/uuid/libc for identities/storage; unicode-segmentation and
unicode-normalization for text; image/base64 for raster/attachments; chrono/jiff
for schedules. Keep exact persisted numeric parsing. The updater is already a
separate path crate with `native-macos`/`native-linux` features. GPUI-Kit,
lyon drawing and raw-window-handle are not reasons to import GPUI into the NSH
UI. Do not copy the whole desktop dependency graph just to reach one adapter.

Many useful items are `pub(crate)` and the library currently compiles GPUI views.
Reuse therefore requires a small source/module boundary, not simply depending on
`pilot-desktop` and claiming framework independence. #563 should expose only its
needed existing logic; later slices can extend that seam. No broad extraction,
new storage schema or general abstraction framework is a prerequisite.

Rendering helpers are not additional backend modules: `S/ui.rs`,
`S/app_icon.rs`, `S/appearance.rs`, `S/typography.rs`, `S/text.rs`,
`S/composer_height.rs`, `S/disclosure_motion.rs`, `S/transition.rs`,
`S/scroll_work.rs`, `S/nested_scroll.rs` and native scroll hooks describe existing
tokens, text geometry, motion and scroll behavior. Reuse values/pure calculations
where suitable; translate GPUI paint/focus/event mechanics to NSH rather than
carrying its widget tree. `S/artifact_chart_keyboard_probe.rs`, chart/canvas
plans and scroll/copy probes supply behavioral cases, not a requirement to
reproduce GPUI internals. The same applies to `S/contextual_navigation.rs`,
`S/chat_link_navigation.rs`, `S/chat_actions_navigation.rs`,
`S/project_add_navigation.rs` and `S/workflow_confirmation_navigation.rs`:
keep destination/guard semantics and replace UI handles.

## Framework behavior versus Pilot integration

The prototype's [lib.rs](https://github.com/babariviere/pilot/blob/632281f47cadecf29e87d590114ab3cecda12daa/experiments/nsh-pilot/src/lib.rs),
[model.rs](https://github.com/babariviere/pilot/blob/632281f47cadecf29e87d590114ab3cecda12daa/experiments/nsh-pilot/src/model.rs),
[native.rs](https://github.com/babariviere/pilot/blob/632281f47cadecf29e87d590114ab3cecda12daa/experiments/nsh-pilot/src/native.rs) and
[tests.rs](https://github.com/babariviere/pilot/blob/632281f47cadecf29e87d590114ab3cecda12daa/experiments/nsh-pilot/src/tests.rs) separate these responsibilities:

| NSH provides | Pilot must integrate and verify |
| --- | --- |
| `nsh-core` Root/View, signals/owners, keyed lists, layout, event/focus and task lifetimes; native platform backend. | Canonical host/project/chat/location identities, subscriptions across navigation, stale-result rejection, stable user-activity order and cancellation of work belonging to a removed owner. A recycled row never becomes the authority for a chat. |
| `nsh-base` input, text/Markdown, buttons and scrolling. Prototype uses unstyled buttons, native multiline input and Markdown text views. | Exact draft capture before Send/navigation/close, IME/preedit guards, app shortcuts, question editors, clipboard, literal source Copy, undo/focus across remounts, reading anchor and full-history Find. Native editing support is not proof of all hardware IME paths. |
| Native virtual-list recycling and mounted text selection. | Paging older history while streaming, restoring unloaded marks, selection/copy retention and exact identity across recycling. The prototype documents mounted-row selection only; test concrete cross-recycle/Select All behavior before selecting a remedy. Do not infer whole-history selection or call it a proven blocker. |
| Native widgets, menus/dialog primitives and platform integration APIs where exposed. | Approved sky palette/Inter/JetBrains typography, calm layout, 76/34 composer geometry, opaque surfaces, transient Thinking, visible assistant Notes, latest-five work steps/full disclosure, exact pending/Unknown and permission semantics. |
| `nsh-testing` headless interaction plus native AppKit capture hooks. | Same production adapter code against isolated hosts, native interactions/captures, save/restart and actual termination evidence. Manual-clock tests are needed for deterministic intermediate streaming/Stop assertions; real-clock settling may finish a short replay first. |

The prototype has process-local drafts, scripted replies, a 32-new-chat fixture
limit and disabled non-chat routes. Those are prototype choices, not production
requirements or NSH limits. Its Stop cancels a replay; production Stop must reach
the existing courier/kernel contract and keep partial output. Neither its six
tests nor its hidden captures establishes durable chat or large-history speed.

## Coherent implementation slices

Use the current workstreams below, splitting bounded implementation assignments
only where ownership or a concrete contract gap requires it. Each delivered
slice needs focused tests and honest unavailable states in the replacement.
Nothing here authorizes dropping a capability from the current app. Base
shell/adapter work starts now; later surfaces need not block that slice.

### Current workstream crosswalk

All source names in this table are under `apps/desktop/src/` unless a different
root is stated. D134 selects **Sol** for existing-component migration, not a
fresh design exercise. Reuse the exact files/adapters enumerated in A–F.

| Current task | Actual reusable surfaces/modules | Precise ownership, gaps or split advice |
| --- | --- | --- |
| #563 first vertical slice | A1: `local_client.rs`, `local_model.rs`, `interaction.rs`, `interaction_delivery.rs`, `delivery_store.rs`, `navigation.rs`, sidebar identity/order and real Store/loopback fixtures. | Establish the smallest reusable source seam; durable drafts/Unknown, exact selection and safe close precede writable enabling. Later workstreams extend it, not independent stores/transports. |
| #564 chat controls/sidebar | A3 plus sidebar models: `sidebar_tree.rs`, `sidebar_memory.rs`, `sidebar_folders.rs`, `chat_order.rs`, `chat_actions.rs`, `chat_models.rs`, `queued_message.rs`, `question.rs`, `database_access.rs`, context/subscription/failure adapters, `session_jobs.rs`, `session_todos.rs`, `session_subagents.rs`. | Own attachment creation/paste/drop/preview/remove, new-chat/project/model forms and chat-location drafts. Explicitly include child-conversation navigation/drafts/send, jobs/log/Stop and public todos; these are delivered capabilities even though the title says controls/sidebar. Keep shared header/Links-inspector navigation here, not a new Review-only substitute. Missing branch/workspace overrides, held-input management and attempt/rewind remain pre-existing residuals, not automatically approved additions. |
| #565 transcript/history/tools/images | A2 and B conversation images: `model.rs`, `local_model.rs`, `transcript_find.rs`, `tool_presentation.rs`, `tool_script.rs`, `message_fold.rs`, `question_entry.rs`, `compaction_event.rs`, `github_event.rs`, `conversation_images.rs`, lazy read lanes in `local_client.rs`. | Own image display/selection/Copy/zoom and geometry in transcript, not attachment submission or standalone artifact reads. Include assistant Notes, structured answered questions, compaction/live status and GUI-only PR-merge events. Preserve #382's specific disclosure request for an implementation check; do not restore rejected ribbon. Reuse #457 request-count evidence for this reader integration, not a separate performance rewrite. |
| #566 artifact readers/native visuals | B: `artifact_model.rs`, `artifact_gallery.rs`, gallery/image workers, `artifact_image.rs`, `artifact_view.rs`, `visual_runtime.rs`, `visual_wire.rs`, `visual_scene.rs`, `visual_session.rs`, drawing/chart plans, `native_mermaid.rs`, `artifact_link.rs`; existing `apps/desktop/visual-worker`. | Own artifact decoding/reader/inline-visual scene and interaction; #565 owns transcript placement/reading anchor. Current schema/render parity first. #495 did **not** implement a revision picker; catalogue remains blocked. Export/project enumeration are residuals, not delivered source to port. #536–541 must stay separately scoped enhancements; #537 explicitly needs approval for its image-reference contract. |
| #567 Review | B Review: `native_review.rs`, `native_review_reader.rs`, `native_review_view.rs`, `native_review_render.rs`, `review_navigation.rs`, `workflow_confirmation.rs`; `session_file_view.rs` and reader for explicit Open. | Model **and** reader import Kit diff types. Extract/replace that concrete boundary; keep exact bytes/hash/anchors and unavailable rows. Use `packages/daemon/src/testing/review-host.ts` for real creation/capture/custody. Own Review snapshot View → live-chat FilePane Open, not all conversation links just because legacy #133 points here. General PR attach/move/merge remains an absent legacy capability, not an enabled migration action. |
| #568 Missions | C except Insights: `mission_browser.rs`, `mission_reader.rs`, `mission_transport.rs`, mission brief/activity/task readers, create/metadata/lifecycle/task transport families, decisions/comments/resources/artifacts and inspector models. | Group bounded assignments by browse/inspector, ordinary edit forms, and task/resource/decision surfaces as needed. Reuse adjacent chat inspector and pinned artifact reader, do not copy them. Phase definition, membership/coordinator management, assignment/dependencies/task start and resource writes are concrete legacy gaps; migration cannot silently implement them through unsafe existing mutations. |
| #569 Home/Inbox/Insights/Automations | D plus C Insights and E Usage: `app_shell.rs`, `inbox.rs`, `home_sky.rs`, `attention.rs`, `slack_triage.rs`, `slack_triage_transport.rs`, `chat_tracked.rs`, `insights.rs`, enable/replace/settings models, `scheduled_messages.rs`, reader, `recurring_schedules.rs`, `automation_hooks.rs`/transport, `usage_overview.rs`/reader/records. | Split by actual surface when assigning: Home/attention, Slack board, Insights, Automations and Usage. Own dated Usage dashboard/records because legacy #146 routes here; #570 owns Settings entry/preferences, not a duplicate usage data owner. At audited source, Insights is **mission-backed**, not the proposed standalone app-level replacement. Recheck landed standalone work before porting; do not invent app records/routes. Keep current scheduling `expectedHome` admission and once-per-item Slack Start linkage via #564 courier. |
| #570 Settings/projects/integrations | E: `settings_state.rs`, `settings_worker.rs`, `scoped_models.rs`/worker, `chat_settings.rs`, `project_settings.rs`/transport, `project_registration.rs`, `project_slack.rs`/reader, `project_memory.rs`/reader, `knowledge.rs`/reader, `mcp_status.rs`/reader, `diagnostics.rs`, `diagnostic_repair.rs`, client folder model. | Explicitly include separate **Knowledge** and Memory windows, exact revisions/source navigation, not only Settings categories. Scope statements name historical environment/database/power/Linear workflows that are not all present in GPUI: separate actual ports from absent-feature/contract reviews. Project default-model editing (#492) and current energy status UI (#493) are blocked audit outcomes. Full-memory search/forgetting, notification policy and actual evidence erasure are not existing implementations. |
| #571 native shell/updater/distribution | F: app menu/native routing, Command Palette, shortcuts, desktop links/clipboard, `bundled_runtime.rs`, `running_identity.rs`, update/daemon lifecycle UI attachments, `apps/desktop/updater`, packaging/native helper scripts and `apps/power`. | Split native shell/menus from updater attachment/full-payload qualification if needed, not a new lifecycle framework. Own common safe external-link routing used by #564/#565/#566/#567; each surface owns its activation/source fence. Existing notification implementation is missing, so #143 is a scoped capability gap, not a port. Keep NSH updater comparison below; existing transaction is reusable and no trust/feed switch is implied. |
| #161 lifecycle acceptance | A/F: real courier/Store tests, `application_quit_probe.rs`, `tests/application_quit.rs`, `lost_ack_fixture.rs`, update-exit/native should-terminate cases. | Qualify actual NSH process Close/Quit/external termination, immediate Store reopen and preserved drafts/Unknown. App-restart checkpoint is not a daemon replacement receipt. Include secondary Settings/forms and child composers, not the main editor alone. |
| #162 input/motion/performance acceptance | A/B/F content/selection corpora, prototype hidden AppKit insertion/capture, native history/scroll/Markdown/image/artifact probes and source-matched release controls. | Hardware IME/clipboard and active-app focus/menu checks remain distinct from hidden synthetic interactions. Keep dropped #240/#302 corpora as regression evidence, not GPUI optimization requirements or NSH failures. #567 Review diff selection/copy and #568/#570 secondary editors also need input coverage; do not limit acceptance to dependencies' chat/artifact views. |
| #572 separate Linux qualification | Existing visual-worker confinement, `linux_bundled_runtime.rs`, updater native-linux/service code, Linux package/runtime/Wayland scripts, `apps/power`; #31/#391/#406 evidence. | GTK/native-backend presence is not Wayland/service/confinement/power qualification. Keep exact distribution/architecture/compositor and real user-manager/hardware prerequisites explicit. No old host authority or macOS acceptance transfers. |

**Concrete handoff boundaries, not new workstreams:** attachment admission and
drafts #564 → conversation image placement #565 → shared artifact decode/scene
#566; Review retained source #567 → existing live FilePane in chat #564; mission
inspector #568 → shared navigation #564/#571; Slack Start #569 → existing courier
#564; all secondary input owners → Close/update collector #571 and acceptance
#161. Each caller keeps source identity and stale-result fences. This avoids
multiple agents owning the same editor, route handler, Store or image cache.

**Stale closures for coordinator:** #353/#359 proposals and #457/#458/#459
investigations report completion without a feature commit; retain evidence and
close administratively rather than waiting for the replacement implementation.
#347 power audit, #351 Linux warning diagnosis, #385 first-stage service plan and
#410 Ask-removal audit likewise have delivered conclusions, with remaining
policy/native gaps kept separately. #87's old SwiftUI readiness failure is not
an NSH native-artifact rendering requirement; preserve quarantine evidence and
decide its old-app CI disposition. #461 needs narrowing between new service-store
retirement already present and unresolved legacy-root exclusion. None of these
closures would mean delivered NSH parity. #344/#390 live-operation requests,
#413 backend Ask policy and #321 retirement remain separate authority gates.

### A. First production chat, then complete conversation behavior

**A1 (#563): sidebar → exact session → transcript → composer → Send/stream/Stop.**
Depends on the existing read/courier/store boundary, not Missions or artifacts.
Reuse `local_client`, `local_model`, `interaction`, `delivery_store`, `navigation`
and sidebar identity/order models. Replace `S/local_view.rs`,
`S/local_chat_update.rs`, `S/chat_editor.rs`, `S/chat_sending.rs`,
`S/chat_header.rs`, `S/sidebar_list.rs`, `S/sidebar_reorder.rs` presentation
incrementally. Keep project/mission grouping, distinct same-title IDs, still
state words, unread dots, pinned/archive scopes and no actual subagent rows.
Do not use the prototype's synthetic integer index as production chat identity.

Writable enabling gate: exact durable drafts survive process restart; admitted
operation and newer text survive lost ACK, selection changes and close; one
Store/writer; no ambiguous resend; legacy Ask stays passive/read-only;
coordinator/explorer/diagnostic eligibility stays unchanged. Initial native
checks cover Unicode/multiline/undo/focus, switch drafts during stream, Send,
Stop and partial output, hidden light/dark narrow/wide captures and safe close.
Report remaining hardware IME/full-close/large-history gaps rather than claiming
the small slice completes them.

**A2: history and exact content.** Reuse `S/transcript_find.rs`,
`S/message_fold.rs`, `S/message_time.rs`, `S/tool_presentation.rs`,
`S/tool_script.rs`, `S/tool_diff_preview.rs`, `S/compaction_event.rs`,
`S/question_entry.rs`, `S/github_event.rs`, `S/submit_visibility.rs` and
`S/model.rs` reader keys. Replace `S/transcript_view.rs`, `S/work_view.rs`,
`S/message_fold_view.rs`, `S/transcript_find_view.rs` and Markdown-specific
hooks, not canonical source text. Preserve true lazy initial tail/older pages,
top-scroll anchor, live-tail behavior, unloaded mark restoration, full-history
on-demand Find, user folding, literal copy, queue/transcript dedupe and selection
under streaming. Thinking is transient; assistant Notes remain visible.
Compaction/status events are not tool output; GUI-only merged-PR lines must not
enter agent context. NSH Markdown/diff parsing must pass the literal-copy corpus,
not silently normalize canonical code.

**A3: remaining chat controls and related panels.**

| Workflow | Existing logic/adapters | UI/native integration to replace |
| --- | --- | --- |
| New Build chat, project/default model, rename/pin/archive/restore, delete empty unsent draft, mission conversion | `S/project_registration.rs`, `S/chat_actions.rs`, `S/chat_actions_worker.rs`, `S/chat_rename.rs`, `S/mission_conversion.rs`, `S/workspace_setup.rs` | `S/new_chat_view.rs`, `S/project_add_view.rs`, `S/chat_actions_view.rs`, `S/chat_draft_discard.rs`, `S/chat_projects.rs`, `S/chat_tracked.rs`, `S/mission_view.rs`. Keep project IDs/location drafts and explicit conversion; no Ask-to-Build conversion. |
| Model/thinking/effective defaults, failure Retry/failed-model recovery, usage Pause/Force/Continue | `S/chat_models.rs`, `S/chat_model_reader.rs`, `S/context_usage.rs`, `S/context_meter.rs`, `S/provider_usage.rs`, `S/provider_refresh.rs`, `S/provider_refresh_reader.rs`, `S/session_failure.rs` | `S/chat_model_picker.rs`, `S/chat_model_picker_tests.rs`, `S/chat_recovery.rs`, `S/chat_subscription.rs`, `S/context_usage_view.rs`, `S/session_failure_retry.rs`. Defaults stay Default; reported/unknown usage stays distinct; paused is unfinished. |
| Questions and database permissions | `S/question.rs`, `S/database_access.rs`, courier Answer/RetireAnswer and volatile decision result | `S/chat_questions.rs`, `S/question_entry_view.rs`. Exact current question/request, reply identity and drafts; blocking asks outrank busy status; old answers/history cannot grant consent. |
| Queued messages/automatic inputs, paths/slash commands | `S/queued_message.rs`, `S/queued_message_transport.rs`, `S/automatic_input.rs`, `S/path_completion.rs`, `S/path_completion_reader.rs`, `S/slash_commands.rs` | `S/queued_message_view.rs`, `S/path_completion_view.rs`, `S/slash_commands_view.rs`, `S/slash_command_actions.rs`. Captured-row edit/remove precondition, held input distinction, UTF-16/graphemes/preedit and existing command admission. No return of removed Changes or ordinary Ask commands. |
| Jobs/log/Stop, public todos, child conversations/send | `S/session_jobs.rs`, `S/session_jobs_log.rs`, `S/session_todos.rs`, `S/session_subagents.rs` | `S/session_jobs_tray.rs`, `S/session_todos_tray.rs`, `S/session_subagents_view.rs`. Keep child identity/drafts/permission ceiling and background work as Working. Sidebar child removal does not remove child access. |
| Links, session references and file side panel | `S/chat_links.rs`, `S/conversation_links.rs`, `S/session_clipboard.rs`, `S/external_links.rs`, `S/desktop_app_link.rs`, `S/session_file_view.rs`, `S/session_file_view_reader.rs` | `S/conversation_links_view.rs`, `S/session_file_view_native.rs`, `S/session_file_panel.rs`, `S/side_panel.rs`. Open retained Review source through guarded live-chat FilePane only on explicit action; no guessed checkout/root. |

### B. Images, native artifacts and global Review

Depends on A's exact chat/host and reading lifetimes. Images are first-class
content, not two visible slots. Preserve inline natural geometry, EXIF-upright
hints as hints only, decode limits, exact revisions, automatic loading and
readable zoom/pan/fit/reset with selection/scroll identity.

| Surface | Reuse | Rewrite/verify |
| --- | --- | --- |
| Attach/paste/drop, attachment preview/remove, stored images, native Copy image | `S/image_attachments.rs`, `S/image_clipboard.rs`, `S/conversation_images.rs`, `S/artifact_image.rs`, `S/artifact_gallery.rs`, `S/artifact_model.rs`, `S/artifact_gallery_worker.rs`, `S/artifact_worker.rs` | `S/composer_attachments.rs`, `S/conversation_images_native.rs`, `S/conversation_images_view.rs`, `S/artifact_image_view.rs`, `S/artifact_gallery_view.rs`. Reconnect native clipboard/drop and preserve coordinator-readable attachment admission, exact owner/kind/codec checks and stale decode rejection. |
| Artifact reader, exact source/Previous revision and inline visuals | `S/visual_runtime.rs`, `S/visual_wire.rs`, `S/visual_scene.rs`, `S/visual_session.rs`, `S/visual_drawing.rs`, `S/visual_canvas_plan.rs`, `S/visual_chart.rs`, `S/artifact_link.rs`, `S/native_mermaid.rs`, `S/reader_zoom.rs` | `S/artifact_view.rs`, `S/inline_visual.rs`, `S/inline_visual_transcript.rs`, `S/visual_canvas_view.rs`, `S/visual_chart_view.rs`, `S/native_mermaid_view.rs`, `S/artifact_canvas.rs`, `S/visual_slider.rs`. Port render/input only; preserve native charts/tables/controls/canvas, mockup layout/vector styling, keyboard readouts, source Copy, exact revision state and safe links. The picker remains contract-blocked, not delivered by #495. |
| Global Review queue, retained comparisons/source and feedback records | `S/native_review.rs`, `S/native_review_reader.rs`, `S/review_navigation.rs`, `S/workflow_confirmation.rs` | `S/native_review_view.rs`, `S/native_review_render.rs`, `S/workflow_confirmation_view.rs`. Both model and reader currently import Kit diff types. Replace that boundary/parser without losing source bytes/hashes, unavailable queue slots, custody/project/revision checks, annotation anchors, exact revisions and explicit approval/Unknown semantics. Review remains change-centered, not a revived Changes inspector. |

Keep `apps/desktop/visual-worker` and its confinement/protocol separately from
NSH. `S/visual_runtime.rs` runs the artifact program off-UI; `visual_scene` checks
the hostile returned tree and `visual_session` commits a validated frame.
Rendering the same tree in NSH does not grant filesystem/network/tool access or
arbitrary native-code execution. Preserve sandbox time/memory/stack limits,
cancellation/reap, worker generation and state/revision fences. Shared schema,
validator and runtime in `packages/artifacts` remain unchanged by this UI port.
Mermaid invalid versus unsupported errors remain distinct and fail closed.

Stored HTML/React/SwiftUI sources, revisions and provenance remain inert and
inspectable/copyable, with unsupported placeholders. No browser/SwiftUI preview,
terminal, shader/3D fallback or artifact deletion. Additional visual authoring
features (#536–541) are separate choices, not conditions for porting the current
schema. NSH's own script/runtime is not a replacement artifact sandbox.

### C. Missions, tasks and existing Insights

Depends on A identity/navigation and B's pinned artifact/Review reader. Retain
current Overview/Tasks/Review hierarchy, brief disclosure, activity, Needs you
and adjacent inspector. Do not build a new six-tab redesign from an old ticket.

| Workflow | Reusable files under S/ | Current presentation files under S/ |
| --- | --- | --- |
| Catalog, overview, exact member/coordinator navigation and inspector | `mission_browser.rs`, `mission_reader.rs`, `mission_transport.rs`, `mission_inspector.rs`, `mission_phases.rs` | `mission_browser_view.rs`, `mission_overview_view.rs`, `mission_inspector_view.rs`, `mission_navigation.rs`, `mission_inspector_navigation.rs`, `mission_motion.rs` |
| Standalone passive create, metadata, Archive/Reopen/Mark done | `mission_create.rs`, `mission_create_transport.rs`, `mission_metadata.rs`, `mission_metadata_transport.rs`, `mission_lifecycle.rs`, `mission_lifecycle_transport.rs` | `mission_create_view.rs`, `mission_metadata_view.rs`, `mission_metadata_browser.rs`, `mission_lifecycle_view.rs`, `mission_lifecycle_browser.rs` |
| Brief edit/history/autosave/conflict; explicit activity update | `mission_brief.rs`, `mission_brief_reader.rs`, `mission_activity.rs`, `mission_activity_reader.rs`, `mission_update.rs`, `mission_update_transport.rs` | `mission_brief_view.rs`, `mission_activity_view.rs`, `mission_update_view.rs` |
| All tasks, phase/finished filters, task-create popup, status/title/body/preferred model | `mission_tasks.rs`, `mission_tasks_reader.rs`, `mission_task_create.rs`, `mission_task_create_transport.rs`, `task_status.rs`, `task_status_transport.rs`, `task_edit.rs`, `task_edit_transport.rs`, `task_model.rs`, `task_model_transport.rs` | `mission_tasks_view.rs`, `mission_task_create_view.rs`, `task_status_view.rs`, `task_edit_view.rs`, `task_edit_pane.rs`, `task_model_view.rs`, `task_model_pane.rs` |
| Decisions/retired guidance, proposals and all comments | `mission_decisions.rs`, `mission_decision_resolve.rs`, `mission_comments.rs` | `mission_decisions_view.rs`, `mission_comments_view.rs`. Keep original text/history, replacement/withdrawal meaning and exact confirmation. |
| Canonical resources and pinned artifacts | `mission_resources.rs`, `mission_artifacts.rs` | `mission_resources_view.rs`, `mission_artifacts_view.rs`. Preserve pinned revision/no latest fallback, unknown PR binding and task provenance. |
| Current mission-backed Insights reports/findings/settings, Enable/Check/cancel, replacement | `insights.rs`, `insights_enable.rs`, `insights_replace.rs`, `insights_settings.rs`, `mission_tasks_insights.rs` | `insights_view.rs`, `insights_enable_view.rs`, `insights_replace_view.rs`, `insights_settings_view.rs`, `insights_navigation.rs`. Preserve desired versus effective values, pending/accepted receipt versus current resources, panel-wide stale-read fences, replacement history and no blind resend. |

This audit sees existing mission-backed Insights in production. App-level
standalone Insights is parallel work, not permission to change schemas/routes
here or treat workspace reservation as execution. When porting, use the then
landed contract; keep report/session/owner identities and explicit activation
consent. Do not synthesize a hidden ordinary mission or put a workspace ID in a
v1 mission field to fill an incomplete UI.

Missing mission management remains missing, not framework-provided: membership
join/move/leave/coordinator administration, assignment/dependencies/task start,
phase definition/order/gating, resource writes and managed-ticket delivery
roles. Review actual endpoint side effects before enabling writes. The phase
[contract audit](../../apps/desktop/docs/mission-phase-editing.md) found non-exact
targeting and coordinator/publication effects; NSH cannot fix this with a dialog
or postflight check. Separate narrow backend approval remains necessary.

### D. Home, Inbox, Archive, Automations and tracking

Depends on A's shared inventory; Slack Start also depends on the courier.
`S/app_shell.rs` currently routes Home, Archive, Automations, Missions/Mission,
Inbox, Project, Review and Chat. Usage/Settings/Memory/Knowledge also have windows;
absence from `Page` alone does not prove a missing workflow.

| Surface | Existing integration to reuse | Preservation/remaining distinction |
| --- | --- | --- |
| Home/project overview/Inbox | `S/app_shell.rs`, `S/inbox.rs`, `S/attention.rs`, `S/home_sky.rs`, shared usage and mission projections | Loaded-summary counts must stay labeled; preserve exact project scope, needs-you explanations, subscription refresh and quiet Home sky. Do not relabel partial projections authoritative totals. |
| Archive | `S/archive_view.rs`, `S/archive_navigation.rs`, `S/archived_composer.rs`, passive paths in `local_client` | Full registered summary inventory, exact filters and Restore; process-kept offline rows are not durable offline history. Passive multipage archive reads do not provide an immutable snapshot across concurrent reset/restore. |
| Automations/schedules/hooks | `S/scheduled_messages.rs`, `S/scheduled_messages_reader.rs`, `S/recurring_schedules.rs`, `S/automation_hooks.rs`, `S/automation_hooks_transport.rs` | Port `S/automations_view.rs`, `S/automation_editor.rs`, `S/automation_hooks_view.rs`: one-time/recurring forms, zones/previews, Cancel/Dismiss/Pause, run results, rule revision and explicit admission. Disabling a rule does not undo an entered command. |
| Inbox Slack board/thread/status tabs, hidden filters, exact links, Start chat | `S/slack_triage.rs`, `S/slack_triage_transport.rs`, `S/chat_tracked.rs`, `S/jump_slack.rs`, `S/interaction_links.rs` | Port `S/slack_triage_view.rs` and palette routing. Keep status/drag controls, unforced sync, team-qualified links, full thread, editable Build draft, accepted-chat linking and once-per-item Start. No live Slack verification here. |
| Linear, GitHub project import, broader tracked work | Historical `apps/macos/Sources/Pilot/TrackingSettings.swift`, `MissionTicketsSection.swift`, `GitHubImportModel.swift`, `GitHubImportSheet.swift` as references only | These are residual capabilities, not a general new NSH transport. Audit existing approved routes/source when selected; do not invent clients or run GitHub/Linear actions to demonstrate parity. |

### E. Settings, projects, diagnostics and utilities

Depends on A identity/courier and native window ownership. Current Settings
categories: Appearance, Chats, Scoped models, MCP connections, Updates,
Diagnostics, plus selected project. Preserve separate draft/committed state and
Save/Revert only when dirty. Do not import Swift preferences silently.

| Workflow | Existing models/adapters | Port/acceptance |
| --- | --- | --- |
| Appearance/font preferences; scoped model catalog/defaults; chat preferences | `S/settings_state.rs`, `S/settings_worker.rs`, `S/scoped_models.rs`, `S/scoped_models_worker.rs`, `S/chat_settings.rs`, `S/chat_models.rs` | `S/settings_view.rs`, `S/settings_fonts.rs`, `S/scoped_models_view.rs`, `S/chat_settings_view.rs`, `S/appearance.rs`, `S/typography.rs`. Apply only acknowledged preferences; preserve effective/inherited model distinction and explicit settings writes. |
| Add existing project, General/Workspace, folders and Slack settings | `S/project_registration.rs`, `S/project_settings.rs`, `S/project_settings_transport.rs`, `S/project_slack.rs`, `S/project_slack_reader.rs`, `S/sidebar_folders.rs` | `S/project_add_view.rs`, `S/project_settings_view.rs`, `S/project_slack_view.rs`, `S/sidebar_folders_view.rs`. Preserve dirty form/project identity and unrelated config; preflight is not atomic project CAS. #492 documented the missing captured-model precondition, not a delivered project default-model editor. |
| Usage overview/trends/subscription refresh/dated retained records and project filtering | `S/usage_overview.rs`, `S/usage_overview_reader.rs`, `S/usage_overview_records.rs`, `S/provider_usage.rs`, `S/provider_refresh_reader.rs` | `S/usage_overview_view.rs`, `S/usage_overview_chart.rs`, `S/provider_usage_view.rs`, `S/provider_refresh_view.rs`. Preserve totals separate from bounded retained rows, cursor generation, dates and unknown/coverage provenance. |
| Project Memory/Knowledge browse, loaded-range search, explicit Refresh, source/revision navigation | `S/project_memory.rs`, `S/project_memory_reader.rs`, `S/knowledge.rs`, `S/knowledge_reader.rs` | `S/project_memory_view.rs`, `S/knowledge_view.rs`. Loaded-range search is not full-store search; no deletion/forgetting is implied. |
| MCP observations/Check/sign-in/cancel | `S/mcp_status.rs`, `S/mcp_status_reader.rs` | `S/mcp_status_view.rs`. Preserve daemon credential ownership, live versus cached status and exact cancellation. No GUI credential/config fallback. |
| Local diagnostic evidence/reviewed export, Ask about Pilot and confirmed repair | `S/diagnostics.rs`, `S/diagnostic_repair.rs`, courier Repair | `S/diagnostics_view.rs`, `S/diagnostic_repair_view.rs`. Preserve sanitized bounded schema, disable/clear write-drain ordering, host binding, evidence/proposal editing/model choice and separate repair approval; export preview is not data erasure. |
| Energy/helper status; environment/setup/databases; notification preferences | Existing daemon power report and structured database approvals only | Do not turn cached energy status into live proof or infer saved policy from GUI lifetime. Environment/setup/database editors, notification permission/delivery and broader policy controls remain separately scoped gaps. |

### F. Native shell, close, updater and delivery packaging

Depends on A's real input/courier lifetime; integrate this before claiming the
replacement can safely quit/update, not after a default switch.

- Replace `S/main.rs`, root registration in `S/local_view.rs`,
  `S/app_menu.rs`, `S/app_menu_native.rs`, `S/menu_routing.rs`,
  `S/daemon_menu.rs`, `S/daemon_menu_native.rs`, `S/pi_reload.rs`,
  `S/jump.rs`, `S/jump_view.rs`, `S/jump_links.rs`, `S/jump_navigation.rs`,
  `S/shortcuts_view.rs` native bindings. Preserve Command Palette, Cmd+K,
  navigation history, Settings, standard Edit/Window actions, deep links,
  exact session paths/links, Help/shortcuts/About versions, and the normal
  app-menu Daemon submenu. No persistent tray icon is required by that submenu.
- Port `S/update_lifecycle.rs`, `S/coordinated_update.rs`, `S/update_hold.rs`,
  `S/daemon_upgrade_lifecycle.rs`, `S/updates_view.rs`,
  `S/daemon_upgrade_view.rs`, `S/bundled_runtime_view.rs` UI coordination.
  Keep the separate updater crate and established runtime/profile/service proof.
  Explicit one-shot daemon lifecycle actions may interrupt work under D131;
  ordinary GUI close/update must not replace/restart the daemon. Unknown remains
  inspectable, never an excuse to create another operation.
- Native Close, menu Quit and external should-terminate must capture exact
  input, respect secondary preedit/unsavable forms, drain current saves and
  obtain **current Close/Flushed after Store and input-lane release**. Checkpoint,
  channel status, timer or attempted Stop is not that acknowledgment. Preserve
  unsent drafts and admitted Unknown; do not send old intents on cold-open.
  macOS deferred termination requires a real request/reply hook on the selected
  upstream NSH, or a concrete integration report before choosing a bridge.
- Keep `apps/power`, `packages/daemon/src/power.ts`, `power-helper.ts`,
  `system-power.ts` and bundled helpers daemon-owned, independent of GUI lifetime.
  Preserve heartbeat/guardian cleanup, 60-second grace and existing opt-in lid
  policy. No live power/service setting change is part of migration.
- Reuse packaging/closure checks in `apps/desktop/scripts/bundle_runtime.py`,
  `verify_macos_bundle.py`, `verify_update_lifecycle.py`,
  `gui_release.py`, `linux_gui_package.py`, plus native helpers and release
  provenance. NSH packaging layout must be reconciled with that closure rather
  than replacing it with a demo binary. Keep source/build identity, attribution,
  updater helper and visual-worker binaries. No release dispatch or install.
- macOS15+ is first. Linux remains a later Wayland-only backend/package/native
  qualification with retained systemd user ownership; macOS success is no Linux
  proof. iOS is not part of production desktop migration.

## Updater suitability: compare contracts, not feature names

Observed upstream source at `0e4a20b`: `docs/dev/updater.md`,
`crates/nsh-updater/src/lib.rs` and `crates/nsh-updater/src/install.rs`.
Rust apps can call `nsh-updater` directly with their own HTTP; the JS module is
not required. That makes it relevant, but not a drop-in replacement.

| Contract | NSH observed implementation | Existing Pilot requirement/source | Disposition |
| --- | --- | --- | --- |
| Manifest trust/feed | Config/manifest version and ID, Ed25519 context-framed signature; public key optional for GitHub, required for custom host. Relative assets; SHA-256 and optional size checked by Download. | `U/manifest.rs`, `U/transport.rs`, `U/lib.rs`: existing signed release/build identity, configured trust/repository/transport and archive admission. | Different signed format/domain and configuration. Keep existing trust/feed; same crypto algorithm is not wire compatibility. |
| Installed identity/layout | `Installation::of` checks app ID and byte-equal packaged updater config under `Contents/Resources/nsh`; executable must exist/be executable. | `U/layout.rs`, `U/installer.rs`, `U/runtime.rs`, native platform checks: full GUI/runtime/helper closure, source/native identities and retained runtime policy. | Preserve Pilot full-payload verification. NSH packaged identity alone is insufficient. |
| Archive/resource safety | `install.rs::unpack` delegates ZIP/tar extraction, excludes AppleDouble and checks one root; macOS runs codesign deep/strict. | `U/archive.rs` and `U/archive/`: pre-index counts/EOCD, compressed/expanded/source limits, path/link/mode/ACL/inventory checks; installer/native closure and signing policy. | No equivalence demonstrated. Do not drop bounded extraction or full-payload policy based on codesign success. |
| Swap/launch rollback | `install_and_launch` swaps directories, restores on launch-command failure, removes old directory after successful activation command. macOS launches with `open -n`. | `U/installer.rs`, `U/helper.rs`, `U/installer_temporary.rs`: durable candidate/rollback/journal, helper READY/COMMIT, parent OS exit and replacement startup acknowledgment/recovery. | Command success is not fresh-app boot/Store ownership ACK. Keep Pilot transaction and rollback retention. |
| Save/exit | Rust caller exits after success; documented JS install waits 300ms for NSH storage writer then exits without further teardown. | `S/update_lifecycle.rs`, `S/interaction.rs`, `U/app_update.rs`, `U/coordinated.rs`: exact capture/checkpoint, Close/Flushed, input/store release, vetoes, no historical-intent replay. | Use app-owned lifecycle, never a fixed sleep or generic process exit. JS path is outside approved Rust-only scope anyway. |
| Daemon/service independence | NSH self-updater manages its app directory, not Pilot profile, service or worker admissions. | `U/coordination.rs`, `U/daemon_reservation.rs`, `U/runtime_service.rs`, daemon upgrade/control modules and `S/bundled_runtime.rs`. | Keep daemon management separate and unchanged. GUI adoption grants no service authority. |
| Platform/recovery qualification | Cross-platform updater library and tests; not Pilot's assembled distribution. | Full-payload macOS and separate Linux native/package/service qualification. | Reuse upstream only where a concrete contract fits. No production suitability claim from library tests. |

**Practical choice:** retain the existing UI-independent updater now; replace
its GPUI view/lifecycle attachment. NSH updater remains a comparison candidate,
not an approved feed/trust/installer migration. Replacing Pilot's transaction
would require a concrete contract/evidence plan and approval for any changed
trust/storage/service behavior. This does not block A1.

## Verification and fixture reuse

Use existing adapters in both runtime and tests; fake responses are allowed,
fake alternate transports are not evidence of integration. Isolate HOME/profile,
store and all processes. Do not discover the user's Local profile in fixtures.

| Reusable host/corpus | What it actually covers | NSH use and limits |
| --- | --- | --- |
| `S/*_fixture.rs`, especially `lost_ack_fixture.rs`, `chat_models_fixture.rs`, `queued_message_fixture.rs`, `mission_fixture.rs`, `project_settings_fixture.rs`, `native_review_fixture.rs` | Loopback synthetic HTTP, request barriers, held/swapped/lost replies and exact identities through real Rust adapters. | Keep production decoder/courier routes; drive NSH UI. Seeded JSON does not prove daemon route side effects or creation pipeline. |
| `packages/daemon/src/testing/workflow-host.ts` | Real isolated daemon routes/SQLite, stdin proxy and held/dropped responses; faux lead metadata overrides `sessions.get`, empty MissionService; workers cannot start. | Useful narrow workflow/lost-ACK host, not real standalone enrollment, coordinator runtime or provider execution proof. |
| `packages/daemon/src/testing/review-host.ts` and `session-workspace.ts` | Actual creation-only SessionManager.spawn, managed jj workspaces, FakeWorker checkpoints, retained snapshots, real review requests/routes/store; explicit stdin setup. | Prefer for Review custody/capture/enrollment integration. FakeWorker means no model/reviewer run; repeat capture checkpoints until pending is zero for many changes. |
| `S/interaction_*tests.rs`, `delivery_store_tests.rs`, `reader_identity_tests.rs`, `local_*tests.rs`, `history_latest_tests.rs`, `archive_reader_tests.rs` | Production state/transport/durable identity and recovery regressions. | Reuse pure tests after source seam changes. Add UI tests for stale selection/generation/lost ACK; do not settle Unknown from a rendered echo. |
| `tests/application_quit.rs`, `S/application_quit_probe.rs`, `S/lost_ack_probe.rs`, `S/history_paged_probe.rs`, `S/reader_restore_probe.rs` | Existing GPUI/native scenarios: actual app close/Quit, store reopen, exact draft/Unknown, paged reconnect and reading restoration. | Port assertions/host barriers, not GPUI handles. Require actual NSH process exit and immediate Store reopen, plus external termination veto/success cases. |
| `S/markdown_fidelity_tests.rs`, `S/markdown_nested_corpus.rs`, `S/markdown_nested_probe.rs`, tool/source tests and artifact native probes | Literal source/copy, nested code/list/quote, selection/recycle, supported visual chart/canvas/control/image behavior. | NSH parser/render behavior needs its own results. Keep exact source and compare Copy, not just screenshots. |
| Historical `experiments/nsh-pilot/src/tests.rs` and `native.rs` (linked above) | Same Rust NSH root under headless tests and real hidden AppKit interactions/captures with synthetic content. | Reuse native insertion/click/capture mechanics; add real adapters, durable restart/close and failure cases. They do not qualify hardware IME, active menus or representative-history performance. |
| `apps/desktop/scripts/check-scoped.py`, `ci.sh`, `test_ci.py`; updater fixture and lifecycle/package scripts | Scoped tests/lint/build, native target census, isolated updater/package scenarios. | Add NSH checks alongside retained GPUI checks. Keep harness=false targets registered; no fabricated full-suite success. Respect bounded shared mbx/build resources. |

Per slice: smallest relevant pure/adapter tests, matching format/lint/locked
build, hidden native interactions and actual narrow/wide light/dark captures.
Record what used real adapters versus synthetic host/model data. Broaden tests
for actual cross-cutting risk. Before performance claims, run representative
release histories/streaming/images and compare measured responsiveness; ask
before any visible benchmark. Native UI captures alone do not establish smooth
motion, OS input, Linux safety or complete production acceptance.

## Open-task reconciliation proposals

This covers **every remaining open task at the audit read**, including research
and non-parity tasks. Coordinator owns dispositions/plan edits; no task status or
assignment is changed by this document. Keep task bodies, source evidence,
artifacts and unresolved acceptance requirements. “Supersede” below means retire
stale implementation wording, not mark the NSH replacement accepted.

### Older parity umbrellas

| Task | Source/completion cross-check | Proposed disposition / slice |
| --- | --- | --- |
| #105 creation Unknown | Original operation diagnosis remains evidence-dependent; delivery/store now also have #279/#280/#514/#550 recovery work. | Keep report/evidence, reproduce exact identity before fixing; A1/A3, no blind retry. |
| #31 Wayland visual confinement | Worker/confinement source and isolated tests exist; task requires genuine native OS corpus. | Keep separately qualified Linux gate in B/F, never enable from a build/self-report. |
| #55 app polish, #82 palette shared labels | Old paused GPUI work predates design tokens and broad polish; `ui.rs`, `jump_view.rs`, #242–265/#456/#526 delivered later. | Supersede GPUI-specific cosmetic backlog with design-preservation checks A/F; keep parked work/evidence, no resurrection/rewrite. |
| #87 quarantined Swift artifact journey | Historical SwiftUI native readiness failure, cause not established. Product SwiftUI authoring removed by #532, stored sources kept. | Keep historical quarantine evidence; coordinator decide obsolete-app CI disposition, not an NSH browser/SwiftUI preview requirement. |
| #108 overview/tabs/inspector | `mission_browser_view`, `mission_overview_view`, `mission_inspector_view`; #177/#277/#281/#293/#380/#465. | Migrate delivered hierarchy C; narrow residual to actual detail refresh/coverage gaps. |
| #109 standalone mission | `mission_create*`; #188 passive creation exists. | Port C; retain coordinator-start/source-prefill options as distinct missing work. |
| #110 metadata/lifecycle | `mission_metadata*`, `mission_lifecycle*`; #189/#191/#419. | Port C; keep only deletion/other absent metadata as residual. |
| #111 membership/coordinator | Exact coordinator/member opening #369 exists; no general member administration UI. | Split missing join/move/leave and appoint/start/configure, C; do not duplicate navigation. |
| #113 decisions/proposals/comments | `mission_decisions*`, `mission_comments*`, resolve path; #205/#281/#293. | Port reading/history/exact withdrawal confirmation C; retain authoring/targeted reply/other resolutions. |
| #115 task management | `task_status*`, `task_edit*`, `task_model*`; #187/#190/#194. | Port existing edits C; keep assignment/claim/dependencies separate. |
| #116 phase editing | `mission_phases`, task grouping/folds; #380/#416. #489 is a contract audit, not editor delivery. | Keep blocked definition-write contract, plus order/gating/reassignment residual C. |
| #117 task start | Task creation #182/#389 is not task execution. | Keep explicit start/dependency/phase confirmation gap C. |
| #118 links/resources | `mission_resources*`, `mission_artifacts*`; #510/#511. | Port exact passive reads C/B; keep write manager/verified PR binding separate. |
| #119 managed-ticket roles | Overview reads pause/error reasons, not managed delivery editing. | Keep role/contribution/manual-pause controls as C/D residual requiring contract review. |
| #123 branch/workspace/Ask | Build-only #408/#412; project creation defaults delivered; no branch/workspace override chooser. | Keep override gap A3; drop Ask conversion as parity requirement, preserve legacy read-only. |
| #124 queue/held input | `queued_message*`; #198/#320/#343/#345/#361. | Port existing inline queue A3; retain held automatic-input controls only. |
| #127 context/usage | Context/Force/Continue/refresh/Paused #192/#208/#276/#341/#452/#466/#559. | Supersede missing-controls claims; A3/E migrate current controls, qualify true coverage. |
| #128 failure/recovery | Failure/model/Retry #200/#203/#276/#533 and handoff retry #542. | Port delivered recovery A3; retain attempt picker/rewind/prior-message editing/startup gaps, not courier retry duplicates. |
| #129 Home/Inbox | `app_shell`, `inbox`, sidebar state and subscriptions; #395/#415/#440/#473; Slack #523/#528. | Port D; keep authoritative dashboard/private reviewed-ack equivalence separate from loaded summaries. |
| #130 chat actions/Archive | `chat_actions*`, `archive_view`, passive archive transport; #180/#186/#355/#379/#411/#513. | Retire missing-UI claims; preserve archive reset/offline snapshot limitation A3/D. |
| #131 jobs/todos/children | `session_jobs`, `session_todos`, `session_subagents`; #210/#378/#449/#453/#544. | Port A3; keep actual missing child start/Stop controls separate; no sidebar children. |
| #132 Changes/file viewer | Global Review replaces Changes; retained-source guarded FilePane remains, #197/#204. | Supersede Changes UI request; B/A3 preserve Review and live FilePane boundary, no unapproved repo watch. |
| #133 Links | `conversation_links*`, `external_links`, `desktop_app_link`; #195/#298/#400/#403. | Port A3/F; keep loaded-history coverage/tab reuse qualification. |
| #134 Markdown | #488/#509 literal nested corpus, #414 streaming selection and #535 Notes. | Port A2 with corpus; retain grammar/OS-input/performance gaps, no blanket Markdown parity. |
| #135 PR workflows | Links/palette/GUI merged events #377/#424/#557 exist, no general attach/move/detach/merge UI. | Port existing A2/F; keep explicit PR management/confirmation gap, no agent merge authority. |
| #136 native visuals | #218/#222/#266–275/#289–291/#367/#531 delivered controls/charts/canvas/mockups. | Port supported schema B; keep concrete corpus omissions, not wholesale reimplementation. |
| #139 artifact previews/revisions | Gallery/inline #99/#218/#222/#248/#250; #495 delivered contract audit/tests, not picker UI. `artifact-revisions.md` confirms no bounded revision catalogue. | Port existing exact reads/Previous B; keep picker blocked on separately approved catalogue, latest-follow/durable reader state separate. Never guess `1..=revision`. |
| #140 share/links | Image/source Copy and safe native links #451/#494. | Port B; keep explicit export/share/screenshot gap. |
| #141 project artifacts | Current-chat gallery and pinned mission artifacts are not global/project enumeration. | Keep bounded API audit residual B/C, no guessed cross-session scan. |
| #143 notifications | No notification Settings category/native delivery owner found. | Keep missing OS permission/dedup/click-route gap F/E; scope capability before implementation. |
| #145 folders/Finder/GitHub | `sidebar_folders`, #415 delivered folders, not project repository discovery/Finder actions. | Port folders A/E; keep Finder/canonical repo-open residual. |
| #146 Usage | #196/#442/#452/#479/#499/#500/#502 overview/project filters/retained requests. | Port E; retain other grouping/reconciliation/budget residuals only. |
| #147 Memory | `project_memory*`; #486/#491/#501 browse, loaded-range search and explicit Refresh. | Supersede missing search/refresh wording; E keep full-store search and confirmed forgetting gaps. |
| #148 schedules | #497 roster and #498 contract-audit fallback preceded current `scheduled_messages*`, `recurring_schedules`, `automation_editor` and `schedule-creation.md` supersession. | Port D current creation/management with `expectedHome`; #498 alone did not implement creation. Preserve lost-ACK/no-blind-retry and revision admission. |
| #149 MCP | `mcp_status*`; #487/#518/#520 roster, Check/sign-in/cancel. | Port E; keep setup/config/remote-host and chat-level attention residuals. |
| #151 diagnostics | `diagnostics*`, #324/#482/#483 export and bound observations. | Port E; retain telemetry/actual evidence clear/config binding gaps. |
| #152 diagnostic repair | `diagnostic_repair*`, #529/#534 proposal editing/model and confirmed repair start. | Supersede missing-proposal/start wording; E preserve scoped evidence/approval/recovery. |
| #153 energy | #493 is a read-only audit/cached report, not policy UI; helpers #402/#405 exist. | Keep preferences/approval/status contract gaps E/F, not GUI-owned power. |
| #154 environment/setup | Project General/Workspace #144 does not deliver tool discovery/setup editors. | Keep narrow contract-reviewed residual E. |
| #155 tracking Settings | Project Slack #524 exists (`project_slack*`); Linear mappings and learned-rule guide/rebuild residuals remain. | Port Slack E; split other residuals, keep applied versus saved-only effects explicit. |
| #156 database Settings | Structured approval #122 is not connection/policy editing. | Keep gap E; preserve credential/grant boundaries. |
| #157 GitHub import | Add-existing #95 is not import/setup/resume wizard. | Keep separately guarded E/D residual; no live import. |
| #158 Linear work | Slack board is not Linear triage/start/state/cycle/subissue workflow. | Keep D residual; audit canonical existing APIs first. |
| #159 Slack | #523/#528/#530/#548/#549 plus #554 verification; `slack_triage*`, `chat_tracked`. | Port delivered board/thread/filters/palette/Start D; retain mission/common-case/search/Force sync/linked-chat residuals. |
| #160 menus/commands | #340/#364/#384/#411/#424/#456/#496/#519/#547/#550; `app_menu*`, `jump*`, `shortcuts_view`. | Supersede missing-base-menus wording; F/A3 port real commands, no removed Changes/Ask reintroduction. |
| #161 close/offline/history | #280/#471/#476/#503–508/#514–517/#550/#555/#560. | Retain NSH qualification gate A/F, reuse real regressions, not a feature rewrite checklist. |
| #162 input/motion/performance | Existing GPUI evidence/probes are baseline only. | Retain macOS native acceptance F/A/B; release histories before performance claims. |

### Other open work and policy gates

| Task(s) | Cross-check and coordinator proposal |
| --- | --- |
| #165, #166, #167, #168, #169, #170 | Ultimate-inspired notes/exploration/previews/self-improvement/anchored feedback/hierarchy are planning proposals, not approved migration additions. Preserve research; park outside A–F. Existing Review/mission threads are useful evidence, not proof all proposals shipped. |
| #181 | Same-title identity report remains evidence-dependent; A1 exact-ID navigation tests, not title-based dedupe. |
| #226 | Release packaging source #226 is landed; initial trust provisioning is recorded, qualification/rollout distinct. Keep source evidence; F reconcile NSH executable/closure only when packaging selected. No release trigger. |
| #228 | Keep full assembled macOS distribution qualification; isolated helper/demo tests are not full-payload acceptance. F. |
| #240 | GPUI dense-table timing is a measured historical regression, not an NSH limit. Preserve corpus/measurements; retest B in release before carrying over optimization code. |
| #302 | Concrete GPUI per-character Unicode truncation finding. Supersede GPUI patch request; keep emoji/combining-title geometry acceptance case A/F on unmodified NSH. |
| #310 | Personal iOS consideration remains deferred; desktop stack change does not approve mobile connectivity/signing or TSX. |
| #311 | Historical optional NSH artifact embedding proposal, not production shell migration. Keep separate/park pending exact artifact authoring/confinement contract. No executable reinterpretation of old artifacts. |
| #321 | Swift deletion/rename only after replacement acceptance and explicit user approval. Update GPUI-target wording to NSH, preserve required helpers/attribution. Never infer approval from tests. |
| #344, #390 | Historical live installation/upgrade requests and blocked evidence remain separate from source migration. #390 source blocker fix is delivered; neither authorizes new live actions. Coordinator close/narrow historical requests, not repeat them from this audit. |
| #347 | Audit finished; daemon already owned power. Rust helper #402 and Linux support #405 followed. Administratively close audit preserving policy/hardware gaps; F retains helper packaging/lifetime checks. |
| #351 | Linux recovery diagnosis/authorized archival finished without source commit; coordinator administrative closure, preserve cause/evidence. Not an NSH patch. |
| #353 | Proposal done, #363 delivered, #375 replaced ribbon per D94. Administratively close proposal; A2 ports current compact summary/latest-five, not rejected ribbon. |
| #359 | Proposal done, D98/#395 and later #415/#440/#453 delivered sidebar direction. Administratively close proposal; A preserves thread/project/unread behavior. |
| #382 | User request for unfolded opened-call sections remains specific follow-up to #375. Carry A2 as presentation acceptance/residual; inspect exact current disclosure before changing behavior. Preserve output/script copy and no duplicate arguments. |
| #385 | Plan completed; retained launchd/systemd implementation #387 and one-shot controls #519/#550 now exist. Administratively close first-stage plan, retain independent daemon distribution/update policy as separate future scope F. |
| #391 | Keep Linux native retained systemd user-manager qualification; container compile/absent-manager tests are not native cgroup/lifetime proof. Update corpus for D131 explicit interruption policy. F. |
| #406 | Keep Linux/KDE hardware sleep/lid qualification needing freshly authorized disposable fixture; no historical-host reuse or live power changes. F. |
| #410 | Audit delivered, #408/#412 removed ordinary Ask UI and kept legacy read-only. Administratively close audit with evidence; A retains restrictions. |
| #413 | Broad backend Ask policy is undecided, not a migration dependency. Park proposal; do not freeze/cancel/convert historical work or remove API compatibility. |
| #435 | Native blur qualification is superseded as product requirement by #526/D126 opaque surfaces. Preserve source/evidence; propose drop blur acceptance, retain Wayland renderer qualification F. |
| #457 | Investigation finished, no source commit; #464/#465/#471 reduce catalog/mission/history reads. Administratively close research, keep measured request corpus and retest real NSH adapter amplification, no assumed cure. |
| #458 | Investigation finished; #462 delivered temporary-tree flushing/cleanup changes. Administratively close research; keep full-payload timing gaps F, no extrapolated speed claim. |
| #459 | Diagnosis finished; old four-capsule refusal is historical. Current macOS source uses separate service store (#550/#560), with legacy store contract kept. Administratively close diagnosis, preserve recovery evidence, do not delete live roots. |
| #461 | Original safe published-runtime retirement is blocked on forward-use/reference semantics. Current `U/runtime_service.rs` and #550/#560 handle qualified roots in a distinct service namespace, not proof all old capsules can be deleted. Narrow to legacy residual/policy or supersede new-store scope; never census-only cleanup. |
| #536 | Opt-in visual artboard fit is a separate B enhancement, not current schema parity; retain current zoom/pan and selective text. |
| #537 | Same-chat image references change artifact validation/identity contract; keep approval-needed, not NSH renderer permission. |
| #538 | Hover/pressed style variants are a separate schema/renderer enhancement; port current press/focus behavior B first. |
| #539 | Visual layout animation is separate from porting existing reduced-motion/shared transitions. Keep optional B enhancement and existing clock semantics. |
| #540 | State-bound visual text input is a separate artifact API/control feature, not ordinary composer migration. Keep contract/IME validation separate. |
| #541 | Visual-check errors/recipes remain focused shared validator/skill work, outside this doc-only task and not prerequisite to B. |
| #562 | This source/task map. Coordinator applies proposals; no automatic plan/status mutations. |
| #563 | Active first production-adapter NSH slice A1; owns implementation/manifests/locks. This map neither edits its files nor blocks on its completion. |

## Attribution, preservation and unresolved acceptance

Keep existing MIT/third-party notices and attribution for any reused source;
the audited tree has no root LICENSE file, so do not invent one as evidence.
In particular
[MONOCODE.txt](../../apps/desktop/licenses/MONOCODE.txt) covers adapted tool/find/
context/diff/todo work. Keep [LUCIDE.txt](../../apps/desktop/licenses/LUCIDE.txt),
[OCTICONS.txt](../../apps/desktop/licenses/OCTICONS.txt),
[INTER.txt](../../apps/desktop/licenses/INTER.txt),
[JETBRAINS-MONO.txt](../../apps/desktop/licenses/JETBRAINS-MONO.txt) and
[HOME-SKY.txt](../../apps/desktop/licenses/HOME-SKY.txt) with corresponding assets.
NSH's observed workspace license is **Apache-2.0**, not MIT: retain its license
and applicable dependency/NOTICE requirements in the final payload. Reconcile
the actual NSH Rust feature/dependency closure and bundled font/image licenses;
do not assume removing GPUI source removes obligations for copied code/assets.

Acceptance still needs evidence, not another speculative architecture study:

1. **Production adapter boundary:** A1 must exercise actual read/courier/store
   code; all subsequent pages must keep the same authority and durable identity.
   Test stale hello/summary/generation, lost ACK, accepted-but-private-save-failed,
   selection switch and restart, not just successful JSON decoding.
2. **Native input/content:** exact Unicode/UTF-16/graphemes, hardware IME,
   undo/redo, keyboard/focus after menus/dialogs/recycling, system clipboard,
   literal nested Markdown and long sources, retained selection, images/zoom and
   complete paged history/Find. Distinguish mounted selection from full history.
3. **Lifecycle:** actual NSH Close/Quit/external termination veto and acknowledgment,
   fresh Store ownership, preferences/secondary inputs, visual worker drain,
   updater helper handshake/rollback/startup acknowledgment and daemon-independent
   GUI replacement. No inferred durable ACK from elapsed time or launch success.
4. **Supported workflow parity:** A–F visible routes plus remaining explicitly
   scoped gaps above. Unsupported legacy artifact placeholders preserve source;
   they are intentional, not successful renders. Backend/host expansion needs
   separate approval, not workaround transport code.
5. **Design/motion/performance:** actual native narrow/wide light/dark rendering,
   reduced motion and stable streaming/reading layout; representative release
   histories and mixed artifacts before speed claims. Old GPUI timings and the
   smooth synthetic NSH prototype establish baselines, not final performance.
6. **Distribution/platform:** assembled macOS15+ payload, trust/closure/native
   helpers/service reuse and attribution; Linux Wayland/service/confinement/power
   separately. No claim of user acceptance, hardware qualification, release
   readiness, default switch or Swift retirement from this document.

Keep implementation practical: ship A1, extend through focused A–F slices, reuse
the real Rust seams and fixture hosts, and reproduce any concrete upstream NSH
gap on the unmodified selected revision before escalating it. Do not silently
drop behavior or turn hypothetical limitations into blockers.
