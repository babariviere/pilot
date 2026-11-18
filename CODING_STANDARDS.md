# Coding standards

## Simplicity

Review complexity against the requested behavior and concrete risks. Prefer existing tools and direct code.
Flag speculative abstractions, redundant validation and recovery machinery for unsupported scenarios.
Name the simpler alternative and explain why it meets the same requirements.

Use existing contracts for trusted internal data. Add defensive checks where inputs or failure modes require them,
not at every layer. Keep safeguards that protect security or user data.

Keep feature runtime checks separate from distribution, signing and release checks unless the feature actually
depends on them. Prefer a small working end-to-end path over infrastructure that leaves the requested behavior missing.

## Limits

Add a limit (a count, a size or a time) only for a cost you can name: disk, memory, daemon or UI blocking, model
tokens, or abuse. Next to it, say what it protects and how you chose the number, from a measurement or a real
case. Do not copy a number from another feature. A refusal names the limit, the value it got and what to change:
"the map holds at most 40 questions and this save has 42", not "Invalid planning list". Check that long-lived
data (a mission, a chat, a history) cannot grow into the limit with no way out, such as items that must be kept.

## Live data in the UI

The user must never lose their place, their focus or their words because Pilot read new data.

- Show the last good data and update it in place. A background read never hides, clears or rebuilds what is shown.
- Key each list item by its stable identity (decision, question, topic or chat ID). Never key by index, revision,
  digest or a whole object.
- Do not publish a read equal to what is shown. Compare first, and change only the fields that changed.
- Every read names the scope it was asked for (window, project, mission, thread or chat) and is dropped unless that
  scope is still the one shown. Last good data is kept per scope: after a switch, show the new scope's own last read
  or a quiet loading state, never the previous scope's data.
- While the item is the same, a read never moves focus, cursor, selection or scroll, and never changes a draft.
- Read automatically: on service events, reconnect, wake and window focus, with retry and backoff. Do not add a
  "Read again" button or a "Reading…" note for a normal refresh.
- Warn about old data only when it is older than 5 minutes and 3 automatic retries in a row failed (the user's
  choice: earlier warnings were noise). A read that never worked shows as unavailable, never as an empty list.
- When a write is refused only because the surrounding read changed, and the item the user acted on did not,
  send it again without the user (a new operation ID each time, a few attempts). Refuse only when the item itself
  changed, and say what changed.
- When Pilot did not hear back about a write, look up its result automatically. Never send it again. A manual
  Check is only a fallback after the automatic lookups fail.
- A screen with an input has a test that types, delivers a refresh of the same item, and checks that the field
  kept its node, focus and text.
- Every state that needs the user shows, on the same card or page, the action that resolves it: Continue, Answer,
  Reply, Dismiss or Open chat. A link to see the work alone is not an action.
