# Local mission briefs

From a Local mission overview, choose **Open brief workspace**. This is a separate
retained workspace, not the conversation composer. It reads Markdown source, offers
full received-text Copy, and lets you select the received immutable revision rows.
History selection never becomes an edit base implicitly. **Edit current brief**
returns to the current draft, not the historical text.

## Explicit editing and recovery

- **Save** captures the exact qualified source, received base revision, known base
  content and new content. There is no autosave, automatic merge or write retry.
- **Cancel editing**, Overview and app navigation retain the draft in this window.
  This is bounded in-process state, not restart-durable storage. Copy important text
  before closing the app/window. No Swift draft or private delivery store is used.
- A conflict retains your text. Refresh latest, review/copy the received content,
  then explicitly **Use received latest as base, keep my text** before another Save.
- An unknown result may already have committed. Later GET/history visibility does
  not confirm that attempt, nor does choosing a new base settle it. A subsequent
  explicit Save is a new operation, never a replay of a client-generated ID.
- A received, validated successful response is tracked separately from later read
  errors and newer edits. A late response records its original owner even while
  hidden, without selecting that mission, stealing focus or replacing newer text.

The server normalizes with ECMAScript trimming. A normalized no-op retains its
revision; saving the initial empty revision zero creates revision one. Confirmation
checks those different rules against the captured known base, not a later read.

## Scope and limits

Only existing pinned Local hello/catalog/detail/brief/revision endpoints are used.
Canonical home, daemon, lineage, mission and project evidence is required. Missing,
foreign, malformed or truncated evidence fails closed. Reads have generation and
view fences. One worker coalesces/cancels obsolete reads; an admitted Save has a
separate bounded lane and non-coalesced acknowledgment channel. Navigation/read
cancellation does not cancel that Save. Worker exit preserves drafts and known
acknowledgments; restart requires an explicit read action.

| Item | Supported bound |
| --- | --- |
| Received Markdown source | Exact persisted text within the brief JSON transport budget; no write-length validation |
| Brief JSON response | 2 MiB |
| Native editable draft | 64 KiB UTF-8 |
| Selectable source excerpt | 32 KiB, clipped only on a Unicode boundary |
| History response | 128 KiB and at most 256 received rows |
| Retained qualified sources | 16 per workspace/window |
| Unconfirmed Save attempts | Four per source, counting the current attempt |

Full Copy copies the admitted received source, not the excerpt. A source above the native edit cap
remains read/copy-only; Swift remains available for larger edits. An already retained
small private draft remains recoverable even if a newer source exceeds the edit cap.
A native edit exceeding 64 KiB is rejected **in full**, restoring the prior draft
and character-clipped selection. The notice explicitly discloses that this rare
limit rejection resets editor undo history. A new valid edit clears the notice;
duplicate input effects do not. Capacity refusal never evicts drafts or known
acknowledgments. History reports received rows, not an invented total or pages.

Marked text blocks Save, workspace switches and shell navigation/palette/Settings/
project-picker entry. A paint-scoped window capture listener protects sibling
pointer targets before blur, rather than relying only on a late click handler.
It is cleared with the next GPUI frame; there is no polling/global input service.

## Verification

Use the scoped wrapper:

```sh
cd apps/desktop
python3 scripts/check-scoped.py --unit mission_brief --test mission_brief --native-probes --lint
```

The model/transport tests cover exact source/CAS/no-op/empty rules, parser/wire/
history limits, stale owner/newer draft, conflict/unknown distinction and capacity,
post-commit errors, lost/malformed replies, read cancellation and closed lanes.
Only owned faux HTTP is used, never real profile inspection or live mutation.

The native target executes four production Browser/Workspace journeys at 680/1100
points in light/dark, plus an actual synthetic `LocalViewer` shell journey. It uses
real button/keyboard/history/copy/paste paths for explicit Save, conflict recovery,
hidden late acknowledgment/newer edit retention, unknown-after-GET, full/excerpt
copy, atomic edit rejection and explicit worker restart. The shell case checks
marked text against Home/back/palette/Settings and sibling pointer targets before
blur, then successful unmarked navigation, focus and retained-text Save.

`PILOT_NEXT_BRIEF_CASE=root-ime` or `component-wide-light` selects exactly one case
for iteration; invalid selectors fail. Omit it for all five. Set
`PILOT_NEXT_BRIEF_DIR` to a fresh owned directory for actual offscreen GPUI captures,
using `umask 077` for private files. Static captures are not animation, production
rollout, Linux desktop acceptance or full Swift parity evidence.
