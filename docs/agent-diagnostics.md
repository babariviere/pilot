# Agent diagnostics

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

Only an on-demand diagnostics specialist gets the `diagnostics` reader, fixed-catalogue `diagnostic_logs` reader and
proposal-only `repair_proposal` publisher.
When the user selected **Diagnose this chat** or supplied a nonblank chat link, that specialist also gets
`diagnostic_history`. Generic no-link **Ask about Pilot** sessions do not. This is a separately persisted native grant;
missing legacy metadata denies history access.
The app admits that persistent session role explicitly; Build, Ask, control and child agents receive neither. The
kernel loads the specialist with no
personal or project extensions, skills, MCP, codemode, shell, file, job, memory, mission, artifact, question or
subagent tools. A tool-dispatch allowlist is reapplied after reload and the daemon independently rejects diagnostic
IPC from a session whose persisted role is not `diagnostics`. These are runtime boundaries, not prompt conventions.

Before creation, the app shows an explicit setup sheet with the resolved target host, target link and the selected
model and thinking level. **Diagnose this chat** pins that chat. **Ask about Pilot** also accepts an optional multiline
question or bug report of at most 8 KiB UTF-8. Its chat link is optional: blank selects the explicit control target on
the currently selected verified host, while a supplied `pilot://chat/<UUID>` resolves only when exactly one
already-known local or hosted chat matches. Malformed, missing, ambiguous, disconnected and unavailable supplied
targets fail closed; there is no silent Local fallback. Dismissing the sheet creates no session, and duplicate starts
are rejected while one is in flight. The sheet discloses bounded sanitized Pilot-log access on the selected host and
whether the specialist additionally receives conversation and tool history for the exact linked chat.

Diagnostics uses the same nonblocking, once-only title generator as ordinary chats. A submitted question or reason is
the bounded opening seed. Without one, the chat keeps a readable **Pilot diagnostics** fallback until a completed turn
contains substantive assistant text; ready/idle transitions and tool-only history do not qualify. The fixed diagnostic
instruction, target link and host identity are excluded from that reply-based title context. Provider failure keeps the
fallback, interrupted generation resumes safely on reopen, and a manual rename clears the pending title so a late
result cannot overwrite it. This renames only the specialist, never its linked target. Reason, transcript excerpts and
generated title remain local chat metadata and are not telemetry fields.

The app admits one exact target as a canonical host-qualified reference containing the host, session UUID and
matching canonical chat URL. Native code sends that reference with the selected model and thinking level, the daemon
revalidates the URL plus daemon and lineage identity before persisting it, and the kernel receives the same reference.
The specialist prompt and visible header identify that admitted scope, while the host-owned tool always makes its
first and every later read for the persisted session UUID. The model has no target selector, and the daemon rejects
every other ID even when another chat shares the project. This lets project-less and control-chat diagnostics keep
the same qualified-host boundary. **Diagnose this chat** and a supplied link explicitly authorize a separate bounded
cold read of committed conversation and tool entries for that exact target. A blank Ask about Pilot link does not
authorize the Control transcript. An Ask about Pilot question is new user-authored specialist-chat content, separate
from that immutable target reference. Its text cannot grant or widen transcript, tool or target access and is never
included in diagnostic evidence or telemetry. Operational tool results
contain a qualified host identity, collection time, source
freshness and availability, queue/resource summaries, stable evidence references and explicit truncation/drop
counts. In-flight tool evidence separates elapsed time, useful-progress age, liveness age and cancellation wait; it
does not claim that silence proves a stall. Conservative suspected-stall assessments preserve explicit waits,
background jobs, pauses and disconnects. The specialist cannot restart, retry, replay, wake or mutate the target.

`diagnostic_logs` has no path, host or session selector. Every dispatch rechecks the caller's persisted diagnostics
role and admitted daemon, lineage and target identity, then reads only these closed source IDs:

| Source ID | Scope and coverage |
| --- | --- |
| `app` | Native app text logs. Pilot does not currently retain a searchable app text log, so this is explicitly unavailable. |
| `daemon` | The current and one rotated `pilotd.log` on macOS. Other hosts expose only the redacted current-process ring when no safe persistent file exists; journal history is explicitly unavailable because the reader never runs a shell. |
| `kernel_worker` | Kernel/worker stdout and stderr inherited by the persistent daemon log. Records can be interleaved and cannot be reliably attributed to one process. The daemon ring alone is not presented as worker coverage. |
| `native_report` | Existing Pilot-named crash, hang, spin and diagnostic reports in the current macOS user's `DiagnosticReports` directory. System-wide and ambiguous Node reports are excluded. Empty coverage does not prove no crash or hang. |
| `lifecycle` | The admitted target's current and rotated content-free lifecycle records. |
| `request_timing` | The admitted target's current and rotated content-free request timing records. |
| `tool_activity` | The admitted target's current and rotated sanitized tool lifecycle records. |

The current producers are `~/Library/Logs/Pilot/pilotd.log` and its `.1` file for the macOS launch agent;
`<PILOT_HOME>/sessions/<target>/lifecycle.jsonl`, `durable/performance.jsonl` and
`durable/tool-activity.jsonl`, each with its supported `.1` segment; and Pilot-named files under the current user's
`~/Library/Logs/DiagnosticReports` on macOS. launchd directs both daemon stdout/stderr and inherited worker
stdout/stderr to the daemon file. Linux services currently write to the system journal, which this no-subprocess
reader deliberately does not query, so only pilotd's bounded redacted process ring is available there. These path
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
subscribe to a worker, change collection or retention, or read the Control transcript. Generic no-link **Ask about
Pilot** may read this selected-host log catalogue but still has no `diagnostic_history` tool.

Sanitized log excerpts exist only in the specialist conversation. Reads and excerpts are not copied into lifecycle,
request timing, AI usage, telemetry or an automatic repair handoff. Log refs deliberately cannot satisfy the
`repair_proposal` evidence-ref field, which remains limited to the content-free `diagnostic:v1:…` projection; a
proposal may summarize supported findings but must not copy raw log or history text.

`diagnostic_history` has no session selector. Each dispatch rechecks the caller's persisted diagnostics role, the
explicit history grant and the exact daemon, lineage and session identity before opening the target's SQLite storage
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

A specialist has no repair or spawn tool. When the user asks for a suggestion, its host-owned `repair_proposal` tool
may persist one latest bounded proposal containing 1 to 16 currently available evidence refs, plain-language
findings, low/medium/high uncertainty, a suggested repair and regression-test guidance. The daemon validates the
closed fields, byte bounds, target and refs before replacing the previous proposal. Publishing only updates the
specialist's proposal summary; it never starts, wakes, changes, retries, restarts or replays either chat.

Before a proposal exists, the app explains that the diagnostic agent must author it and offers a non-executing
request. It does not ask the user to invent a cause, choose raw event IDs or write a regression test. Once published,
the specialist chat replaces its ordinary composer with a native proposal tray after the current turn settles. A
live agent question stays in front. The tray summarizes findings, uncertainty, suggested repair and cited-evidence
count without taking focus or navigating from another chat. **Not now** persists only that proposal ID; a replacement
appears again, and the context menu can always reopen review. Viewing, reconnecting, dismissing or reopening never
creates work. The review sheet shows labeled prefilled fields and distinguishable safe source/time/evidence summaries.
The user may optionally edit the bounded text and uncertainty. Cancelling creates nothing.

A repair is always a separate ordinary coding chat. Only explicit confirmation after review may call:

```text
POST /api/sessions/:specialistId/diagnostics/handoff?hostId=…&daemonId=…&lineageId=…
```

The request identifies the latest persisted proposal and carries only the reviewed bounded fields. Evidence refs are
fixed by that proposal rather than selected or invented by the app. The daemon re-reads diagnostics, rejects missing,
changed or stale proposals and refs, and returns only those exact structured items plus the reviewed proposal. This
step still never creates, starts, subscribes to, wakes or changes either chat. The specialist cannot call this
endpoint or spawn a coding chat. For a projectless app/control diagnosis, the user must explicitly choose an
available project on the same host; Pilot never treats a control or specialist working directory as a repair
destination. Only the sheet's confirmation starts the separate Build chat. The resulting chat
does not inherit the specialist role or diagnostics authority. The normal Ask “Start a Build chat with this
context” path is unavailable for diagnostics specialists, so an unbounded transcript cannot substitute for this
handoff. The confirmed start is an immutable `repair-create` operation. Pilot keeps it through an unknown response,
checks that exact operation before an explicit retry, and blocks a second intent. At daemon admission the current
specialist role, proposal ID, host/daemon/lineage and admitted target are checked again immediately before creation;
a replaced proposal cannot borrow an older confirmation. An accepted chat is selected before the operation is
retired. An unresolved start remains actionable after reconnect rather than being inferred as success or failure.

The operational diagnostic schema intentionally has no open attribute maps. It does not include messages, prompts,
responses, tool input or output, model/provider names, paths, credentials, raw errors, event-loop labels or stall
contexts. Treat that snapshot as operational evidence, not as conversation history, and cite its `diagnostic:v1:…`
references in findings. The separately authorized history page is local untrusted content, not diagnostic or
telemetry data. Proposal text is bounded agent output for review, not telemetry and not an authorization channel.
