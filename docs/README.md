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
The planner gives each task a [work profile](connections.md#work-profiles) and a size. Pilot starts the
least busy model for them, and sends a turn blocked as cyber work again in projects that allow Cyber.
If a mission creation reply is lost, Check status reads that request's saved receipt.
A similar goal offers Create another as a separate request, never a replay; the first stays checkable.
Other goals and drafts remain available. Re-planning an old mission offers context to carry over
and asks before replacing New's existing words and project choice.
While Pilot plans, the planning page shows the agent's current step and time, and
Show planning chat opens its conversation, read only.
When a planner needs interview answers, Today shows a card in Needs you.
**Answer interview** opens that mission's current questions without submitting or starting work.
Back returns to the same Today scope. Saved drafts stay in the interview until you submit.
Choose Search or press Command+K to find missions, chats, results, saved outputs,
Knowledge and app destinations. Work is labeled by project. The search filter does not
change Today's filter. Open an item in the same window, then use Back to return to your
draft. Search never sends an answer, accepts a result or starts work.
Choose **Open in new window** to inspect a saved result, output or Knowledge
revision without editing it there. Open an agent's chat to inspect its current
private working copy. The live comparison is separate from saved evidence.
Today To check discovers new mission deliveries from a saved first-use cutoff.
On Today, each result to check is a card in Needs you, after the questions and actions. **Check the result**
(⌘↩) opens it; **Later** (L) puts it after the other results in this window only. A mission's overview lists
its own results to check.
New Slack requests wait in Needs you after the results, one card each: the message's words, its client and
reporter when Pilot found them, and where work starts. **Start work** (⌘↩) asks once before it starts one Build
chat; **Change** picks a mission instead or plans a new one. **Later** (L) and **Discard** set the request aside;
the folded lists below Needs you bring it back. **Open in Slack** shows the message in your browser. Today's
headline counts these cards and the results with the questions. Linear is one quiet row after Missions, with
how many issues are yours and how many are new; **Open** shows the Linear page, where Linear issues start.
On a Decide card, the Mission and Chat links below the question open its source.
Standalone questions show only Chat. Back returns to the pending question and keeps your draft.
Opening either link sends no answer and starts no work.
Older work stays in missions, without being accepted or deleted. Your saved
checks stay available. Open a result directly from any project you can access.
When a result has code, its page shows one **Code changes** row: files, lines added and
removed, your comments, the pull request and the saved commits. **Review code** (⌘R, also in
Command+K) opens the code on its own page; Back, ⌘[ or Escape returns to the result. Until you
open it, Review code is the page's main button, then Mark done is. The page lists the files on
the left (J and K go to the next and previous file) and shows the selected file's saved diff,
never your working copy. Select lines to write a comment under them. Comments stay with the
result and are never posted to GitHub. **Send back with N comments** sends every saved comment
of this result, with its code, to the agent once, after any unsent Send back words.
**Keep for later** keeps the result behind other pending results. The ⋯ menu has Add to review
queue, which explicitly selects older work without accepting it, and Refresh private review.
A comparison must be linked evidence or match the owner's explicitly reported committed revision;
otherwise the page says no matching comparison is available. After a new result, old comments
show as an earlier version where their exact code still shows.
**Add a note** under Your check saves a general comment on the result. It counts with your
comments and goes with Send back. **My notes…** keeps notes only for you; Send back never includes them.
Saving a comment or a note, or reading code, never accepts a result. Independent work continues.
Unconfirmed private saves offer Check saved comment, which reads only the original receipt.
A result's Agent work section (folded until Show, or opened from a task linked in a thread) lists
the changes its agent owns, the chat's saved pushes and pull requests, and what Pilot saw on GitHub.
A push with no saved result stays Unknown. It is Pilot's record, not the agent's report or your check.
In a planned mission, a worker's delivery report reaches To check, also for work with no code such as a choice
between mockups: you check it, and what the worker
asks its coordinator shows on that page. Answer with Send back or a thread.
A delivery report that says the work is not moving is partial: it stays out of To check, and the mission page
shows what it waits for.
After your first Start work, marking a task's result done finishes the task, and Pilot starts the next
tasks that are ready, within the worker limit, Pause and Stop. A merged pull request of a task finishes it too,
when it is in the project's own repository and the task's latest report does not say it is not moving.
Coding work has two slots per isolated-copy project and four across Pilot. A project using your folder has
one writer. Waiting shows dependency, capacity and uncertain-start reasons. An uncertain start keeps its slot;
Pilot checks the original attempt instead of starting it again. Only tasks with overlapping declared files take
turns; others run side by side. A chat that already ran never waits in this queue again. Check combined changes
before marking the result done.
Pause blocks new starts while agents save and stop. Pausing stays visible until confirmed.
An agent's question offers Open discussion: recent context from that same agent, with the same reply and draft.
Opening it creates no agent or second request. Ordinary thread comments queue; Interrupt… asks first, then
stops the existing discussion's response and sends your message. It does not pause the mission's coding agents.
To add work to a published plan, discuss it in a thread or use Revisit: the planner proposes new tasks, and they
join the plan only when you confirm that revision. Adding tasks alone needs no Pause; they start like the others.
Each screen task gets a prototype you choose during planning, and its worker builds what you chose. A screen task
without one starts with a mockup in its chat, and the worker builds only after you agree.
When a change you can see lands, its chat captures the real app before and after the change. The result page shows
each screen under Screens, with Before and After tabs, or the chat's reason for having no captures.
The Artifacts page and the mission overview show each such screen as one Before/After card.
On a mission page, a done task folds its report until Show report, and each task links its own chat.
A Slack request (Change, then Plan a mission…) or a Linear issue (Prefill mission draft on the Linear page)
can also become a mission: it opens New with its title and link. Your Plan takes it off Today and links it to
the mission, without changing Linear or Slack. When the mission's first task starts, Pilot marks the request
started there.
A chat started from Slack, Linear or a schedule saves a report for its result page: its answer, how
it knows, its limits, your next step and links. A chat with no report shows its last message instead.
For published native plans, Revisit mission requests planning only. Review new questions and
the exact proposed changes. Pause affected work and apply checkpoints only affected agents before
applying those exact changes; unaffected work continues. A whole-mission
Pause needs a fresh preview. Earlier
answers and finished work stay kept. Release affected work is separate and keeps other holds.
Revisit never starts work or changes permissions.
Preparing a revision leaves work running. Applying changes needs a safe checkpoint only for
affected work (global agreement changes can affect everyone). Old missions can finish migration
to their published successor after a safe Pause. History, chats and unpublished work stay;
Linear management does not transfer automatically. The successor keeps Read previous mission,
a read-only view of the old agreement, decisions, tasks, saved links and recent activity.
Today also shows Working now below Needs you: active mission and standalone chats across the projects you can
access. Each row names its project and current task, or says the purpose is unavailable. Chat bubbles open the
exact chat without sending anything; Back keeps your Today draft and place. Show all reveals rows beyond four.
Waiting, held and finished chats stay out of this list. Chats waiting for a coding slot show under it in Waiting,
with their place in line and the chats using the slots; the chat page, feedback and task results say the same.
Earlier or unavailable reads never claim live work.
A mission's overview leads with its work: Now shows current work (working, in review, held or waiting
for you), Next lists the plan's queue in order, and Blockers shows tasks that wait for earlier work,
a Pause and decisions for you. Queued in plan is not a start: Pilot still checks permission, limits and holds.
Goal and spec, Tasks, Discussions, Results and evidence, and the map, interview and plan open in place below.
A mission's overview lists its threads, one subject each. Start one by writing its first message; its
first sentence becomes the title. Each thread has its own read-only chat: it answers at once, reads the
mission like the coordinator, asks one question at a time about work you suggest, and shows mockups for
screen work. When you agree and say yes, it sends the work to the planner, which proposes a revision for
that thread. Confirming it resolves the thread. Later and Discard keep the history. Talking never starts work.
The thread opens its whole topic conversation in time order. Show earlier messages adds older pages;
new replies do not remove messages already shown. Each message keeps access to its original history.
Messages awaiting a reply say so. Older replies without a clear topic link are not silently included;
the page explains gaps. Show activity opens underlying history below the conversation, including other
coordinator work and tool calls. Reading either view sends nothing and keeps your reply draft.
Feedback (in the header, or Send feedback on a mission) saves your words about Pilot, with the
mission when you keep it. Choose the project with Pilot's code and a read-only agent triages what you
send once, including after checking an uncertain save: Pilot keeps the exact original investigation
intent and never restarts an entered attempt. It reads only that project's context, groups duplicates, may ask you a question and
proposes a small fix, a mission or no change. Read access explains the project's source scope,
including named folders and subfolders. Literal absolute or ~/ paths in your feedback are shown
before Send and can be read if available. Quote paths with spaces. Known credential stores are
excluded; extra text files are sanitized and limited to 256000 bytes, without silent truncation.
Other projects' context and unrelated files are not included.
Questions use the same form as interviews, with suggestions and your own words. Check answers,
then Submit answers sends once; choosing or typing only keeps a draft. Start fix uses the scope,
project, model and allowance shown on the suggestion. It starts one standalone chat, even if the
suggestion recommends a mission. Draft a linked mission opens an editable goal without starting work.
It keeps your other New draft unless you choose to replace it.
If a fix stalls, you can edit a handoff note and start a linked chat. Pilot pauses the old writer first
and keeps its history, checks and remaining fix allowance. Feedback stays open until you mark it
resolved in Feedback or on the linked result.
When the look or behavior is unclear, the triage proposes a prototype. Start prototype makes 2-3 mockups,
writes no code and asks you to choose on the feedback item; your choice, with its mockup, becomes the fix.
Remove deletes one item and its steps after you confirm. Its chats and missions stay.
Today's Needs you shows one question at a time. Other feedback waits under Up next; selecting it
keeps the current question unanswered. Later keeps feedback aside across reopening this window;
Bring back restores it with its draft. A new question or finished investigation returns.
Routine investigation progress stays in Feedback. Reading or deferring starts no work and approves nothing.
An unusable suggestion keeps the agent's explanation and offers Correct the investigation.
Corrections go only to that investigation. Uncertain answers and corrections keep their words;
Check again only looks up the exact send and never repeats it.
Paste a screenshot into the feedback field with Cmd+V/Ctrl+V, or use the + icon
(Add image…). Uploaded thumbnails stay above the field until you remove or send them
(up to four PNGs, 8 MiB each). Text paste works as usual.
Pilot keeps the images with your feedback so its triage agent can read them after a restart.
An upload failure keeps the image for Retry upload. Sending feedback still happens only with Send.
Saved feedback lists open items before resolved history. Search filters the loaded history;
Show earlier reads older items. A missing save reply holds only that item and its images.
Check reads its receipt without sending again. Write another leaves it there while you send
unrelated feedback. Put-aside drafts survive reopening; Resume draft swaps rather than
overwrites your current words. Checking an earlier item never clears a different draft.

The screen agent (Day): press Cmd+J, or choose Ask about this window in Cmd+K, to ask an agent about the
window you are looking at. It reads the window's controls, takes a picture of it and can use its controls, but
it never sends, starts, approves or saves anything in Pilot: it tells you which control to press. Point lets you
click the control you mean first. Make feedback drafts feedback from the conversation; Send feedback is yours,
and the conversation becomes that feedback's triage. Esc hides the bar; the conversation stays with the window.
Open the triage chat or Open the fix chat shows that chat read only: your messages, Pilot's replies,
one line per tool step and whether it works, finished or failed. A chat started from New, and a
mission's coordinator, task and working chats on its overview, open the same way. Chat actions sit at the top
right of their headers, separate from actions that start work. Reading a chat sends
nothing.
A stopped chat, or a failed one that is safe to retry, shows **Continue**, on its page, on Today's
**Needs a look** and on a task result that has nothing yet. It asks the agent once to pick up where it
stopped, or to ask a lost question again. A Continue that Pilot could not confirm shows Check and is never
sent again. **Dismiss** takes a failed chat off Needs a look and sends nothing to it.

| Feature                                         | Guide                                         |
| ----------------------------------------------- | --------------------------------------------- |
| Projects, Home, and Inbox                       | [Find and organize work](projects.md)         |
| Ask, Build, questions, and queued messages      | [Chats](chats.md)                             |
| Isolated edits, pull requests, and cleanup      | [Workspaces and pull requests](workspaces.md) |
| Briefs, tasks, phases, and coordinators         | [Missions](missions.md)                       |
| One-time and recurring messages                 | [Schedules](schedules.md)                     |
| Setup commands, checks, and todo continuation   | [Project hooks](automations.md)               |
| Generated visuals and attachments               | [Artifacts](artifacts.md)                     |
| Connections, authentication, models, profiles   | [Models and MCP](connections.md)              |
| Slack triage                                    | [Slack](slack.md)                             |
| Linear tickets                                  | [Linear](linear.md)                           |
| Subscription limits, token history, and context | [Usage](usage.md)                             |
| Project notes and research                      | [Memory and knowledge](knowledge.md)          |
| Sleep, offline work, and closed-lid mode        | [Energy and connectivity](energy.md)          |
| Failures, diagnostics, and updates              | [Troubleshooting](troubleshooting.md)         |

[Insights](insights.md) covers chosen-source reports and findings in Day, and the separate legacy weekly setup.

Pilot runs work locally. Remote devbox execution is retired; saved history and
drafts are not migrated or submitted elsewhere.

Agents cannot run filesystem-root searches such as `find /` or `fd . /`.
They must choose a project or a specific directory. Pilot also blocks unsafe
`rm` targets, including home folders, root, top-level system folders and
repository metadata. Scoped build cleanup and ordinary file edits still work.
These command checks catch mistakes; they are not a filesystem security boundary.

Implementation contracts, proposals, benchmarks, and historical material belong in
[technical documentation](technical/README.md), not these guides.
