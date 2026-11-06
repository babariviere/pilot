# Usage and context

## Read usage

Home shows cached provider subscription reports. **Usage** shows saved token
history, daily trends, and catalog cost estimates. Filter historical data by project
or inspect individual requests without treating page rows as complete totals.

Estimates are not bills. Missing, stale, partial, or unknown reports are not zero
usage. Subscription windows remain global even when history is filtered to a project.
**Refresh limits** requests a provider-cache refresh; **Refresh history** rereads
stored totals. The two actions are independent.

## Subscription pauses

Pilot pauses new model requests and tool calls at **99%** of a reported subscription
window. Active tools finish first. Subagents follow their own provider's limits.
Work resumes after reset or a fresh reading below the threshold.

**Force work** lets a chat and its subagents proceed beyond the reported limit until
the override clears or the provider rejects work. It does not add quota or bypass
provider enforcement. **Pause at limit** restores the guard early.

## Long conversations

Open **Context…** in the chat header for reported context and direct/child accounting.
Compaction shortens model context, not your saved transcript.

**Settings → Chats → Automatic handoff (experimental)** is off by default.
When enabled, ordinary chats prepare a fresh context at a safe boundary above 70%
of the model window, with extra room reserved for small windows. The same visible
chat, workspace, history, and mission membership remain. Coordinators use their own
memory policy. An invalid or interrupted handoff keeps the original context.

Changing providers may need a separate continuation. Read its confirmation and
finish or stop background jobs and close live terminals first.
