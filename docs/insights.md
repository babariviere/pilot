# Insights

## Pilot Day

Open **Insights** from the command palette. In **Settings**, choose the report
project and model, the source projects, and both spending limits. Review the
settings before applying them. Setup enables manual reports without starting
one. After setup, you can choose a weekly day, time and time zone. Applying
settings while paused does not resume reports.

**Reports** shows samples, gaps and evidence links. All active chats in the
chosen projects are eligible unless excluded. Archived chats qualify for 24
hours after archive; earlier messages in an eligible chat may still be read.
Day uses a bundled version of `/retro` to look for changes that could help
future agents. It samples user turns, failures and nearby replies. The selected
provider also receives partial catalog cost estimates for each sampled chat,
when available, separate from the report budget. These estimates are not bills.
The selected model provider processes sanitized excerpts, which can still
contain private project text. The two limits use catalog estimates, not bills:
each request must fit both the report budget and the shared UTC calendar-month
budget. Insights does not use the small background-work allowance.

**Findings** shows separate proposals based on the evidence from a report.
Pilot rejects an exact duplicate pattern key without showing the earlier
finding to the report model. A finding opens a fix or mission draft with
source references. A report can propose a PR for any selected source project.
Each PR proposal identifies one project so you can open its own fix draft.
Only an explicit Start or Plan begins that work. Shipping is not benefit
verification; mark the benefit verified only after checking it yourself.
Earlier history is read-only and does not transfer source access or schedules.
See the [Day service contract](../packages/protocol/src/insights/day-insights-wire.md).

## Earlier Insights setups

Use **Insights → Settings** in Day for new setup. The old desktop setup,
replacement and settings commands no longer accept new operations. Exact
receipts remain readable. An uncertain operation is not proof that nothing
happened; do not start another setup to bypass it.

The upgrade does not remove saved reports, findings, receipts or automation
rules. Explicit migration and the controls for stopping an existing executor
remain separate from new setup. Day can refuse setup if it cannot confirm
that an earlier executor and its schedule are stopped. Inspect the old
automation and report status before trying again.

See the [workspace and migration contract](../packages/daemon/src/insights/insights-workspace.md)
for compatibility details.
