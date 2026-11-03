# Troubleshooting and updates

## A chat needs attention

Read its reported reason first. A pending question, failed startup, usage pause,
and background job each need a different response. Failure details can be selected
or copied without retrying the run.

- **Startup failed:** fix the reported configuration or extension dependency, then
  choose **Retry Startup** where offered. Queued messages and history are retained.
- **Usage hold:** wait for reset or review [Force work](usage.md#subscription-pauses).
- **Offline:** restore connectivity. Do not repeatedly resend the task.
- **MCP sign-in:** open [Connections](connections.md) for the named server.
- **Unconfirmed action:** inspect its original status. Do not repeat a send or update
  just because its response was lost.

Stop cancels work, not prior file edits. A crash-interrupted native tool is not
automatically replayed.

## Ask about Pilot

On macOS, **Help → Ask about Pilot…** opens a read-only diagnostics conversation.
Describe the problem and include the reported error. Diagnostics reads bounded,
sanitized evidence; it does not gain arbitrary shell or filesystem access.

A repair is separate Build work, not something an investigation silently starts.
Diagnostic availability varies by client; do not assume a legacy repair control is
available in Pilot Next. Local diagnostic capture and optional reporting are separate
settings. Remote reporting and product analytics default off.

## Updates and the daemon

Use **Settings → Updates** for the available app and daemon controls. On macOS,
packaged managed connections also offer **Pilot Next → Daemon** actions.
Registration, service replacement, and coordinated project-proposed updates require
explicit approval. Connecting to an existing daemon does not take ownership of it.

Live jobs, terminals, unknown child processes, or unsaved state can block a safe
handoff. Resolve the named blocker rather than forcing replacement. An uncertain
outcome is not permission to replay it. Keep the daemon on loopback; its local API
has no network authentication and must not be exposed publicly.
