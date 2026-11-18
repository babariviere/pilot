# Thread chats: a read-only chat per thread, interview, handoff, resolved

Each open mission thread has its own **thread chat**. It replaces sending thread messages to the planning agent
([mission threads](mission-threads.md) keeps the record and operation API).

## Why

- A thread message went to the planning agent. When it worked or was held, the message waited, and admission
  races left messages Unknown and the planner stuck in `discussing`.
- A suggestion in a thread became tasks with no questions asked, and the thread stayed open after it.
- The planner kept one pending revision per mission, so one thread's proposal replaced another's.

## How it works

1. **Discuss.** The first `thread-send` of an open thread starts its chat: an Ask chat (role `explorer`, the
   project's read-only main view) that joins the mission. Later messages go to the same chat with the operation ID
   as request ID. Unknown sends only look up the exact saved target and receipt; they never resend. The chat answers while the planning agent works or is held. The
   thread's history reads this chat (`scope: "thread-chat"`).
   As an Ask chat, it needs no worker slot and takes none. If Pilot refuses the start (for example, a paused
   mission), the host saves an exact refusal marker. Check can start it later only under the same project and
   owner authority. Missing chat metadata alone is not permission to retry. A start lost in a crash stays Unknown
   and is never started again.
2. **Read like the coordinator.** Its mission tool (`THREAD_ACTIONS`) has the coordinator's reads: `get` with
   members, needs-you and PRs, `status`, tasks, brief, decisions (coordinator audience too), comments, activity,
   links, artifacts, map, answers and replaced. It has no write action. `thread` reads its own thread, including
   the messages it had with the planning agent before thread chats (`earlier`).
3. **Interview and mockups.** Its prompt (`MissionContext.thread`) asks it to interview one question at a time
   with suggested answers, and to publish NSH mockups for screen work in its own `scratch/artifacts/`. Each question
   shows in the thread conversation with its suggested answers; the user answers with an ordinary thread message.
   Day settles a send by its saved input and the chat that took it (`result.chat.sessionId`).
4. **Handoff.** When the user agrees, it asks whether to send the work to the planner, and only after a yes calls
   `mission handoff` with a summary and tasks (title, outcome, acceptance, dependencies, chosen mockup). Pilot checks
   each mockup is one of the chat's artifacts, saves the handoff on the thread, and queues it once
   (`handoff.queuedAt`) with the existing waiting-message delivery.
5. **Revision.** The planner saves one proposal per thread (`topicId`). A new task can carry the chosen mockup
   (`newTasks[].prototype`). Each thread and Revisit keep their own latest pending proposal; the planning page
   shows one that still applies first, then the oldest, and `waiting` counts the others.
6. **Resolved.** Confirming the thread's proposal links the mockup to its task, adds a "Chosen mockup" line to the
   task body, and sets the thread `resolved` with the new tasks. Pilot archives the chat of a resolved or discarded
   thread once it is idle. Reopening the thread starts a new chat at the next message.

## Limits

`thread-send` optionally takes `interrupt: true`. It requires an existing live discussion and an unpaused mission.
The host saves its intent before stopping that chat, then checks the exact Stop generation before sending the
new input. A later Stop or mission Pause wins. Lost acknowledgement never repeats Stop or input. Older sends
without an exact saved delivery target or an immutable original-chat receipt stay Unknown. Ordinary sends remain
queued follow-ups, not Interrupt.
Focused context opened from an agent's Needs you request is different: it reads the asking agent and reuses
the original question and reply. It creates neither a thread chat nor another attention request.

A handoff lists at most 20 tasks, each with at most 20 acceptance lines and 20 dependencies. A thread is one topic,
and the planner reads the whole handoff in one turn; a refusal names the limit. Thread chats need native planning:
a mission without a planning worker refuses `thread-send`, because no planner would take the handoff.

## It never

- Edits files outside its `scratch/artifacts/`, changes the plan, creates tasks or answers for the user.
- Grants anything with a handoff: only the user's confirmation of the revision adds tasks.

## Moving older threads

At startup, `MissionThreads.migrate()` moves thread messages that still waited for the planning agent to their
thread chats. The thread view reads earlier conversation from original records through exact input and history
links, not by assigning whatever assistant messages followed a user message. The existing `earlier` context
capture for the thread chat stays unchanged, but the new conversation does not use its uncertain associations. Reopening a
thread keeps access to its previous chat histories through saved chat bindings and accepted operation receipts.

## Code

- `packages/daemon/src/mission-threads.ts`: sends, chat start and recovery, history, migration.
- `packages/daemon/src/mission-service.ts`, `mission-thread-handoff.ts`: thread chat reads and `handoff`.
- `packages/daemon/src/planning-workers.ts`: `queueHandoffs`, `closeThreadChats`, handoff content for the planner.
- `packages/daemon/src/mission-revisions.ts`, `missions.ts`: `topicId`, pending per thread, resolution, mockup links.
- `packages/kernel/src/mission-tools.ts`, `policy.ts`: the thread chat's tool and prompt.
- `apps/day`: `resolved`, the chat conversation, the handoff note and earlier messages on the thread page.
