---
name: pilot-next-design
description: Plan, implement, and review Pilot Next GPUI interfaces for calm hierarchy, just enough information, and focus on what matters. Use for screens, navigation, controls, conversation and artifact presentation, or visual critique.
---

# Pilot Next design

The user's preference is a calm interface with just enough information, no crowding,
and clear emphasis on what matters. Restraint is the design, not a lack of polish.
This skill is a decision workflow, not another component or token specification.

## Read the existing contracts

- [DESIGN.md](../../../DESIGN.md) owns product intent, screen roles and state vocabulary.
- [Desktop UI vocabulary](../../../apps/desktop/docs/design-system.md) owns the app's
  component choices, tokens, geometry, exceptions and verification contract.
- [frontend-design](../frontend-design/SKILL.md) supplies planning and critique;
  its generic calls for boldness, new typography or palettes do not override this
  product's restraint, native conventions or existing tokens.
- [gpui-kit](../gpui-kit/SKILL.md) supplies component and lifecycle mechanics. Read
  its relevant guides and verify current signatures before changing implementation.

Read the nearest real view, its guarded handlers and relevant checks before proposing
a change. Follow the current approved scope and priorities. A design improvement does
not authorize missing features, new host capabilities or a framework replacement.

## 1. Name the decision before drawing controls

Write a short plan answering:

- What is this screen's job, and which object and scope is the user viewing?
- What needs the user now, what is still working, and what can quietly wait?
- What is the next meaningful action and its truthful result?
- Which existing owner holds data, identity, input, focus and pending operations?
- What remains visible, what moves into disclosure, and how does the keyboard reach it?

For example: a project overview orients the user to that project; it is not a debug
console. A conversation leads with readable content and outcomes, not transport state.
An artifact gallery leads with the artifacts, not counts of renderer internals.

## 2. Subtract, retain, reveal

Give the current workflow one clear primary action. Use an emphasized commit button
for an actual decision, not every ordinary command. Stop, recovery and other essential
actions must remain available when applicable; do not enforce an arbitrary control count.

| Review | Decision |
| --- | --- |
| Subtract | Remove duplicate permanent controls, repeated scope labels, badge/count walls, debug IDs and ornamental containers. Fix hierarchy before shrinking type. |
| Retain | Keep enough identity/scope and readable content to make a decision. Preserve relevant errors, stale data, pending/uncertain delivery, unsaved input, permission boundaries, Stop and retry. |
| Reveal | Put secondary commands in a discoverable menu or contextual disclosure. Keep the full detail and a named keyboard/pointer path; do not delete a capability to reduce clutter. |

Prefer a content title, a concise state/reason and the next action over a stack of
status rows. Loading is not empty; stale data is not current; working is not Needs you.
Keep the last usable content on failure. Never replace uncertainty with Saved or Done
without the required acknowledgment. Error text and recovery belong beside what failed.

No essential information may depend only on hover, color, a clipped suffix or a tiny
font. Familiar icon actions need accessible names and useful shortcut/scope tooltips;
an unfamiliar action usually needs a label. Keep active filters and selection apparent,
and restore focus when a menu or disclosure closes.

## 3. Compose the native vocabulary

Use [ui.rs](../../../apps/desktop/src/ui.rs),
[appearance.rs](../../../apps/desktop/src/appearance.rs),
[AppIcon](../../../apps/desktop/src/app_icon.rs) and the compiled
[catalog](../../../apps/desktop/src/catalog_probe.rs). Reuse `Text`/`TextRole`,
`Space`, `Radius`, semantic surfaces and the existing action/field/resource/notice
components. Do not invent a palette, typography scale, popup or parallel framework.
Resolve a genuinely missing shared role centrally under the design-system contract.

Use whitespace, alignment and reading order before borders or nested cards. Preserve
the app's neutral navigation/selection treatment without losing keyboard focus or
control behavior. Keep readable text, usable hit targets and light/dark hierarchy.
The composer keeps the documented 76pt tray/34pt editor geometry and opaque white
editor on soft gray tray in light mode, with the corresponding card/tray dark roles.
Compact does not mean flattening both surfaces or adding another padded editor wrapper.

Use meaningful Bayer activity and existing word fade, not decoration on every control.
Reuse the bounded shared motion owner, respect reduced motion and hidden/idle state,
and never animate streaming layout height or introduce per-control clocks.
Real thumbnail tiles are legitimate artifact content; this is not permission for a
dashboard-card grid around unrelated metadata or eager execution to create previews.

## 4. Apply the feedback, not a generic template

These are preferred directions for scoped changes, **not claims of shipped behavior**.
Check the actual implementation and retained alternatives first.

| Before | Preferred direction and capability to retain |
| --- | --- |
| Prominent Back/Forward text row | Quiet contextual icon actions with names and shortcut hints; retain history, existing keyboard paths and focus restoration. |
| Permanent Include archived checkbox | A discoverable filter menu with honest active scope/state; archived history remains reachable and read-only where required. |
| Permanent Earlier and Latest buttons | Scroll-driven history and a contextual recovery/return-to-latest affordance when relevant; keep explicit failure retry, pagination and the reading anchor. |
| Large blocks of tool arguments/output | Concise work/outcome summary with progressive arguments, output and diff disclosure; failed or uncertain work stays findable. |
| Add project hidden or expanded into a giant debug form | A discoverable Add project action and focused folder/confirmation flow; show only decision-relevant scope, pending/error and retry information. Never silently create or retarget a chat. |
| Artifact text list or eager preview wall | A current-chat thumbnail gallery when implemented, with titles/type/revision and honest placeholders; exact selection and detail/back navigation, bounded lazy previews, no global crawl or per-tile generated-source execution. |

Presentation must preserve canonical resource identity, drafts, native input capture and
flush, immutable pending-delivery identity, IME/preedit, Unicode editing, selection/copy,
focus, reader anchoring, streaming and Stop. Keep I/O/decode/expensive work off the UI
thread with bounded queues, caches and concurrency. Styling is not authority to weaken
these guards or to hide a failed write.

## Review before calling a UI change done

- [ ] State the screen's job, important information and next action in one short paragraph.
- [ ] Name what was subtracted, retained and revealed, including the alternate keyboard path.
- [ ] Check content before chrome: can the user read, decide and recover without guessing?
- [ ] Check actual native narrow/wide layouts (680/1100 where used by the existing probes),
      light/dark, long Unicode labels/content, and loading, empty, error, stale, disabled,
      read-only, permission, pending/uncertain and unsaved states where applicable.
- [ ] Exercise the affected pointer/keyboard/focus/IME paths and preserved draft, delivery,
      scroll/selection/stream/Stop behavior through the relevant synthetic checks.
- [ ] Inspect actual bounds, wrapping, clipping and targets. Do not widen tolerances or
      shrink text merely to make a capture pass. Inspect shared component/catalog adoption.
- [ ] Verify motion and hot-path cost separately when changed, using approved representative
      measurements and reduced motion. No new visible benchmark without approval.
- [ ] Report exact source and checks, what remains unverified, and requested user review.
      Static captures or mocks cannot prove motion, performance, OS IME/AX or acceptance.

For UI implementation, follow the existing verification wrappers and shared resource
admission. Documentation-only work needs link/frontmatter/scope checks, not app builds.
Keep built-in accessibility; dedicated AX and Wayland acceptance remain separately deferred.
