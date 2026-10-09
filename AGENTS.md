# AGENTS.md

## Project

Pilot runs background [pi](https://github.com/earendil-works/pi) agents on durable sessions
(`@earendil-works/pi-durable`) and exposes them through a local daemon and a native macOS app.
[PLAN.md](PLAN.md) is the spec and milestone plan; keep it current when scope changes.

- `packages/protocol`: shared HTTP/WebSocket types between daemon and clients. Types only.
- `packages/kernel`: one worker process per session. Owns the Harness, its SQLite storage and the
  native Pi SDK kernel that loads the user's pi packages and extensions.
- `packages/daemon`: `pilotd`. HTTP + WebSocket API, session registry and worker supervision.
- `apps/macos`: SwiftUI app (SwiftPM, Command Line Tools only). `PilotCore` mirrors `packages/protocol`;
  change both together.

## Working conventions

- TypeScript, ESM, `.ts` import extensions, strict mode. Node 24+.
- The Harness owns history and the model loop. The native SDK session never runs its own loop.
- Native tools are replay-unsafe: a crash during a tool yields an interrupted result.
- Keep the daemon bound to loopback until authentication exists.
- Swift: no `@State` (its macro plugin is missing from Command Line Tools); use `@StateObject` holders.
- For user-visible UI changes, use the `artifact` tool to show the result. Prefer `kind: "swiftui"`
  for native layout previews: supply a self-contained `struct ArtifactView: View` with mock data,
  inspect it with `action: "preview"` when available, then publish with `action: "create"` (or update an existing
  artifact). SwiftUI artifacts are static screenshots, not project-aware builds; call out that
  limitation when showing a prototype. If the tool or renderer is unavailable, explain why and
  provide another visual check rather than claiming a preview was verified.

## Performance

- Every change must consider GUI responsiveness and daemon CPU, memory, I/O and event-loop impact.
  Treat smooth scrolling, typing and navigation as requirements, not optional polish.
- Keep blocking I/O and expensive computation off the UI main thread and daemon event loop.
  Bound concurrency, queues and retained data; avoid repeated work and unnecessary view updates.
- Prefer event-driven updates over polling. Coalesce high-frequency updates where appropriate,
  and cancel obsolete work and release timers, subscriptions and resources when no longer needed.
- For changes affecting hot paths, verify with representative large sessions and streaming activity.
  Use relevant benchmarks or profiling, compare before and after, and report any unverified risks.

## UI consistency and simplicity

- Keep the UI clean, calm and focused. Prioritize primary actions and use progressive disclosure
  for secondary controls and details instead of overloading screens.
- Follow existing layouts, interaction patterns, terminology and visual hierarchy. Avoid introducing
  one-off styles or duplicate controls for the same action.
- Check changed UI at realistic window sizes and with long content, including loading, empty,
  error and disabled states. Preserve keyboard access, readable contrast and reduced-motion support.

## Design system

- Treat `apps/macos/Sources/Pilot/Theme.swift` and shared UI components as the foundation of the
  design system. Reuse them rather than adding screen-specific styling.
- Keep colors, typography, spacing, sizing, corner radii and motion consistent through shared
  semantic tokens. Add missing reusable tokens or components centrally instead of scattering literals.
- Define reusable components with consistent interaction and accessibility behavior. Document new
  patterns and their intended use alongside the shared implementation so future changes follow them.
- Evolve the design system incrementally as part of relevant UI work; do not introduce a parallel
  styling system or broad unrelated redesign.

## Formatting and tests

- Biome: tabs, width 120. `npm run fmt` / `npm run fmt:check`.
- Tests use `node:test` and `node:assert/strict`, beside their implementation as `*.test.ts`.
- Before finishing a change: `npm run typecheck` and `npm test`; for Swift changes also
  `apps/macos/scripts/test.sh` and `swift build --package-path apps/macos`.

## Repository safety

- This is a jj repository. Use `jj` for repository-modifying version-control operations.
