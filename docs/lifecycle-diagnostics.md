# Local lifecycle diagnostics

Pilot keeps a small content-free lifecycle timeline beside each session's metadata. It complements, rather than
duplicates, [kernel request timings](request-timings.md) and the daemon's
[event-loop/request diagnostics](daemon-stalls.md).

## Location and bounds

The current and preceding segments are:

```text
~/.local/share/pilot/sessions/<session-id>/lifecycle.jsonl
~/.local/share/pilot/sessions/<session-id>/lifecycle.jsonl.1
```

Each owner-only segment is capped at 256 KiB, each event at 1 KiB, and a session can queue at most 64 writes. The
daemon uses one asynchronous writer for all sessions. Overload drops evidence instead of blocking admission or UI
requests; a later event reports `droppedBefore`. A bad or symlinked path disables only that session's writer.
Parking leaves the files in place and never wakes a worker. Deleting a session removes the timeline with the rest of
its private storage.

## Contents

Version 1 records reviewed enums for worker startup/parking, execution start/completion, sleep/update/user pause
changes, subscription quota holds, connectivity holds and crash recovery. Events contain an opaque local evidence
ID, UTC timestamp, numeric Pilot release and local/devbox kind. They never contain titles, prompts, transcript rows,
models, provider text, tool activity, paths, URLs, errors or stacks.

The daemon records transitions from the same authoritative state projection used by clients. The timeline does not
control state and does not infer a root cause. For example, `process_exit` says that a worker exit initiated recovery;
it does not claim why the process exited. Missing events can mean rotation, overload, I/O failure or process death
before the asynchronous write.

The versioned schema, retention and privacy rules are in the
[diagnostics and telemetry contract](telemetry-contract.md#local-diagnostic-schema-v1).
