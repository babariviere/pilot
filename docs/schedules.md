# Schedules

This guide records Pilot Next schedule controls and shared daemon behavior. Those
controls are historical; existing schedules and saved history are not removed by the source cutover.

In Day, open **Settings → Schedules…**, or choose **Schedules** in the command
palette. Opening the page only reads saved state.

Choose **New schedule…**, a project and an existing agent. Enter the message,
date or repeat rule, and time zone. One-time work can have an optional expiry.
Dates use `YYYY-MM-DDTHH:MM`; recurring times use `HH:MM`. For a repeated clock
hour, Pilot uses the first occurrence. A skipped clock time moves to the first
valid minute. Monthly dates beyond a short month's end use its last day.

## Holds and catch-up

Pause, host holds and global automation-off prevent starts. Saving a definition
does not release a hold. On resume, valid overdue coordinator check-ins are
combined. One-time work never starts at or after its expiry.
If a combined input is refused before entry, valid reminders stay pending and
combine again without the expired or changed reminders. An uncertain input is
never split or replayed.
Combined check-ins over 32 KiB stay paused instead of starting several turns.
Shorten their messages or resume selected check-ins separately.

Recurring work catches up only the latest occurrence whose calendar period is
still current. It skips an occurrence while previous work is running. Catch-up,
pause and overlap do not shift the next scheduled time.

Today shows a small upcoming preview and exceptions. Open a schedule's **Details**
for its target, prompt and recent runs, including late, missed, skipped and failed
runs. **Pause**, **Resume** and **Cancel schedule** keep its definition and history.
Insights-owned rules remain managed through Insights settings.

If a change is unconfirmed, use **Check status**. This only looks up its saved
receipt. It never resends the change. A kept or stale draft requires a review of
current state before saving.
The saved request also fences an older restored editor. It cannot create the
same schedule again after a lost reply. Legacy drafts without request identity
keep their text but require an explicit new schedule, not another save.

“Saved for delivery” means the input was queued, not that an agent completed it.
History records acknowledged input entry separately, so a reminder held past its
due time still shows its late delivery when it resumes.
An unknown kernel admission keeps its exact input and never retries
automatically. Inspect the owning agent before replacing that work.

## Check-ins and repair

A mission coordinator can schedule, cancel or replace its own agreed check-ins
with the mission tool. A check-in names the agreed brief revision. A changed
agreement or coordinator stops that check-in instead of granting new work.

Post-run checks and todo continuation share at most three automatic follow-ups
per user-directed run. They stop sooner on no progress or unavailable allowance.
The page shows saved check results, attempts and stop reasons.

Earlier flows keep their original owner, controls, definitions and visits. The
page distinguishes unfinished, held, interrupted and unknown work. Reading here
never starts, resumes or transfers a flow. Legacy execution retirement requires
the separately approved migration, not merely opening this page.

The older desktop's **Automations** page still supports new-chat targets and
[weekly Insights](insights.md). Day does not silently transfer their execution.
For workspace setup and post-run commands, see [project hooks](automations.md).
