# Insights

**Status: native setup and review are available; there is no active weekly schedule yet.**

To set up the report chat, open the backlog mission and choose **More → Set up Insights chat…**.
The dialog explains what Insights can read and which model processes it, and nothing is granted
until you confirm. In the report chat, **Insights access** shows the scope, opens the backlog
mission, lists findings for your decisions and can revoke access. Revoking keeps the chat's history
and reports. Delivering one improvement never retires the report chat.

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
approve a finding or verify its benefit. Only your explicit decision in **Insights access** changes a
finding's state, and approving starts no work: fixes run in separate chats you start.

Bounded review context, reports and unfinished source positions survive restart. Reports disclose
partial coverage and uninspected content, and revisit previous findings. Cost proposals distinguish
known spend from estimates or unknown baselines, with safety trade-offs and a later benefit check.
A save proves persistence, not complete coverage or a successful weekly run. Stopped or uncertain
review inputs never automatically replay. Weekly activation remains separate work, and weekly
settings still require confirmation.

See the [permission and verification contract](technical/insights-history.md) for implementation limits.
