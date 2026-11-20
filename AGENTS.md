# AGENTS.md

## Project

Pilot runs background [pi](https://github.com/earendil-works/pi) agents on durable sessions
(`@earendil-works/pi-durable`) and exposes them through a local daemon and a native macOS app.

- `packages/protocol`: shared HTTP/WebSocket types between daemon and clients. Types only.
- `packages/kernel`: one worker process per session. Owns the Harness, its SQLite storage and the
  native Pi SDK kernel that loads the user's pi packages and extensions.
- `packages/daemon`: `pilotd`. HTTP + WebSocket API, session registry and worker supervision.
- `apps/day`: Pilot Day, the only desktop app, on Apple Silicon macOS. See the [Day guide](apps/day/README.md)
  for Native Shell builds, fixtures and checks.
- `crates`: [shared Rust crates](crates/README.md). The updater and power helper have
  separate manifests and lockfiles. Day packaging scripts live in `apps/day/scripts`.
- [`apps/day/macos`](apps/day/macos/README.md): shared native helpers, assets and runtime/release scripts, not a GUI app.

Docs to use when the task touches them:

- [README.md](README.md) is a short product introduction and setup entry point. Keep it short.
  Update concise feature guides in [docs/README.md](docs/README.md) when user-facing behavior changes.
- Keep lasting contracts and runbooks beside the code they cover.
- [DESIGN.md](DESIGN.md) holds the UI intent, state vocabulary and review checklist for UI changes.
- `scripts/bench` holds reopen, workspace, memory and daemon-stall benchmarks for hot-path changes;
  [docs/technical/performance-check.md](docs/technical/performance-check.md) records a past CPU and memory audit and its method.
- Agent-facing text (the Pilot prompt in `packages/kernel/src/policy.ts`, tool descriptions and the bundled
  `pilot-artifacts` skill) is loaded on every turn or tool listing. Keep it short, state boundaries plainly,
  and move detail into skill references or tool descriptions that load only when needed.

## Agent skills

### Issue tracker

Track work in Pilot missions and tasks. See [issue-tracker.md](docs/agents/issue-tracker.md).

### Domain docs

Single context: consult the glossary and relevant ADRs before design or refactoring. See [domain.md](docs/agents/domain.md).

## Working conventions

- The source cutover removes Pilot Next GPUI. Keep installed apps, services and user data unchanged.
  Preserve Day's history readers and explicit migration paths. Backend retirement is separate.
- For an authorized private install or update to `~/Applications/Pilot.app`, use
  [update-pilot](.agents/skills/update-pilot/SKILL.md). Linux desktop is deferred; no public Day publication.

- For code review, read [CODING_STANDARDS.md](CODING_STANDARDS.md).
- TypeScript, ESM, `.ts` import extensions, strict mode. Node 24+.
- The Harness owns history and the model loop. The native SDK session never runs its own loop.
- Native tools are replay-unsafe: a crash during a tool yields an interrupted result.
- Keep the daemon bound to loopback until authentication exists.
- Shared Swift helpers build through `apps/day/scripts/build-native-helpers.sh`.
  `apps/day/macos/Package.swift` covers helpers only. Preserve their shared consumers.
- Before building a user-visible UI change, show the design as an NSH mockup built from mock data, and say it is a
  mockup. After it lands, show the real Day views before and after with `apps/day/scripts/before-after.sh`
  ([apps/day/README.md](apps/day/README.md#before-and-after-captures)) as image artifacts (the `pilot-artifacts`
  skill has the details). Say when no capture was possible.

## Performance

- GUI responsiveness (smooth scrolling, typing and navigation) and daemon CPU, memory, I/O and event-loop load
  are requirements, not polish.
- Keep blocking I/O and expensive computation off the UI main thread and the daemon event loop. Limit
  concurrency, queues and kept data, and avoid repeated work and unnecessary view updates.
- Prefer event-driven updates over polling, coalesce high-frequency updates, and cancel obsolete work and
  release timers, subscriptions and resources when they are no longer needed.
- When a change touches a hot path, measure it with large sessions and streaming activity, compare before and
  after, and report any risk you could not verify.

## UI and design system

- Pilot Day's look lives only in its library, `apps/day/ui` (guide: `apps/day/ui/README.md`); screens compose parts.
  DESIGN.md "Pilot Day" holds its intent.
- For interface work, read and use `.agents/skills/frontend-design/SKILL.md` for
  planning and visual critique. Apply it within `DESIGN.md` and the approved product
  brief, using the native renderer and shared tokens rather than importing web defaults.
- Keep screens calm and focused: one primary action, progressive disclosure for the rest, and existing
  layouts, terminology and hierarchy. DESIGN.md explains the intent.
- Reuse Day's shared tokens and components. Add missing tokens centrally with a note on their
  intended use rather than adding one-off styles or a parallel system.

## Formatting and checks

- Use concrete names and plain language in code, prompts and guides. Prefer "limited" to "bounded",
  "saved" or "kept" to "retained", and "writing" to "authoring" where meaning stays clear.
  Keep precise technical terms, wire values and stored field names when compatibility requires them.

- Dependencies use pnpm (`pnpm install`). Each workspace's `node_modules` clones files from the shared
  pnpm store, so per-session installs cost little disk. Declare every imported package in the importing
  package's `package.json`; pnpm does not expose undeclared transitive dependencies.
- Biome: tabs, width 120. `pnpm fmt` / `pnpm fmt:check`.
- Tests use `node:test` and `node:assert/strict`, beside their implementation as `*.test.ts`.
- See [testing.md](docs/technical/testing.md) for suite selection, replay-only fixtures, timeouts and concurrency.
  Use `pnpm test:fast` for quick feedback and `pnpm test` for the full suite.
- Local checks use temporary directories and faux model providers, not real accounts. Run the ones that cover
  your change, fix failures it causes, and rerun them without asking: `pnpm typecheck`, `pnpm test`.
  For native app changes, use the [Day checks](apps/day/README.md#check).

## Repository safety

- This is a jj repository. Use `jj` for repository-modifying version-control operations.
