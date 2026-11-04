# Insights

**Status: setup and backlog review are available. Weekly activation is still pending.**

To set up the report chat, open the backlog mission and choose **More → Set up Insights chat…**.
Choose the model and confirm the disclosed read scope. Setup creates the report chat, not a
history review or weekly schedule.

In the report chat, the **Insights backlog** header button opens the mission's **Tasks** tab.
Findings have lifecycle chips; use each row's menu to choose a decision, then confirm it.
Finding controls need the linked report chat to be available in the chat list and unarchived.
Counts are bounded hints, not complete totals.

Use the report chat's **… → Insights settings…** for compact status, model, expandable **Reads**
details and **Revoke…**. Revoking keeps history and reports. Delivering one improvement never
retires the report chat. If an action is **Unknown**, use **Check** to look up its durable outcome;
closing and reopening is not permission to repeat it.

Insights is intended to review chat evidence across projects and propose useful improvements.
Its restricted reader can discover local chats, including archives, and read bounded, sanitized
committed history without starting or changing the source chats. Missing, truncated or unavailable
history remains an explicit coverage gap. Artifact and attachment contents are not available.

Redaction can remove credentials and private reasoning, but cannot guarantee that all sensitive
business text is removed. Before activation, setup must explain that selected-model processing
can include sanitized excerpts from other projects.

Findings can retain repeated evidence, affected projects, proposed changes, cost assumptions and
implementation links in the dedicated mission backlog. Recurring evidence amends a stable finding,
not a new implementation task. Findings are tracking records only, never permission to change a
project, start fixes, or change models, budgets or schedules.

The lifecycle distinguishes Proposed, Approved, In progress, Shipped and Verified, with Deferred
and Dismissed alternatives. Shipped means delivered, not proven useful. Model-written results cannot
approve a finding or verify its benefit. Only your explicit decision from a finding's row changes a
finding's state, and approving starts no work: fixes run in separate chats you start.

Bounded review context, reports and unfinished source positions survive restart. Reports remain
partial, disclose coverage gaps and uninspected content, and revisit previous findings. Cost proposals
distinguish known spend from estimates or unknown baselines, with safety trade-offs and a later benefit check.
A save proves persistence, not complete coverage or a successful weekly run. Stopped or uncertain
review inputs never automatically replay. Weekly activation remains separate work, and weekly
settings still require confirmation.

Once those settings are agreed, use **Automations → New automation → Repeats → Send to a chat**
with the Insights chat as the destination. This runs a bounded review using the chat's existing
access, not the saved message as review instructions. Existing pause/resume controls apply.
Stopped, interrupted or uncertain reviews appear as schedule failures and are never resent after
restart. A later weekly occurrence is a distinct review, not proof that an older gap was resolved.

See the [permission contract](technical/insights-history.md) and
[verification and limits](technical/insights-review.md#synthetic-checks-and-limits) for technical detail.
