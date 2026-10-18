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
The app admits that persistent session role explicitly; Build, Ask, control and child agents receive neither. The
kernel loads the specialist with no
personal or project extensions, skills, MCP, codemode, shell, file, job, memory, mission, artifact, question or
subagent tools. A tool-dispatch allowlist is reapplied after reload and the daemon independently rejects diagnostic
IPC from a session whose persisted role is not `diagnostics`. These are runtime boundaries, not prompt conventions.

Before creation, the app shows an explicit setup sheet with the resolved target host, target link and the selected
model and thinking level. **Diagnose this chat** pins that chat. **Ask about Pilot** defaults to the selected host's
control chat and can resolve a pasted `pilot://chat/<UUID>` only when exactly one already-known local or hosted chat
matches. Malformed, missing, ambiguous, disconnected and unavailable targets fail closed; there is no silent Local
fallback. Dismissing the sheet creates no session.

The app admits one exact target as a canonical host-qualified reference containing the host, session UUID and
matching canonical chat URL. Native code sends that reference with the selected model and thinking level, the daemon
revalidates the URL plus daemon and lineage identity before persisting it, and the kernel receives the same reference.
The specialist prompt and visible header identify that admitted scope, while the host-owned tool always makes its
first and every later read for the persisted session UUID. The model has no target selector, and the daemon rejects
every other ID even when another chat shares the project. This lets project-less and control-chat diagnostics keep
the same qualified-host boundary. The link is authority to bounded operational diagnostics only: no title, path,
message or transcript is copied into the request, and no transcript or cold-reader access occurs. Tool results
contain a qualified host identity, collection time, source
freshness and availability, queue/resource summaries, stable evidence references and explicit truncation/drop
counts. In-flight tool evidence separates elapsed time, useful-progress age, liveness age and cancellation wait; it
does not claim that silence proves a stall. Conservative suspected-stall assessments preserve explicit waits,
background jobs, pauses and disconnects. The specialist cannot restart, retry, replay, wake or mutate the target.

Native clients call:

```text
GET /api/sessions/:id/diagnostics?hostId=…&daemonId=…&lineageId=…&limit=128
```

The immutable daemon and lineage values must match the connected host. A stale identity fails with `409` rather than
falling back to another host. Responses are `no-store`, contain at most 128 evidence items and 64 KiB, and report
missing or stale sources instead of manufacturing evidence.

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

The schema intentionally has no open attribute maps. It does not include messages, prompts, responses, tool input or
output, model/provider names, paths, credentials, raw errors, event-loop labels or stall contexts. Treat a snapshot as
operational evidence, not as conversation history, and cite its `diagnostic:v1:…` references in findings. Proposal
text is bounded agent output for review, not telemetry and not an authorization channel.
