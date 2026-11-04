# Automations

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

## Run setup again

An idle isolated Build chat can rerun its enabled workspace setup commands without
recreating the workspace or starting an agent. Commands run in their saved order,
including create-only and restore-only hooks, once each. Existing files remain in
place, so commands should be safe to repeat. Progress and results use the same chat
status and timeline as automatic setup. **Stop** cancels the rerun.

The native action uses `POST /api/sessions/:id/setup`, with no body and the native
`x-pilot-github-capability` header. It returns `202` with the current session summary;
`automation` reports waiting/running commands with trigger `manual`, and
`workspaceSetup` retains the final result. It is unavailable while Automations is
off, and refuses archived, Ask, direct-checkout, coordinator, continuation, busy
or already-setting-up chats. Chats without enabled setup commands are also refused.
After an uncertain response, inspect the chat status rather than automatically retrying.
In the app, use **Run setup again** in the chat's … menu or on the setup failure
notice above the conversation.

There are no teardown or archive-time hooks.
For time-based work, use [schedules](schedules.md).

## Agent flows (design)

A flow runs one Build worker, then read-only Ask reviewers, one chat at a time.
The worker keeps its isolated workspace and chat across review rounds. Reviewers
inspect that workspace; their outcome either finishes the flow or returns feedback
to the worker. Every loop has a fixed round limit. Approval routes the flow only,
never grants permission to merge or publish.

Flows use personal project settings alongside hooks. Starts are manual and require
the native app's authority and the Automations switch. Questions pause the current
node until answered. Stop never silently restarts a flow. Progress and failures use
session automation state, with no new desktop controls in the engine MVP.

The [flow format and execution contract](technical/agent-flows.md) defines the JSON
format, worker → reviewer example, durable recovery and limits. Multiple writing
nodes, automatic starts and advanced graphs are later options, not part of this MVP.
