# Subscription-limit recovery

While pilotd reports `subscriptionPause` for the selected chat, one row above the
composer tray states it ("Paused at Claude 5-hour limit · resumes at 18:00", or
"Working past usage limit · Claude 5-hour at 97%"). Its tooltip lists every window
and reset. Nothing shows without a pause. This mirrors Swift `SubscriptionLimitNotice`,
`SubscriptionLimitActions` and `ModelContinuationSheet`.

- **Force work** / **Pause at limit** sends one `POST /api/sessions/:id/subscription-force`
  after a fresh read of the chat. pilotd keeps its own scope (this chat and its
  subagents, until the windows reset). A lost reply is reported, never resent.
- **Continue with another model…** (unforced pause only) opens an inline choice:
  a scoped model, an explanation of what that model actually does, Cancel and the
  confirm button. Picking a different model from the composer chip while held opens
  the same choice. Same provider: "Switch model" keeps this chat and its history, and
  the same limit still holds work. Another provider: "Start new chat" hands a
  plain-text summary to a new chat, this one becomes read-only, and the new chat opens.
  Nothing promises an automatic resume.
- Continue sends one `POST /api/sessions/:id/continue-model` with the model only, after
  identity, pause and scoped-catalog checks. It is retained like a model switch: a
  4xx settles it, a lost reply keeps the existing Unknown model notice (Inspect,
  Acknowledge) and fences Send. No retry.
- Continue waits for pending/Unknown delivery, a retained model switch, marked text
  and other model actions. The draft, its delivery and the transcript are untouched.
  Forced pauses are not held, so the ordinary idle-only model change applies.

No backend change. Checks: `subscription_pause` and `chat_models` unit/transport tests,
and the `project_creation` native target's subscription-limit probe at 680/1100 in light
and dark (pointer and keyboard, preedit guard, private draft restart).
