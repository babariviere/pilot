# Linear tickets

Connect the `linear` MCP server and configure teams in project tracking settings.
Review issues in the Inbox, the project's current cycle, or its Linear queue.
Sub-issues are grouped under their parent.

Start a chat for a focused change or a mission for broader work. Size suggestions
such as **Quick fix** and **Needs planning** help choose; they never start work on
their own, and you can correct them.

Chats started from a Linear ticket explicitly request a short interview before
implementation. The agent reads the ticket and relevant code read-only first,
then asks 1–3 material questions about scope, acceptance or tradeoffs. A clear
ticket needs only one scope-confirmation question.

The shared `interview` tool has `read`, `questions` and `check` actions. The agent
saves the full question list with `questions`, which returns immediately, then
ends its turn. You answer in the native app; submitting the round resumes the
chat. The agent never answers or selects for you and waits for your answers
before implementation.

Direct Ask and Build prompts leave the interview choice to the agent: clear
requests proceed, while material uncertainty or an explicit interview request
uses `interview`. Isolated blockers still use `ask_user`, which saves one question
and ends the turn without waiting inside the tool. This is agent guidance,
not a new enforced start gate. Answers never grant permissions or change mission
approvals. Mission workflows are unchanged.

See [shared interviews](technical/shared-interviews.md) for durability and recovery.

In Day, open an issue to start linked work or prefill a mission draft. **Manage
status** is off unless you turn it on. A reference keeps the link without
changing Linear. Size advice uses the shared background AI allowance and never
chooses or starts a route. Issue text is context, not permission.

## Mission ticket contributions

A chat or mission can manage an issue, but not both. For a mission planned from
an issue with **Manage status** on, tasks in the approved initial plan count
toward that issue. Other ticket and task links are references by default.

Pilot syncs only **In progress** and **In review**. You mark the issue complete
in Linear. Use relation-only PR wording unless you explicitly choose closure
and the final contributor passes the live checks. Set the state mappings for
the issue's team in project settings. A missing mapping leaves Linear unchanged.

An external status change pauses sync, not the work. Review the issue before
resuming. For a linked chat, you can change status management from the issue
without starting another chat.

Reassignment holds the affected work and marks contributing tasks delegated.
When the issue returns to you, only the assignment hold clears. Canceled or
duplicate issues hold affected work and ask for plan review. No tasks are
dropped or transferred automatically.
