# Project settings: General, Workspace and Slack

The Settings window lists Local projects under **Projects**, after the app-wide pages. A project
page edits the subset of Swift's `ProjectSettings` that the existing daemon project contract
(`PATCH /api/projects/:id`, partial `ProjectRequest`) can express safely:

| Field | Next | Contract |
| --- | --- | --- |
| Name | Editable | `name`, trimmed, nonempty (Next caps it at 240 bytes, the catalog's display bound). |
| Folder | Read-only path | `path` could re-point the project; Next does not offer it. Add a new project to use another folder. |
| Default branch | Read-only explanation | Not a project setting; workspaces follow the origin remote's default branch. |
| Isolated workspace per chat | Checkbox | `workspace`: `"clone"` (default, also sent to turn it back on) or `"direct"`. |
| Require a pull request | Checkbox | `requirePullRequest`; only an explicit `false` permits direct default-branch pushes. Turning it off shows a warning before Save. |

Default model, environment, Linear, databases and Remove stay in the Swift app for now. Slack is
described below.

## Slack

The project page's Slack section mirrors the Slack half of Swift's `TrackingSettings.swift`:

| Setting | Next | Contract |
| --- | --- | --- |
| Channels | List with remove, plus a search field | `tracking.slackChannels` holds canonical channel IDs (older configs may hold names; kept as stored). Names go to `slackChannelNames`, display only. |
| Only messages that mention me | Checkbox per channel | `slackMentionOnlyChannels`, configured channels only. |
| My Slack groups | Text field, shown once a channel is mention-only or groups are set | `slackGroupHandles`, sent trimmed, without `@`, lowercased and deduplicated as pilotd stores them. `@here`, `@channel` and `@everyone` are refused. |
| Labels | Name, description, effect menu and remove | `slackLabels` (at most 50, unique names of at most 80 and descriptions of at most 240 UTF-16 units). Hide and Close spell out what they do under the label. |
| Account and channel health | Only when something needs attention | `GET /api/sources?projectId=`, pilotd's local projection (no poll or MCP call). |

The search field asks pilotd's read-only lookup (`GET /api/tracking/slack/channels?query=`)
350 ms after typing settles; the newest query wins and followed channels aren't offered. A
pasted channel ID can be added without a lookup. Nothing signs in, polls, posts or starts work.
Sign-in, the triage guide (Rebuild) and recent corrections stay in the Swift app for now.

**Reads.** The catalog carries only navigation metadata, so each page reads its project's
tracking with `GET /api/projects/:id` when opened, after every projects broadcast and on Revert.
Only the newest read settles, and a save invalidates reads started before it. A tracking value
with keys this editor doesn't know is shown read-only rather than rewritten.

**Saves.** pilotd replaces `tracking` whole (`validateTrackingConfig`), so a Slack change sends
the complete object: the Linear team, name and mappings exactly as read, plus the edited Slack
values. A General-only save never sends `tracking`. The pre-PATCH read refuses the save when
the project's tracking differs at all from the value the edits started from.

**Missing backend precondition.** That read is a check, not a lock. `ProjectRequest` has no
expected tracking value or `trackingGeneration`, and `ProjectStore.update` applies the submitted
tracking unconditionally, so a Linear or Slack change landing between the read and the PATCH
(for example from the Swift app) is overwritten. Closing that needs an opt-in atomic precondition
on `PATCH /api/projects/:id`, such as an expected `trackingGeneration`; it is not added here. The
same limitation applies to the General fields above.

A Linear-only change that arrives while Slack edits are unsaved becomes the new base silently,
since this page never edits Linear. A Slack change elsewhere shows "Slack settings changed
elsewhere" and Save is refused until Revert loads it. A reply without the written values, an
error or a lost reply is Unknown and never resent; a later read showing the values settles it.

## Default-model contract audit

The native General page has no default-model picker. The **Scoped models** page edits
the allowed catalogue, not a project's default; the chat/draft model pickers are also
different scopes. Historical Swift `ProjectSettings` has a free-text Default model
field (`ProjectEditor.request.model`), not a catalogue-backed project picker.

The existing read path for a future picker is `GET /api/models?cwd=<project.path>`:
`ModelCatalog.list` returns daemon-owned allowed choices with exact `id` values
(`provider/modelId`) and an optional `defaultModel`. Next already parses that response
with `chat_models::Catalog`. A future project editor must retain an unavailable stored
override visibly, not replace it with the catalogue default or first model. This audit
does not call that endpoint, inspect accounts or refresh providers.

`PATCH /api/projects/:id` forwards a partial `ProjectRequest` to `ProjectStore.update`.
A model-only body preserves unrelated fields, trims the model, and clears the override
on `model: ""`. The route uses the exact ID and the store requires that ID. There is
no model-catalogue call, session mutation or work-start in this path; its project-change
listener invalidates the mission catalogue and broadcasts projects. New-session
inheritance remains `request.model?.trim() || project?.model` in `SessionManager.spawn`.
No existing-chat or draft rewriting is needed or authorized.

**Blocked on unsafe overwrite:** `ProjectRequest` has no expected model or revision,
and `ProjectStore.update` applies the submitted model unconditionally. The ordinary
native helper's hello gate and baseline GET precede its PATCH; they are not an atomic
precondition. If another user saves a model after that GET, the captured Save silently
overwrites the unseen selection and returns 200. Immutable client requests and
generation fences cannot close this server-side gap. No new picker, backend expansion,
alternate write path or live settings mutation was added.

The isolated HTTP regression
[`server-project-model.test.ts`](../../../packages/daemon/src/server-project-model.test.ts)
reproduces the ordered GET → concurrent PATCH → stale PATCH race against a temporary
daemon. It asserts the stale model replaces the newer one on disk while unrelated
fields survive, exact model strings round-trip, an empty override clears, and neither
host commands, catalogue reads nor new chats occur. This test documents the current
unsafe contract, not acceptance of that behavior. An approved atomic captured-model
precondition would be needed before implementing this requested safe editor. Existing
General/Workspace settings have the same preflight limitation; they were not redesigned.

Audit checks: `node --test --test-timeout=120000 packages/daemon/src/server-project-model.test.ts
packages/daemon/src/projects.test.ts`, scoped `biome check` on the new test, and
`tsgo -p tsconfig.json`. No runtime implementation changed.

Because no UI or Rust changed, native 680/1100 light/dark, keyboard/IME, unavailable
catalogue, project-switch and Save/Unknown journeys and a Cargo build are not feature
verification for this blocker-only delivery. They were not run; no native acceptance
is claimed.

## Saving

- Edits stay local until **Save changes** (or ⌘S). Save and Revert appear only once something
  changed, a save is running or the last save needs attention.
- Save sends only the fields that differ from the form's baseline, so tracking, environment and
  other settings are never rewritten. Before the PATCH, a read checks the hello identity and that
  the project still holds the baseline for those fields. A removed project or a field changed
  elsewhere is refused with nothing sent.
- After the PATCH is sent, any error, lost reply or reply without the written values is
  **Unknown**: the edits stay, nothing is resent, and the daemon's next project broadcast settles
  it when it shows those values. The daemon may change the project before failing to persist, so
  no status proves the save didn't happen.
- Projects have no revision. A broadcast that differs from the baseline while the form has edits
  keeps the edits and says the project changed elsewhere; Revert loads the new values.
- Pages are keyed by exact project ID and outlive the Settings window, so drafts survive closing
  Settings and switching projects. A removed project's page stays on that ID, read-only, with its
  draft until Revert; it never shows another project. Closing Settings or installing an update
  waits while a project page is unsaved or saving.

## Entry points

The Settings window's Projects section, by pointer or keyboard. `LocalViewer::open_project_settings`
opens Settings on one project ID for a project menu.

## Checks

`python3 scripts/check-scoped.py --unit project_settings --lint` covers the form, transport and
owner; `--unit project_slack` covers the Slack model.
`python3 scripts/check-scoped.py --test project_settings --lint` runs the real Settings
window at 680/1100 in light and dark against a synthetic project daemon: pointer and keyboard
navigation, IME composition blocking ⌘S, Unicode names, an acknowledged save, a lost reply,
a change elsewhere and a removed project, then the Slack section: load with channel health, a
debounced lookup, mention and group filters, a Close label, IME in a label, an acknowledged
save that keeps Linear, a lost reply, a Slack change elsewhere, a failed read with retry and
drafts kept across projects. Set `PILOT_NEXT_PROJECT_SETTINGS_DIR` to keep captures.
These are synthetic offscreen checks, not live data or OS IME qualification.
