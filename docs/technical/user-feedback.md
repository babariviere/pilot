# User feedback

Day has a direct path for the user's own feedback about Pilot. It saves the words, shows
them again and lets the user take explicit steps on them. It is not agent Insights,
findings or a retrospective, and it is not an inbox. Saving feedback creates no mission,
spends nothing and approves nothing. There is no dedicated improvement mission and no
mission is needed for triage.

## Storage and API

- One append-only `user_feedback` table in the mission database (`MissionStore`), with
  its transaction and disk durability. No second store and no external service.
- Native generic operation kind `user-feedback`, `targetId` = the new feedback ID the
  native host names. The payload is `{purpose, text, origin, attachments?}`: the text (at most
  8 KiB UTF-8, not blank) and `null` or one exact `{kind:"mission", missionId}` /
  `{kind:"chat", sessionId}`. The service reads the origin's project and title when it
  saves; a missing mission or chat refuses the feedback. Native capability authentication
  is required. The accepted receipt's `result` is the saved `UserFeedback`, after the
  durable write. Journal recovery is lookup only: a lost ACK stays Unknown, never resent.
- `GET /api/feedback?before=<sequence>&limit=20` (native authenticated) lists saved
  feedback newest first with an exact cursor. Each item has `work`: its saved steps,
  oldest first, with what Pilot reads about them now (below).

### Images

Day selects PNG files with the native picker or reads a clipboard image only after
Paste image. It accepts up to four PNGs of 8 MiB each. The default development
configuration stays deny-all. Connected bundles declare and receive picker and
clipboard capabilities, but no filesystem, network or process access. Artifact
preview engines keep their separate deny-all policy.

`day.feedback.image` first reserves a random upload ID, then sends the PNG with
that ID to the existing native-authenticated attachment upload route. Retrying an
upload reuses that ID and its exact bytes, including after a lost upload reply.
Only this image method has a larger bridge request limit; other requests stay
limited to 64 KiB. Uploaded references, not image bytes, go in the window draft
and the feedback operation. An unfinished upload blocks close/update capture until
the user retries or removes it.

The daemon adopts the image references under the feedback operation before saving
the feedback. The existing attachment store checks content hash, size, PNG header,
dimensions, origin and ownership, fsyncs the data and metadata, and never expires
referenced images. Feedback rows and receipts keep the immutable references.
Lost feedback ACKs remain lookup-only. Only a receipt matching the images as well
as the text can clear a draft.

Triage and fix admission look up only the images owned by that saved feedback.
Their opening message names those paths. An Ask chat's saved context grants its
read tool only those exact image paths, not their directory or arbitrary paths
from feedback text. Other Ask chats receive no such grant. The normal source-only
and no-symlink reader still applies. No image bytes enter duplicate summaries.

## Steps

A step is one explicit act of the user's on one saved item, saved append-only in
`user_feedback_work` (at most 32 per item). Native operation kind `feedback-work`;
types live in `packages/protocol/src/user-feedback.ts` (`UserFeedbackWorkIntent`).
None follows from another by itself.

| Action | Target | What it does |
| --- | --- | --- |
| `triage` | new chat ID | One read-only Ask chat in the chosen project. |
| `fix` | new chat ID | One Build chat for a finished triage's exact `fix` proposal. |
| `link` | mission ID | Links an active mission and adds a user note to its activity. |
| `resolve` / `reopen` | feedback ID | The user's own mark. Nothing else resolves feedback. |
| `answer` | latest triage chat ID | The user's reply to the triage's pending question. |

- Triage and fix payloads freeze the exact project selection that
  `GET /api/projects/:id/chat-profile` returned (`projectId`, `projectPath`,
  `contextDigest`, `model`, `thinking`). The daemon requalifies it through
  `NativeChat` and creates the chat with `spawnDurable`, so project, model policy, price
  caps, Stop, pause and update gates are the existing ones. The daemon writes the
  opening message; the window cannot supply one, a mode or a cwd.
- The step row is saved before the chat is created, so a crash never leaves an unlinked
  chat. If creation then fails, the row shows the chat as `missing`.
- One triage and one fix at a time per item. A fix needs the triage's current proposal
  digest and `next:"fix"`; a changed or later answer refuses it as stale.
- A link refuses a missing or inactive mission and a repeat of the latest link. The
  mission note says the feedback is context, not a request to start work.
- Recovery is lookup only, like Send: a lost ACK stays Unknown and is never resent.

## Answers

A triage that calls `ask_user` reads as `question`, and its step carries the pending
question exactly as the chat saved it: `{id, question, context?, options, multiSelect?}`,
where `id` is the question's history entry. A database access request is not shown.

- An `answer` payload is exactly `{questionId, message}` (at most 8,000 UTF-16 units).
  The daemon checks that the target is the item's latest triage, that it still waits on
  that same question and is not paused, then sends the words with `sendDurable` as the
  reply to that question entry (`followUp`, `questionReplyId`, `inputGeneration`),
  the same input admission as any reply to an agent question. A newer question refuses an
  older answer.
- After the chat accepted the words, the daemon saves `{kind:"answer", sessionId,
  questionId, text}` on the feedback. A failed save leaves the step Unknown, not refused.
- A lost ACK stays Unknown. Startup recovery and the receipt lookup read only whether the
  chat accepted that exact operation ID (`lookupNativeAttentionInput`); if it did, the
  step is saved and accepted. Nothing is sent again.
- An answer clarifies the feedback. It starts no fix, links no mission, approves no
  proposal and resolves nothing. A fix chat's question is not answered here.

## Triage

The triage chat gets the feedback, up to 30 other recent feedback items and the
project's active missions as labeled data, not instructions. It reads the code, lists
duplicates, uses `ask_user` when something is unclear and ends with one JSON object:
`{summary, duplicates, next, detail, missionId, goal}`, where `next` is `fix`,
`existing-mission`, `new-mission` or `none`. The proposal stays in that chat's
history. A read parses the last assistant text of the finished turn (at most 8 KiB, one
optional Markdown fence) and returns `{value, digest}` or `{problem}`. Duplicates keep
only saved feedback IDs. Parsing is cached per chat and finished turn; reads save nothing.

Each triage or fix step reads its chat as `starting`, `working`, `question`, `done`,
`failed`, `stopped`, `archived` or `missing`. A mission link reads the mission's
title, status and task counts, or `null` when it is gone.

## Day

The header's Feedback opens the page about Pilot in general. A mission overview's Send
feedback opens it about that mission. Words with an origin keep it: opening the page from
somewhere else offers the new origin and never switches by itself. Make it general drops
the origin. No transcript, file or project is attached silently.

- `day.feedback.read {before?}` reads one page. A failed read is never an empty list.
- `day.feedback.send {text, origin}` journals the envelope before its one POST. While an
  earlier Send is Unknown, the root refuses another.
- `day.feedback.step {feedbackId, action, …}` names only its action's fields. For triage
  and fix the host re-reads the project's chat setup right before saving the envelope;
  a changed project is Stale. While an earlier step is Unknown, the root refuses another.
- `day.feedback.check {operationId}` only looks up that saved Send's or step's receipt.

"Agent triage in" names the project agents work in. Nothing is chosen for the user, and
the window keeps the user's choice across a close or update (`feedbackProject` in the
saved view). While one is chosen, a saved Send also starts its triage there. Each saved
item then shows its triage, the proposal with its
one suggested command (Start fix, Link to this mission or Plan a new mission), a mission
picker from Today's missions, the fix and link states, and Mark resolved / Reopen.
Plan a new mission only fills New's empty goal and opens New; the existing planning flow
creates the mission, and the user links it afterwards. A delivered fix leaves the
feedback open until the user marks it resolved.

A triage waiting on the user shows its question in place: the words, the context, the
suggestions (one may be marked Suggested) and a field for the user's own words or detail.
Picking and typing only keep a draft; Send answer sends it once. Picked suggestions come
first, then the user's words, as Today's answers to agent questions read. The unsent
answer stays with its own triage chat and question across a close or update
(`feedbackAnswers`: `<chat>/<question>\n<picks from 1>\n<text>`). Only an accepted
answer clears it. After it, the triage line shows "You answered: …".

Only an accepted receipt clears the draft. Leaving the page, closing or updating keeps
the draft and its origin in the saved view (`feedbackOpen`, `feedback`).

## Limits

- Day has no chat screen. A triage question is answered on the feedback page; a fix
  chat's question is still answered in its chat (`pilot://chat/<id>`).
- New does not link the mission it creates; the user links it from the feedback page.
- Checks: `user-feedback-work.test.ts` (real daemon HTTP, faux sessions/provider),
  `host::feedback` unit tests and `Feedback.test.tsx` on a scripted source. They do not
  run a real provider, a native window or a live triage.
