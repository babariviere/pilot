# Chats

## Choose Ask or Build

|                   | Ask                                        | Build                             |
| ----------------- | ------------------------------------------ | --------------------------------- |
| Use it for        | Exploring, discussing, planning            | Implementing, testing, delivering |
| Repository writes | No                                         | Yes                               |
| Source            | Current checkout or pinned branch snapshot | Configured workspace              |

An Ask chat does not become writable because you request an edit. Start a separate
Build chat when ready to implement. Code exploration reports source relationships,
not proof of runtime behavior or complete impact coverage.

## Steer the work

In Day, open a chat from Today, its mission or Search. The chat page shows any available recovery actions.

### Legacy composer controls

The controls below describe Pilot Next.

Send follow-ups to clarify direction. While the agent is busy, messages can queue.
Open **Queued** to inspect them; supported text messages can be edited or removed.
Image-bearing messages are kept intact rather than flattened into editable text.

When an agent asks a question, choose a suggested answer or write your own.
Automatic inputs wait while it is open.

**Stop** ends the current run, stops working subagents and holds automatic follow-ups. Background
jobs keep running, but their results wait with the other held inputs, so the chat shows as stopped,
not working. Stop also withdraws an open question. Send another message
or explicitly send held inputs to continue. Stop does not undo changes already made.
On macOS, **⌘.** stops the open chat's working agent.

### Recovery in Day

Day's **Continue** action sends one fixed follow-up to a stopped chat (native operation
`chat-continue`, payload `{purpose, sessionId}`; the daemon writes the words and refuses a chat that
is not stopped). A lost reply is checked by exact input lookup, never sent again.

Day also offers **Retry** and **Correct follow-up…** for failed or stopped chats. Both keep
the same chat, source copy, access and remaining allowance. A startup failure offers Retry
only, keeping its original queued inputs. Correction drafts survive window saves and reopen
without sending. An uncertain attempt stays **Check** only; no previous tool effect is replayed.
Older service versions may refuse these recovery controls.

## Read and review

Older history loads as you scroll. Work and tool activity can be expanded for details.
In Day, **Find** (⌘F) searches literal, case-sensitive message
source. Choose **Load full history** to include older pages. The coverage label
shows when only loaded messages were searched, or loading stopped or failed.
Enter and Shift-Enter move through matches. Escape closes Find.
Build chats expose changes, artifacts, and related pull requests. A diff preview
does not itself apply a change.

Choose a model and thinking level before sending. Changing providers may require
rebuilt context or a linked continuation rather than reusing provider-specific history.
Read the confirmation before continuing paused work with another model.

See [workspaces](workspaces.md), [usage and context](usage.md), and
[failure recovery](troubleshooting.md).
