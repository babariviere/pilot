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

Only an on-demand diagnostics specialist gets the `diagnostics` reader and proposal-only `repair_proposal` publisher.
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
are rejected while one is in flight. The sheet discloses whether the specialist receives operational evidence only,
or bounded conversation and tool history for the exact linked chat.

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
the review sheet shows labeled prefilled fields and distinguishable safe source/time/evidence summaries. The user may
optionally edit the bounded text and uncertainty. Cancelling creates nothing.

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
handoff.

The operational diagnostic schema intentionally has no open attribute maps. It does not include messages, prompts,
responses, tool input or output, model/provider names, paths, credentials, raw errors, event-loop labels or stall
contexts. Treat that snapshot as operational evidence, not as conversation history, and cite its `diagnostic:v1:…`
references in findings. The separately authorized history page is local untrusted content, not diagnostic or
telemetry data. Proposal text is bounded agent output for review, not telemetry and not an authorization channel.
