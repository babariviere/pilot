# Project-pinned standalone New

This is the native-host seam for the New chat screen, not a navigation or UI
change. The existing mission interview path is separate. There is no
mission-as-chat fallback.

## Existing services and the gap

`ProjectStore` owns canonical project IDs and roots. `SessionManager.spawnDurable`
owns the session identity, durable first input, workspace preparation, Ask/Build
permissions, admission holds and later Stop. `OperationJournal` owns daemon
operation receipts. The native host owns its private fsynced command ledger and
awaited close. These services are reused, not duplicated.

The generic `chat-create` operation does not pin a project configuration, and
generic recovery can enter session creation again. The intake adapter has
lookup-only recovery but requires a tracked request. Neither is a safe standalone
New contract by itself. `NativeChat` adds only the missing project fence and
lookup-only operation handler.

## Passive reads and selection

All new HTTP routes require the existing native capability. They use no live
profile mutation, provider request, source sync or authentication recovery.

* `GET /api/native-projects` returns `{version:1,complete:true,projects}`. Each
  row has `projectId`, `projectPath`, `name` and `contextDigest`. It refuses more
  than 256 projects rather than silently truncating. Names are not IDs.
* `GET /api/projects/:id/chat-profile?mode=ask|build` uses the existing task-model
  policy to resolve `model` and `thinking`. It returns those fields with the
  project ID, root, configuration digest and explicit mode. Project changes
  during catalog I/O refuse the selection. No worker opens.
* `day.projects.read {}` exposes the complete inventory and saved creation
  operation summaries through the existing root channel. Its `current` field
  names the window's own project ID (Today's and new missions'), so New can
  default to it. It is not a selection.
* `day.chat.select {projectId,contextDigest,mode}` re-reads that selection and
  returns `ChatChoice`, adding a native UUID `draftId`. Selection creates no
  session. Ask means read-only; Build uses the project's existing workspace and
  permission defaults. This grants no extra database, host or integration access.

The native host keeps only the latest selected choice, and rejects an older
choice even when that project's configuration is still valid. The screen must
also discard superseded read replies. A stale or missing project,
denied capability or offline service never selects another project automatically.
The root's original Today project stays immutable. Choosing New's project does
not change existing chats, Today, mission Pause or another profile.

These commands do not use the shared read epoch as a fence: every dashboard or
session notice bumps it, including the one a creation causes, so it would refuse
quick follow-up choices as stale. The host re-reads the inventory and chat
profile right before saving, and the daemon rechecks the full configuration.
The host only requires an open root and an admitting window gate.

## Explicit creation and recovery

`day.chat.create {choice,message}` is the only new effect. It keeps the exact
message bytes, selected root, mode, model and draft identity. The native host
requalifies the profile, then saves the full `native-chat-create` operation before
sending it once through `/api/operations`. `draftId` is its reserved session ID.
The daemon rechecks the full project configuration and model selection, then
passes a guard into the existing session admission service. No cwd override,
mission membership, role or extra authority can be supplied.

The exact accepted receipt includes `sessionId`, `projectId` and `admissionId`.
The host validates all three. Receipt acceptance means durable session creation
and queued first input, not completed work or a provider result.

An entered request without a receipt is Unknown. A repeated exact draft returns
only its saved outcome; changing its project or words is stale. Pending creation
blocks another New selection/creation in this profile/home, even if Today is
reopened for another project. `day.chat.check
{operationId}` sends only the original operation to `/api/operations/receipt`.
It does not create, resend, change projects or repair missing authority. The
daemon also refuses handler re-entry during duplicate delivery or recovery.
Historical receipt lookup still works after the project is changed or deleted.
A missing outer receipt stays Unknown even if session metadata exists.
If the daemon ACK arrives but the local receipt save fails, the reply keeps that
exact ACK as evidence with `state:unknown` and `receiptSaved:false`. The poisoned
writer refuses clean close. After storage recovery, cold Check reads the same
operation, never creates again.

## Drafts and close

`SavedView.chat` is an optional `ChatChoice`; `SavedView.goal` keeps the unsent
text. Save both through the existing all-form flush/native capture barrier. Old
captures without `chat` still read. Restore is passive and never creates a chat.
Saved fields are not fresh permission or a current project read. Before creating,
the host rechecks the choice. The original command journal keeps uncertainty even
if the screen's saved selection is absent.

Close and update capture fence new effects and join entered work using the
existing root. This change does not add chat continuation, update qualification,
provider access, or a replacement history store.

## Checks and scope

`native-chat.test.ts` uses real isolated daemon HTTP, project/session metadata and
operation storage, with fake model selection and no worker/provider. It covers
two projects, explicit modes/text, stale/deleted choices, denial and missing
session-admission acknowledgement without re-entry.

`native/tests/new_chat.rs` uses the released NSH JSON channel, real native host,
fsynced local journal and isolated daemon. The shared intake fixture drops an
outer creation ACK, checks saved drafts and cold lookup, refuses retargeting,
and tests close, stale choices, denial and offline behavior.
It also checks capability denial before dispatch and a local receipt-save failure
after an exact daemon ACK, followed by cold lookup with no duplicate.
Existing intake, host, planning, control and saved-view suites remain the regression gates.

## Screen

New (`NewScreen.tsx`, `chatFeed.ts`, `chatCommands.ts`) consumes this seam.
Opening New reads the projects and selects the user's earlier choice, else
`current`. A pick whose project is gone stays unchosen. The screen drops answers
to older selections, and Start chat sends only the newest accepted choice with
the exact words. After an accepted creation it selects again, so the next chat
gets a new draft ID. A stale creation selects again and sends nothing. While
any creation is Unknown, New shows it with Check and refuses another. Plan a
mission stays pinned to the window's own project. Close and update save
`SavedView.chat`; restore turns it into a choice to select again.

`Chat.test.tsx` covers the screen rules on a scripted source (`chatDemo.ts`).
`native/tests/new_chat_today.rs` runs `Connected.tsx` on the isolated daemon:
default project, explicit other project and Ask, a lost creation ACK across a
cold reopen, one Check lookup, no second send, and the saved chat in the chosen
project. No native window, real provider, production profile or running app is
used by these tests.
