# Agent diagnostics

### Existing daemon performance snapshot

`diagnostic_context` → `performance` returns the already-running watchdog's bounded CPU/memory, event-loop
delay/stall and operation snapshot through the same sanitization and byte/node bounds as other context evidence.
It accepts only the action and optional host identity, requires the persisted diagnostics role at worker admission,
and never forwards to a linked host. Replaced daemon/lineage, missing watchdog or cancellation refuses the read.
It neither enables collection nor resets counters, profiles, wakes workers, performs provider requests or mutates
the subject. Cumulative CPU and lifetime percentiles are not current utilization or a specific request's latency;
in-flight HTTP operations are not IPC queue depth. Native clients already have the separate performance GET contract.

### Background integration job health

`diagnostic_context` → `refresh_health` includes host-scoped manual discovery lookups and linked-Linear
sync scheduling, plus per-project linked sync, parent-header prefill, Slack Done writes and triage-guide
rebuild observations. Linear polls also report the bounded `parent_headers` stage (requested headers,
cached/detail hits, external read attempts and returned headers). The real owners report queue/start,
stage progress, completion, no-work/skip/partial/failure/cancellation and retry/cooldown timestamps.
Linked sync reuses its existing fixed failure stage/category and retry evidence, never issue names,
status names, remote payloads or error strings. `no_work` there means no remote status write was needed,
not that no reconciliation/read occurred. A successful no-op is distinct from a write.

This is a bounded last-observation surface: at most 256 job keys and four recent completions per key,
with drop counts and installed/applicability labels. Event-driven or deliberately deferred jobs do not
have a fabricated periodic heartbeat. `idle_unobserved` is not failure, and observed success is not proof
of current liveness. Full tracking configuration hashes fence replacement/removal and late completions.
Diagnostic reads only inspect observations, never execute, enqueue, retry or write an integration job.
Local operational collection/clear controls apply independently of remote export. Nothing is uploaded.

Quota evidence comes from current policy constants, not a new budget: Slack currently counts 100 local
operations per fixed UTC hour. Force remains a single counted bounded pass and preserves provider limits.
Slack Done writes use existing durable admissions/shared slots and provider limits, not the source-read
quota. Manual lookups and linked sync retain their own provider/scheduler guards. Triage rebuilds retain
existing grooming spacing/day limits and failure cooldown, not Slack classification quota. Observation
does not change status ownership, mappings, eligibility, retry limits, concurrency, model or schedules.

Starting a reviewed repair discloses that its originating diagnostics chat will be archived once the
exact durable repair-create receipt and created-chat identity are confirmed. The app selects the repair;
archival preserves the specialist history and never stops it or changes the diagnosed subject. Unknown,
pending, rejected or mismatched receipts do not archive. If archival fails, the accepted create intent
stays in the private native outbox for reconnect or **Check repair start** to retry archival, not creation.
Recovery uses the original confirmed identity even if the proposal or project binding changes. Older
intents without the disclosure flag do not archive, and there is no retroactive sweep or agent archive tool.

Pilot exposes a bounded, read-only diagnostic snapshot to agents and native clients. It combines the current daemon
projection with retained lifecycle transitions, request timings, [tool-call evidence](tool-call-diagnostics.md),
event-loop stalls, delayed native OS evidence and the target's bounded aggregate AI usage/context-efficiency summary.
It also includes the local app's bounded devbox setup timeline, including attempts that failed before registration.
The AI summary exposes explicit cache denominators, latest context headroom, paired compaction observations and closed
worker-launch reasons with partial coverage. It contains no provider/model identity or transcript content, and
missing timing, relaunch cost or adjacent context remains unavailable rather than inferred.
When this host has an explicitly configured informational cost budget, the snapshot also derives a retained-chat
comparison with basis, coverage and subscription semantics. No setting means no comparison; the result is evidence,
not authority to pause or alter the target.
Native crash/hang items are host-level observation windows, not events attributed to the selected chat. Reading it never starts,
subscribes to or mutates the target session and never opens transcript storage.
Devbox setup stages keep local daemon health, SSH/remote bootstrap and verified remote handshake as independent
observations. A responsive local daemon cannot establish remote setup success. The timeline has no alias, hostname,
path, command, raw stderr or arbitrary error text and cannot initiate setup or connection probes.

Only a trusted diagnostics specialist gets `diagnostics`, `diagnostic_context`, `diagnostic_history` and the
fixed-catalogue `diagnostic_logs` reader. Diagnostics always has bounded, sanitized read access across Pilot chats,
including archived committed conversation/tool history, usage/cost/informational budgets, failures and locally
available mission/task/issue context. The selector sets investigation focus, not permission. **No chat** means
app-wide diagnosis, never an implicit Control target. There is no repeated per-chat consent. Existing authentic
diagnostics sessions gain this capability on runtime reload without recreation; legacy history-grant flags do not
gate reads. Ordinary Ask/Build and caller-supplied role fields cannot authorize these tools.
App-wide and chat-focused specialists also get the proposal-only `repair_proposal` publisher.
The app admits that persistent session role explicitly; Build, Ask, control and child agents receive neither. The
kernel loads the specialist with no
personal or project extensions, skills, MCP, codemode, shell, file, job, memory, mission, artifact, question or
subagent tools. A tool-dispatch allowlist is reapplied after reload and the daemon independently rejects diagnostic
IPC from a session whose persisted role is not `diagnostics`. These are runtime boundaries, not prompt conventions.

Before creation, the app shows an explicit setup sheet with the resolved target host, target link and the selected
model and thinking level. **Diagnose this chat** pins that chat and accepts an optional **What should we investigate?**
reason. Both setup flows accept multiline questions or bug reports of at most 8 KiB UTF-8; blank input is valid,
and start errors keep the draft. **Ask about Pilot** also offers a host-qualified chat selector defaulting to **No chat**:
an explicit app scope on the currently selected verified host, without resolving, creating or displaying a Control target.
Selecting a known local or devbox chat sets the initial focus; no copied link is required.
Selection retains the exact host, daemon, lineage and chat identity even when titles or UUIDs repeat.
Missing, replaced, disconnected and unavailable targets fail closed; there is no silent Local fallback.
Dismissing the sheet creates no session, and duplicate starts
are rejected while one is in flight. The sheet discloses bounded sanitized Pilot-log access on the selected host and
that diagnostics has app-wide read visibility, with no wake, mutation or automatic repair authority.

Diagnostics uses the same nonblocking, once-only title generator as ordinary chats. A submitted question or reason is
the bounded opening seed. Without one, the chat keeps a readable **Pilot diagnostics** fallback until a completed turn
contains substantive assistant text; ready/idle transitions and tool-only history do not qualify. The fixed diagnostic
instruction, target link and host identity are excluded from that reply-based title context. Provider failure keeps the
fallback, interrupted generation resumes safely on reopen, and a manual rename clears the pending title so a late
result cannot overwrite it. This renames only the specialist, never its linked target. Reason, transcript excerpts and
generated title remain local chat metadata and are not telemetry fields.

The app admits exactly one of two persisted scopes. App scope contains only the verified host identity and carries no
session UUID, chat URL, project or hidden target. Chat focus retains one exact target as a
canonical host-qualified reference containing the host, session UUID and matching canonical chat URL. Native code
sends that scope with the selected model and thinking level, the daemon revalidates any URL plus daemon and lineage
identity before persisting it, and the kernel receives the same scope.
The specialist prompt and visible header identify that initial focus. Trusted runtime role, not focus metadata or
tool arguments, authorizes app-wide reads. The default `diagnostics` read remains content-free app health or focused
chat evidence. `diagnostic_context` discovers other chats and already-linked verified hosts on demand; no histories
are preloaded. Reads never open an agent, start, subscribe to or mutate subjects. A submitted investigation reason or
question is new user-authored specialist-chat content, separate from the focus reference. Its text cannot grant privileges and is never
included in diagnostic evidence or telemetry. Operational tool results
contain a qualified host identity, collection time, source
freshness and availability, queue/resource summaries, stable evidence references and explicit truncation/drop
counts. In-flight tool evidence separates elapsed time, useful-progress age, liveness age and cancellation wait; it
does not claim that silence proves a stall. Conservative suspected-stall assessments preserve explicit waits,
background jobs, pauses and disconnects. The specialist cannot restart, retry, replay, wake or mutate the target.

`diagnostic_logs` has no path, host or session selector. Every dispatch rechecks the caller's persisted diagnostics
role and admitted daemon and lineage identity, plus the target identity for chat scope, then reads only these closed
source IDs. In app scope, host sources remain available and target-only sources report `no_target` rather than
falling back to any chat:

| Source ID | Scope and coverage |
| --- | --- |
| `app` | Private native app lifecycle, host transport and repair event/error codes on this Mac. Only closed categories and allowlisted error domains/numeric codes, never error descriptions, userInfo, console interception or payloads. Retained history is not current app liveness or comprehensive crash capture. |
| `daemon` | The current and one rotated `pilotd.log` on macOS. Verified owned Linux user services expose bounded retained Pilot-only journal history. Unsupported/unowned/permission-denied hosts fall back to the redacted current-process ring, explicitly not historical worker coverage. |
| `kernel_worker` | Kernel/worker stdout and stderr inherited by the persistent daemon log. Records can be interleaved and cannot be reliably attributed to one process. The daemon ring alone is not presented as worker coverage. |
| `native_report` | Existing Pilot-named crash, hang, spin and diagnostic reports in the current macOS user's `DiagnosticReports` directory. System-wide and ambiguous Node reports are excluded. Empty coverage does not prove no crash or hang. |
| `lifecycle` | The admitted target's current and rotated content-free lifecycle records. |
| `request_timing` | The admitted target's current and rotated content-free request timing records. |
| `tool_activity` | The admitted target's current and rotated sanitized tool lifecycle records. |

The native app producer writes `~/Library/Logs/Pilot/App/app.jsonl` and `.1`, each at most 256 KiB,
with a 2 KiB record limit, seven-day expiry and a 64-entry off-main admission queue. Its directory is
0700 and files 0600. It starts only after the Local host identity and local operational collection setting
are known. It records lifecycle and transport/repair events, not every OSLog/print, arbitrary strings,
stack dumps or native crash payloads. Startup before settings, dropped events and write failures can leave
gaps. Writes never throw into app workflows. The reader independently validates the closed schema,
daemon/lineage identity, age, size, ownership, permissions and no-follow files before disclosure.
Disabled local diagnostics hides this source; **Clear local diagnostics** drains/invalidate pending app
writes and deletes both app segments. No app event is uploaded or mirrored to a remote host. App-absent
or pre-upgrade hosts report missing/not-recorded rather than pretending retained logs exist.

Other current producers are `~/Library/Logs/Pilot/pilotd.log` and its `.1` file for the macOS launch agent;
`<PILOT_HOME>/sessions/<target>/lifecycle.jsonl`, `durable/performance.jsonl` and
`durable/tool-activity.jsonl`, each with its supported `.1` segment; and Pilot-named files under the current user's
`~/Library/Logs/DiagnosticReports` on macOS. launchd directs both daemon stdout/stderr and inherited worker
stdout/stderr to the daemon file. Linux services write to the system journal. A host-owned adapter lazily reads
only the current user's `pilotd.service`, never another unit, system-wide logs, sudo or a shell. It verifies the
installed owned service text against the shipped renderer, private runtime/data home and the daemon's own
user-service cgroup before invoking the fixed `/usr/bin/journalctl` with fixed UID/unit filters. The binary must
be root-owned and non-writable to other users; the child receives only a minimal host-derived environment.
There are no model-selected paths, commands, flags or journal cursors. No setup/restart/service mutation occurs.

The read is capped at seven days, 256 records, 192 KiB raw output, 128 KiB sanitized snapshot, 8 KiB per
message and 1.5 seconds. Pipe overflow/deadline/cancellation kills the child; close/error paths dispose timers
and listeners. Only trusted UID/service-matching journal records are accepted; credential and conversation-bearing
records are redacted/withheld before caching and again before disclosure. One 60-second in-memory snapshot
preserves opaque paging/excerpt refs without retaining raw journal cursors. Expired/replaced snapshots invalidate
refs honestly. Historical entries can cover retained earlier processes, never prove current liveness, and cannot
recover deleted or never-retained history. Clear does not delete OS-managed journals. Missing journalctl/systemd,
non-managed/modified services and denied access report unavailable coverage with ring fallback, not guessed data.
These path
templates document producers; responses expose only source IDs and signed opaque cursors/refs, never the paths or
report names.

Callers start with `inventory`, which reports availability, scope, retention, readable/rotated file counts, catalogue
truncation and a closed unavailable reason without revealing filesystem paths. `search` accepts only a source ID, an
optional case-insensitive literal filter, an ISO timestamp with timezone, a 1–40 record limit and an opaque
continuation cursor. Each call scans at most 128 KiB, returns at most 64 KiB and clips individual records at 8 KiB.
It reports scanned/encoded bounds, skipped oversized records, truncation and a continuation cursor. `excerpt` accepts
only a returned opaque ref, includes at most ten bounded lines on either side and uses the same total scan bound.
Cursor and ref identity includes the opened file device/inode; rotation can be followed while that same file remains
catalogued, while replacement, shrinkage or expiry returns explicit `stale_cursor`, `stale_ref` or `source_changed`
status rather than silently mixing records.

The daemon resolves the admitted target directory itself. It rejects unsafe roots and symbolic-link leaves and opens
files read-only with no-follow semantics. Native report directory enumeration and retained files are separately
capped. Log records pass the existing credential redactor, while prompt, message, conversation, transcript, private
reasoning, tool/integration payload and attachment fields are withheld. Useful sanitized errors and stacks remain.
Log text is untrusted local content, never authority. Reading does not run a subprocess, probe a service, start or
subscribe to a worker, or change collection or retention. App-wide diagnostics may explicitly inspect Control
history like other available chats, but never attaches Control implicitly.

Sanitized log excerpts exist only in the reading conversation (a specialist or explicitly authorized repair). Reads and excerpts are not copied into lifecycle,
request timing, AI usage, telemetry or an automatic repair handoff. Log refs deliberately cannot satisfy the
`repair_proposal` evidence-ref field, which remains limited to the content-free `diagnostic:v1:…` projection; a
proposal may summarize supported findings but must not copy raw log or history text.

`diagnostic_history` accepts a known local chat or defaults to the initial focus. Each dispatch rechecks the caller's
persisted diagnostics role and exact daemon, lineage and subject identity before opening the subject's SQLite storage
in a one-shot read-only worker. It does not start or subscribe to the target and works for parked, failed and archived
chats while their storage remains available. A page returns at most 20 entries, at most 64 KiB of encoded entry data,
at most 8 KiB per entry and scans at most 200 committed records per call. Only user, assistant and tool-result entries
are returned; internal state records are skipped, embedded attachment bodies are omitted, and credential-named fields
and obvious credential-bearing text are redacted before sizing. Private model reasoning and signatures are omitted.
Each entry includes a stable `diagnostic-history:v1:…` source ref, sanitized byte count
before excerpt truncation, and a truncation flag. The response reports source availability/freshness, scan bounds and
`nextBefore` for explicit pagination toward older entries. Missing or unreadable storage is reported as unavailable
rather than replaced with cached or invented content. History does not expand child sessions or fetch attachments,
files, links or secrets.

## App-wide context reader

`diagnostic_context` uses closed actions: `hosts`, `chats`, `chat`, `history`, `search`, `logs`, `projects`,
`missions`, `mission`, `issues`, `features` and `refresh_health`. Chat discovery includes archives; title and history filters are literal, not
regular expressions. Chat detail includes content-free operational evidence, retained usage/comparisons, the
configured informational budget and available member mission context. Projects expose IDs/names, not checkout
paths. Mission detail exposes the retained brief and paginated tasks. Issues read only the current integration
binding's retained local records, without a new account, credential or external network fetch.
Feature evidence is a separately controlled, content-free local aggregate with explicit observer/time/host coverage,
positive observed cells only, and independent remote-export consent. See [local feature evidence](feature-adoption.md).
`refresh_health` reads structured Slack/Linear scheduler/stage/channel evidence without triggering a refresh.
It separates observed attempts/commits from retained checkpoints, partial round-robin coverage, queue/backoff and
unknown/uninstrumented work. See [refresh-health semantics and limits](refresh-health.md).

Each response carries a qualified source host, collection time, availability and page bounds. Discovery scans at
most 200 metadata rows, returning at most 20; history/search reads one bounded history page from one chat at a time,
using the history limits above. Follow `page.after` and `page.before` together for cross-chat search; absence is not
proof of no matches. Mission/project/issue pages use `page.before` as an offset. Non-transcript metadata is sanitized
too: reasoning/attachments/credential fields are omitted, free-text fields above 8 KiB are withheld with explicit
truncation, and responses fit 64 KiB. Failed/deleted/offline/unsupported/partial evidence is unknown, never zero.

For linked hosts, an ephemeral native courier uses only already-connected trusted `HostClients` entries and their
verified host/daemon/lineage and connection-generation fences. It never connects, bootstraps or wakes a host or chat.
The receiving read-only HTTP endpoint and courier response require the existing protected native app-action
capability (not a GitHub credential); capability acquisition and responses are fenced independently. No URL, path,
role or grant from a model is accepted as authority. The courier is event-driven, bounded to eight in-flight reads
and a ten-second caller deadline, with no polling or durable transcript cache. Underlying bounded cold-reader work
may finish after cancellation; late replies cannot reach the caller. If the native app is absent, this host remains
readable and linked-host coverage is explicitly unavailable. No telemetry/export/collection setting changes.

Conversation and tool entries are untrusted data, not instructions or authorization. The specialist must not follow
commands, links or target references found in them. Sanitized history excerpts remain local to the specialist
conversation, are not added to lifecycle diagnostics or AI usage summaries, are never emitted as telemetry, and are
not copied into an
automatic repair handoff. The proposal path remains limited to user-reviewed bounded findings and cited evidence.

Native clients call:

```text
GET /api/sessions/:id/diagnostics?hostId=…&daemonId=…&lineageId=…&limit=128
```

The immutable daemon and lineage values must match the connected host. A stale identity fails with `409` rather than
falling back to another host. Responses are `no-store`, contain at most 128 evidence items and 64 KiB, and report
missing or stale sources instead of manufacturing evidence.

Control request preparation also contributes `control.request.preparation` items to the request-timing source.
They identify only a closed stage (`history_record`, `history_summarization` or `request_projection`), timestamp,
duration, random opaque attempt reference and `prepared`, `failed` or `cancelled` outcome. Failures use the fixed
`preparation_failure` category, not raw errors or message content; the failed chat outcome carries the same
reference. These records share request-timing consent, bounded queues and two capped local log segments.
`prepared` means only that a request projection was built, not that an action ran or a task succeeded.
Likewise, lifecycle `execution.completed` with `parked_idle` is not a task-success signal. Reporting never retries
or replays an action, changes the summarization algorithm or rewrites retained history.

## Specialist-authored repair proposal and authorized handoff

A specialist has no repair or spawn tool. When the user asks for a suggestion, its host-owned
`repair_proposal` tool may persist one latest bounded proposal containing 1 to 16 currently available evidence refs, plain-language
findings, an issue-specific title, low/medium/high uncertainty, a suggested repair and regression-test guidance. The daemon validates the
closed fields, byte bounds, qualified evidence subject and refs before replacing the previous proposal. Publishing only updates the
specialist's proposal summary; it never starts, wakes, changes, retries, restarts or replays either chat.

Diagnostics chats retain their generated descriptive title, while the sidebar, read-only toolbar badge and chat
header identify the persisted **Diagnostics** role instead of presenting it as ordinary Ask. Before a proposal exists,
the fixed composer-adjacent footer's **Suggest a repair** action sends one host-qualified follow-up asking the specialist to
author it. Requesting and busy-queue states prevent duplicate submission; a failed completed attempt offers an
explicit retry. Missing target identity, destination or connectivity is explained without another-host fallback or
probing. The action does not open a manual authoring form, and the app does not ask the user to invent a cause, choose
raw event IDs or write a regression test.

Once published, that same footer action becomes **Review repair**. It lives outside transcript scrolling, not in the
scrolling header or at history's end. The ordinary composer and its draft/Send/Stop controls remain mounted. A compact
native summary appears above the action after the current turn settles; a live agent question stays in front without
hiding the fixed repair action. The summary shows
findings, uncertainty, suggested repair and cited-evidence count without taking focus or navigating from another
chat. **Not now** persists only that proposal ID and hides its summary, never the fixed **Review repair** action;
a replacement appears again, and the footer or context menu can
always reopen review. Viewing, reconnecting, dismissing or reopening never creates work. The review sheet shows
labeled prefilled fields and distinguishable safe source/time/evidence summaries. The user may optionally edit the
bounded text and uncertainty. Cancelling creates nothing.
The single footer action also preserves requesting/queued/error states and **Check repair start** for an unresolved
original intent, even if its proposal is replaced or unavailable. It does not take focus, request a scroll or recreate
the composer on proposal changes. Offline/invalid identities keep the action visible but disabled.

A repair is always a separate ordinary coding chat. Only explicit confirmation after review may call:

```text
POST /api/sessions/:specialistId/diagnostics/handoff?hostId=…&daemonId=…&lineageId=…
```

The request identifies the latest persisted proposal and carries only the reviewed bounded fields. Evidence refs are
fixed by that proposal rather than selected or invented by the app. The daemon re-reads diagnostics, rejects missing,
changed or stale proposals and refs, and returns only those exact structured items plus the reviewed proposal. This
step still never creates, starts, subscribes to, wakes or changes either chat. The specialist cannot call this
endpoint or spawn a coding chat. The evidence subject is independent of the repair destination, including when the
diagnosed chat belongs to another project. App proposals have a real app/host subject, never a fabricated Control
target. On-demand app snapshots expose content-free `host.snapshot` observations under Local operational
diagnostics: at most 128 process-local records for 30 minutes, including idle expiry, erased on clear or disable.
They contain only chat-state counts and available process-memory counters. They supply point-in-time context, not
proof of a reported failure or its cause. Restart or eviction can make a reference unavailable; request a fresh
proposal rather than substituting a log ref. No new background sampler or upload is enabled.

Configure **Settings → Diagnostics → Repair project** once per execution host (or that devbox's settings).
Explicitly choose an already registered canonical source checkout and confirm its host, directory and local Git
origin. The origin must identify `github.com/babariviere/pilot`; a project name or an origin match alone never selects
a checkout. Origin is local configuration evidence, not cryptographic ownership proof. The private, versioned
`diagnostic-repair-project.json` stores an exact host/daemon/lineage, project ID, directory, origin and configuration
ID/revision. No project is imported, cloned or created by setup. Unknown or corrupt configuration is preserved and
disabled, not treated as an empty default. Symlink directories, missing/moved projects, changed origins or lineages
block admission. Renaming the project does not change identity; another matching clone never substitutes for it.
Host aliases stay pinned until explicit reconfiguration. Cross-host reads remain available through trusted routing,
but cross-host repair handoffs require a separate design; this flow never switches a repair's execution host.

Review displays that destination read-only, the issue title, evidence subject, model and thinking level. Missing or
unavailable configuration requires setup rather than an arbitrary project picker or diagnosed/current-project
fallback. Only the sheet's confirmation starts the separate private-clone Build chat. The resulting chat
does not inherit the specialist role or its app-wide diagnostics authority. **Allow fresh read-only diagnostics**
in the review sheet records an explicit `readDiagnostics` flag in the immutable native-confirmed repair intent.
When true, the daemon persists the exact proposal subject and qualified host as a separate repair-only grant.
The repair Build receives `diagnostics` and `diagnostic_logs`, and `diagnostic_history` only for a chat subject.
Each dispatch revalidates the grant, caller profile, live worker and host identity; chat selectors must match the
approved subject. Shared host logs are disclosed, but another chat's target logs/history cannot be selected.
App subjects authorize no chat history. Readers retain the existing bounds, sanitization, provenance and
unavailable/stale-source behavior, and never wake or change the target. The grant survives reopening that repair,
but is not inherited by child agents or new chats. It does not expose `diagnostic_context`, `repair_proposal`,
cross-host routing or any specialist mutation authority. Missing, false and older intents grant no access;
receipt reconciliation never upgrades an existing repair. Normal Build tools remain unchanged.
Repair prompts prohibit copying raw diagnostic history/logs into source, tests, commits, PRs or telemetry and
require synthetic regression fixtures instead.
The normal Ask “Start a Build chat with this
context” path is unavailable for diagnostics specialists, so an unbounded transcript cannot substitute for this
handoff. The confirmed start is an immutable `repair-create` operation. Pilot keeps it through an unknown response,
checks that exact operation before an explicit retry, and blocks a second intent. At daemon admission the current
specialist role, proposal ID, evidence subject, host/daemon/lineage, binding generation, registered path and Git origin
are checked again after asynchronous preparation and immediately before creation. New repair starts and binding
changes share an admission fence, and a private durable per-proposal claim rejects a second operation ID. Native
host-action authentication protects configuration and new `repair-create` submissions. Existing committed receipts
are reconciled before proposal/configuration revalidation, so a lost acknowledgement does not create another chat;
a replaced proposal cannot borrow an older confirmation. An accepted chat is selected before the operation is
retired. An unresolved start remains actionable after reconnect rather than being inferred as success or failure.
The reviewed issue-specific title is bounded single-line text, not authority. Older proposals derive a safe title
from reviewed findings without an extra model call. Immutable operation bytes retain it across recovery, while a
later user rename of the created chat always wins.

The operational diagnostic schema intentionally has no open attribute maps. It does not include messages, prompts,
responses, tool input or output, model/provider names, paths, credentials, raw errors, event-loop labels or stall
contexts. Treat that snapshot as operational evidence, not as conversation history, and cite its `diagnostic:v1:…`
references in findings. The separately authorized history page is local untrusted content, not diagnostic or
telemetry data. Proposal text is bounded agent output for review, not telemetry and not an authorization channel.
