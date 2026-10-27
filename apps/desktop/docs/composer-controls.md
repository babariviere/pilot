# Composer sending and contextual Stop

The conversation owns attention; the tray offers one primary Send action. The
ordinary composer has no Follow-up checkbox. Send and Return use `steer`, which
starts a turn while idle or steers the current turn. Option-Return explicitly
uses `followUp`; Shift-Return remains a newline. The Send tooltip documents both
paths. These mirror Swift `Composer.send`, `submit` and `ComposerSendButtons`
in `apps/macos/Sources/Pilot/Composer.swift`. Existing queue display/edit contracts
and held automatic inputs are unchanged. Send never invokes Stop.

Stop is a native Button with an accessible name, tooltip and Tab/Space keyboard
path, not a checked-state control. It mounts only for a working/queued chat,
in a reserved Kit-small slot so neither Send nor the editor moves when work
starts/ends. Explicit Stop alone uses the existing Stop command. Swift's
`AppModel.stopSession` also treats it as a separate action and retains withdrawn
queued text. Next keeps that text in its existing separate recovery, rather than
merging it into newer typing. No new endpoint, automatic retry or cancellation
on send is added.

`ChatEditor` remains the retained input/selection/focus owner. It captures the
delivery mode directly into the existing worker command, which prepares the same
immutable operation ID, target, payload and hash before transport. Retry never
reads the new keyboard choice. Pending/readonly/error and marked-text guards
are retained. Pending actions show “Waiting for Local action…” in the same
metadata row. Unknown retains its original diagnostics and recovery actions.
Question replies remain separate, explicitly confirmed steering messages; the
ordinary Option-Return handler is scoped only to the ordinary textarea.

## Contextual recovery

Ordinary unsent drafts have no Discard or recovery toolbar. Only an unresolved
delivery, unadopted created chat, rejected result or separately recovered text
reveals a quiet **Resolve…** entry on the same row as its plain status line
("Couldn't confirm this message was sent."). Errors and Unknown delivery status
remain visible without opening it. The native popover contains only relevant explicit
actions: Check and Send again for operation-backed delivery, Dismiss for uncertain
Stop, open a created chat, copy/remove recovered text, and guarded ordinary-draft
Discard. Opening/dismissing it never executes an operation. Tab/Space opens it;
Escape restores the previous mounted focus. Actions keep the original captured
operation/key/revision. Question-purpose Discard remains disabled. Ordinary new
drafts no longer show a permanent Discard action; clearing text remains ordinary
editor behavior. This is presentation only, not automatic abandonment or retry.

Model/thinking controls remain mounted while the waiting caption is shown, so
pending feedback does not unmount their focused input/trigger.

No geometry, theme, dither lifecycle, transcript or scroll owner changes. Kit
small sizing preserves the 76pt tray and 34pt single-line opaque editor, white
on gray in light appearance and card on tray in dark appearance. No new clock,
I/O or worker is added to render.

Verification is synthetic only. See [evidence](../evidence/composer-controls.md).
