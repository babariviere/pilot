# Chat-open tracing

Pilot traces the latency from selecting a chat through publishing its first prepared transcript. The journey is
named `pilot.chat.open` and uses only the reviewed, content-free telemetry attributes.

## Boundaries

- The app starts the root at chat view construction, before cached rows can be evaluated by SwiftUI.
- A warm open finishes when the cached transcript view appears. It does not wait for a network refresh.
- A cold open propagates one W3C `traceparent` on the first dedicated WebSocket handshake. Reconnects do not reuse
  that context.
- The daemon records `api` and `history_read`. A history read is cold when no kernel worker owns the transcript.
- The app records `reduction`, `publication`, and `first_transcript` for the first snapshot or terminal failure.

`first_transcript` observes SwiftUI model publication, not a Core Animation frame. It therefore reports
`pilot.frame_observation=unsupported`; it must not be interpreted as pixels displayed to a person.

## Interpretation

Compare release distributions by `pilot.phase`, `pilot.cold`, and the closed `pilot.history_bucket` values (`0`,
`1-100`, `101-1000`, `1001+`). Warm opens can legitimately omit API, history, and reduction spans because the
cached transcript was already the first visible result. A resumed WebSocket can record a warm history replay, but
the reconnect is not a new root journey.

Missing milestones mean **not observed**, never zero latency. Leaving the chat, losing the host, sleep, or a failed
subscription can end unfinished spans as cancelled, unavailable, or failed. Empty chats still complete after the
empty snapshot is published.

No transcript content, titles, session IDs, paths, URLs, errors, socket payloads, or host identities are attached.
Only entry-count buckets cross the telemetry boundary. The exact count added to the local snapshot envelope is used
for bucketing in memory and is not itself exported.
