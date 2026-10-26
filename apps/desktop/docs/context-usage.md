# Read-only chat context usage

Use **Context…** in a Local chat's header. This native information dialog does
not resize the conversation/composer and has no policy or mutation actions.
Escape, the close button, or Done dismiss it through Kit's existing focus owner.
Opening is refused while an existing input has marked IME text.

The same control now includes a compact neutral ring and **Context reported**
when the existing summary supplies both safe nonnegative integer tokens and a
positive window. Hover or its accessible name reports exact used/window counts
and the unclamped percentage; click or keyboard activation opens the unchanged
details. The visual arc alone is bounded to 0–100%. Over-limit reports explicitly
disclose that cap. Unknown, invalid and partial reports retain **Context…** without
a gauge, including empty conversations. The control has fixed width across these
states, no animation, polling, severity thresholds or compaction action.

This is a native adaptation of MonoCode at
`26465c620977f3951d0a532a0f7db32c3c179007`:
`src/features/sessions/ui/ContextMeter.tsx` (`MeterRing`, 14pt ring, 2pt stroke,
skip the used arc at zero), and
`src/features/sessions/model/contextUsage.ts` (`contextRatio`, bounded visual ratio).
Copyright (c) 2026 Nick; the existing complete MIT notice remains in
[`../licenses/MONOCODE.txt`](../licenses/MONOCODE.txt). Upstream LICENSE and NOTICE
were reviewed at that exact local clone revision. NOTICE states non-affiliation
and provider-mark ownership; this adaptation copies no marks or assets. No web
runtime is imported. Upstream empty-history inference, 75/90 severity colors,
partial-reading merges and Compact now are deliberately not adopted. Pilot's
existing summary projection, identity-pinned reader and unknown freshness remain
authoritative. An open dialog also pins its navigation generation, so returning
to the same ID cannot revive that disclosure after navigation.

## Sources and coverage

- Swift's `ComposerUsage.swift` reads `SessionSummary.usage.context` and
  `usage.ai`. Next uses those same supported fields, not a visible-history token
  estimate or a guessed model/catalog context window.
- `packages/protocol/src/index.ts` defines optional `ContextUsage.tokens` and
  the window. Percent is derived only from valid nonnegative integer tokens
  and a positive window. Missing/invalid values remain **Unknown**, including
  when a worker parks and the daemon stops providing `context`. Actual reported
  zero is distinguishable from absence. Overage is not clamped away.
- `Sessions.usage` in `packages/daemon/src/sessions.ts` supplies live worker
  context separately from durable `aiUsage.summary`. Context has **no observation
  timestamp**. The dialog therefore always says **Freshness unknown**, **latest
  worker report**, and **not a live measurement**. It does not promote historical
  `ai.efficiency.context` into current context. Reconnection additionally marks
  retained figures as not current. No TTL invents confidence the contract lacks.
- AI direct and child token classes are separate cumulative reported figures,
  not a current context count or complete lifetime coverage. Reasoning is a
  subset of output and is not added. Costs are deliberately excluded, rather
  than presenting catalog estimates as billed or subscription spend.

## Identity, bounds and ownership

`context_usage.rs` retains ten optional safe-integer counters (160 bytes per
summary), no arbitrary wire text, costs, credentials or subscription fields.
The existing reader bounds frames, summary count (1000), update channels and
identity-gates Local connections before subscribing. Snapshot/session projection
replaces all usage fields, so absent data cannot retain an earlier worker's
context. There is no additional network read, cache, timer or remote fanout.

The dialog pins the exact canonical chat ID and observes the existing viewer.
It resolves that ID from the current summary set rather than storing a title-
matched reply. A different chat/page shows only a changed-chat message. Local
drafts cannot open the disclosure. No input/composer, model, subscription, budget,
daemon, settings or persistence behavior changes.

## Focused verification

From `apps/desktop`:

```sh
python3 scripts/check-scoped.py --unit context_usage --test context_usage --lint
```

Four pure cases cover missing/invalid/zero/over-limit values, derived percent,
content-private fixed-size projection, separate token classes and worker removal.
One real identity-pinned reader/faux-WebSocket case covers initial unknown,
updates, disappearance, exact ID separation, bounded teardown and GET-only
traffic without new usage reads. The offscreen native probe mounts the production
header/dialog at680/1100 in light/dark, clicks disclosure/sidebar/Done, dismisses
with Escape, asserts unchanged composer bounds and checks late navigation fences.
Optional captures use `PILOT_NEXT_CONTEXT_USAGE_DIR` and synthetic content only.
These are macOS scoped checks, not live account, OS input, motion, full-suite or
Linux/Wayland acceptance.

The meter adds two pure cases and a mounted six-state matrix (reported, unknown,
invalid, partial, reported zero and over-limit) at both widths/appearances. It
checks stable control bounds, exact descriptions, ring absence/presence, native
Tab traversal/Enter activation/Escape focus restoration and same-ID generation
invalidation. Existing composer IME and late other-chat source checks remain.
Captures include both the unobstructed header and open details. Checks use
`--unit context_usage --test context_usage --lint`, plus the `context_meter`
library filter under the shared verification slot. Rationale: only the bounded
usage presentation and existing header/dialog seam change; full suites stay in
CI. The fixed native arc has no transition or task-completion clock; static
captures are not FPS or operating-system IME proof.
