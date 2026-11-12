# Wayfinder map prototype (throwaway)

A disposable browser prototype for design review. It is not Pilot app code and is not
how Pilot is built: the app stays native (NSH). Nothing here is approved for production.
Open `index.html` in a browser (double-click it). No server, install or network is needed.

Question: how should a mission's Wayfinder map show what is settled, what is still
unknown and what happens next, and let you check where each answer came from?

- `?variant=A` **Map**: columns from Settled, through Open now and Waiting, to Fog of war and
  the Destination. Lines show what waits for what and what fog became. Select a card to
  inspect it; hover to trace its path.
- `?variant=B` **Outline**: a document. What happens next comes first, then Unanswered
  (grouped as interview, research and prototype), Settled with how each was settled,
  Fog of war and Build tasks. Open a row to inspect it.
- `?variant=C` **Rounds** (optional): a lighter map read top to bottom. Each planning round adds
  one row: what Pilot explored, what that produced (answers, decisions, Knowledge, prototype
  findings, new questions, fog) and the next steps it set up. Lines run from a next step to the
  later round that took it up. Select an output to see its source record and what it changed.
  Older rows stay as history. A planning round is each time Pilot updates the map from something
  new; interview rounds are one kind of input to it.
- `?variant=D` **Expedition** (a playful last experiment): the same records drawn as an expedition
  chart. Settled answers are inked islands, open questions sit on blank ground, fog of war is
  drawn as fog, trails show what waits for what, and each planning round is a numbered camp on
  Pilot's red route. The compass points at what needs you. Places keep their spot, so answers
  ink new ground and fog lifts in place. Select a place for field notes with its real sources.
  No points, progress bar or perpetual motion; it moves only when something changes.
- `?mission=big` (or **Small mission / Big mission** in the bottom bar) swaps in a big mock
  mission, "Pilot for small teams": 41 questions in six regions and 22 planning rounds. Every
  variant renders it, so you can see how each one holds up at that size. In D the chart
  changes shape for it:
  - **Regions with zoom.** The overview shows regions with their counts (needs you, settled,
    open, waiting, fog) and places as plain markers. Choose a region (on the chart or in the
    tabs above it) to zoom in and see labels. Markers keep their screen size while the land
    zooms. Esc or "Whole chart" zooms out.
  - **No route spaghetti.** Rounds in a row that explore the same region become one stay.
    The route only runs between fixed harbors on each region's coast, along one channel
    between the rows, so it never crosses places. Legs between the same two harbors share
    one lane that gets wider with each trip (×N). Only the last three legs stay strong; "All
    legs" shows the full history. A harbor badge says how many rounds Pilot spent there.
  - **Links between regions.** The overview shows one counted arrow per pair of regions
    ("2 waiting") instead of a line per question. Zoomed in, a link to another region is a
    small chip on the place ("from Accounts and sign-in ↗") that moves you there.
  - The small chart also fades legs older than the last five.
  The regions are mock data. In Pilot the coordinator would need to keep them.
- The bottom bar and the left/right arrow keys switch variants. The bottom bar's Panel holds
  walkthroughs, free play, the current state, a side-by-side comparison and About.
  Reset or reload starts over.
- All variants show the same mission, "Pilot on Linux desktops", taken from the Day mock
  planning world (`apps/day/native/src/plan_world.rs`). They use the native map's records and
  words: questions with a kind and a state, fog of war, original Decision and Knowledge
  sources, interview rounds, agreement and tasks. No new contract or tracker.
  Choosing a variant is feedback, not approval to build it.
- All variants use the visual language of the work prototype's variant A
  (`../prototype-work`, inline on Today): the same page header, sections, rows, inline detail,
  banners and evidence rows. Only the map-versus-outline structure differs.
  D leaves that look on purpose inside the chart only; the page around it is the same.

## Review in ten minutes

0. Open `?variant=D`, then the Panel, Walkthroughs, "Read the chart (D)". Press each step.
   Follow the compass, open camp 2 and the Decision 4 record, then watch research and your
   answers ink new ground and lift the fog. Is it fun enough for an occasional look beside B,
   and do the field notes still tell you what is settled, unknown and next?
   Then run "A big mission (D)": the same chart with 41 questions, regions, zoom and a
   bundled route. Does it still read? Switch to B with the big mission for comparison.
1. Open `?variant=C`, then the Panel, Walkthroughs, "How did we get here? (C)". Press each step.
   Open round 2's decision and its original record, follow "Keyring access" across rounds,
   then watch research and your answers add new rows. Compare with B: is C worth an
   occasional look next to the outline?
2. Open the Panel, then Walkthroughs, then "What is settled, and why?". Press each step.
   Open the original Decision 4 and interview round 1 records, then come back.
3. Press → to switch variant and run the same walkthrough. Compare where your eye goes.
4. Run "What needs me next?" in each variant: answer the interview, watch the map settle
   it, and watch fog turn into a precise research question.
5. Run "Research and a prototype report back" and "From map to build tasks". Check that
   research, prototype findings, interviews, fog and build tasks read as different things,
   and that nothing starts by itself.
6. Free play: click around. Keys: ↑ ↓ move, Return opens, Esc closes or goes back,
   ← → switch variant. In the interview: 1–9 pick, 0 opens "why", ← → move, ⌘Return submits.

C is laid out in columns when the page is wide enough. With the Panel and a selected item open
on a narrow window it stacks the columns and hides the lines; hide the Panel to get them back.
D's chart keeps its shape: on a narrow window it scrolls sideways, and everything on it is also
listed below it (Next on the route, Expedition log, Key).

Feedback that helps most: which variant (or which mix) makes "settled, unknown, next" clearest,
whether sources are easy enough to check, and what feels like too much. Earlier feedback: B is
the practical one and A is attractive but rarely needed; C tests a lighter, optional history
view beside B. D is the last, playful experiment; B Outline stays the baseline. Liking C or D
is not approval to build it.

Shape follows the upstream `prototype` skill (UI.md and LOGIC.md) from mattpocock/skills at
`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` (MIT, Copyright 2026 Matt Pocock), vendored in
[`packages/kernel/skills/mission-planning/upstream/prototype`](../../../../packages/kernel/skills/mission-planning/upstream/prototype).
Map words follow the vendored `wayfinder` skill in the same folder and Pilot's native map.
