# Reported chat failures

The selected conversation shows a contextual public failure report below its
header. The reason is directly visible, selectable plain text, not a sidebar
label or hover-only diagnostic. Copy reason copies the displayed report.
Long details scroll within a bounded region. Healthy chats mount no region.
A current failure offers one explicit **Retry** (below). There are no repair,
send or permission actions here.

## Retry

Retry sits beside Copy reason, reachable by pointer and Tab/Return. It never
runs automatically. It uses the existing contract for the kind of failure,
through the shared chat-action owner (`chat_actions*.rs`), after one fresh
eligibility read of the exact chat (`session_failure_retry.rs`):

- **Startup failure** (`canRetryStartup`): `POST /api/sessions/:id/retry-startup`,
  as the row menu's Retry startup and Swift's `AppModel.retry`. pilotd reloads the
  worker with its existing outbox and applies a saved next-attempt model.
  Nothing is resent. An unconfirmed restart may be asked for again.
- **Failed turn**: Swift's failed-turn Retry, `POST /api/sessions/:id/rewind`
  `{"action":"retry","entryId"}`. The entry is the committed assistant entry
  that ended in error (`stopReason: error`) and is the newest loaded entry while
  no run, stream, queued input or newer entry exists (Swift
  `TranscriptPresentation.retryEntryID`; here `LiveTranscript::retry_entry`).
  pilotd starts a new attempt before that turn's user message and resends it
  itself; the failed attempt stays in history. The client never reposts a
  message. Only 400/404 are refusals; every other answer, a lost response or a
  mismatched session is **Unconfirmed** and that chat is never retried again
  from this window (a conflict can follow the attempt switch).

Retry is shown disabled with a visible reason when it can't run safely: not
connected, the last message's delivery is unconfirmed, the conversation is
loading, the failed turn isn't the newest loaded entry (for example an
interrupted run without an error entry), or a next-attempt model is saved.
pilotd applies a saved model only to a startup retry or the user's next
message; its turn retry would refuse after switching the attempt, so this UI
does not offer it (a contract gap, not worked around). Earlier, archived and
read-only failures offer no Retry.

Pending shows *Retrying…* with input waiting; repeats submit nothing. An ACK
shows *Retry sent* until Local reports the new run. The draft, composition
guard, pending answers, focus and the transcript are untouched. The inspect
result must still match the shown failure (chat, generation, completion
version, active attempt and failed entry); otherwise nothing is submitted.

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

Retry is verified with the chat actions suites:

```sh
python3 scripts/check-scoped.py --unit chat_actions --lint
PILOT_NEXT_CHAT_ACTIONS_CASE=failure-retry python3 scripts/check-scoped.py --test chat_actions
```

The native case (`chat_actions_retry_probe.rs`) runs pointer (light) and keyboard
(dark) retries at 680/1100 against synthetic HTTP: preedit guard, pending with a
single POST despite repeats, ACK, draft retention through the private store,
unavailable/disconnected/saved-model reasons, a stale summary refused before
POST, startup retry and a lost ACK that is never repeated.
