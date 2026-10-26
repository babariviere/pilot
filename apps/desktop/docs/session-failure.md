# Reported chat failures

The selected conversation shows a contextual public failure report below its
header. The reason is directly visible, selectable plain text, not a sidebar
label or hover-only diagnostic. Copy reason copies the displayed report.
Long details scroll within a bounded region. Healthy chats mount no region.
There are no retry, startup, repair, send or permission actions here.

## Public contract audit

- `packages/protocol/src/index.ts`, `SessionCompletion`: `outcome` is the latest
  settled result, independent of the parked worker. `outcomeAt` is its stable
  completion version. `outcomeReason` is bounded, already-redacted public text.
  There is no exact run ID on this contract.
- `packages/daemon/src/session-outcomes.ts`: working clears old outcomes. Fresh
  completions have monotonic versions; daemon failures also receive versions.
  Changing attempts clears outcomes without rewinding the high-water mark.
- `packages/daemon/src/sessions.ts`, `summary`: the daemon suppresses outcomes
  while working/held/offline-paused. Public `error` is also redacted, but can
  describe startup, input or worker problems. It is not by itself proof of a
  failed run. `canRetryStartup` identifies a startup failure, not authorization
  for this UI to retry. Archived startup failures may lack that flag.
- `attentionReason.detail` is an independent public attention description. Only
  `kind: failed` may supply fallback failure detail; MCP, tool-stall, quota and
  unrelated attention text must not become a run diagnosis.
- `packages/kernel/src/failure.ts`: normal diagnostics cap at 1,600 UTF-16 units,
  redact secrets before clipping, bound cause traversal and flatten control
  characters (including newlines). The UI preserves multiline Unicode if a
  public/older producer supplies it; it cannot restore formatting or causes
  already omitted by the producer.
- `apps/desktop/src/local_client.rs`: hello identity pinning precedes sockets,
  epoch fences reject old connections, chat generation/session/stream/sequence
  fences reject old chat events. Reader/transport errors use bounded generic
  privacy-preserving status messages. Neither their private wire message nor
  durable structured error entries are promoted to a summary failure reason.
- Swift `PilotCore/TranscriptPresentation.swift::failureBannerText` suppresses
  the persisted banner while working and prefers `error` then a failed
  `outcomeReason`; `NeedsYouReason.swift` uses a first-line list projection. The
  selected-chat view instead prefers the versioned completion reason for a
  failed outcome, while an explicit startup failure prefers its startup error.

## Presentation and identity

`session_failure.rs` reduces only those public fields. With explicit failure
evidence, reason precedence is startup error (for startup), failed completion
reason, public chat error, then failed-attention detail. Missing, blank and
non-string details say **No failure reason was reported**. Non-failure error
objects are not serialized or inspected. Retention is capped at 8 KiB per
report on a UTF-8 boundary, with a visible omission notice also included in
Copy. This does not promise to recover the daemon's already-clipped text.

The report retains its source, completion version and public active-attempt
association. Exact versions/attempt association are supplementary tooltip
metadata, not invented run IDs. Archived reports, reports older than the
active attempt, and an old completion observed across a new run are labeled
historical. Disconnection explicitly labels a retained report, not a new
failure. There is no cross-chat report cache or diagnostic fanout.

The selected-chat and generation guards also fence captured Copy callbacks.
New run observations come from the existing bounded transcript reducer; they
do not infer a failure from stream termination or a load error. The retained
native text/scroll identity includes chat, generation and report contents.
Summary/stream updates do not create text input entities or replace the draft.
The sibling-pointer guard runs before IME blur, and focus moves to the mounted
composer/navigation destination before the failure region unmounts.

The native view uses `ui::text`/`ui::action`, semantic foreground/danger colors,
existing spacing and native `SelectableText`. Its bounded detail viewport is
the sole scroll owner for this small public report, independent of transcript
scrolling. It adds no animation, timer, network read or backend capability.

## Scoped verification

From `apps/desktop`:

```sh
PILOT_NEXT_SESSION_FAILURE_DIR=/tmp/session-failure-captures \
  python3 scripts/check-scoped.py --unit session_failure --test session_failure --lint
```

Rationale: the filter covers the public projection, run/attempt provenance and
real hello-pinned faux reader; the native target mounts the production selected
conversation to exercise failure/missing/multiline/long text, selection/copy,
IME/draft/focus guards, working transitions and late chat switches in 680/1100
light/dark layouts. The wrapper retains shared admission, CPU2/4GiB limits and
private outputs. Full suites remain CI's job. Synthetic native rendering is not
OS IME, live-daemon, performance, Wayland or user acceptance evidence.
