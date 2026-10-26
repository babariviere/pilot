# Loaded conversation links

The Local chat header's **Links** action (Cmd-Option-L) reveals an adjacent
inspector. Wide windows use the side; narrow windows use a bottom dock.
**Copy link** copies received text exactly. **Sources** reveals the canonical
entry/message/block identities; choosing one scrolls only to a unique source
still in the mounted transcript. Escape or Close returns focus to the composer,
or mounted navigation when editing is unavailable. Composition guards apply
before sibling pointer actions as well as keyboard actions.

This is an explicit snapshot, not a complete-history index. Opening and
**Refresh** scan only the mounted Local window, newest message first. New
streaming text does not trigger scans or change the list. Uncommitted streaming
without a stable source identity, reasoning, tool detail groups/results and
artifact bodies are excluded. Earlier history is never fetched for this feature.
Conversation/selection generation fences reject stale copy/source callbacks.

## Bounds and safety

- At most 512 eligible rows, 2 MiB total text and 64 KiB per row per scan.
- At most 64 unique links, 256 mentions/source records and 4096 bytes per URL.
- UTF-8 boundaries are retained; URLs cut at a scan boundary are not admitted.
- Web-only absolute HTTP(S), parsed with the existing URL parser. No bare domains,
  credentials, control characters, bidi controls, backslashes or encoded ASCII
  controls. Dedup uses parsed URL equality, retaining the latest received spelling
  and every admitted canonical source. Paths, queries and fragments are not
  aggressively merged.
- Scanning runs on the background executor. Only Arc-backed received message
  references cross the UI seam. There is one active bounded scan per inspector,
  no polling, network, DNS, file open, OS URL opener, service conversion, command
  interpretation, transcript mutation or backend capability.
- The interface always labels loaded-window coverage, and reports scan limits.

## Audited sources

Swift `PilotCore/ChatLinks.swift::ChatLinkIndex` scans user, automatic, assistant
and coordinator-message rows incrementally. `Pilot/ChatLinksPane.swift` throttles
stream scans and notes unloaded earlier messages. Its service classification,
service conversion and open behavior are deliberately not copied here.

Next `local_model.rs::assistant_rows`, `slim_message` and `message` form the actual
bounded reader text. Reasoning is filtered before projection, user text is plain,
assistant blocks carry `ReaderKey::Entry { entry, model, block }`, and tool details
are separate work projections. The inspector takes `Message::source`, never HTML
display text or tool arguments. It reuses canonical `reader_index` resolution and
`restore_reading`; `restore_anchor` does not manufacture user-scroll events or
request pagination. It never falls back to presentation IDs.

## Focused verification

`check-scoped.py --unit conversation_links --test conversation_links --native-probes --lint`
covers parser/provenance/caps, actual reducer text and the mounted Local inspector.
The native probe uses synthetic data, hidden 680/1100 light/dark windows and no
live Local actions. Full CI and macOS platform/OS IME acceptance remain separate.
