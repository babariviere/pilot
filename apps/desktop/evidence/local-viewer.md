# Pilot Next, read-only Local viewer

2026-10-21. Evidence captured before the first source checkpoint, renamed from
`apps/gpui-fixture` to `apps/desktop` at the user's request. Product: Pilot Next;
Rust package/binary: `pilot-desktop`. Production Swift, daemon, packaging,
services and canonical data formats are unchanged. Publication status is recorded
in the README; the observations below predate the draft source-backup PR.

## Reviewed contract and authority

Reviewed current checked-out and installed daemon/native source, not just the
earlier transport research: `config.ts`, `hello.ts`, `origin.ts`, `server.ts`,
`chat-streams.ts`, `sessions.ts`, protocol `index.ts`, native `PilotClient.swift`
and `Transcript.swift`. Local read routes have no request authentication.
`X-Pilot-GitHub-Capability` protects distinct mutations, not chat reads.
Chat socket attach also invokes existing PR-status refresh. The user explicitly
accepted **existing Local read semantics**, rather than approving a backend
authentication or subscription redesign. Identity pinning is not authentication.

Local identity files are read, never created/replaced; a protocol or full
daemon/lineage mismatch stops subscriptions before WS. One fixed IPv4 loopback
endpoint only, with no proxy, redirects, cookies, Origin, remote registry,
credentials or production config changes. GET hello/history and WS upgrades are
the entire application request surface. WS output is protocol ping/pong only,
never focus or application commands. No composer/actions exist in live mode;
handlers defensively reject live submission. Fixture echo stays network-free.

## Ownership and bounds

`local_client.rs` owns a private async runtime, HTTP/WS lifecycle, reconnect
sequences, generation/epoch fences and bounded channels. `local_model.rs` owns
wire reduction and bounded source projections. `local_view.rs` owns the standard
Kit virtualized/searchable List and selection. Existing `TranscriptView` owns
retained message parsers, selection, word fade and MessageScroller state.

At most 1 control socket, 1 chat socket and 1 history read. Commands 4, wire
queue 2, complete-projection queue 1, UI delivery about 31/s. No delta dropping.
HTTP 4 MiB, frame/message 8 MiB, 1,000 summaries, 256 entries/512 rows,
8 MiB source budget including live/tool reserves, 1 MiB message, 32 running
tools/64 KiB output each. The README explains exact limits and exclusions.
Oversize/capacity/unsupported data is labelled, not claimed as full history.
Split snapshots keep the previous complete visible projection until ready.
Manual reconnects fence old epochs; chat switches fence old generations.
Closing drops the client, aborting its I/O/timers without a UI-thread join.

The checksum-pinned Base patch has 22 exact edits in four source files. The
new retained image-policy opt-out blocks remote/file/data image resolution for
both measurement and paint. It does not replace Kit's styling or built-in fade.
Original archive SHA256 remains
`d5cd7de73d5b2d3d18b94a928abf343922091fa77bc472f77b7d2e7e8b1823a7`.
Current specification SHA256:
`19e55509d990dc48a98712b0e83cec435ba8562f916fb2b1c9d7ee4caba9e50b`.
No registry/cache source edits, new framework fork or global setup.

## Verification

```sh
cd apps/desktop
bash scripts/check.sh
bash scripts/cargo.sh build --locked
target/dev/debug/pilot-desktop --help
/usr/bin/time -l target/dev/debug/pilot-desktop --local-check
```

Strict rustfmt and all-target Clippy, all 33 pure/component/network tests, native
Metal offscreen fixture/browser rendering and locked normal build passed.
Existing selection/grapheme/IME/manual-tail/fade regressions are retained.
New tests cover hello-before-WS/identity/protocol refusal, redirects, GET-only
requests and no application WS output, real loopback paging, rapid switching,
stream resume/sequence and final refusal, drop cancellation, projection queue
coalescing, split/replacement snapshots, stale cursor, bounded history/live
payloads, streaming-to-commit identity, exact selected clipboard after
prepend/unmount/remount, no cross-chat selection and image HTTP denial.

Native fixtures use synthetic data only. `evidence/local/viewer.png` is a real
offscreen GPUI render, not a desktop interaction/smoothness test. The separately
published SwiftUI mock is a **static mock screenshot**, not the GPUI views.

### Real Local read smoke, content-free

The first explicit `--local-check` completed successfully in 0.44 s wall,
0.09 s user/0.01 s system, 36,847,616-byte peak RSS (35.1 MiB). It verified the
existing identity before sockets, listed 862 summaries, opened one active chat,
projected 159 rows/616,314 source bytes, received 4 event batches and completed
a history request. Only counts were printed, never content, IDs or titles.
This is a short transport/projection CLI observation, **not GUI steady-state
memory, a benchmark or a Swift comparison**. Counts naturally change with live
work. No visible app or disruptive desktop session was launched.

### Large source/history and performance interpretation

Synthetic reducer workload: 6,000 entry appends remained bounded at 256 entries;
the observed run took about 70–76 ms. Exactly 1 MiB/2,000 paragraphs is admitted;
one byte over receives an explicit placeholder. Aggregate live block/argument
retention is bounded separately from individual blocks. These are admission/
reduction checks, not a claim to render arbitrary history cheaply.

`scripts/measure-rendering.py <rendering-executable>` freezes the compiled test
binary and runs normal/giant synthetic workloads with a credential-free env and
120 s per-process timeout. Native harness checks parser readiness before its
first measured render. Peak RSS includes framework, renderer, screenshots and
the multi-scene harness; CPU frame calls exclude real display/GPU presentation.
Do not compare these debug offscreen observations with Swift release scrolling.

Final frozen native probe (binary SHA256
`6704d2e4a05349b0541f9a3e427cec652454250c5ac81d04a7f6bd21c51d72fb`):

| Debug headless case | Parser drain | First CPU frame call | Process peak RSS |
| --- | ---: | ---: | ---: |
| Normal fixture | 3.111 ms | 166.479 ms | 111.3 MiB |
| Exactly 1 MiB / 2,000 paragraphs | 984.312 ms | 180.584 ms | 181.5 MiB |

The large source was asserted fully parsed before its frame, not inferred from
nonblank chrome. Earlier undrained-first-frame observations were discarded.
This is a one-run diagnostic per case, with cold font/setup effects and different
echo paths, not a paired throughput/latency comparison. GPU/driver memory is not
fully accounted by RSS. The near-second giant parse is a real scaling concern;
it is not evidence of faster or smoother real-window rendering.

Final strict rerun: 33 tests passed (21.72 s), native parser-ready renderer and
locked normal build passed. A second content-free Local smoke also succeeded:
863 summaries, 189 projected rows/666,684 source bytes, 4 batches/history request,
1.26 s wall and 37.0 MiB peak CLI RSS. Changing live counts are not a controlled
benchmark. The final build following tests was a 0.34 s no-op/reuse observation,
not a cold or one-source-edit measurement.

## Remaining limits

No matched visible release A/B, steady streaming/scroll latency or repeated
cold/warm/second-worktree iteration measurements. Fit-content giant TextView
layout and per-admitted-row parser retention remain risks, not solved by caps.
No production runtime/speedup/full-parity claim. The short native test harness
does not establish live-window responsiveness under a 1 MiB message.

Actual macOS 15 and native Wayland remain unavailable; macOS test host is
Apple M3 Pro/macOS 27 with deployment target 15. OS IME candidate-window/routing,
broader selection formats/long drags, narrow reflow and reduced-motion platform
validation remain separate. Dedicated accessibility engineering is deferred;
built-in support is retained. No sends, durable drafts, rich attachments,
approvals, artifacts, settings, install/update or shipping/default change.
