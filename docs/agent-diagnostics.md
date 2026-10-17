# Agent diagnostics

Pilot exposes a bounded, read-only diagnostic snapshot to agents and native clients. It combines the current daemon
projection with retained lifecycle transitions, request timings, [tool-call evidence](tool-call-diagnostics.md),
event-loop stalls and delayed native OS evidence.
Native crash/hang items are host-level observation windows, not events attributed to the selected chat. Reading it never starts,
subscribes to or mutates the target session and never opens transcript storage.

Only an on-demand diagnostics specialist gets the `diagnostics` tool. The app admits that persistent session role
explicitly; Build, Ask, control and child agents do not receive the tool. The kernel loads the specialist with no
personal or project extensions, skills, MCP, codemode, shell, file, job, memory, mission, artifact, question or
subagent tools. A tool-dispatch allowlist is reapplied after reload and the daemon independently rejects diagnostic
IPC from a session whose persisted role is not `diagnostics`. These are runtime boundaries, not prompt conventions.

The app admits one exact target chat when it creates the specialist. The tool has no target selector, and the daemon
rejects every other ID even when another chat shares the project. This lets project-less and control-chat
diagnostics keep the same qualified-host boundary. Tool results contain a qualified host identity, collection time, source
freshness and availability, queue/resource summaries, stable evidence references and explicit truncation/drop
counts. In-flight tool evidence separates elapsed time, useful-progress age, liveness age and cancellation wait; it
does not claim that silence proves a stall. The specialist cannot restart, retry, replay, wake or mutate the target.

Native clients call:

```text
GET /api/sessions/:id/diagnostics?hostId=…&daemonId=…&lineageId=…&limit=128
```

The immutable daemon and lineage values must match the connected host. A stale identity fails with `409` rather than
falling back to another host. Responses are `no-store`, contain at most 128 evidence items and 64 KiB, and report
missing or stale sources instead of manufacturing evidence.

## Authorized repair handoff

A repair is a separate ordinary coding chat. After reviewing a diagnosis, an explicit app action may call:

```text
POST /api/sessions/:specialistId/diagnostics/handoff?hostId=…&daemonId=…&lineageId=…
```

The request selects 1 to 16 evidence refs from the admitted target and supplies bounded likely-cause and
regression-test guidance. The daemon re-reads local diagnostics and returns only those exact structured evidence
items plus the two bounded guidance fields. It rejects stale or invented refs. Preparing the handoff never creates,
starts, subscribes to, wakes or changes either chat. The specialist cannot call this endpoint as a tool; the app
must obtain user authorization and pass the returned material when it separately creates the coding chat. Pilot's
repair sheet makes that selection explicit and states that the action does not retry, restart, replay or change the
diagnosed chat. The resulting chat
does not inherit the specialist role or diagnostics authority. The normal Ask “Start a Build chat with this
context” path is unavailable for diagnostics specialists, so an unbounded transcript cannot substitute for this
handoff.

The schema intentionally has no open attribute maps. It does not include messages, prompts, responses, tool input or
output, model/provider names, paths, credentials, raw errors, event-loop labels or stall contexts. Treat a snapshot as
operational evidence, not as conversation history, and cite its `diagnostic:v1:…` references in findings.
