# Models and MCP connections

Pilot uses your existing pi configuration and provider authentication on this machine.
Configure providers in pi first, then select a model and thinking level for your chat.
Missing authentication or unavailable models should be fixed at the source, not
worked around by repeatedly sending the same request.

## Day AI settings

In Day, **Settings → AI** shows the chosen model list, shared defaults, the
selected project's override and the effective thinking for each action. Existing
per-model settings, advanced patterns and project Pi configuration stay intact.
Editing shared settings does not switch running chats.

Task starts keep the reference-price ceiling. If reference prices are missing,
set a replacement input + output price limit before starting affected work. Pilot
does not silently choose another configured model. Failed work offers eligible
replacements from that chat's actual source copy. **Save for next attempt** saves
only that preference, without starting or retrying the chat.

**Provider sign-in** offers the provider's supported device or browser-code flow,
with **Check sign-in**, **Cancel sign-in** and explicit sign out. Codes stay out of
chats, saved drafts and command receipts. Sign out removes the stored credential,
not environment variables or the provider's own authorization. An uncertain
settings action stays Unknown. **Check receipt** reads its result without resending.

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
