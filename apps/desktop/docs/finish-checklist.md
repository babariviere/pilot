# macOS finish checklist

Source reconciliation, 2026-10-30, against parent
`d62af634f021801acb725776ed4f94e7ea0c3168`. This replaces the **remaining-work
interpretation**, not the historical evidence, of [everyday parity](../evidence/everyday-parity.md)
and [Settings parity](settings-parity.md). It is not a redesign, a full capability
inventory, permission to act on live data, or product acceptance.

Task numbers below identify internal coordination records, not GitHub issues.
They are supersession **proposals for the coordinator**, not status changes.
Superseding delivery numbers in the tables refer to completed records. Older
records without a completion object are not assigned invented
commit hashes. No runtime tests/builds or live actions were run for this audit.

## Finish next, without reopening delivered features

- [ ] **Everyday reliability:** retain #105 (unknown creation) and #181
  (same-title navigation) as evidence-dependent reports. Reproduce with exact
  operation/chat identity before proposing a fix. Keep #161/#162 as qualification,
  not feature umbrellas. Run selected native journeys for Send/Stop, draft edits
  during HTTP waits, queued edits, lost ACK, reconnect, paged history/Find and Quit.
  Preserve Unknown and immutable envelopes, never infer acceptance from an echo.
- [ ] **Input acceptance:** qualify real macOS IME, grapheme/UTF-16 selection,
  undo/redo, clipboard interoperability, keyboard-only navigation and focus after
  dialogs/recycling. Existing simulated preedit and hidden GPUI probes are useful
  regressions, not OS-input acceptance. Do not rebuild Swift to do this.
- [ ] **Mission management:** split #111 into explicit membership move/leave and
  coordinator management; split #115 into assignment and dependencies; keep
  #116 phase/order editing separate from delivered phase display. #117 task-start
  confirmation depends on those contracts. Begin each with existing endpoint and
  side-effect review; missing atomic safety requires a narrowly scoped decision,
  not an invented client workaround. #389 is a small ready presentation gap:
  move New task into a dialog without changing creation semantics.
- [ ] **Small missing daily surfaces:** choose separate read-only memory (#147),
  schedule creation (#148), MCP roster (#149) and energy status (#153) slices.
  Do not bundle their write/setup/sign-in flows. Add project default-model editing
  as a small residual of #144, not a repeat of General/Workspace Settings.
  The [energy read audit](energy-status.md) found only a cached report without
  observation freshness or structured platform/unknown metadata. Do not add a
  current-state page or infer inhibition from configuration under that contract.
  The [default-model audit](project-settings.md#default-model-contract-audit) found
  a non-atomic GET/PATCH overwrite race; safe editing is blocked on an approved
  captured-model precondition, not on another catalogue or chat-model picker.
- [ ] **Content:** leave giant tool-source expansion/scroll performance with
  active #420; do not open a second renderer refactor. #134 still needs table/list/
  code-copy qualification. Narrow #139 to revision selection/following, #140 to
  export, #141 to project enumeration contract review.
- [ ] **Settings/integrations:** prioritize truthful missing controls over new
  dashboards. #146 remaining filters/reconciliation are distinct from the delivered
  overview. #151 telemetry/clear/repair binding is distinct from local reviewed
  export. Keep #154–159 as individually scoped gaps, not one integration project.
- [ ] **Updater and acceptance:** use existing isolated lifecycle/full-payload
  checks and retain blocked #228/#390/#459/#461 for their actual qualification/
  live-state blockers. Delivered source and a fast preparation measurement do not
  authorize installation, service migration, runtime deletion or Swift retirement.

## Proposed reconciliation of open parity tickets

**I** = implemented for the stated source scope, not accepted parity.
**P** = partly implemented; retain only the named residual.
**M** = missing from the audited reachable Next UI, not necessarily the daemon.
**D** = deliberately excluded by current decisions. **B** = blocked on evidence,
authority or platform qualification. A source symbol is implementation evidence;
a test/probe file is only a reproducible check until its recorded result is cited.

### Missions

| Old ticket | Current classification and coordinator proposal | Checked source; superseding delivery |
| --- | --- | --- |
| #108 overview/tabs/inspector | **P.** Retire missing-overview/inspector claims. Keep full live-detail refresh and any specifically required absent tab behavior, not a six-tab redesign. Current tabs are Overview, Tasks, Review. | [Browser::Tab/accept](../src/mission_browser_view.rs), [Inspector](../src/mission_inspector_view.rs), [Review::Pane](../src/native_review_view.rs); #177, #277, #281, #293, #380, #465. |
| #109 standalone creation | **P.** Basic passive standalone creation is delivered. Keep optional fresh-coordinator/start and tracked/source-prefill choices separate. | [Form](../src/mission_create_view.rs), [transport](../src/mission_create_transport.rs); #188. |
| #110 metadata/lifecycle | **P.** Title/goal and confirmed Archive/Reopen/Mark done are delivered. Do not reopen them; deletion or other metadata needs its own scope. | [metadata Form](../src/mission_metadata_view.rs), [lifecycle Action](../src/mission_lifecycle.rs), [capability/ACK transport](../src/mission_lifecycle_transport.rs); #189, #191, #419. |
| #111 members/coordinator | **P.** Exact available coordinator/member opening exists. Membership move/join/leave, appoint/remove/start/configure are missing. | [Browser::coordinator/open_coordinator/can_link](../src/mission_browser_view.rs); #369. |
| #113 decisions/proposals/comments | **P.** Reading decisions, pending proposals and all comments exists. Authoring, accepting/rejecting proposals, targeted replies and resolution remain. | [reveal_proposal](../src/mission_decisions_view.rs), [read-only Comments](../src/mission_comments_view.rs); #205, #281, #293. |
| #115 task status/owner/model/dependencies | **P.** Status, title/body and passive future-model choice exist. Keep claim/release/assignment and dependency editing. Status mutation has disclosed coordinator/phase effects, not passive safety. | [row_menu/RowAction](../src/mission_tasks_view.rs), [status transport](../src/task_status_transport.rs), [model transport](../src/task_model_transport.rs); #187, #190, #194. |
| #116 phases/order | **P/B.** Grouped phase progress, folding and finished-task filtering exist; definition editing is blocked by ordinary mutation side effects and non-exact phase targeting. Phase deletion/gating, reassignment and ordering remain separate missing work. | [phase contract audit](mission-phase-editing.md), [Index::groups](../src/mission_phases.rs), [Pane::toggle_phase](../src/mission_tasks_view.rs); #380, #416, #489. |
| #117 task start | **M.** No task-start action in the task row menu. Preserve explicit confirmation/dependency/phase handling requirement. | [row_menu/RowAction](../src/mission_tasks_view.rs); task creation #182 is not task execution. |
| #118 resources/artifact links | **P.** Existing mission/task resources have read-only list/details, guarded Open, exact Copy and exact task navigation. Mission-level exact pinned artifacts open native readers. Creation/edit/removal, ticket delivery controls and verified PR binding remain missing. | [reported resources](mission-resources.md), [attention](../src/mission_browser.rs), [pinned artifacts](mission-artifacts.md), [Browser](../src/mission_browser_view.rs); browsing does not deliver a resource manager or binding authority. |
| #119 managed-ticket roles/pause | **P.** Paused/error ticket reasons are readable. Role, contribution and manual-pause editing remain missing. | [attention](../src/mission_browser.rs), [overview attention](../src/mission_overview_view.rs); #281. |

### Conversation, navigation and native content

| Old ticket | Current classification and coordinator proposal | Checked source; superseding delivery |
| --- | --- | --- |
| #122 database approvals | **M.** Structured access requests deliberately cannot become generic message consent. Keep exact grant/deny UI as a separate contract audit. | [Question parsing, Kind::AccessUnavailable](../src/question.rs). #121/#394 answer ordinary questions, not database grants. |
| #123 branch/workspace/Ask conversion | **M/D.** Explicit branch/workspace override missing. Ordinary creation is Build-only; broad Ask removal/conversion policy remains blocked #410/#412/#413, not implied by autonomy. | [new_chat_setup](../src/new_chat_view.rs), [project fields](../src/project_settings.rs); #408, D102. |
| #124 queue/held input | **P.** User steering/follow-up queue edit/remove is delivered. Retain held automatic-input management only. No visible Follow-up button is required. | [Snapshot/Change](../src/queued_message.rs), [inline view](../src/queued_message_view.rs), [queue contract](queued-messages.md); #198, #320, #343, #345, #361. |
| #125 image attach/display | **I** for Build/coordinator attach/paste/drop, previews/remove, stored images and native Copy image. Propose supersede; retain OS clipboard qualification under #162. Ordinary Ask/explorer and coordinator-child sends remain refused. | [save_to/coordinator_readable](../src/image_attachments.rs), [image contract](image-attachments.md); #199, #451, #454, #474. |
| #126 path/slash completion | **P/D.** Path completion delivered; native slash chooser absent and outside D68's approved path slice. Separate any slash-command proposal. | [Token::replacement/utf16](../src/path_completion.rs), [path contract](path-completion.md); #212, #437. |
| #127 context/usage recovery | **P.** Context popover, Force/Pause, model continuation and shared subscription gauges/refresh exist. Retain any required near-limit composer notice, not a second usage owner. | [subscription_row/confirm_continuation](../src/chat_subscription.rs), [context](context-usage.md), [limits](subscription-limit.md); #192, #208, #276, #341, #452, #466. |
| #128 startup/rewind/attempts/continuation | **P.** Failure reason, next-model recovery and explicit continuation exist. Startup recovery, attempt selection and rewind/edit-prior-message are not delivered by courier Check/Retry. | [WriteCommand](../src/interaction.rs), [failure](session-failure.md), [failed model](failed-chat-model.md); #200, #203, #276. |
| #129 authoritative Home/Inbox/review | **P.** Shared subscription reports and project/mission-thread/read marks exist. Home activity remains loaded-summary-derived; no complete authoritative dashboard/Inbox or private reviewed-ack equivalence. Review tab is not review acknowledgment. | [Page/Counts](../src/app_shell.rs), [sidebar memory](../src/sidebar_memory.rs), [Usage](../src/usage_overview_view.rs); #341, #395, #415, #440, #473. |
| #130 chat actions/archive | **P.** Rename/pin/archive/restore/copy references, palette archive and dedicated Archive navigation now exist. Archive covers all registered summaries, exact project/mission filters and process-retained offline rows. Passive transcript pages are not an atomic context-pinned snapshot across reset; no passive artifact catalogue/live-tail claim. Coordinator owns parent reconciliation. | [actions contract](chat-actions.md), [Archive coverage/residual](archive.md), [Archive](../src/archive_view.rs); #180, #186, #355, #379, #411, #513. |
| #131 jobs/todos/subagents/status | **P.** Jobs/log/Stop, todos, child conversations/drafts/send and compacting/Paused status exist. No child start/Stop controls. Actual subagent sidebar rows are intentionally removed, not missing parity. | [jobs worker](../src/session_jobs.rs), [todos Feed](../src/session_todos.rs), [child Target/transcript](../src/session_subagents.rs); #210, #378, #399, #401, #449, #453, #466. |
| #132 Changes/file view | **P.** Canonical diff and bounded file reader delivered. Refresh is explicit, not repository-event/polling parity; refusals must not fall back to guessed paths. | [Pane::refresh](../src/workspace_changes_view.rs), [Content::parse](../src/session_file_view.rs); #197, #204. |
| #133 Links/external handling | **P.** Loaded-source inspector, normal external opening and desktop Slack/Linear routing delivered. Keep exact history coverage/existing-tab reuse qualification separate. | [Pane::open](../src/conversation_links_view.rs), [route/open/badge](../src/external_links.rs); #195, #298, #400, #403. |
| #134 Markdown/copy/folding | **P.** User folding, copy, streaming selection, Mermaid and structured questions/compaction exist. Focused table/list/top-level and nested list/quote literal-code coverage is recorded separately; not full Markdown or giant-source acceptance. | [Markdown corpus and limits](markdown-fidelity.md), [selection evidence](../evidence/selection.md), [folding](message-folding.md), [Markdown hook](../src/markdown_mermaid.rs); #213, #296, #358, #375, #397, #414, #418, #426, #488, #509. |
| #135 PR actions/merge | **P.** Confirmed PR links and current-chat palette opening exist. Attachment/move/detach and merge-confirmation UI remain absent. No agent merge authority. | [Destination::OpenLink/pull_requests](../src/jump.rs), [GitHub events](../src/github_event_view.rs); #377, #424. |
| #136 native visuals | **P.** Controls, chart geometry/readouts, animated canvas/pointer and inline zoom/pan exist. Keep only supported-corpus omissions or measured regressions; not full Swift/browser equivalence. | [ArtifactPane::event/draw_pointer](../src/artifact_view.rs), [chart evidence](../evidence/chart-parity.md); #218, #222, #266–275, #289–291, #367. |
| #139 previews/revisions | **P.** Gallery and inline image/native previews delivered. Previous revision and exact source exist; explicit picker needs a bounded revision catalogue, absent from the current contract. Latest-follow and durable reader state remain separate. | [gallery Key/Metadata](../src/artifact_gallery.rs), [ArtifactPane::open/render](../src/artifact_view.rs), [revision contract audit](artifact-revisions.md); #99, #218, #222, #248, #250. |
| #140 artifact sharing/links | **P.** Exact source/native image clipboard copy and explicit safe native visual links delivered. File export/share/screenshot still missing. Visual links reuse message routing, never execute artifact source. | [copy_image](../src/artifact_view.rs), [fenced visual links](../src/artifact_link.rs), [contract](inline-visuals.md#resource-links); #451, #494. |
| #141 project artifacts | **M/B.** Current-chat gallery is not project/global enumeration. Audit existing bounded API before any UI; new backend enumeration requires approval. | [Metadata::accept(owner)](../src/artifact_gallery.rs); #99 is not project browsing. |

### Settings and integrations

Missing-page findings below were checked against the reachable
[Settings Category](../src/settings_view.rs), [project Fields/Submission::patch](../src/project_settings.rs)
and [shell Page](../src/app_shell.rs), not inferred from filenames alone. These
currently expose no notification, energy or tracking page.
Scheduled messages now has a passive Local roster, described below.
MCP now has a passive Local report page, described below.
Memory now has a separate passive project window, described below.
Usage and Settings also have separate windows, so absence from `Page` alone is
not an absence proof. Swift links are historical capability references only.

| Old ticket | Current classification and coordinator proposal | Checked source; superseding delivery |
| --- | --- | --- |
| #143 notifications | **M/B.** Preference, OS permission/delivery/dedup/click route absent. Native OS notification capability must be scoped under D57 before implementation. | Next Category above; Swift [NotificationSettings](../../macos/Sources/Pilot/Settings.swift). Attention UI is not notification delivery. |
| #145 folders/Finder/GitHub | **P.** Client-only folders delivered; Finder reveal and project-repository resolution/open remain. Opening an already validated web link is not repository discovery. | [Folders methods](../src/sidebar_folders.rs), [external_links::open](../src/external_links.rs); #415. |
| #146 Usage | **P.** Local dated overview/trends, coverage, shared subscription refresh delivered. Historical All/project/Unattributed filtering uses existing passive ledger queries with a visibly bounded catalogue. On-demand retained request pages replace25 rows with exact selectable/copyable data and generation/cursor reset; authoritative totals remain separate. Other group filters/reconciliation and informational budgets remain residuals. | [Usage](../src/usage_overview_view.rs), [Range/State](../src/usage_overview.rs), [records](usage-overview.md#retained-request-records); #196, #442, #452, #479, #499, #500, #502. |
| #147 memory | **P.** Read-only project summary/note browsing delivered separately. Search, live refresh and explicit forgetting remain; forgetting needs a confirmed-action contract. `sidebar_memory` is unrelated UI state. | [Memory window](../src/project_memory_view.rs), [existing contract audit](project-memory.md); #486. Swift [MemoryPage](../../macos/Sources/Pilot/MemoryPage.swift) remains the historical fuller reference. |
| #148 schedules | **P/B.** Passive global roster/details delivered. One-time creation is blocked: POST has no mutation-time daemon/lineage precondition; postflight can detect a replacement only after an executable row exists. Management/repeats remain separate. | [Passive roster](scheduled-messages.md), [creation contract and isolated evidence](schedule-creation.md); Swift [ScheduleSheet/ScheduledMessages](../../macos/Sources/Pilot/ScheduleUI.swift). |
| #149 MCP | **P.** Read-only Local reported roster/status/details delivered. Check/test/reconnect, sign-in/auth and setup/config actions remain separate reviewed scope. No GUI credential/config fallback. | [Passive contract audit](mcp-status.md), [native page](../src/mcp_status_view.rs); #487. Swift [ConnectionSettings/McpCheckButton](../../macos/Sources/Pilot/ConnectionSettings.swift). |
| #150 account inventory | **I** for resolving the inventory question: no standalone provider-login Settings category in the checked Swift inventory. Propose retire the unknown, not invent a login feature. Import's GitHub setup remains #157. | Swift [SettingsTab.general](../../macos/Sources/Pilot/Settings.swift); Next Category above. |
| #151 diagnostics controls/export | **P.** Local reviewed export and current-host macOS `next_app` reader delivered. Telemetry/reporting controls, actual clear and repair-checkout binding remain absent. Clear preview is not retained-evidence erasure. | [Diagnostics::review/clear/export](../src/diagnostics_view.rs), [closed reader/control scope](diagnostic-coverage.md); #324, #482, #483. |
| #152 diagnostic chat/repair | **P.** Help → Ask about Pilot creates an explicit read-only diagnostic draft; no start before Send. Repair proposal/configured-checkout approval flow is missing, not granted by diagnostic role. | [menus](../src/app_menu.rs), [ChatEditor::new_diagnostics](../src/chat_editor.rs), [new_chat_setup](../src/new_chat_view.rs); #478. |
| #153 energy | **P/B.** Daemon-owned Rust helper source delivered, native Settings controls absent. Passive GET is cached and lacks observation freshness/structured platform unknowns; current-state UI awaits a narrowly approved read contract. Preserve opt-in macOS lid policy; hardware qualification remains separate. | [Read audit and isolated regression](energy-status.md), [power crate](../../power/Cargo.toml), Swift [EnergySettings](../../macos/Sources/Pilot/EnergySettings.swift); #402, #405, #493, blocked #347/#406. |
| #154 environment/setup | **M/B.** No toolchain/setup/local-file/database-plan editor. Scope existing discovery first; execution/setup authority is not General Settings authority. | Project Fields above; Swift [EnvironmentSettingsSection](../../macos/Sources/Pilot/EnvironmentSettings.swift). |
| #155 tracking configuration | **M.** No Linear mapping or Slack channels/labels/guides editor. Read-only service links and mission attention do not implement configuration. | Project Fields above; Swift [TrackingSettingsSection](../../macos/Sources/Pilot/TrackingSettings.swift). |
| #156 databases | **M/B.** No connection/policy editor. Do not use ordinary question answers as grants; audit credential-owner and exact approval contract first. | Project Fields and Question above; Swift [ProjectDatabaseSettingsSection](../../macos/Sources/Pilot/DatabaseSettings.swift). |
| #157 GitHub import | **M/B.** Existing-local-folder Add project is delivered, not import/account/setup/reconciliation. No credentials/setup execution fallback. | [Add project contract](add-project.md); Swift [GitHubImportContent](../../macos/Sources/Pilot/GitHubImportSheet.swift); #95 does not supersede import. |
| #158 Linear work | **M** for queue and tracked-work actions; **P** only for links/mission paused-ticket attention. Separate read-only browsing from external mutations. | [attention](../src/mission_browser.rs), [external route](../src/external_links.rs); #281, #403 are not a tracked-work queue. |
| #159 Slack triage | **M.** Desktop deep links exist, not triage board/common cases/ingestion or corrections. Preserve explicit external actions and rate/manual-pause rules. | [external route](../src/external_links.rs), Page above; #403 is not triage. |
| #160 menus/keyboard/palette | **P/D.** Native menus, standard Edit, guarded history, Command Palette, archive/current-chat links, diagnostic Help and native shortcut reference delivered. Keep missing mission/task resources/actions and specific scoped keyboard gaps; no blanket slash chooser. | [menus](../src/app_menu.rs), [Destination/Kind](../src/jump.rs), [menu contract](native-menus.md), [shortcut reference](../src/shortcuts_view.rs); #229, #340, #364, #384, #411, #424, #456, #478, #496. |

## Evidence and gates that still prevent “finished”

- **Delivery/history:** [Interaction::run](../src/interaction.rs),
  [DeliveryOwner::submit/submit_answer/reconcile](../src/interaction_delivery.rs)
  and [chat_sending::shown_text](../src/chat_sending.rs) separate saved drafts,
  visible sends and immutable pending operations. The current owner services
  autosaves during ordinary Send, Stop, chat model/thinking selection and inspection,
  subscription Force/Continue, child-message sends, chat-to-mission conversion,
  project registration and its post-registration catalogue, question replies and
  explicit receipt recovery waits, but mutation/Stop/checkpoint commands remain FIFO. The [held Stop
  regression](stop-autosave.md) separates durable typing from Stop acknowledgment;
  it is not live Stop-latency qualification. The [model wait regression](model-autosave.md)
  preserves separate healthy/failed-next-model contracts and Unknown/no replay;
  the [subscription wait regression](subscription-autosave.md) preserves existing
  Force meaning, continuation confirmation/admission and no replay. The
  [child-send wait regression](subagent-autosave.md) preserves the one-shot
  request ACK, exact child identity and Unknown/no replay without inventing
  receipt/Inspect support. The [conversion wait regression](mission-autosave.md)
  retains guarded admission, one-shot captured intent, current-membership-only
  inspection and volatile accepted evidence on private disk faults. The
  [registration wait regression](project-registration-autosave.md) preserves
  path/attempt capture, staged one-shot registration, catalogue-only inspection,
  Unknown/no replay and existing row validation. This closes the known
  Interaction HTTP/Store-borrowing adapters, not all app ownership work. Project
  default-model PATCH remains outside this coverage.
  #280's [restart evidence](../evidence/restart-retention.md)
  records synthetic lost-ACK/restart checks, not force-quit/power-loss qualification.
  Compare the textarea to `shown_text`, not blindly to saved draft text.
- **Lazy history:** #471/#476 have recorded hidden native and synthetic transport
  results in [lazy history](lazy-history.md). Initial 60-entry tail, contiguous
  24-entry older pages and explicit full-history Find are implemented. Distant
  reading marks still page sequentially; loaded history is not constant-memory.
  Old installed daemons retain legacy behavior. #469 fixes historical tool status,
  not a general proof of live activity. Keep active #457 load-amplification work
  separate from claims that history is missing.
- **Input:** [ChatEditor::marked](../src/chat_editor.rs),
  [preedit/navigation tests](../src/chat_editor_tests.rs) and
  [selection evidence](../evidence/selection.md) demonstrate specific synthetic
  contracts. #161/#162 still need genuine OS journeys, large streaming sessions,
  smooth motion/reduced-motion and close/Quit/offline qualification. No new
  performance budget or visible benchmark is authorized here.
- **Updates/services:** #387 records real isolated launchd fixtures, not live
  migration; #391 still owns native systemd/cgroup lifetime qualification.
  #462's [timing evidence](update-timings.md) separates disposable extraction from
  final durability: [extract_payload](../updater/src/installer.rs) selects temporary
  extraction only for the macOS temporary layout, retaining durable extraction
  elsewhere. [Daemon upgrades](daemon-upgrades.md) describes current source;
  #461 retirement remains blocked. Positive no-use/reference proof, exact boot/
  lease/ACK and rollback evidence cannot be replaced by an empty census or GET.
- **Other stale umbrellas:** propose #221 superseded by #265's embedded font work
  ([appearance::FONTS](../src/appearance.rs)). #264 itself records an already-landed
  Linux fix despite remaining todo: [linux_release_capsules](../scripts/gui_release.py)
  still admits previous releases, and [selected/owner_live](../updater/src/coordination.rs)
  selects the app runtime when the old profile lease is not held. Propose retire
  its implementation backlog using its own delivery record, retaining platform
  qualification; #232/#262 alone are not proof of all D79 behavior.
  Keep active #31/#312/#351/#353/#359/#420 and evidence-dependent
  #87 with their owners until reconciled, rather than assume open means missing.
- **Deliberately outside acceptance:** HTML/React/SwiftUI/browser rendering is
  excluded from Next, legacy sources retained (#278, D67/D82). Terminal, shaders/
  3D, dedicated screen-reader work and iOS remain deferred. [Mermaid](native-mermaid.md)
  is a bounded subset with Invalid/Unsupported refusal, not full Mermaid parity.
  NSH experiments (#310/#311) are not required GPUI parity.
- **Separate approvals/platforms:** Linux GUI/update source delivery is not all
  Wayland confinement, blur, input, service or hardware acceptance (#31/#391/#406/
  #435). #226/#228 release/full-payload qualification and live #344/#390 must retain
  their actual gates. No release trigger, signing/feed change, live provider/data/
  service/app action, runtime cleanup, default switch or Swift deletion follows
  from this checklist. #321 requires user acceptance and explicit retirement,
  with PilotPower/data preserved and D89 naming considered afterward.

Coordinator action: supersede only the delivered subscopes above; narrow each
partial ticket to its residual, keep missing/blocked/deferred work distinct, and
create small fresh implementation tasks in that order. No blanket “parity done.”
