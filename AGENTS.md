# AGENTS.md

## Project

Pilot runs background [pi](https://github.com/earendil-works/pi) agents on durable sessions
(`@earendil-works/pi-durable`) and exposes them through a local daemon and a native macOS app.

- `packages/protocol`: shared HTTP/WebSocket types between daemon and clients. Types only.
- `packages/kernel`: one worker process per session. Owns the Harness, its SQLite storage and the
  native Pi SDK kernel that loads the user's pi packages and extensions.
- `packages/daemon`: `pilotd`. HTTP + WebSocket API, session registry and worker supervision.
- `apps/macos`: SwiftUI app (SwiftPM, Command Line Tools only). `PilotCore` mirrors `packages/protocol`;
  change both together.

Docs to use when the task touches them:

- [PLAN.md](PLAN.md) is the spec. Read the section for the area you change (workspaces and policy in §5,
  missions §5.7, project memory §5.8, integrations §6, the app §7) and keep it current when scope changes.
- [DESIGN.md](DESIGN.md) holds the UI intent, state vocabulary and review checklist for UI changes.
- `scripts/bench` holds reopen, workspace and memory benchmarks for hot-path changes;
  [docs/performance-check.md](docs/performance-check.md) records a past CPU and memory audit and its method.
- Agent-facing text (the Pilot prompt in `packages/kernel/src/policy.ts`, tool descriptions and the bundled
  `pilot-artifacts` skill) is loaded on every turn or tool listing. Keep it short, state boundaries plainly,
  and move detail into skill references or tool descriptions that load only when needed.

## Working conventions

- TypeScript, ESM, `.ts` import extensions, strict mode. Node 24+.
- The Harness owns history and the model loop. The native SDK session never runs its own loop.
- Native tools are replay-unsafe: a crash during a tool yields an interrupted result.
- Keep the daemon bound to loopback until authentication exists.
- Swift state: use `@State` with plain values for view-local UI state (hover, expansion, form fields, busy
  flags). Keep `@StateObject` for models that own work, subscriptions or a lifetime, and for holders a parent
  shares with children, because `@State` re-evaluates its initial value on every view init.
- Build Swift through `apps/macos/scripts/{build,test,bundle}.sh`. With Command Line Tools only, the macOS 27
  SDK's `@State` macro has no plugin, so `scripts/swift-env.sh` falls back to an older installed SDK.
- Show user-visible UI changes with a SwiftUI artifact built from mock data (the `pilot-artifacts` skill has
  the details). It is a static screenshot, not the real views: say so, and say when no visual check was possible.

## Performance

- GUI responsiveness (smooth scrolling, typing and navigation) and daemon CPU, memory, I/O and event-loop load
  are requirements, not polish.
- Keep blocking I/O and expensive computation off the UI main thread and the daemon event loop. Bound
  concurrency, queues and retained data, and avoid repeated work and unnecessary view updates.
- Prefer event-driven updates over polling, coalesce high-frequency updates, and cancel obsolete work and
  release timers, subscriptions and resources when they are no longer needed.
- When a change touches a hot path, measure it with large sessions and streaming activity, compare before and
  after, and report any risk you could not verify.

## UI and design system

- Keep screens calm and focused: one primary action, progressive disclosure for the rest, and existing
  layouts, terminology and hierarchy. DESIGN.md explains the intent.
- `apps/macos/Sources/Pilot/Theme.swift` and the shared components are the design system. Reuse their tokens
  and components, add missing ones centrally with a note on their intended use, and evolve them incrementally
  rather than adding one-off styles or a parallel system.

## Formatting and checks

- Biome: tabs, width 120. `npm run fmt` / `npm run fmt:check`.
- Tests use `node:test` and `node:assert/strict`, beside their implementation as `*.test.ts`.
- Local checks use temporary directories and faux model providers, not real accounts. Run the ones that cover
  your change, fix failures it causes, and rerun them without asking: `npm run typecheck`, `npm test` (two
  test files at a time; `PILOT_TEST_CONCURRENCY=4 npm test` when the machine has headroom), and for Swift
  changes `apps/macos/scripts/test.sh` and `apps/macos/scripts/build.sh`.

## Repository safety

- This is a jj repository. Use `jj` for repository-modifying version-control operations.
