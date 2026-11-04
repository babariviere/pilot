# Composer slash commands

A leading `/` in a writable, settled composer opens a menu above the editor. It lists
native commands at once and the chat's prompt templates and skills once read. Typing
narrows it (name prefix, then substring; `skill:` names also match without the prefix).

| Command | Where | Opens |
| --- | --- | --- |
| `/jobs` (built-in) | existing chat | the running-jobs strip, expanded; refuses when no job runs |
| `/compact` (built-in) | healthy idle chat | explicitly requests manual context compaction |
| `/model` | composer with a model picker | the composer's model menu, with its own busy/pending rows |
| `/changes` | existing chat | the Changes panel, through its header toggle |
| `/artifacts` | existing chat | the artifact gallery; refuses when the chat has none |
| `/help` | existing or new chat | the keyboard shortcuts window |

Precedence matches the Swift app: built-ins are reserved, and a session prompt or skill
with an app command's name keeps it (the control stays in its header, menu or shortcut).
New chats have no session, so they offer only `/model` and `/help`.

## Keys and pointer

- ↑/↓ select (wrapping). Enter chooses: a native command opens its control; a prompt or
  skill is completed as `/name `, never sent. Tab completes any command.
- Escape closes the menu until the text changes. Shift-Enter keeps its newline. Clicking a
  row chooses it without moving focus or the caret.
- Native commands remove only their exact invocation (and one following space) after the
  control opened, as one undoable edit. Attachments and the rest of the draft stay. When
  nothing opens, the text stays and a quiet note says why; the next edit clears it.
- A whole draft that is a native command (`/help`, `/jobs`) is intercepted by Send,
  Enter and Option-Enter: it is never sent, queued or used to create a chat. Arguments
  are refused with a note. Unknown slash text, prompts and skills send exactly as typed.

## Guards

- No menu during marked IME composition, for read-only, pending/Unknown delivery, open
  questions, diagnostic or subagent composers, or drafts over the text limit.
- Choices apply only to the exact chat key, text and caret token the menu was built from.
- The command list comes from the existing `GET /api/sessions/:id/commands`, pinned by
  hello before and after the read, on a worker thread. It may reopen a parked chat's
  worker (never a model), so it is read only when a command token is typed. It applies
  only to the same chat, Local identity and connection generation; a failed read keeps
  native commands and retries the next time the menu opens.

## Not offered

- `/mode` (Ask/Build choice) and `/terminal` (deferred) are not implemented.
- `/model name` filtering: the Kit menu has no query setter; `/model` takes no arguments.

Checks: `slash_commands::tests`, `chat_editor::slash::tests` and the hidden
`slash_commands` native probe (680/1100 × light/dark).

## Manual compaction

`/compact` takes no arguments. Choosing it keeps attachments, remaining draft and
focus. Busy/read-only/failed/paused chats, queued input and pending or uncertain
delivery refuse the action. The existing chat-action owner checks current Local
hello and session eligibility before one `POST /api/sessions/:id/compact` with `{}`.
It never sends a chat message, retries a failed turn or triggers handoff.

Only `202 {"ok":true}` acknowledges admission, not completion of the summary.
400/404/409 are refusals; other statuses, lost replies and malformed ACKs stay
Unconfirmed and block repeating the action in this window. Reads are never proof
of acceptance. There is no automatic retry or saved request replay. The endpoint
has no client operation ID or incarnation/CAS precondition; hello/session reads
are preflight checks, not atomic admission fences. Existing daemon guards remain
authoritative, including races after preflight. Native tests use synthetic servers
only, never live compaction or provider calls.
