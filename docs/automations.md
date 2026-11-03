# Project hooks

Hooks run personal commands around Build work. They are stored in Pilot's project
settings, not committed to the repository.

1. Enable **Settings → Chats → Automations**. It is off by default.
2. Open **Automations → Hooks → New hook** and select the project.
3. Name it, choose when it runs, and enter its command or continuation message.
4. Save. Open an existing hook to edit, disable, or delete it.

## Hook types

- **Workspace setup:** runs commands in order when an isolated Build workspace is
  created or restored after pruning/reclamation. The first turn waits up to ten minutes;
  failed or unfinished setup is reported. Ask, coordinator, direct-checkout, and
  continuation chats do not run setup.
- **Post-run checks:** run matching commands after successful runs change files.
  A failure can send a redacted follow-up to an idle agent.
- **Continue on open todos:** asks the agent to continue unfinished chat todos.
  Repeats require progress; failed checks take priority.

Checks and todo continuation share a three-message automatic follow-up limit.
No progress or an exhausted limit raises **Needs you**. A user message resets it.

Hook results appear in the chat timeline and on the Automations page. **Stop**
cancels setup/checks and holds queued automatic inputs. Disabling automations
prevents new commands; already admitted commands may finish.

There are no teardown or archive-time hooks. Manual **Run setup again** remains planned.
For time-based work, use [schedules](schedules.md).
