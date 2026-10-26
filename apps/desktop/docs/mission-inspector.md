# Conversation mission context

The context button beside the chat history menu (or Cmd-Option-M) opens a
read-only companion for an existing Local mission-linked conversation. Opening
or refreshing it never navigates, sends, creates a mission, or modifies delivery
state. Explicitly choosing an available member uses normal guarded navigation.

## Subtract, retain, reveal

- Subtract tabs, editing controls, duplicate toolbars, nested cards and polling.
- Retain the mounted conversation and composer entities, their IDs, draft writer,
  pending-operation authority, input/IME guards, selection and reader ownership.
- Reveal a quiet overview first, then bounded Tasks and Members disclosures.
  Refresh is explicit. Escape closes only from inside the inspector; its context
  button also closes it without stealing focus into the pane on open.

The wide companion is 280–300pt only while reserving at least 420pt for the
conversation. The shell budgets its existing maximum 232pt sidebar extent, which
is its actual extent at the side-pane breakpoint. Narrow windows keep the same
conversation mounted above a lower dock, at most one third of window height or
240pt, reserving at least 360pt for the conversation. This does not change the
composer's editor/tray contrast or 76/34 metrics. Actual mounted bounds, not a
mock, are the native probe's geometry assertions.

## Identity and lifetime

A separate immutable membership projection accompanies Local session metadata,
bounded by the existing 1000-session cap. A full snapshot replaces old links;
partial updates affect only their exact chat ID. Unknown, malformed and known
unlinked are different states. Equal metadata shares its existing allocation.
The regular Chat projection and private delivery store are unchanged.

The source includes pinned daemon/lineage, selected chat, project, declared
mission and selection generation. Existing bounded catalog reads must provide a
received exact canonical home/project match before detail/member reads. Missing
evidence, including an absent row in a truncated window, never triggers guessed
ID, title or host fallback. Existing reader limits remain: 128KiB catalog, 2MiB
detail and 1MiB members; 256 received/24 displayed tasks and 128 received/16
displayed members; bounded goal/brief parsing. Counts distinguish received,
displayed and mission-reported totals.

The inspector owns a separate cancellable reader and update task. Close, page or
source changes fence old generations and lanes. Source identity changes discard
old text. Refresh failure/offline state retains only the same-qualified snapshot,
explicitly marked not current, with navigation disabled. Reader exit clears busy
and requires explicit retry. No frame callback performs I/O and there is no
automatic polling or recovery send. Member events revalidate current source,
generation, received membership, current Local metadata and loaded chat/project
before existing editor-capture/normal-navigation guards.

## Focused verification

Use `scripts/check-scoped.py --unit mission_inspector --native-probes` for the
metadata/source and retained state tests, and `--test mission_inspector --lint`
for the explicit native target and its matching lint. The native fixture owns its
HTTP server and temporary private draft state, never a real Local profile.
`PILOT_NEXT_MISSION_CONTEXT_DIR` optionally records actual GPUI PNGs at 680×840,
680×520 and 1100×840 in committed light and dark appearance. It checks actual
selection/input and geometry, not GPU smoothness or OS-wide IME acceptance.

Scoped checks: six metadata/lifecycle tests, selected library/native lint and
seven mounted native cases pass, including an active-chat pending envelope.
All immutable operation fields survive private flush byte-for-byte. Actual
current-generation stream publications retain selection and reading anchor;
Stop availability is preserved without an automated Stop. A real marked-input
member click is refused before blur, and a subsequent explicit member choice
issues only the existing guarded Open. All traffic is owned synthetic GETs.
The 46 fake-tool CI/registry contracts pass. Frozen source PREPOST hashes match.

The shortcut-close focus regression has an actual mounted red control: closing
with Cmd-Option-M while the pane owns focus previously unmounted the focused
scope. Both close paths now use the existing conversation focus fallback; marked
input remains guarded. The `PILOT_NEXT_MISSION_CONTEXT_CASE=shortcut-close` fixture
selector runs the two wide-light ordinary/pending cases, rejecting unknown or
zero-case selectors; the default native CI target still runs all seven cases.
Focused green verification on the composed delivery-diagnostics source passes:
ordinary shortcut close restores the original composer, real typing and reading
anchor; active-pending close retains a mounted focus scope and exact immutable
envelope. Matching target lint and the 46 registry/CI contracts pass, with 282
unchanged frozen inputs. No unrelated units or broad native sweep were rerun for
this close-path correction. Existing seven-case geometry/visual and six-case
metadata/lifecycle receipts are retained, not relabelled as fresh composition
runs.

Capture review caught a small-button/ResourceLabel height mismatch; member rows
now reuse the existing mission-browser's 54pt two-line contract, with measured
title/detail containment. Final qualification of that isolated visual correction
passes: seven native cases and matching target lint, with 277 unchanged frozen
inputs and 15 actual GPUI captures. No full mission-feature parity, production rollout, OS IME,
performance, GPU smoothness or release acceptance is claimed.
