# User feedback

Day has a direct path for the user's own feedback about Pilot. It saves the words and
shows them again. It is not agent Insights, findings or a retrospective, and it is not
an inbox: saving feedback creates no mission, starts or routes no work, spends nothing
and approves nothing. Triage, routing, dedupe and retro analysis stay open design work.

## Storage and API

- One append-only `user_feedback` table in the mission database (`MissionStore`), with
  its transaction and disk durability. No second store and no external service.
- Native generic operation kind `user-feedback`, `targetId` = the new feedback ID the
  native host names. The payload is exactly `{purpose, text, origin}`: the text (at most
  8 KiB UTF-8, not blank) and `null` or one exact `{kind:"mission", missionId}` /
  `{kind:"chat", sessionId}`. The service reads the origin's project and title when it
  saves; a missing mission or chat refuses the feedback. Native capability authentication
  is required. The accepted receipt's `result` is the saved `UserFeedback`, after the
  durable write. Journal recovery is lookup only: a lost ACK stays Unknown, never resent.
- `GET /api/feedback?before=<sequence>&limit=20` (native authenticated) lists saved
  feedback newest first with an exact cursor.

## Day

The header's Feedback opens the page about Pilot in general. A mission overview's Send
feedback opens it about that mission. Words with an origin keep it: opening the page from
somewhere else offers the new origin and never switches by itself. Make it general drops
the origin. No transcript, file or project is attached silently.

- `day.feedback.read {before?}` reads one page. A failed read is never an empty list.
- `day.feedback.send {text, origin}` journals the envelope before its one POST. While an
  earlier Send is Unknown, the root refuses another.
- `day.feedback.check {operationId}` only looks up that saved envelope's receipt.

Only an accepted receipt clears the draft. Leaving the page, closing or updating keeps
the draft and its origin in the saved view (`feedbackOpen`, `feedback`). Saved
feedback shows its words, date and origin, with the plain statement that nothing triages
or routes it yet.
