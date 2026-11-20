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

## Work profiles

A work profile names a kind of work and the models that do it. **Settings → AI → Work profiles** lists
them, closed, with a summary such as "Large: Sol, Opus 5.5 · Small: Terra, Sonnet 5.5". Choose **Edit models** to
change its two lists: **Large** for risky, cross-cutting or design-heavy work, **Small** for contained work.
Each entry has a model, any signed-in model, and its own thinking level. Move entries up or down, remove
them or add one. **Opt-in only** keeps a profile off in every project until you allow it there.
**Add a profile** and **Remove profile** change the list. Each change saves the whole list once.
Until you save your own list, Pilot uses Backend, UI and Cyber.

A profile's models only need a signed-in provider. They do not have to be in the chosen model list, and the
task price ceiling does not apply to them. Keep a model out of the chosen list to keep it out of the chat model
pickers, and use it only through a profile.

**Settings → Local projects** shows **Profiles allowed in this project**, one checkbox per profile. Until you
change a project's boxes, it allows every profile except opt-in-only ones such as Cyber. Once you change them,
the project keeps exactly your list: a profile you add later is off there until you check it.
A project never puts one profile on all its chats.

The planner gives each task one allowed profile and a size. When Pilot starts the task, it picks the model:

1. A model set on the task, by you or the coordinator.
2. The task's profile and size, if the project allows that profile. Pilot takes the entry with the fewest of
   your chats working now. When two are equally busy, the first in the list wins. It skips a model that is
   not signed in or is at its usage limit.
3. Your default model. When every profile model was skipped, the task line says why.

A mission's task rows say how the task got its model, such as "Backend · large · Sol · preferred",
"UI · large · Sol · Opus 5.5 was busier" or "Sol · set by you". **Change** opens Settings at that task's
work profile, open and focused.

When a provider blocks a turn with "Cyber safeguards flagged this message" and the project allows Cyber,
Pilot sends that turn again once with a Cyber model. The chat then stays on that model, and a note says
"<model> blocked this turn as cyber work. Pilot sent it again with Cyber (<model>)." Its task line says
"after a cyber block". When the project does not allow Cyber, the chat fails as before. After two blocks in
such a project, Today asks once: "<Project> hit cyber blocks twice. Allow Cyber work in this project?"
**Allow Cyber** checks Cyber for that project; **Not now** keeps it off. Either answer, or any Cyber box change
in that project, ends the question there.

## Scoped models

**Settings → Scoped models** edits pi's global model list on this Mac. Search,
select models (or All), and save. Project overrides, sign-ins, default models,
and running chats are not changed. Unavailable models and advanced patterns are preserved.

## MCP

In Day, **Settings → Tool connections** shows saved setup and the last service
check. **Check connection** runs a fresh check. **Read again** only reads the
cached report. The service checks at startup and when Pi's MCP configuration or
authentication changes, not on each Settings visit.

**Add connection…** adds an HTTPS service or an already installed command. It
does not replace existing entries. Unsupported and advanced entries remain in
`mcp.json`, including their headers, arguments and other external settings. Edit
those entries with Pi. Pilot never displays their secret values or installs commands.
Browser sign-in and cancellation name the connection and current attempt. An
uncertain setup or sign-in action stays Unknown; **Check status** reads its
receipt without sending it again.

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
