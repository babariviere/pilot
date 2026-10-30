# Documentation plans

Audience plans only. No user guide is implemented here. General documentation belongs to architecture/reliability; Automation owns supported setup, and Global/Control owners review Control facts. Coordinate Diagnostics, Review, updater and Polish work rather than reproducing it. See the [roadmap](roadmap.md) and [testing strategy](testing-strategy.md).

## USER audience

| Proposed section | Source and owner | Dependencies and acceptance |
| --- | --- | --- |
| First project and everyday chats | Current `README.md` and desktop behavior; general docs owner | Verify current Rust/GPUI flows on supported platforms; a new user can find a project, start and resume without assuming Swift. |
| Delivery, uncertain actions and recovery | `docs/durable-operations.md`, actual desktop copy; desktop + daemon owners | Explain pending/Unknown, Check and explicit Retry without promising exactly-once completion or automatic replay; review against real UI and lost-ACK journey. |
| Permissions, origin and local behavior | Current policy/protocol and desktop; security/daemon owners | Distinguish approval, per-chat access, local/remote boundaries and read-only diagnostics. Do not claim loopback alone authenticates hostile local processes. |
| Settings, setup and troubleshooting | Current settings and [setup](../environment-setup.md); general docs links, Automation owns setup facts | Link supported instructions, not proposed setup as shipped behavior. Verify recovery on supported platforms, avoiding destructive fixes and secrets. |
| Control and mission workflows | Current implementation and Control/Global owners | Owner-reviewed facts, authority and failure cases; list freshness does not grant permission. |

## DEVELOPER audience

| Proposed section | Source and owner | Dependencies and acceptance |
| --- | --- | --- |
| Architecture and request ownership | `apps/desktop`, `packages/daemon`, `packages/kernel`, protocol; subsystem owners | Trace a current GPUI journey through transports, services, journal, worker and events. Separate facts, proposal and compatibility. |
| Durability, lifecycle and recovery | [durable operations](../durable-operations.md), journal/session code; daemon + desktop owners | Describe exact identity, persisted boundaries, Unknown, cancellation, scoped barriers and teardown. Complete startup/rollback review before claiming coverage. |
| Development setup | [setup](../environment-setup.md), repository README; Automation owns environment guidance | Link maintained supported prerequisites and commands; do not duplicate evolving procedures. |
| Testing and native qualification | [testing](../testing.md), [risk matrix](testing-strategy.md); test and subsystem owners | Runnable commands, fixture teardown and current gate owners; distinguish synthetic, native and exact-head CI results. |
| Observability and privacy | [agent diagnostics](../agent-diagnostics.md), [telemetry contract](../telemetry-contract.md); Diagnostics owners | Document bounded sources, consent, retention, redaction, loss and evidence limits; no new access or exporter implied. |
| Control and updates | Current implementations, Control/Global and updater owners | Independent factual review, platform-specific native identity, rollback and cleanup; avoid outdated retained-capsule assumptions. |

## Existing handoff blocker

The earlier author session `c8153ae1-731a-4866-b5d3-26d1ef0336d2` is unverified. A prior read-only audit found a checkpoint with no content difference from its parent and no scratch Markdown/patch/diff; this proves neither saved prose nor its absence elsewhere. The reported Global handoff withdrawal/block is not independently verified. Preserve the author's workspace and checkpoint. Do not clean, move, rebase, import or duplicate its prose. Before implementing guides, obtain an author-confirmed manifest of paths, provenance, base, uncommitted/ignored content, validation and gaps, then reconcile with current sources and owners. These plans do not resolve that blocker.
