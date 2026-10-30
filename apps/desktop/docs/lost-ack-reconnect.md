# Ordinary Send recovery across paged reconnect

This is an isolated regression corpus, not evidence about a particular live
message. It does not resolve the new-chat report without its captured operation
identity. No backend contract, receipt semantics or automatic retry is changed.

## Production ownership

- `chat_editor.rs` captures the explicit Send's draft revision/request and keeps
  newer native text separate. `chat_sending.rs::shown_text` can be empty for the
  captured revision even while that exact text remains durably retained.
- `interaction_delivery.rs::DeliveryOwner` owns the FIFO writer. Its `effect`
  services text autosaves during HTTP without lending Store to the request or
  overtaking queued commands. Pending Q&A/config metadata remains frozen.
- `reconcile` checks the pinned daemon/lineage and posts the retained envelope
  to the existing receipt lookup. Only matching operationId, payloadHash,
  destination, targetId and accepted result.sessionId permit adoption.
  `Check` passes `retry:false`. Transport failure, absent/ambiguous/mismatched
  receipts and identity refusal cannot execute the message again.
- `local_client.rs` owns typed socket health, full-baseline admission and the
  fatal fence. Hello, deltas and malformed full lists do not establish a fresh
  sessions baseline. Chat owner/sequence, navigation generation, snapshot
  revision and cursor fence live events and older pages independently of Send.
- `Store::finish` settles only the exact intent and preserves newer text.
  Reader rows, matching prose/titles and session membership are not receipts.
  `Interaction::run` drops Store before its update lane closes, allowing an
  immediate lock-preserving reopen after the final Close publication.

## Reproduction

From `apps/desktop`, using the pinned local toolchain and private target:

```sh
python3 scripts/check-scoped.py --test lost_ack --lint
python3 scripts/check-scoped.py --unit local_client::network_tests::session_lists --native-probes
python3 scripts/check-scoped.py --unit local_client::network_tests::archive_reads --native-probes
python3 scripts/check-scoped.py --unit interaction::tests::send_waits --native-probes
bash scripts/cargo.sh build --locked -p pilot-desktop
```

`src/lost_ack_fixture.rs` listens only on an OS-assigned loopback port. It
records the actual immutable envelope produced by the production courier,
holds its execute response after synthetic admission, then drops that response.
Every unexpected route fails the fixture. It never starts an agent/provider.

`src/lost_ack_probe.rs` mounts the production LocalViewer, textarea, Send,
sidebar, Find and contextual Check controls in hidden 680/1100-point windows,
each in light/dark. Real LocalClient HTTP/WebSockets and the real Interaction
worker/FIFO Store use only this daemon and a fresh private directory. Complete
projections are delivered through the normal `accept` methods. The harness
observes the native owner's Close ACK without letting its normal process-exit
event terminate the shared test runner.

The journey holds ordinary Send, durably saves newer Unicode input, composes
simulated preedit, loses both sockets and the ACK, reconnects through held and
malformed/full-valid baselines, pages history with native wheel input, searches
older source, visits another same-title chat and passive Archive, returns to
the original draft, explicitly checks the exact receipt, then closes the owner
and immediately reopens Store after lane closure. Same-title chats deliberately
contain the exact sent prose. Foreign-owner/duplicate-sequence frames precede
a valid frame; neither can replace the selected transcript. Keyboard Find
resolves the unique older match. Prepend and return navigation assert canonical
reading identity and pixel offset, not a coincidentally reused render number;
the textarea's simulated marked/selection ranges and focus survive socket loss.

Each window/theme runs exact accepted, absent, HTTP error, identity-incomplete
accepted, wrong operation/hash/destination/target/result, exact Pending, wrong
daemon and wrong lineage cases. Every case asserts exactly one execute POST,
the precise captured envelope/revision/target, separate drafts, retained answer
and configuration, and the final reopened Book. Only exact accepted settles;
exact Pending remains Pending, all other uncertain cases remain Unknown.
Archive uses the shared passive history route and never opens its chat socket.

All 48 hidden journeys passed on macOS arm64, with scoped native Clippy clean.
The regression required no production delivery, reader or Store behavior change.

## Limits

This corpus observes native controls, source-owned state and ordinary temporary
file writes, not screenshot-only success. It is not OS IME, real pasteboard,
power-loss, force-quit, live service/window-parent lifecycle, visible smoothness,
Linux/Wayland or production daemon/provider acceptance. Passive Archive still
has the legacy non-atomic multi-page context limitation documented in
[Archive](archive.md). Existing full-history Find/selection and distant anchor
corpora remain in [lazy history](lazy-history.md); this is not a new history cap
or a general memory/performance qualification.
