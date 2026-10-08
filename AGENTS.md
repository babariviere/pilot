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

## Formatting and tests

- Biome: tabs, width 120. `npm run fmt` / `npm run fmt:check`.
- Tests use `node:test` and `node:assert/strict`, beside their implementation as `*.test.ts`.
- Before finishing a change: `npm run typecheck` and `npm test`; for Swift changes also
  `apps/macos/scripts/test.sh` and `swift build --package-path apps/macos`.

## Repository safety

- This is a jj repository. Use `jj` for repository-modifying version-control operations.
