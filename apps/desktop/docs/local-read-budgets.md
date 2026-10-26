# Local read envelopes

`local_client.rs` uses route-specific response budgets, not a blanket 4 MiB
viewer gate:

| Read | Wire budget | Contract |
| --- | --- | --- |
| `/api/hello` | 4 MiB, unchanged | daemon/lineage/protocol pin |
| `/api/sessions/:id/history?before=…&limit=24` | 64 MiB | existing cursor page, oldest first, `more` |
| `/api/sessions/:owner/artifacts/:id?revision=…` | 44 MiB | exact owner/id/revision, including unknown-kind pins |

Known image artifacts keep their existing specialized 44 MiB path, which skips
redundant prepared HTML when deserializing. Unknown-kind pins can also resolve
to images, so their JSON envelope must not use the former 4 MiB gate. Artifact
kind/provenance validation and source/decode/pixel budgets remain downstream.
This does not enable rendering legacy HTML.

## Source audit

- `ReadRoute` has only hello, history and artifact variants. Session/project
  summaries and active transcript snapshots arrive over WebSockets, not this
  HTTP helper. Their 8 MiB frame policy is unchanged.
- `server.ts` history accepts an entry-count limit (up to 500); the client
  continues requesting 24. `SessionHistoryPage` contains full `EntryRecord[]`
  and `more`, including inline base64 image blocks in `entry.model`.
- `snapshot.ts::readEarlierEntries` checks its 4 MiB **soft** byte stop before
  adding the next entry, after previous entries have already crossed it.
  It always returns at least one entry, whatever that entry's size. JSON
  envelope overhead also adds bytes. A hard 4 MiB client gate therefore
  rejects valid pages; changing only the entry-count limit cannot fix this.
- Artifact publication allows 16 MiB decoded image sources, base64 on the wire,
  with redundant source/prepared HTML in existing revision envelopes. Even a
  pin whose kind is not yet known needs image-envelope headroom.

This is source/synthetic evidence, not reproduction of the user's actual
payload. No real profile content was inspected or changed.

## Remaining boundary

64 MiB is a finite client memory-safety budget, **not** a daemon-guaranteed
maximum. The current history API has no hard single-entry byte bound or way to
page inside one entry. Larger pages still return a truthful budget error, never
truncated JSON, false success or a skipped cursor. Supporting arbitrarily large
single entries with bounded client memory requires a separate backend contract
or streaming projection change. There is no new user action-count limit or
adaptive retry/paging state machine.

Both declared lengths and accumulated chunks are checked before growth, using
fallible bounded reservation. Redirect refusal, loopback scope, timeouts and
generation/epoch fences remain. History now checks hello identity before and
after fetching, just like artifact reads. Mutation, file, sandbox and image
decoder limits are unchanged.

## Focused verification

From `apps/desktop`:

```sh
python3 scripts/check-scoped.py --unit local_client --native-probes --lint
```

This covers faux HTTP length/chunked >4 MiB history pages with embedded images,
ordinary hello/history, malformed/interrupted responses, route-specific budgets,
identity changes before/after reads, artifact pins and existing socket paging,
switch-generation and cancellation tests. Matching production Clippy/build uses
the shared verification slot, CPU2/4GiB wrapper and private outputs. No live
actions, app launch or performance/visual acceptance is implied.
