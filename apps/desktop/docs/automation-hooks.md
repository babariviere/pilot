# Hooks and hook results

Project hooks (docs/technical/automations.md) appear in two places in the Rust desktop app:
the chat timeline and the **Hooks** section of the [Automations page](scheduled-messages.md).

## Chat timeline

Hook activity uses the automatic-input row: one quiet, folded line with the
Automations glyph, and the full text behind the disclosure.

| Entry | Line |
| --- | --- |
| Setup result (`pilot.activity`, `automation_finished`/`automation_failed`) | `Workspace set up`, `Setup failed: Install dependencies (exit 1)` |
| Check result | `Checks passed: Lint, Tests`, `Checks failed: Tests` |
| Check follow-up (`pi.user`, origin `automation`) | `Checks failed: Tests · sent to agent (1/3)` |
| Todo follow-up | `Open todos · asked agent to continue (2/3)` |

Failed results swap the glyph for the error mark. Follow-up lines come from the
`<automation name kind attempt>` opening line only; anything else reads
`Automation message`. Classification uses the structured origin or event kind,
never message text. The latest setup failure also keeps its banner above the chat.

An exhausted attempt limit or a no-progress stop is pilotd's `automation`
attention reason. The chat shows **Needs you** with pilotd's one-line detail
(`2 open todos, agent made no progress`), and it blocks **Ready to merge**.

## Hooks section

```text
Hooks · 3                                                [New hook]
Pilot
    Install dependencies · Workspace setup        Passed   (●)  ⌄
  ▲ Lint and test · When packages/** or 1 more…   Failed · exit 1  (●)  ⌄
    Continue on open todos · When todos remain             ( )  ⌄
```

- One group per project that has hooks, sorted by name. Rows show the name, when
  the hook runs, the last result across that project's chats (from the session
  list's retained `automationRuns`, without output) and an on/off switch.
- The chevron or row opens the command, what happens on failure, where it last
  ran and **Edit**. Technical fields (ID, project, revision, exact JSON) stay
  under **Details**.
- **New hook** picks a project, then opens the editor: name, when it runs
  (workspace setup, after runs that change files, after runs with open todos),
  command or message, paths and whether failures go to the agent. Editing keeps
  fields the editor doesn't show (`cwd`, `env`, `timeoutMs`, an unchanged
  `argv`). Delete asks once more inside the dialog. Hooks the editor can't
  represent are listed read-only.
- The section hides when no project has hooks and the host switch is off or
  unknown. With the switch on it shows an empty line and **New hook**. With the
  switch off, saved hooks stay listed read-only with a note pointing to
  Settings → Chats. Invalid saved definitions show their error; saving a new
  hook replaces them.

## Reads and writes

Opening the page and Refresh read `GET /api/projects` and `GET /api/chat-settings`
with hello checks, a 16 MiB cap and generation fencing. A failed read keeps the
last report. The switch, Save and Delete each send one
`PUT /api/projects/:id/automations` with the shown revision, the whole list and the
native host-action capability. Only an exact echo at the next revision counts as
saved. A conflict shows Local's current list; a lost answer is never repeated and
triggers a passive re-read. One save runs at a time.

Checks: `automation_hooks` unit tests (model, edits, exact-ACK transport) and the
hidden native `automation_hooks` probe at 680/1100 pt in light and dark.

