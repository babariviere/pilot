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

Send follow-ups to clarify direction. While the agent is busy, messages can queue.
Open **Queued** to inspect them; supported text messages can be edited or removed.
Image-bearing messages are kept intact rather than flattened into editable text.

When an agent asks a question, choose a suggested answer or write your own.
Automatic inputs wait while it is open. Database approvals require the explicit
[approval control](databases.md), not a typed reply.

**Stop** ends the current run and holds automatic follow-ups. Send another message
or explicitly send held inputs to continue. Stop does not undo changes already made.
On macOS, **⌘.** stops the open chat's working agent.

## Read and review

Older history loads as you scroll. Work and tool activity can be expanded for details.
Build chats expose changes, artifacts, and related pull requests. A diff preview
does not itself apply a change.

Choose a model and thinking level before sending. Changing providers may require
rebuilt context or a linked continuation rather than reusing provider-specific history.
Read the confirmation before continuing paused work with another model.

See [workspaces](workspaces.md), [usage and context](usage.md), and
[failure recovery](troubleshooting.md).
