# Read-only chat context usage

Use **Context…** in a Local chat's header. This native information dialog does
not resize the conversation/composer and has no policy or mutation actions.
Escape, the close button, or Done dismiss it through Kit's existing focus owner.
Opening is refused while an existing input has marked IME text.

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
