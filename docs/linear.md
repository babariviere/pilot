# Linear tickets

Connect the `linear` MCP server and configure teams in project tracking settings.
Review issues in the Inbox, the project's current cycle, or its Linear queue.
Sub-issues are grouped under their parent.

Start a chat for a focused change or a mission for broader work. Size suggestions
such as **Quick fix** and **Needs planning** help choose; they never start work on
their own, and you can correct them.

Chats started from a Linear ticket explicitly request a short interview before
implementation. The agent reads the ticket and relevant code first, then asks
1–3 targeted questions about scope, acceptance or tradeoffs. A clear ticket needs
only one scope-confirmation question. The agent waits for your answers before
implementation. Direct prompts leave the interview choice to the agent: clear
requests proceed, while material uncertainty prompts questions.

This is agent guidance through the existing `ask_user` tool, not a new enforced
start gate. Answers do not change the chat's permissions or mission approvals.

Starting work can move an eligible issue to the team's configured **In progress**
state. A missing or invalid mapping leaves Linear unchanged and reports an error
without blocking local work. Review each team's state mappings in project settings.

## Mission ticket contributions

A ticket link is normally a read-only reference. Explicitly choose to manage a
ticket in a mission and count tasks toward it when you want synchronization.
One mission manages a ticket; several tasks can contribute.

Managed tickets follow contributing work toward In progress, In review, and Merged,
not Deployed. Dropped contributors block completion until explicitly excluded.
Empty contribution sets and reference links do not complete tickets.

Manual Linear changes or contribution-scope changes can pause synchronization.
Review **Linear tickets** in Mission Overview, then choose **Resume** or **Retry**
when appropriate. A warning is not proof the requested remote update succeeded.

Tasks delegated to someone else in Linear do not count as complete. Existing
chats are not stopped just because the assignee changed.
