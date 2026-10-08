# CPU and memory audit

## Scope and observations

Checked the native UI, transcript reducer/caches, daemon polling and worker lifecycle,
cold history reads, and streaming transports. Used a five-second macOS `sample` of the
installed app, process CPU/RSS observations, source review, and regression tests.
The installed app identified itself as **1.2.0**; these changes target the **1.3.0** checkout.
The installed app was not replaced or restarted.

During an active agent conversation the installed UI initially used approximately
46–49% of one CPU core. The sample showed substantial SwiftUI layout/AttributeGraph
work, including timeline updates. Its physical footprint was 156 MiB, with a lifetime
peak of 264 MiB. This is a short observation, not an idle baseline, leak test, or proof
that a particular view accounts for all the CPU usage.

## Focused fixes

- **Status clocks:** discrete braille glyphs share one 10 Hz timer/publication instead of
  independent timelines. Repeated lifecycle callbacks cannot duplicate subscribers; the
  last disappearing glyph stops the timer. Hidden apps/windows do not publish glyph updates,
  and Reduce Motion does not subscribe to the clock.
- **Hidden terminals:** only the selected session on the visible Terminal tab is
  declared visible to Ghostty. Disappearing surfaces stop rendering without stopping shells.
- **Transcript-cache cost:** retained row/argument/diff costs are prepared off-main and
  read in constant time during UI cache trimming. Diff-line storage and queue/TODO
  metadata now contribute to the cache budget. This remains a conservative estimate,
  not an allocator measurement or a hard limit on the currently displayed conversation.
- **Idle workers:** display-only usage and artifact refreshes no longer reset the
  inactivity timeout. Actual work, viewers, and live subprocesses remain protected.
- **Cold history:** parking no longer eagerly rebuilds a transcript nobody is viewing.
  Reads remain on demand, with two active readers and at most 32 queued reads.
- **Native synchronization:** callers that discard the result no longer allocate a
  second deep copy of the entire history. Native mirrors and prompt copies remain isolated.

## Repeatable checks

```sh
npm run typecheck
npm test
npm run fmt:check
apps/macos/scripts/test.sh
swift build --package-path apps/macos --jobs 2

xcrun swiftc -O -parse-as-library apps/macos/scripts/bench-status.swift \
  apps/macos/Sources/Pilot/BrailleProgress.swift -o /tmp/pilot-status-bench
/tmp/pilot-status-bench --animation
/tmp/pilot-status-bench
```

The standalone status benchmark compares the original animation schedule with the earlier
per-view periodic schedule. The final app uses a shared clock; use the whole-UI fixture below
for that implementation. The standalone benchmark briefly displays twelve mock working sessions. It
does not connect to the daemon or change user settings. It reports eight-second
process CPU after warmup and peak RSS. Repeat both modes under comparable foreground,
occlusion, and system-load conditions. Early local runs were noisy: the old schedule
used 4.8% and 11.2% CPU; the periodic schedule used 6.9% and 4.5%, with peak RSS around
51 MiB in both modes. These are component measurements, not a claimed whole-app speedup.

Deterministic regressions cover parking despite telemetry, protecting active workers,
on-demand history reads, cold-reader admission, native-history isolation, cache eviction
with prepared diffs, metadata-only cost reuse, and terminal visibility eligibility.

## Authorized follow-ups

- **MCP-aware parking:** the injected SDK transport factory tracks exact stdio transport
  PIDs and outstanding JSON-RPC requests. Only idle owned transports are exempt. Unknown
  children, descendants of owned transports, jobs/subagents and process-list failures still
  protect workers. Wrappers with untracked server children consequently remain unparkable. The default
  factory is delegated to the pinned SDK 1.0.4 implementation, preserving its transport,
  environment, authentication and process-group behavior.
- **Terminal retention:** keep the visible surface plus five inactive surfaces. Eviction
  detaches the client without killing the daemon shell. Reattachment replays daemon
  scrollback; local selection, scroll position and older libghostty-only history can be lost.
- **Transcript projection:** changed call IDs update indexed committed tool rows rather
  than rebuilding historical context and summaries. Streaming publication compares its
  suffix, not the whole historical row array. History and the live tail share separate immutable
  arrays; a constant-time history key isolates the SwiftUI subtree. Tool expansion survives
  movement between those subtrees. Operation-count tests check increasing histories.
- **Working highlight:** move the wave to a compositor-layer animation rather than a
  30 Hz SwiftUI timeline; preserve the text mask, cycle and Reduce Motion behavior.
- **Upstream IPC:** a bounded FIFO permits one send callback in flight. A false send return
  is backpressure, not permission to discard a packet. The limits match full-snapshot
  headroom: 64 MiB per packet, 128 MiB total, 256 packets and a 30-second stalled-send deadline.
  Overflow/disconnection fails explicitly and invokes worker recovery rather than silently
  dropping transcript deltas.
- **Acknowledgement deadlines:** startup is limited to 120 seconds and commands to 60
  seconds. Transport failures are distinct from definite kernel rejection, retaining durable
  admission IDs and recovery state. Replacement waits for the old worker to exit. Parking
  inspection failure is conservative, not evidence that children are absent. Retirement
  sends SIGTERM before an eight-second SIGKILL fallback, allowing SDK cleanup hooks to run.
- **Draft persistence:** debounce edits for 300 ms, encoding/writing on a serial utility
  queue. Lifecycle flushes wait for the latest snapshot. Attachment files remain reserved
  across superseded/in-flight writes and failures, and corrupt/unreadable drafts remain protected.
- **Background reads:** TODO polling reuses unchanged inode/size/nanosecond timestamp
  metadata, reads at most 64 KiB of front matter with four concurrent readers, and preserves
  the last good state across temporary failures. Quota/title-only session broadcasts do not
  invalidate repository caches. The last departing cold-view consumer cancels queued work;
  another viewer's read and already active cache-populating reads remain intact.

### Offline whole-UI check

The app supports a bounded offline fixture using its production reducer/publication path,
1,000 historical messages and twelve sessions. It never connects to the daemon, loads
extensions, opens terminal shells, or saves drafts:

```sh
apps/macos/.build/out/Products/Debug/Pilot --performance-check
apps/macos/.build/out/Products/Debug/Pilot --performance-check --working
apps/macos/.build/out/Products/Debug/Pilot --performance-check --streaming
# Optional real-window visual check, after measurement:
apps/macos/.build/out/Products/Debug/Pilot --performance-check --working \
  --screenshot /tmp/pilot-working-performance.png
```

It warms up for two seconds, measures ten seconds, then exits. Streaming sends ten text
deltas per second. Reports include process CPU and lifetime peak RSS, not physical footprint.
Early debug runs measured 0.58% idle CPU and 61.34% streaming CPU with approximately
182–188 MiB peak RSS. These exposed further UI invalidation work. Subsequent per-view
status clocks still used 28–49% CPU for the twelve-working-session fixture. After sharing
one clock, a local run measured 5.00% working and 20.16% streaming CPU, with peak RSS of
182 and 197 MiB respectively. These are short debug fixture observations under varying
system load, not a claimed installed-app or battery-life improvement. Compare identical
fixtures in packaged/release builds before drawing broader conclusions.

## Verification

- TypeScript: typecheck, formatting and lint passed; **356 tests passed, 3 skipped**.
- Swift: standalone build passed; **150 core tests and 81 native tests passed**.
- **11 focused UI regressions passed**, covering draft coalescing/flush/attachment retention,
  incremental history isolation, preserved expansion and compositor geometry/lifecycle.
- Full UI commands were run, but the Command Line Tools helper can exit before its UI-target
  summary during existing standalone-window tests, even when the command returns success.
  This is not evidence that the entire UI integration suite passed. The changed UI paths were
  therefore also verified with explicit filters. The existing token-command timing test once
  failed under heavy load; its isolated and subsequent core-suite runs passed.
- The native artifact tool was unavailable. A standalone AppKit preview using the actual
  `WorkingIndicator.swift` rendered its Working/Retry labels and text mask successfully at
  `/tmp/pilot-working-component.png`. Whole-window screen capture was denied by the host;
  AppKit cache snapshots omitted composited scroll content, so those are not visual proof
  of the whole transcript or of the animation's presented phase.
- `git diff --check` passed. The installed app was not restarted or replaced, and no existing
  user daemon sessions or terminal shells were stopped by the checks.

## Remaining limits

These fixes do not make every resource globally bounded. Active conversations, durable
history, unsent drafts, user-started jobs and daemon terminal shells intentionally survive.
Very large replacement snapshots still rebuild history; work within one very large tool
group still scales with that group's size. Compatibility/actions requesting the combined
row array may copy history. Cache costs are estimates, and 64 MiB snapshots require
substantial transient memory. MCP transport tracking depends on
the pinned SDK implementation until its default factory is exported at the package root.

Reprofile a packaged build with long chats, many sessions/terminals, idle MCP transports,
and background/closed windows before making battery-life or leak-free claims.
