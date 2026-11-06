# Insights

**Status: weekly Insights can be enabled from Automations. Review settings are editable; Apply uses them.**

The app-owned workspace backend is a separate foundation. It does not yet replace these
screens or activate a report. See the [v2 contract](technical/insights-workspace.md).

To turn it on, open **Automations → Weekly Insights…**. One confirmation shows the findings
backlog, the schedule (Fridays 18:00, Europe/Paris), the exact model, what it reads and the
approximate budget. **Enable** creates or reuses the report chat and its weekly automation.
The first report runs at the next scheduled time, not right away. If no report chat already names a backlog,
choose an active mission in the same confirmation; Pilot never creates one or guesses by title.
The global Automations switch in **Settings → Chats** must be on. Weekly Insights never turns it on.
If Terra 6.1 is missing, nothing else is used instead; if several models share that name, choose one.

If enabling is interrupted, the confirmation shows **Check**. Check reads its status and only
re-admits the saved enable command when its receipt is unknown, using the same bytes and ID.
An unknown lookup does not prove nothing happened. The host journal prevents entered setup steps
from repeating; pending steps stay status-only in the app. Closing, reopening or restarting the app
never resends the command. Daemon recovery may finish a setup step not yet entered, not resend a review.
The result is On only when both the report chat and its weekly automation are confirmed.
**More → Set up Insights chat…** on a mission still creates just the report chat.
Repeated clicks on Enable, Replace, Save or Apply before its reply do not send another command.

## Replace a missing report chat

If Weekly Insights says the linked report chat isn't available, **Replace report chat…** may appear
in the same panel. If an earlier setup is accepted but its current report is unavailable, choose
**Set up again…** to check that same report first. This does not resend the old setup or create a chat.
Replacement reads Local's exact plan first and writes nothing. One confirmation names the
old chat (kept as a record, never reused), the automations it stops, the new empty report chat and
its fresh fixed settings: schedule and first report, model and thinking, what it reads, the partial
sample and the approximate budget. It does not restore the old chat's history or copy its access.
Replacement starts no immediate review, and the Automations switch is never changed.

**Replace report chat** sends that plan once. If it is interrupted, **Check** reads its status and
resends the same request only when Local has no record of it. Closing or restarting never resends it.
Local can refuse: for example when it can't confirm where the old chat lived, earlier work may still
be running, an automation can't be stopped safely or the plan changed. These stay blocked; there is
no reset. **Back** or Escape leaves the confirmation without sending anything.

Keep using the same **Check** while an action is unconfirmed. A pending cancellation can remain
blocked after restart; matching automation values do not prove it finished. Do not delete saved
requests or set up another backlog to bypass it. A completed replacement keeps the old records,
but does not restore deleted content or copy old review settings. Review the new settings before
confirming. Older Local versions keep Enable blocked and do not offer replacement.

If Local already completed the replacement but this app has no accepted replacement receipt,
reopening the replacement step checks the exact new report before adopting it. That adoption stays
in the open panel only; after an app restart, use the same step to check it again. No setup is resent.

In the report chat, the **Insights backlog** header button opens the mission's **Tasks** tab.
Findings have lifecycle chips; use each row's menu to choose a decision, then confirm it.
Finding controls need the linked report chat to be available in the chat list and unarchived.
Counts are hints, not complete totals.

Use the report chat's **… → Insights settings…** for compact status, model, expandable **Reads**
details, the **Weekly** state and **Revoke…**. Revoking keeps history and reports. Delivering one improvement never
retires the report chat. If an action is **Unknown**, use **Check** to look up its durable outcome;
closing and reopening is not permission to repeat it.

## Review settings

**Review → Settings…** in those settings (or **Review settings…** once weekly Insights is On) edits the
desired review: day, time and time zone, the exact model, which projects and archives are read,
excluded projects and chats, the partial sample and an advisory budget per report or per month.
It shows the resolved model ID and the report chat's thinking level (Default when unset).

**Save** stores these as desired settings only. The current weekly rule keeps its old settings and
never adopts a saved revision by itself. **Review Apply…** reads a fresh preview from Local and shows
exactly what **Apply** will do: the revision, model and thinking, schedule, sources and exclusions,
provider processing, sample, budget and the exact rule it keeps, or cancels and replaces. Apply
changes the report chat's model only when the saved model differs, and starts no review.
If Local refuses (for example an unavailable model, or a model switch that would need a paid context
rebuild), nothing else is tried; decide separately.

Unsaved edits survive closing the panel in the same app session, not an app restart. If settings
changed elsewhere, your edits stay and you choose **Discard** or **Keep mine**. An unconfirmed
Save or Apply blocks both until **Check**. Check looks up the saved request and resends it,
byte for byte, only when Local has no record of it.

Insights is intended to review chat evidence across projects and propose useful improvements.
Its restricted reader can discover local chats, including archives, and read limited, sanitized
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

Limited review context, reports and unfinished source positions survive restart. Reports remain
partial, disclose coverage gaps and uninspected content, and revisit previous findings. Cost proposals
distinguish known spend from estimates or unknown baselines, with safety trade-offs and a later benefit check.
A save proves persistence, not complete coverage or a successful weekly run. Stopped or uncertain
review inputs never automatically replay.

Each weekly run reviews a sample using the chat's existing access, not the saved message as
review instructions. Existing pause/resume controls on the Automations page apply.
Stopped, interrupted or uncertain reviews appear as schedule failures and are never resent after
restart. A later weekly occurrence is a distinct review, not proof that an older gap was resolved.

## Fixed initial defaults

The backend now offers a fixed preset: Friday **18:00 Europe/Paris**, **Terra 6.1**, and a limited
weekly sample across locally admitted projects, including archived chats. Source chats stay read-only.
Sampling keeps one inventory page, two history pages and four entries per page. This is partial
coverage, not a scan of every chat; the dates label review context, not a history date filter.

**Approximately $5 per report** is an initial assumption, not a hard cap or approved spend. The user
confirmed approximate budgeting, but its period and source scope still need activation confirmation.
Unknown pricing or spend stays unknown, never zero. Nothing switches models or budgets automatically.

Terra is suggested only when one configured, available model in the selected project's scope has
the display name **Terra 6.1**. Missing or ambiguous matches stay unresolved, with no guessed ID or
Sol fallback. Explicit model choices and existing schedules are unchanged.

Saving settings does not activate them or change an existing model, access grant or automation.
Apply preserves the report chat and replaces only the exact previewed integration-owned weekly rule.
Apply starts no report and cannot perform a paid context migration. Interrupted effects stay pending
without replay; inspecting matching model/rule values is not an acknowledgement.
See the [settings contract](technical/insights-settings.md) for native integration and limitations.
Opening the confirmation, reading status or restarting the
app grants no access and starts no review or schedule. **Enable** authorizes weekly setup, not an
immediate review. A daemon restart can reconcile an already confirmed setup without new consent.

See the [permission contract](technical/insights-history.md) and
[enable verification and limits](technical/insights-enable.md#verification-and-limits) for technical detail.
