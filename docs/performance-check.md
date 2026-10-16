# CPU and memory audit

For the later repository polling and streaming WAL audit, see [I/O amplification audit](io-performance-check.md).
For daemon event-loop stalls, their log lines and live diagnostics, see [pilotd event-loop stalls](daemon-stalls.md).

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
pnpm typecheck
pnpm test
pnpm fmt:check
apps/macos/scripts/test.sh
apps/macos/scripts/build.sh

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
deltas per second. Reports include process CPU and lifetime peak RSS; streaming runs add physical footprint and
frame hitches (see [Streaming benchmark](#streaming-benchmark)).
Early debug runs measured 0.58% idle CPU and 61.34% streaming CPU with approximately
182–188 MiB peak RSS. These exposed further UI invalidation work. Subsequent per-view
status clocks still used 28–49% CPU for the twelve-working-session fixture. After sharing
one clock, a local run measured 5.00% working and 20.16% streaming CPU, with peak RSS of
182 and 197 MiB respectively. These are short debug fixture observations under varying
system load, not a claimed installed-app or battery-life improvement. Compare identical
fixtures in packaged/release builds before drawing broader conclusions.

### Streaming benchmark

The streaming fixture can stream a long Markdown reply (headings, paragraphs, numbered and bulleted
lists, Swift code, tables and quotes) at a chosen rate, in a release build:

```sh
apps/macos/scripts/bench-streaming.sh     # release build, then three runs of each case below
apps/macos/.build/out/Products/Release/Pilot --performance-check --streaming --markdown --rate 100
apps/macos/.build/out/Products/Release/Pilot --performance-check --streaming --markdown --rate 4 --chunk 100
```

`--rate N` sets the deltas per second (default 10), `--chunk N` the characters per delta (default 12, about three
tokens) and `--seconds N` the measured time (default 10). Without `--markdown` the fixture streams the old
" streamed text" phrase, so earlier numbers stay comparable. Each run prints:

- process CPU and main-thread CPU, as a share of one core, over the streaming window;
- physical footprint (the figure Activity Monitor shows), its peak while streaming and at the end, and peak RSS;
- display frames from the window's display link: refresh rate, frames, hitches (a gap longer than one and a half
  frames, so 12.5 ms at 120 Hz) and dropped frames, and the longest gap;
- `ChatView` body evaluations;
- the count, total, mean and longest duration of each streaming phase: transcript apply, publish, Markdown prepare,
  text update (replacing an NSTextView's content) and text measure (TextKit layout for a SwiftUI size probe);
- CPU over five seconds after the reply is committed and the run ends, which should be close to idle.

The same phases are os_signpost intervals (subsystem `com.babariviere.pilot`, category `Streaming`), so an
Instruments trace of the real app shows them on its signpost track. Totals are only collected by the fixture.

**How often updates really arrive.** The kernel forwards every provider delta into pi-durable
(`packages/kernel/src/native-adapter.ts`, the `for await` loop in the model stream), but pi-durable commits the
partial message at most once per `progress.partialIntervalMs` with one commit in flight, and Pilot sets that to
250 ms (`packages/kernel/src/session.ts`). Each commit becomes one `message_update` carrying everything since the
previous one, and pilotd forwards those batches as they are. So a streaming chat receives about four updates a
second, each with tens to hundreds of characters, not one per token. The `--rate 4 --chunk 100` case is that
cadence; 10, 50 and 100 deltas/s are stress cases for per-update cost and for future lower intervals. Large,
infrequent chunks are also why newly streamed text needs a short fade-in to look smooth.

Numbers depend on the Mac, its display and load. Run every branch on the same Mac, plugged in, with the window on
the built-in display and other apps idle, and compare medians of at least three runs. The baseline below comes from
`main` before the streaming work; later changes add their before/after rows.

| Case (release, `main`) | CPU | Main thread | Footprint peak | Hitches / dropped | Body evals | After completion |
| --- | --- | --- | --- | --- | --- | --- |
| 4/s, 100 chars | pending | | | | | |
| 10/s, 12 chars | pending | | | | | |
| 50/s, 12 chars | pending | | | | | |
| 100/s, 12 chars | pending | | | | | |

The Swift app is only built in CI, so these numbers have to come from a local run of
`apps/macos/scripts/bench-streaming.sh`.
+
**Incremental Markdown.** A streaming reply was parsed and styled again in full on every update, so its cost
grew with the reply. `MarkdownStream` (PilotCore) keeps the blocks before the last boundary (a blank line, closing
fence, heading or rule outside a code fence) and parses only the text after it; `MarkdownRenderer` keeps their
prepared, styled blocks and their IDs, so unchanged blocks also skip their text views. The component benchmark
compares a full parse per update with the stream, both followed by inline `AttributedString` Markdown for the blocks
they prepare (code highlighting, also skipped now for finished code blocks, is not included):

```sh
xcrun swiftc -O -parse-as-library apps/macos/scripts/bench-markdown.swift \
  apps/macos/Sources/PilotCore/Markdown.swift -o /tmp/pilot-markdown-bench && /tmp/pilot-markdown-bench
```

| 24 KB reply (M3 Pro, two runs) | Full parse per update | Incremental per update |
| --- | --- | --- |
| 12-character deltas, 2,028 updates | 1.9–2.2 ms | 0.04–0.05 ms |
| 100-character deltas, 244 updates | 1.8–2.0 ms | 0.06 ms |

The full parse is the mean over the reply; near its end a single update cost about 4 ms off the main thread.
Whole-app numbers come from the streaming benchmark above.



### Mission tab switches

`--mission-tabs-check` opens an offline mission with 100 tasks (with descriptions, links,
artifacts and dependencies), twelve chats, 30 decisions, a 50 KB brief and 1,000 activity
events in a real window, then visits every tab several times:

```sh
apps/macos/scripts/build.sh -c release
apps/macos/.build/out/Products/Release/Pilot --mission-tabs-check --rounds 6
# One tab against a cheap one, for profiling with sample(1) or Instruments:
apps/macos/.build/out/Products/Release/Pilot --mission-tabs-check --tabs tasks,chats --rounds 12
# Screenshots of every tab after measuring:
apps/macos/.build/out/Products/Release/Pilot --mission-tabs-check --rounds 1 --screenshot /tmp/mission
```

Per tab it reports the synchronous switch (selection through layout and display), the longest
main-thread gap in the following second and the main thread's CPU time, plus how many task rows
the Tasks tab built. Release builds on a busy 11-core M3 Pro (load 7 to 10), median of later visits:

| Tab | Before | After |
| --- | --- | --- |
| Tasks | 459–740 ms | 114–125 ms |
| Brief | 1,373–1,750 ms | 103–121 ms |
| Chats | 219–294 ms | 57–82 ms |
| Artifacts | 183–190 ms | 93–103 ms |
| Activity | 1,667–2,096 ms | 53–93 ms |
| Overview | 1,122–1,239 ms | 75–92 ms |

Before, the worst gap was 6.8 s (Brief) and 3.8 s (Activity). The first visit to a tab in a fresh
process stays slower (one-time AppKit and SwiftUI set-up). What made switches slow, and the fixes:

- Every tab built all of its rows: task rows with their menus, every activity entry and every
  Markdown block of the brief as a text view. Lists and brief blocks are now lazy (17 of 55 open
  task rows are built), and row menus are created only while the row is hovered.
- Each tab had its own scroll view. Replacing a scroll view made AppKit rebuild the window toolbar,
  which cost more than a small tab. The page now keeps one scroll view for every tab.
- The selected tab was published by the app model, so a switch re-rendered the window, sidebar and
  toolbar. It now has its own observable object, read only by the picker and the page content.
- Rows filtered the mission's links and artifacts and sorted its members themselves. The tab now
  indexes them once per update. The brief's Markdown is prepared off the main thread when it
  arrives, and its revision list is fetched once per revision instead of on every visit.

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
