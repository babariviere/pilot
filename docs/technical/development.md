# Development reference

The source/build instructions below include the legacy Swift app. For the current Rust desktop,
start with [desktop development](../../apps/desktop/README.md) and its scoped check scripts.


### Build from source

Use **Node 24+**, the pnpm version pinned in `package.json`, and **Swift 6.2+** on macOS. Xcode Command Line
Tools are sufficient with a compatible SDK. On SDKs where SwiftUI's `@State` requires an Xcode-only macro
plugin, the build scripts select an older installed SDK; install full Xcode if none is available.

```sh
git clone https://github.com/babariviere/pilot.git
cd pilot
pnpm install
pnpm app:macos
open apps/macos/build/Pilot.app
```

The development app uses the checkout and local Node runtime. To run only the daemon in the foreground:

```sh
pnpm dev:daemon
```

Don't start a second daemon on the same port as the app-managed one. Use a separate `PILOT_HOME` and
`PILOT_PORT` for isolated development state.

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
apps/macos/scripts/lint.sh        # pinned SwiftLint correctness checks, no build needed
apps/macos/scripts/test.sh        # Swift tests
apps/macos/scripts/build.sh       # native app build
```

CI runs portable Node tests and typechecking on Linux, with a smaller macOS lane for native behavior
and packaging, on PRs (`pr.yaml`) and after merging (`main.yaml`). Tests never block a release:
`release.yaml` runs Release Please on every main push and, for a new stable draft, builds the macOS ZIP
and the macOS/Linux Rust GUI packages from the release tag, then signs and publishes those same artifacts.
Rust GUI signing/trust and native full-payload qualification are explicit publication prerequisites;
future releases no longer publish a standalone headless Linux runtime. Swift distribution is preserved.
See [Rust GUI releases](../../apps/desktop/docs/releases.md) for the required configuration and remaining gates.

See the [reliability roadmap](reliability/roadmap.md) for current risks and verification plans.

See [testing](testing.md) for suite selection and offline fixtures, and the
[CPU/memory](performance-check.md) and [I/O](io-performance-check.md) audits for measurement methods.
For agent-side artifact preview screenshots, install the optional renderer with `pnpm artifacts:browser`.
Publication still works without it.

### Dependency updates

[`renovate.json`](../../renovate.json) configures reviewed update PRs for pnpm and maintained Rust dependencies,
including required Anthropic auth. Pi SDK packages and workspace overrides update together; `pi-extensions` tracks upstream
`main` while remaining pinned to a full commit SHA. Its updates are paused until upstream `main` includes
Pilot's embedding exports; the current pin stays on the compatible embedding commit. The native npm
manager refreshes `pnpm-lock.yaml` with dependency updates, and Renovate reports artifact generation
success or failure on every update PR.
Automerge is disabled. Renovate PRs also check an isolated production runtime before and after ZIP
relocation in the macOS Node CI job. Review those checks and the existing tests before merging.

Cargo covers the GPUI desktop, visual worker and independent updater. Toolchains, source-patched GPUI,
the updater's parser-specific ZIP pin and experimental comparison baselines stay manual. See
[dependency update policy](renovate.md) for the inventory and intentional exceptions.

Renovate runs through the [Renovate GitHub App](https://github.com/apps/renovate). Re-enable the
`pi-extensions` package rule only after upstream `main` includes Pilot's embedding exports and the
production runtime checks pass.

### Architecture

```text
Pilot.app (SwiftUI + libghostty)
    │ HTTP / WebSocket on loopback
    ▼
pilotd (per-user launchd agent)
    │ fork + IPC, one worker per session
    ▼
Kernel worker
    ├── pi-durable Harness: SQLite history, tasks and model loop
    └── native pi SDK: tools, prompts, extensions and provider authentication
```

| Path | Responsibility |
| --- | --- |
| [`apps/macos`](../../apps/macos) | Native app, terminal, artifact viewer and `PilotCore` protocol mirror |
| [`packages/daemon`](../../packages/daemon) | HTTP/WebSocket API, sessions, workspaces and worker supervision |
| [`packages/kernel`](../../packages/kernel) | Durable agent worker and native pi SDK integration |
| [`packages/protocol`](../../packages/protocol) | Shared client/daemon types |
| [`packages/artifacts`](../../packages/artifacts) | Artifact storage, preview rendering and bundled libraries |

The Harness owns history and the model loop. The native SDK supplies tools and extensions, not a second
model loop. Keep protocol changes in sync with `apps/macos/Sources/PilotCore`.

The daemon owns shared model discovery for its host and agent directory. Concurrent worker startups
reuse one catalog pass, and later reads revalidate model definitions, cached catalogs, credentials and
revocation fences. Project scopes, extension providers, virtual routing and request authentication stay
in each worker. Catalog snapshots contain metadata and configuration checks, not credentials or proof
of successful provider authentication. Unchanged models are reused in place; endpoints, request headers
and other transport settings stay local. See [catalog tests and measurements](testing.md#shared-model-discovery).

### Configuration and boundaries

See [tool access by role](tool-access-by-role.md) and
[system prompts by role](system-prompts-by-role.md) for capability boundaries and prompt composition.

Legacy event-watch records remain on disk but have no active service or API.
Production no longer starts their chat, PR, Linear or mission sources, reconciles targets, retries
follow-through or delivers notices. Saved instructions are retained as history, not executed.
Mission notices and ordinary chat PR tracking continue independently.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_HOME` | `~/.local/share/pilot` (or `$XDG_DATA_HOME/pilot`) | Local session data and managed repositories |
| `PILOT_PORT` | `4319` | Daemon port |
| `PILOT_AGENT_DIR` | pi's agent directory | Pi settings, packages and authentication |
| `XDG_CONFIG_HOME` | `~/.config` | Pilot settings in `pilot/database.json` and `pilot/tracking.json` |
| `PILOT_WORKSPACE_RETENTION_DAYS` | `1` | Archived workspace cleanup delay; `0` disables cleanup |
| `PILOT_PERF_TIMINGS` | enabled | Set to `0` to disable local, content-free request timing logs for new workers |

These are daemon environment variables. The app-managed daemon runs under launchd; exporting a variable
in your terminal does not change an already running daemon.

[Local request timings](request-timings.md) separate preparation, provider waiting and streaming.
They stay outside the transcript, have bounded private storage, and are never exported.
[Local lifecycle diagnostics](lifecycle-diagnostics.md) retain bounded, content-free startup, pause, quota,
connectivity, recovery and parking transitions without waking parked workers.
[Agent diagnostics](agent-diagnostics.md) combine those records with request timings and daemon health in an
on-demand, runtime-restricted specialist and host-qualified read-only API that never wakes a parked worker. Use
**Diagnose this chat** from a chat's More menu, or **Ask about Pilot** from Help, to open
an explicit setup sheet and choose the specialist's model and thinking level. Both accept an optional
investigation reason or bug report (up to 8 KiB UTF-8). Ask about Pilot also offers a host-qualified chat selector,
defaulting to **No chat**. Without a selected chat it diagnoses Pilot on the
selected verified host through an explicit app scope, with no hidden Control row or chat target. The report becomes
only the specialist chat's bounded
opening user message, never telemetry, diagnostic evidence or target authority. The created chat is visibly labeled
**Diagnostics** in the sidebar and chat header, with its admitted app or host-qualified chat scope and read-only
boundary.

Pilot Next on macOS restores **Help → Ask about Pilot…** as a separate Local diagnostic draft.
Sending creates the existing read-only diagnostics role with exact host identity and the daemon's default model,
not a Build or coordinator chat. Existing app-scoped and chat-focused diagnostic conversations accept replies
and Stop again; archived/continued chats remain read-only. The composer identifies the role and refuses image
attachments and project-path completion. This first slice does not include Swift's focus/model setup or repair
confirmation UI. Settings → Diagnostics still reviews only Next's private numeric desktop capture, not daemon logs.
The specialist can inventory existing sanitized sources. Its **performance** context selector reads the existing
bounded daemon CPU/memory, event-loop and operation snapshot through sanitization, on that daemon only.
It does not gain Next's private tracing files, arbitrary filesystem/shell/MCP access or provider-refresh authority.

Diagnostics can also read opt-in, local-only daily feature-usage aggregates across chats, independently of remote
export. Settings → Diagnostics → Local feature usage explains its seven-day retention and clear/disable controls.
Missing, dropped or disabled observations remain unknown, not zero. See [feature evidence](feature-adoption.md).
Structured [Slack/Linear refresh health](refresh-health.md) also distinguishes actual progress, queued/backoff
work and per-channel coverage from old checkpoints, without contacting a provider to answer a diagnostic read.
It includes bounded background-job observations and private restart history, kept separate from current liveness
under local operational collection/clear controls. Historical data never restores a scheduler, queue or retry.
Its descriptive chat title remains independent and is generated through the normal
bounded title lifecycle: a submitted reason seeds the title, while a reasonless setup waits for the first substantive
specialist reply rather than naming the fixed diagnostic instruction. The readable fallback remains if title
generation is unavailable, and a user rename always wins. Titles and title context stay out of telemetry. Cancel
creates nothing, and unavailable,
missing or replaced selections fail without falling back to Local. A selected chat is focus, not an access gate.
Diagnostics always has bounded, sanitized app-wide read access to available chats and archived history, usage/cost/
informational budgets, failures, retained mission/tasks and local issue records. Ordinary Ask/Build stay isolated.
Trusted linked-host reads use already-connected verified native routing; offline/unsupported/partial evidence stays
explicitly unavailable. No chat means app-wide investigation, never a hidden Control target. Every specialist can inventory and search a fixed,
path-free catalogue of bounded sanitized Pilot daemon, worker, native report and admitted-target operational logs on
its selected host. App-scoped sessions expose host sources while marking target-only lifecycle, request-timing and
tool sources unavailable. Native Mac app event/error-code logs are privately bounded, and verified owned Linux
services expose bounded retained Pilot-only journal history. Missing or unsupported logs/reports remain explicit gaps, not proof
that no failure occurred. The reader rejects symbolic links and arbitrary files, uses opaque bounded continuations
and excerpts, never wakes or probes the target, and does not copy logs into telemetry or repair handoffs. Logs and
history stay local, are treated as untrusted data, and grant no attachment, child-session, shell or mutation access.
When no proposal exists, the diagnostics chat's fixed composer-adjacent **Suggest a repair** action sends one bounded,
host-qualified follow-up to the specialist. It reports requesting, queued and retry states, but never opens a manual
proposal form or starts work. Once the specialist publishes a bounded, cited proposal, the action becomes **Review
repair**, and after the turn settles the chat also shows the native review tray without displacing a live question or
stealing focus or replacing the composer. The action is outside transcript scrolling and remains reachable beside
the composer, including during a live question. Not now hides that exact proposal's summary, while **Review repair**
stays in the footer. Pending starts use that same action to check the original receipt; unavailable actions stay visible
but disabled. The context menu can also reopen review.
Publishing, viewing, reconnecting, dismissing or cancelling never starts work. Only explicit confirmation in the
review sheet sends the proposal to a separate private Build in the explicitly configured Pilot source project,
never the diagnosed/current project. Configure its verified host-qualified checkout in Diagnostics settings once;
missing, changed or unavailable bindings block starts without fallback or automatic cloning. App-wide proposals need
no fabricated chat target. Review includes an issue-specific title and model, and preserves the title without an
extra model request. That start uses one durable, host-qualified operation and per-proposal admission claim,
revalidates the proposal, subject, binding/path/origin at admission, and reconciles
an unknown response before any retry or replacement intent.
The review sheet also offers **Allow fresh read-only diagnostics**. When confirmed, the repair Build can read
bounded, sanitized evidence for the exact approved subject, shared Pilot logs on that host, and that chat's
history if the subject is a chat. App repairs do not gain chat-history access. This does not grant app-wide
discovery, other chats/hosts, target wake/restart/replay or mutation. Declined and older confirmations grant no
fresh diagnostic access; reopening or retrying an old intent never adds it.
[Tool-call diagnostics](tool-call-diagnostics.md) add bounded in-flight and completed lifecycle evidence for
built-ins, MCP and nested `codemode` calls while keeping raw names, arguments, output and commands out of diagnostics
and opt-in telemetry. Liveness and useful progress remain separate observations; Pilot does not automatically retry,
restart or replay a suspected call. Conservative live **Needs you** attention distinguishes suspected no-progress,
worker-liveness and cancellation delay from explicit waits, background jobs and paused sessions.
Chats also expose durable, content-free AI usage accounting from committed provider reports, keeping token classes,
catalog estimates, billed-spend availability and subscription coverage semantically distinct. Observed context
headroom, cache denominators, compaction pairs, request retries and worker relaunch reasons help diagnose efficiency
without changing model, context, compaction, retry or restart behavior. Diagnostics settings can optionally compare
retained per-chat catalog estimates or authoritative billed spend with an explicitly entered USD budget. No budget
exists by default, missing or partial data is not zero-filled, and the result never gates or changes execution.
The separate [local usage-history store](usage-history-contract.md) provides a bounded foundation for the usage
dashboard: private host-owned accounting, 30-day retention, up to 250,000 records / 512 MiB,
lossless binary-JSON storage, replay-safe replacement identities and separate
non-additive legacy checkpoints. Kernel and delegated requests retain physical-model and already-observed virtual
selection provenance locally, including failed responses with reported usage. Unknown crash responses are not zero,
and deterministic compaction records activity without invented inference cost. It is not a billing source or
diagnostic export. Separate [background completions](background-inference-accounting.md), including titles,
memory compaction (including historical Control usage), Slack classification and triage workers record observed usage before output validation
or application. Capture and dashboard projections remain partial; neither establishes complete historical coverage
or waives the dashboard performance/release gates. Pilot Next’s passive
[Local Usage overview](../../apps/desktop/docs/usage-overview.md) filters historical totals
and daily trends by exact ledger project or Unattributed records, with a bounded
project list. On-demand retained request pages expose exact selectable/copyable
records without deriving totals from pages. Subscription limits remain global
and independent of those filters.
[Native and devbox setup diagnostics](native-diagnostics.md) use Apple's delayed MetricKit delivery for crash
and hang observations and a closed app-owned timeline for setup stages through verified remote handshake. They
retain only bounded content-free metadata locally. Pilot does not ingest stacks or report bodies into those
aggregates, SSH output, aliases or arbitrary errors; it does not upload these records or treat historical evidence as
a retry or restart signal. The separate on-demand log catalogue may return bounded sanitized Pilot report excerpts
inside a diagnostics specialist chat, never as aggregate evidence or telemetry.
The [diagnostics and telemetry contract](telemetry-contract.md) defines the versioned privacy, identity,
correlation, retention and resource budgets for local diagnostics and opt-in OpenTelemetry export. Remote export and
product analytics are disabled by default, and no telemetry backend is selected by the repository.
[Node telemetry](node-telemetry.md) documents the daemon/kernel OpenTelemetry helper, bounded OTLP behavior and
local in-flight hooks that keep useful progress separate from liveness heartbeats.
[Swift telemetry](swift-telemetry.md) documents the native trace module, strict propagation, bounded background
export, sleep handling and packaged dependency notices.
[Feature-adoption catalog](feature-adoption.md) defines the closed, content-free eligibility, exposure, attempt
and outcome events and the limits on funnel and repeat-use interpretation.
The [local OTLP Collector example](../../examples/otel-collector/README.md) and
[starter queries](telemetry-starter-queries.md) provide bounded vendor-neutral evaluation without provisioning
a hosted backend or enabling upload automatically.
[Telemetry controls](telemetry-settings.md) documents independent local, operational and analytics consent,
per-host OTLP endpoints, revocation and private pseudonymous identity.
[Telemetry verification](telemetry-verification.md) maps the offline privacy, failure-isolation, bounds and
overhead fixtures used by the exact-head Node, macOS, Linux and packaging gates.
[Message send tracing](message-send-tracing.md) explains the correlated app/daemon/kernel phases, thinking versus
visible text, and why queued, restarted or unobservable milestones are reported as unavailable rather than guessed.
[Chat-open tracing](chat-open-tracing.md) covers warm and cold transcript latency, bounded history buckets,
WebSocket correlation and the distinction between model publication and an observed display frame.

- **Keep the daemon local.** It binds to `127.0.0.1`, rejects requests with an `Origin` header and has no
  authentication. Do not expose it to a network.
- **Durability is not tool replay.** If a native tool is interrupted by a crash, it is reported as
  interrupted rather than automatically rerun. After an unexpected kernel exit, interrupted chats reopen
  automatically with crash backoff. A slow but connected kernel is not treated as dead.
- **Extensions must fit the host.** Extensions that replace the SDK session or start their own model loop
  are unsupported. Subagent controls require a pi-extensions version with the `subagents:*` host events.
- **Project trust still applies.** Project-local `.pi` resources load only for directories pi trusts
  (or when `defaultProjectTrust` is set to `always`).
