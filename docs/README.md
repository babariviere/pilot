# Using Pilot

Short guides for the desktop app. Start with [installation and setup](getting-started.md).

The upcoming interface can be prepared locally as a [connected candidate](technical/day-connected-candidate.md).
Connected Day keeps earlier reads marked as older while it refreshes. An
unavailable attention read never means that nothing needs you. Read again only
reads; it does not resend an answer or start work.
Day opens the global dashboard without a project or model selection. Today's
header defaults to All projects and saves its filter per window. A project filter
still counts attention elsewhere and never retargets work or New's draft. New
requires an explicit project choice; saved choices stay with their drafts.
In a profile-only window, New reads that project's configured model and trusted
planning setup. Choosing starts nothing. Plan a mission starts planning only;
building still needs the separate Start work confirmation.
While Pilot plans, the planning page shows the agent's current step and time, and
Show planning chat opens its conversation, read only.
Command+K opens a palette over any screen. Search to go to a place or to a mission
that Today or Planning lists. It only navigates: answers, sends and starts stay on their pages.
Today To check discovers new mission deliveries from a saved first-use cutoff.
Older work stays in missions, without being accepted or deleted. Your saved
checks stay available. Other projects' results are read-only in this window.
A result's Agent work section (folded until Show, or opened from a task linked in a thread) lists
the changes its agent owns, the chat's saved pushes and pull requests, and what Pilot saw on GitHub.
A push with no saved result stays Unknown. It is Pilot's record, not the agent's report or your check.
For published native plans, Revisit mission requests planning only. Review new questions and
the exact proposed changes, then pause and request a fresh preview before confirming. Earlier
answers and finished work stay kept. Revisit never starts work or changes permissions.
A mission's overview lists threads with its coordinator, one subject each. A thread shows the
coordinator's whole conversation and marks the messages it sent or linked. Send reaches only an
active, unheld planning coordinator; Later and Discard keep the history. Talking never starts work.
Feedback (in the header, or Send feedback on a mission) saves your words about Pilot, with the
mission when you keep it. Choose the project with Pilot's code and a read-only agent triages what you
send: it groups duplicates, may ask you a question and proposes a small fix, a mission or no change.
You answer its question on the same page; the answer only clarifies. Start fix, linking a mission and
Plan a new mission are your own steps; only you mark feedback resolved.
Today's New section also shows finished triages and triage questions. Open a row to read the
proposal or answer the question. Later keeps it out of New across reopening this window;
Bring back restores it. A new question or finished triage returns to New. Reading or deferring
feedback starts no work and approves nothing.
Paste a screenshot into the feedback field with Cmd+V/Ctrl+V, or use the + icon
(Add image…). Uploaded thumbnails stay above the field until you remove or send them
(up to four PNGs, 8 MiB each). Text paste works as usual.
Pilot keeps the images with your feedback so its triage agent can read them after a restart.
An upload failure keeps the image for Retry upload. Sending feedback still happens only with Send.
Open the triage chat or Open the fix chat shows that chat read only: your messages, Pilot's replies,
one line per tool step and whether it works, finished or failed. A chat started from New, and a
mission's coordinator, task and working chats on its overview, open the same way. Reading a chat sends
nothing.

| Feature                                         | Guide                                         |
| ----------------------------------------------- | --------------------------------------------- |
| Projects, Home, and Inbox                       | [Find and organize work](projects.md)         |
| Ask, Build, questions, and queued messages      | [Chats](chats.md)                             |
| Isolated edits, pull requests, and cleanup      | [Workspaces and pull requests](workspaces.md) |
| Briefs, tasks, phases, and coordinators         | [Missions](missions.md)                       |
| One-time and recurring messages                 | [Schedules](schedules.md)                     |
| Setup commands, checks, and todo continuation   | [Project hooks](automations.md)               |
| Generated visuals and attachments               | [Artifacts](artifacts.md)                     |
| Connections, authentication, and models         | [Models and MCP](connections.md)              |
| Slack triage                                    | [Slack](slack.md)                             |
| Linear tickets                                  | [Linear](linear.md)                           |
| Postgres access and approvals                   | [Databases](databases.md)                     |
| Subscription limits, token history, and context | [Usage](usage.md)                             |
| Project notes and research                      | [Memory and knowledge](knowledge.md)          |
| Sleep, offline work, and closed-lid mode        | [Energy and connectivity](energy.md)          |
| Failures, diagnostics, and updates              | [Troubleshooting](troubleshooting.md)         |

[Insights](insights.md) covers one-confirmation weekly enable from Automations, review settings with Save and Apply, Tasks-tab decisions and access settings.

Pilot runs work locally. Remote devbox execution is retired; saved history and
drafts are not migrated or submitted elsewhere.

Agents cannot run filesystem-root searches such as `find /` or `fd . /`.
They must choose a project or a specific directory. Pilot also blocks unsafe
`rm` targets, including home folders, root, top-level system folders and
repository metadata. Scoped build cleanup and ordinary file edits still work.
These command checks catch mistakes; they are not a filesystem security boundary.

Implementation contracts, proposals, benchmarks, and historical material belong in
[technical documentation](technical/README.md), not these guides.
