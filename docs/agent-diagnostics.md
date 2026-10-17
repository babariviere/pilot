# Agent diagnostics

Pilot exposes a bounded, read-only diagnostic snapshot to agents and native clients. It combines the current daemon
projection with retained lifecycle transitions, request timings and event-loop stalls. Reading it never starts,
subscribes to or mutates the target session and never opens transcript storage.

Agents use the `diagnostics` tool. Omitting `sessionId` selects the current chat. A non-control chat may inspect only
itself or another chat in the same project on the same host; the control chat may select any local session. Tool
results contain a qualified host identity, collection time, source freshness and availability, queue/resource
summaries, stable evidence references and explicit truncation/drop counts.

Native clients call:

```text
GET /api/sessions/:id/diagnostics?hostId=…&daemonId=…&lineageId=…&limit=128
```

The immutable daemon and lineage values must match the connected host. A stale identity fails with `409` rather than
falling back to another host. Responses are `no-store`, contain at most 128 evidence items and 64 KiB, and report
missing or stale sources instead of manufacturing evidence.

The schema intentionally has no open attribute maps. It does not include messages, prompts, responses, tool input or
output, model/provider names, paths, credentials, raw errors, event-loop labels or stall contexts. Treat a snapshot as
operational evidence, not as conversation history, and cite its `diagnostic:v1:…` references in findings.
