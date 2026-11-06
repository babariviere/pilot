# Troubleshooting and updates

## A chat needs attention

Read its reported reason first. A pending question, failed startup, usage pause,
and background job each need a different response. Failure details can be selected
or copied without retrying the run.

- **Startup failed:** fix the reported configuration or extension dependency, then
  choose **Retry Startup** where offered. Queued messages and history are kept.
- **Usage hold:** wait for reset or review [Force work](usage.md#subscription-pauses).
- **Offline:** restore connectivity. Do not repeatedly resend the task.
- **MCP sign-in:** open [Connections](connections.md) for the named server.
- **Unconfirmed action:** inspect its original status. Do not repeat a send or update
  just because its response was lost.

Stop cancels work, not prior file edits. A crash-interrupted native tool is not
automatically replayed.

New message sends and chat creation save an immutable delivery intent before
contacting the daemon. Lost replies and offline periods reconcile automatically,
including after restarting the app. Pending or Reconnecting is not Sent. Delivery…
keeps details, copy and discard available without a routine Check or Send again.
Older unresolved messages and one-shot actions remain inspectable and are not
silently opted into retries. A newer daemon may be required for automatic sends.
Stop and model changes fence older, not-yet-accepted captures; edit a rejected
message to send a new intent. Discard prevents future retries, but cannot retract
an already accepted message.

## Ask about Pilot

On macOS, **Help → Ask about Pilot…** opens a read-only diagnostics conversation.
Describe the problem and include the reported error. Diagnostics reads limited,
sanitized evidence; it does not gain arbitrary shell or filesystem access.

A repair is separate Build work, not something an investigation silently starts.
Diagnostic availability varies by client; do not assume a legacy repair control is
available in Pilot Next. Local diagnostic capture and optional reporting are separate
settings. Remote reporting and product analytics default off.

## Updates and the daemon

On macOS, choose **Pilot Next → Daemon → Reload** after changing pi extensions
or MCP configuration. This applies across chats without restarting the daemon.
Idle chats reload immediately; busy chats wait for their work, jobs and subagents
to finish. Sleeping chats load the current configuration when next opened.
History and unsent drafts stay intact. The menu shows pending reloads and failures.
If extension loading fails, fix the configuration and choose **Reload** again;
new work in that chat stays blocked until loading succeeds. Reloading configuration
does not confirm that every MCP server connected; check **Settings → Connections**.

Use **Settings → Updates** for the available app and daemon controls. On macOS,
packaged managed connections also offer **Pilot Next → Daemon** actions.
**Install and restart** saves current chat drafts, question replies, attachments
and app preferences, waits for pending saves, then continues automatically.
It does not send drafts or require a delivery Check. Saved pending messages
keep their original identity across restart; independent daemon jobs keep running.
An actual storage failure or an unsaved secondary form names what needs attention.
Secrets in session-only access fields are never saved to disk.
**Stop**, **Restart**, and **Upgrade** run their stages automatically. Stop leaves
the service stopped. Restart keeps its current runtime; Upgrade selects this app's
verified runtime. Explicit lifecycle actions interrupt work after saving recovery
state. Durable chats resume on Start, Restart, or Upgrade. Shell jobs and terminals
do not replay their commands; interrupted tools remain visible in history.
Registration, service replacement, and coordinated project-proposed updates require
explicit approval. Connecting to an existing daemon does not take ownership of it.

Pilot source-project update proposals appear as cards in their originating chat.
Review the build and summary, then choose **Accept update** or **Dismiss**.
Acceptance pauses new work across all chats. Settings → Updates remains the
recovery fallback.

Automatic startup upgrades still wait for a safe tool boundary. Unverified service
ownership, failed checkpoints, or unsaved state can block a handoff. An uncertain
outcome is not permission to replay it. Keep the daemon on loopback; its local API
has no network authentication and must not be exposed publicly.
