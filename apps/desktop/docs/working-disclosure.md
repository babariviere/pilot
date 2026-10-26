# Stable Working disclosure

Working groups start collapsed. Activity, streamed output, success, failure and
unknown results update the compact header, not disclosure intent. The existing
canonical-call choice map retains explicit open/closed choices across regrouping
and virtualized unmounts. The most recent explicit choice wins on merge. Child
details remain independently controlled and lazily constructed. Existing selected
assistant-note adoption still preserves its selected document when folded into work.

Failure and unknown counts stay in the nonshrinking header status slot, with the
existing error styling. Opening the group exposes every retained step, including
early failures; no output, exact-copy path, detail bound or status is removed.

The first explicit opening may reveal a group taller than the viewport. WorkView
calls the existing transcript disclosure handler synchronously before changing its
choice, so tail-follow is paused before expanded measurement. The previous emitted
event could arrive after that measurement and move the clicked header offscreen.
No scroller, execution, model, transport or backend contract changes.

## Focused synthetic verification

- `check-scoped.py --unit work_view::preview_tests --native-probes`: 3 tests,
  covering default/explicit intent, canonical merge/split and critical preview bounds.
- `check-scoped.py --unit transcript_view::work_tests --test disclosure --lint`:
  7 work tests, matching library/native Clippy, and the offscreen native production
  root. Covers exact copy, hidden-parser laziness, selection, real unmount/regroup,
  clicked-header anchors, user wheel/Latest follow resumption and note adoption.
- The native probe adds 72 transition records: 680/1100, light/dark, unopened/open/
  closed, active/stream/success/next-tool/failure-plus-unknown/settled. It asserts
  retained group identity, stable header position, truthful header labels/counts,
  child independence and reachable exact failure output. Existing long-group anchor,
  thinking and semantic-tool journeys are retained with explicit initial opening.

Both pure and mounted regressions failed against the old activity-driven default.
The final selected run passed with 207 PRE/POST inputs identical. Actual native
compact-header screenshots were inspected in narrow light and wide dark. These are
synthetic UI/geometry checks, not live actions, OS-input or smoothness/performance
acceptance. No full desktop suite, visible benchmark or CI polling was run.
