# Tool/work presentation

Historical verification snapshot. Conversation source-byte limits described below
have since been removed; see [current image contract](../docs/conversation-images.md).

A user-provided real-chat screenshot exposed poor centered alignment, overly
long script subjects and latest-window capacity behavior. The follow-up adds
read-only production-view capture, leading-aligned controls, compact generic
script summaries, newest-first initial admission and explicit Refresh latest.
Local verification: 72 library tests pass, one opt-in disk workload remains
ignored by default; rustfmt, strict all-target Clippy, synthetic native Metal
rendering and locked normal build pass. Private capture was also exercised.
This remains an experimental checkpoint, not full app parity.

Scoped Rust-only presentation slice atop the Local interaction checkpoint.
Frozen reference: `cb64f770`, `ToolViews.swift`, `PilotCore/ChatRows.swift` and
`TranscriptPresentation.swift`. No Swift or backend code was changed.

## Behavior and boundaries

Assistant text/thinking/tool segments keep their order. Notes and tool calls
before the final answer form quiet work, with semantic read/edit/command/script/
search/fetch summaries, failure indicators and generic unknown-tool fallback.
Adjacent calls retain call IDs across start/update/end, message commit and
reconnect snapshots. Out-of-order terminal results cannot regress to running.
Orphan failures remain visible until an authoritative snapshot replaces them.
No fabricated elapsed durations or unsupported structured-result interpretation.

Groups open while active, fold when finished and open on failure/uncertainty.
User choices win and follow member identities through prepend/regroup/remount.
Tool expansion and retained body states are chat-scoped. Latest is explicit;
disclosures pause tail following without changing the offset, while parser/
stream updates do not. Kit may resume immediately if everything still fits.
At capacity, Refresh latest explicitly replaces the bounded history window;
it is not silent eviction of a selected reading row. Ordinary reconnect and
prepend preserve expansion. Refreshing never touches the composer draft.
While a refresh loads, the previous window remains visible, errors are shown,
explicit Retry latest remains available and stale generations cannot replace it.

Tool details are inert selectable text. Only opened panes create a parser;
closed updates do not touch their retained parser. No tool action, approval,
shell, network/file image load, URL opening or generated-code execution exists
in these views. Copy shown text is explicit. Selection is tested through actual
unmount/remount and prepend, using rendered selection/clipboard: HTML/pre does
not expose reliable raw-HTML source spans, so tests do not invent byte offsets.
An already selected ordinary assistant note transfers its existing Markdown
document into the work view, rather than losing selection during grouping.

Known names and simple single-call codemode literals have useful summaries.
Mixed/dynamic scripts and extension tools use conservative generic descriptions,
not a JavaScript parser or evaluation. Structured edit/write/applyPatch data
produces bounded replacement/patch previews; these are not a complete Changes
pane, a minimal-diff algorithm or an arbitrary repository diff read.

## Bounds and protocol audit

At most 256 retained call identities share a 2 MiB detail reserve. Per call:
40 KiB output, 12 KiB diff; metadata also counts against the
reserve. Full received arguments and prepared command/code now live outside that
preview reserve, without a presentation byte cutoff. Existing 8 MiB transcript source and 512-row admission bounds remain.
Large details show explicit omissions. Expanded panes scroll within 256 px;
this is not virtualized arbitrary-output layout or a solved giant-message path.

The installed durable adapter's `harness/events.js` forwards Chord's truncate
operation. `chord/delta/apply-immutable-trusted.js` uses `String.slice(n)`, so
`trimStart` counts UTF-16 units. Astral-text tests cover that distinction. A
truncated prefix cannot safely receive subsequent deltas and is kept explicitly
bounded until a full set/result arrives. Partial string argument paths update
within the existing bound; unsupported partial shapes wait for full blocks.

One checksum-pinned Component edit exposes GPUI's existing tail-pause method.
The archive, exact preimage and generated fingerprints are verified by the same
preparation script as the Base patches, without registry/cache edits, framework
version changes or new defaults. See `patches/README.md`.

## Reproduce and remaining evidence

```sh
cd apps/desktop
bash scripts/check.sh
PILOT_NEXT_VIEWER_SCREENSHOT="$PWD/evidence/local/tools.png" \
  bash scripts/cargo.sh test --test rendering --locked
bash scripts/cargo.sh build --locked
```

Pure synthetic tests cover summaries, unknown tools, diffs, parallel/out-of-order
events, terminal monotonicity, partial arguments, UTF-16, aggregate limits,
snapshot/prepend identity and final-answer order. Real Kit component tests cover
lazy parsing, hidden updates, explicit choices, pointer selection/copy and actual
unmount/regroup/remount. The native Metal offscreen scene uses 48 synthetic text
rows and synthetic read/edit/test work, including expanded diff/arguments.
Source readiness is asserted before capture. No real content, requests, sends,
creates, Stop, approval or visible unattended app is involved.

Separately, after the user's explicit screenshot request, `scripts/capture.sh`
was run against exactly this chat using read-only Local transport and the same
production view, as recommended by https://gpui-kit.com/docs/test/. Private
before/after images were inspected, not committed, published as artifacts or
attached externally. This opens no visible window, write client or draft store,
never falls back to another chat, and saves 0600 PNGs in a 0700 ignored directory.
It captures a fresh snapshot, not running-window scroll/expansion/unsaved state.
The real-data use is opt-in, not part of the ordinary synthetic test suite.

Offscreen rendering is not visible smoothness, OS IME, native Wayland or matched
Swift performance evidence. Existing giant Markdown/parser scaling and private
snapshot I/O risks are unchanged. Syntax coloring, full structured tool-result
renderers, artifact content, per-tool elapsed timing and full app parity remain
separate. No performance win is claimed from a successful render.
