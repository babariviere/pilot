# Models and MCP connections

Pilot uses your existing pi configuration and provider authentication on this machine.
Configure providers in pi first, then select a model and thinking level for your chat.
Missing authentication or unavailable models should be fixed at the source, not
worked around by repeatedly sending the same request.

## Scoped models

**Settings → Scoped models** edits pi's global model list on this Mac. Search,
select models (or All), and save. Project overrides, sign-ins, default models,
and running chats are not changed. Unavailable models and advanced patterns are preserved.

## MCP

Open **Settings → Connections** (or **MCP connections**) for Local's reported MCP
server status. Use the available explicit check or sign-in action when required.
Refresh reads the daemon's report; stale or unavailable status is not a live health check.
Chats pick up newly available credentials on their next turn.

A tool requiring sign-in can move its chat to **Needs you**, naming the server.
Connect the right server rather than changing an unrelated chat's permissions.
For detailed configuration, use pi's MCP setup and `pi mcp list`.

Slack and Linear tracking use the pi MCP servers named `slack` and `linear`.
Enable their sources separately in project settings. Connecting a server does not
automatically enable tracking or authorize arbitrary replies.
