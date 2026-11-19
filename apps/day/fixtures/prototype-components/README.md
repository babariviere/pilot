# Component system prototype (throwaway)

A disposable browser mockup for design review. It is not Pilot app code: the app stays native (NSH).
Nothing here is approved for production. Open `index.html` in a browser. It needs no server or network.

Question: what should Pilot Day's component system be, so every screen is built from the same few parts?

- `?variant=A` Lines (one reading column), `B` Panes (sidebar, list, detail), `C` Blocks (sections as
  blocks on a canvas). The bottom bar and the left and right arrow keys switch direction.
- `?view=system|today|mission|settings`. System lists every part with its rule. Keys 1 to 4 switch view.
- `?theme=light|dark`. D switches appearance.

All three directions show the same invented day with colours from `apps/day/theme.json`.
Choosing a direction is feedback, not approval to build it.

## Round 2

`round-2.html` follows the feedback on round 1 (B too compact, C a good idea, all of it too generic).

- `?variant=D` Quiet (from Things and C), `E` Sharp (from Linear and B), `F` Forge (from tangled.org).
- `?nav=tabs|path|command|rail|sidebar` changes how you get around, with any style. N switches it.
- `?density=compact|regular|roomy` changes sizes, with any style. Minus and plus switch it.
- Command+K opens the palette. Decide on the card shows how an answer settles.

## Round 3

`round-3.html` takes round 2's E and F apart, with navigation fixed to Path.

- `?layout=panes|panel`: list and detail side by side, or one centred panel with tabs. L switches it.
- `?skin=E|F`: Sharp or Forge. S switches it. The arrow keys walk the four pairs.

## Round 4

`round-4.html` goes deep on the chosen direction: Panel layout, Forge skin, Compact density, Path navigation.

- `?font=system|inter|geist|hybrid|pixel|berkeley|iosevka` is the open choice. The arrow keys walk the fonts.
  They come from this Mac; only Geist loads from cdn.jsdelivr.net when it is not installed.
- `?view=system|today|mission|plan|settings`. System is the Parts sheet, the definition of every part.
- `?day=normal|busy|quiet|trouble` shows Today on four kinds of day. S switches it.
- `?narrow=1` shows a narrow window. W switches it.
- Tabs are real: `?tab=` filters Today, `?mtab=` holds a mission's Overview, Tasks, Chat and Changes.

## Verdict so far

Chosen over four rounds. This is feedback on a mockup, not approval to build.

- Layout: one centred panel split by hairlines, with tabs attached (round 2's F). Not side-by-side panes.
- Skin: Forge. Grid canvas, violet accent, mono numbers, marks built from squares.
- Density: Compact. Navigation: Path, with Command+K.
- Font: Geist with Geist Mono.
- Today's tabs filter. One question shows as a card and the others queue as rows under it.
- A quiet day shows the dithered sky inside the panel, at the size in round 4.
- Rejected: B as drawn (too compact with a sidebar), a sidebar, an off-centre two-column page.

Open: whether NSH can bundle Geist was not checked.
