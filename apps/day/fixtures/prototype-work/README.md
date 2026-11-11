# Work intake prototype (throwaway)

A disposable browser prototype for design review. It is not Pilot app code and is not
how Pilot is built: the app stays native (NSH). Nothing here is approved for production.
Open `index.html` in a browser (double-click it). No server, install or network is needed.

Question: where should incoming work (Slack, Linear) live, and does one work item
keep the agent's report, the PR merge, production release and the user's Done apart?
It also shows focused coordinator threads (light grilling, Wayfinder for larger
scope), mission outputs and read-only Linear cycles.

- `?variant=A` Inline on Today, `B` Triage from Today, `C` Separate Inbox.
  The bottom bar and the left/right arrow keys switch variants.
- The bottom bar's Panel holds walkthroughs, free-play simulation, the current state
  and a "where things live" table. Reset or reload starts over.
- All three variants use the same Northwind request, so you can compare them directly.
  Choosing a variant is feedback, not approval to build it.

## Review in ten minutes

1. Open the Panel, then Walkthroughs, then "Northwind, end to end". Press each step.
   Watch "Where this stands" on the item: agent, pull request, production, your check.
2. Press → to switch to B, run the same walkthrough, then do the same for C.
3. Try "Start not confirmed" and "Send it back" for the unhappy paths.
4. Try "Merged is not released" and "Bigger than a thread" for coordinator threads.
5. Open Linear, then a cycle and BIL-231, for ticket browsing and the duplicate prompt.
6. Free play: click around yourself. Keys: ↑ ↓ move, Return opens, Esc goes back,
   ← → switch variant, 1–9 pick an answer, 0 opens "why", ⌘Return sends.

Feedback that helps most: which placement (A, B, C or a mix) feels right, whether the
four status lines read clearly, and what feels like too much.

Shape follows the upstream `prototype` skill (UI.md and LOGIC.md) from
mattpocock/skills at `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` (MIT, Copyright
2026 Matt Pocock), vendored in
[`packages/kernel/skills/mission-planning/upstream/prototype`](../../../../packages/kernel/skills/mission-planning/upstream/prototype).
