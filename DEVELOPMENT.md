# Development reference

Start with [Day development](apps/day/README.md). It is the sole desktop app,
for Apple Silicon macOS. [Shared Rust crates](crates/README.md) and
[macOS support](apps/day/macos/README.md) are not app entry points.

### Build from source

Use **Node 24+** and the pnpm version pinned in `package.json`. Follow the Day
README for its toolchain, build and isolated launch instructions.

```sh
git clone https://github.com/babariviere/pilot.git
cd pilot
pnpm install
```

To run only the daemon in the foreground:

```sh
pnpm dev:daemon
```

Don't start a second daemon on the same port as the app-managed one. Use a separate `PILOT_HOME` and
`PILOT_PORT` for isolated development state.

### Find code by feature

Start in the package or app that owns the change. Within it, put implementation,
tests and feature fixtures together. For example, a mission-planning change
usually starts in one of these folders:

| Concern | Start here |
| --- | --- |
| Day screens and feeds | [`apps/day/missions/planning`](apps/day/missions/planning/) |
| Day native planning | [`apps/day/native/src/planning`](apps/day/native/src/planning/) |
| Daemon mission planning | [`packages/daemon/src/missions/planning`](packages/daemon/src/missions/planning/) |
| Worker tools and permissions | [`packages/kernel/src/missions`](packages/kernel/src/missions/) |
| Shared wire types | [`packages/protocol/src/missions`](packages/protocol/src/missions/) |

Keep package exports, boot entry points and package manifests where their callers
expect them. A source move does not change storage locations or wire names.

### Debug project-memory compaction

Each project's memory directory under `$PILOT_HOME/memory/<project-id>/` retains
`compaction-latest.json` and, after a failure, `compaction-failure.json`. The default home is
`~/.local/share/pilot` (or `$XDG_DATA_HOME/pilot`). Inspect locally, for example:

```sh
python3 -m json.tool "$HOME/.local/share/pilot/memory/PROJECT_ID/compaction-failure.json"
```

These owner-only files contain **private memory text**: the source prompt, up to three model requests
and responses (text and tool submissions, not reasoning), validation errors and exact UTF-8 byte counts,
model, timing, and outcome. Do not share them unredacted. Each file is capped at 128 KiB; clipped
diagnostic fields explicitly report `truncated` and their original byte count. A subsequent success
does not overwrite the last failed run. General daemon logs do not contain these payloads.
Requests are recorded before contacting the model, so a failed or stalled call is inspectable even
without a response. Each attempt records its start and, when available, finish time.
An interrupted process may leave the latest record marked `running`; completed failures use the
existing automatic retry/backoff. Deleting these diagnostic files does not delete project memory.

### Checks

```sh
pnpm fmt:check
pnpm typecheck
pnpm test:fast                    # quick unit and offline feedback
pnpm test                         # full gate, including integration and stress tests
```

Linux remains useful for portable backend checks; Linux desktop is deferred. Use the
[Day checks](apps/day/README.md#check) for native work on Apple Silicon. Qualification
bundles are test evidence, not install or release artifacts. For an authorized update to
`~/Applications/Pilot.app`, use the [private install path](docs/getting-started.md#private-install).
There is no new public Day publication.

See [testing](scripts/testing.md) for suite selection, offline fixtures, and local measurements.
Agents publish NSH and image artifacts. There is no screenshot preview host,
browser installation or generated SwiftUI compilation. Use [Day fixtures](apps/day/README.md#screen-captures) for native fidelity checks.

### Dependency updates

[`renovate.json`](renovate.json) configures reviewed update PRs for pnpm and maintained Rust dependencies,
including required Anthropic auth. Pi SDK packages and workspace overrides update together; `pi-extensions` tracks upstream
`main` while remaining pinned to a full commit SHA. Renovate opens reviewed update PRs for both
`pi-extensions` and Anthropic auth. The native npm
manager refreshes `pnpm-lock.yaml` with dependency updates, and Renovate reports artifact generation
success or failure on every update PR.
Automerge is disabled. Renovate PRs also check an isolated production runtime before and after ZIP
relocation in the macOS Node CI job. Review those checks and the existing tests before merging.

Day's native host, the updater, and the power helper each use a separate Cargo manifest and lockfile.
Review toolchain updates and the updater's parser-specific ZIP pin separately. See
[dependency update policy](scripts/renovate.md) for the inventory and intentional exceptions.

Renovate runs through the [Renovate GitHub App](https://github.com/apps/renovate).

### Architecture

```text
Pilot.app (Day, Native Shell)
    │ HTTP / WebSocket on loopback
    ▼
pilotd (per-user launchd agent)
    │ fork + IPC, one worker per session
    ▼
Kernel worker
    ├── pi-durable Harness: SQLite history, tasks and model loop
    └── native pi SDK: tools, prompts, extensions and provider authentication
```

| Path                                             | Responsibility                                                  |
| ------------------------------------------------ | --------------------------------------------------------------- |
| [`crates`](crates/README.md)               | Standalone updater and power helper                             |
| [`apps/day`](apps/day/README.md)           | Native Shell app and typed native host                          |
| [`apps/day/macos`](apps/day/macos)         | Shared helpers, assets and runtime/release scripts              |
| [`packages/daemon`](packages/daemon)       | HTTP/WebSocket API, sessions, workspaces and worker supervision |
| [`packages/kernel`](packages/kernel)       | Durable agent worker and native pi SDK integration              |
| [`packages/protocol`](packages/protocol)   | Shared client/daemon types                                      |
| [`packages/artifacts`](packages/artifacts) | Artifact storage, preview rendering and bundled libraries       |

The Harness owns history and the model loop. The native SDK supplies tools and extensions, not a second
model loop. Keep native client decoders in sync with the shared protocol.

The daemon owns shared model discovery for its host and agent directory. Concurrent worker startups
reuse one catalog pass, and later reads revalidate model definitions, cached catalogs, credentials and
revocation fences. Project scopes, extension providers, virtual routing and request authentication stay
in each worker. Catalog snapshots contain metadata and configuration checks, not credentials or proof
of successful provider authentication. Unchanged models are reused in place; endpoints, request headers
and other transport settings stay local. See [catalog tests and measurements](scripts/testing.md#shared-model-discovery).

### Configuration and boundaries

See [tool access by role](packages/kernel/src/runtime/tool-access-by-role.md) and
[system prompts by role](packages/kernel/src/runtime/system-prompts-by-role.md) for capability boundaries and prompt composition.
See [refactor decisions](untangle-follow-up.md) for ownership boundaries to preserve.

Legacy event-watch records remain on disk but have no active service or API.
Production no longer starts their chat, PR, Linear or mission sources, reconciles targets, retries
follow-through or delivers notices. Saved instructions are retained as history, not executed.
Mission notices and ordinary chat PR tracking continue independently.

| Variable                         | Default                                            | Purpose                                                                                                         |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PILOT_HOME`                     | `~/.local/share/pilot` (or `$XDG_DATA_HOME/pilot`) | Local session data and managed repositories                                                                     |
| `PILOT_PORT`                     | `4319`                                             | Daemon port                                                                                                     |
| `PILOT_AGENT_DIR`                | pi's agent directory                               | Pi settings, packages and authentication                                                                        |
| `PILOT_WORKSPACE_RETENTION_DAYS` | unset (immediate)                                  | Private workspace discard delay; explicit positive days delay deletion, explicit `0` disables automatic cleanup |
| `PILOT_PERF_TIMINGS`             | enabled                                            | Set to `0` to disable local, content-free request timing logs for new workers                                   |

These are daemon environment variables. The app-managed daemon runs under launchd; exporting a variable
in your terminal does not change an already running daemon.

For diagnostic behavior and privacy limits, see the [request timings](packages/kernel/src/diagnostics/request-timings.md),
[lifecycle diagnostics](packages/daemon/src/runtime/diagnostics/lifecycle-diagnostics.md), and [telemetry contract](packages/telemetry/telemetry-contract.md).
For native diagnostic controls, see [Day diagnostics](apps/day/native/src/diagnostics/native-diagnostics-controls.md).
