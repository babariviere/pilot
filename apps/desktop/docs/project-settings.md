# Project settings: General and Workspace

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

Default model, environment, integrations, databases and Remove stay in the Swift app for now.

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
owner. `python3 scripts/check-scoped.py --test project_settings --lint` runs the real Settings
window at 680/1100 in light and dark against a synthetic project daemon: pointer and keyboard
navigation, IME composition blocking ⌘S, Unicode names, an acknowledged save, a lost reply,
a change elsewhere and a removed project. Set `PILOT_NEXT_PROJECT_SETTINGS_DIR` to keep captures.
These are synthetic offscreen checks, not live data or OS IME qualification.

