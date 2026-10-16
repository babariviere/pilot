# Native devbox UI implementation ownership

All helpers receive an explicit `HostClients`. No global endpoint switch or Local fallback.
`HostViewContext(host:hosts:)` is the lead-owned immutable native surface context. Its `ref` and
`perform` methods qualify resource IDs and resolve the current verified endpoint per operation.

## Lead

Own existing native screens, AppModel, MainWindow, navigation, composer/drafts/feed/cache/resource
integration, Settings destination registration, Theme/PilotIcon, notification/deep-link integration.
Replace the temporary terminal-only hosted destination with the existing chat/inspector layout.
Own runtime-package credential injection from the app's existing update access layer.

## Helper A

New setup/settings/provider/runtime-update UI files and tests only. Entry point:
`DevboxSettings(hosts: HostClients, loadPackage: optional trusted async closure)` with an optional injected runtime-package loader for fixtures.
Expose a production loader service in a new file using existing UpdateAccess/UpdateRelease APIs;
coordinate its signature with lead, never read another host's credentials or persist tokens.
Use existing SettingsPage/SettingsSection/SettingsRow and SheetScaffold.
Use enroll then adopt after confirmed bootstrap; provider helpers and runtime update interfaces
already belong to HostClients/PilotCore. No root file edits, chat creation or alternate remote screen.

## Helper B

New sharing sections/sheets/models and tests only. Explicit `HostRef`, `HostClients`, enrolled
`SharedContextBinding`, and qualified navigation callbacks. Entry points:
`ProjectSharingSection(project: HostResourceRef, hosts: HostClients)`;
`SharedMemoryContent(host: HostRef, binding: SharedContextBinding, hosts: HostClients)`;
`SharedTaskPlacementFields(mission: HostResourceRef, task: MissionTask, hosts: HostClients)`.
Components embed into existing project settings, MemoryPage and mission task forms. Additional
conflict-review sheets are allowed; no parallel remote project/mission/memory pages.
Coordinate exact optional callbacks/results with lead before wiring. Helper B owns new typed client extension files and consumes existing shared read adapters.
Lead owns all PilotClient/HostClients root edits and the bounded request seam.
Binding-scoped reads supply real saved content and pending contributions. Current entity versions
and distinct task definition versions are required; unknown versions block changes, never guess.

## Sharing-swift

Own PilotCore/SharedContext.swift wire mirrors and focused Core tests only. No PilotClient,
HostClients or general native root/UI edits. Backend followups remain intact as the first
 task #5 commit. Conflicts endpoint returns SharedMissionProposal arrays.

## Live client seam

`PilotClient.resourceRequest<Response: Decodable & Sendable>(_ path: [String], method: String = "GET",
body: Data? = nil, query: [URLQueryItem] = [], maximumBytes: Int = 1024 * 1024) async throws -> Response`.
It encodes path segments, bounds requests/responses, and checks availability/socket generation.
Helper B's NEW typed extension files may call it. Existing read methods are sharedMission,
sharedMissionVersions, sharedMissionConflicts, sharedMemoryWake/Recall/Zoom/Tree, with matching
HostClients wrappers. Lead already supplied SharedProjectActions.swift (TaskPlacementRequest,
SharedEditResolution, TaskReleaseResult and fenced HostClients mutation wrappers); consume/extend
that NEW file rather than duplicate declarations. Coordinate its ownership with lead before edits.

## Copy and verification

Use Saved here, Pending sharing, Conflicting edits, Disconnected and Stop requested. Never call a
disconnected chat stopped or permit moving work until the previous devbox confirms it is released.
Every helper supplies focused tests and optional static SwiftUI mock source. Parent renders/publishes
the mock and owns all VCS, PRs and task links. Heavy builds/full suites/packaging run in CI only.
