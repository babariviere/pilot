# Standalone Local mission

The Missions catalog's **New mission…** opens one retained native form. Choose
an existing Local project, enter a title (200 UTF-16 units) and goal (4,000),
then explicitly **Create mission** or ⌘Enter. Plain Return edits text. The form
states that creation starts without an agent. It offers no coordinator, drafting,
tracked-work import, member movement or automatic chat start. Existing-chat
**Make a mission** is unchanged.

## Existing contract audit

- Swift: `apps/macos/Sources/Pilot/MissionSheets.swift::CreateMissionSheet.create`
  sends `startCoordinator: false` with no source for its no-coordinator option.
- HTTP: `packages/daemon/src/server.ts::missionRoute` accepts
  `POST /api/missions` and returns 201 plus MissionDetail.
- `packages/daemon/src/mission-service.ts::MissionService.create`: no
  `fromSessionId` selects only store creation; only a truthy
  `startCoordinator` starts a chat. No source means no join or draft message.
- `packages/daemon/src/missions.ts::MissionStore.create` defaults to no brief
  or tasks and emits the creation event. Notifications/detail construction can
  fail after commit. Non-201 errors are not proof of rejection.

The new transport sends exactly projectId/title/goal/startCoordinator:false.
It rechecks pinned Local hello identity, the bounded canonical project catalog
and hello again before the single non-idempotent POST. It validates the ACK's
mission identity, captured project/text, empty collections, no coordinator and
zero brief revision. It does not add an idempotency key, invent an endpoint,
retry redirects/errors, or use GET/title/status matches as receipts.

## Retained state

The Browser owns the form across close/navigation; native input entities,
selected project and immutable operation stay together. A hidden completion
updates only that operation. Pending, Created and Unknown block resubmission.
Only a positively unsent preflight failure permits another explicit submission;
only a validated creation ACK exposes Another mission. Copy text remains
available for attempted operations. Draft/ACK retention is process-local and the
form discloses that it does not survive restart.

Marked text blocks submit, close and sibling pointer focus before blur. The
Browser's existing navigation guard includes this form. Close restores a mounted
Browser focus ancestor before hiding the editors. No font, composer, brief or
task-editor ownership changes.

## Scoped synthetic verification

`python3 scripts/check-scoped.py --unit mission_create --test mission_create --lint`
uses the normal shared slot, private outputs and CPU2/4GiB scheduler. Unit tests
cover exact payload/receipt, preflight identity/catalog refusal, UTF-16 and
ECMAScript whitespace bounds, lost/malformed/non-201 ACK and immutable pending
intent. The offscreen production Browser/form probe covers 680/1100 light/dark,
native project pointer/keyboard selection, Return/⌘Enter, preedit-before-close,
oversized paste rejection, pending navigation and late ACK, retained project/text,
Unknown reopen/no resend and mounted focus restoration.

No real mission/chat/agent mutations, installation, OS IME acceptance, Wayland
qualification, animation or application performance claims.
