# Chat model eligibility

The composer shows the exact current provider/model and thinking even when a
change is unavailable. Its native menus remain inspectable once the scoped
catalog is loaded; unavailable choices are disabled, with a contextual reason
above the composer. Refresh is a read, not a model-change retry.

`SessionModel::read` accepts healthy, non-working `idle` **and `parked`**
summaries. `Sessions.summary` uses `parked` for an absent worker and stopped
recovery, not just active work. `Sessions.changeModel` explicitly allows a
parked idle conversation to reopen via its one model POST. No extra start,
send, continuation, Stop, or queued switch is added by the client.

The Swift picker also permits non-working parked chats (`canChange` excludes
failed/read-only/working, not parked). Its separate subscription continuation
sheet is not part of this desktop fix.

`summary.error` alone is not an admission restriction: it can contain retained
kernel diagnostics even after the chat returns to idle or parked. Actual
failure (`state == failed` or an explicit failure field) still blocks changes.

The desktop keeps its failure, pause, jobs, ownership, delivery,
catalog and IME protections. Failed chats are **not** fixed by enabling a
selector: the daemon rejects `meta.failure` before opening a worker. Supporting
that recovery would require separately approved backend behavior. Subscription
pause does not imply permission to continue or create another chat.

Summary-derived eligibility is a hint, never an admission receipt. The existing
pinned hello/source/chat preflight and exact scoped catalog remain mandatory.
The daemon checks actual work, queued input, worker activity, configuration
locks and ownership again, including after worker readiness. A race, lost ACK
or error after POST retains the immutable Unknown attempt. GET/Refresh never
settles it or replays the write. New-model selection still omits the old
thinking override and uses the new model's scoped default.

Verification: `check-scoped.py --unit chat_model --test project_creation --lint`
maps projection/preflight/transport and actual mounted composer checks.
`check-scoped.py --unit model_picker --native-probes` executes the nested
`chat_editor::model_picker` state tests (the filename is not its module name).
Both filters are helper-free: these modules use
owned HTTP fixtures and native controls, not the visual worker. The mounted
probe covers active and parked idle, failed-to-parked, busy, pause, pending and
read-only inspection, pointer/keyboard, preedit, exact source fencing, retained
Unknown and the main draft/selection/reader. No live model mutation or real app
restart is used. Native tests are not OS IME or Linux acceptance.
