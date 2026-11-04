# Technical documentation

Implementation contracts, development instructions, proposals, measurements, and historical
references. A document being retained here does not mean its feature is shipped.
Read its status and platform limitations. For usage, start with the [user guides](../README.md).

## Where documentation belongs

- `README.md`: a short introduction, setup entry point, and links.
- `docs/`: concise feature guides explaining what users can do and important limits.
- `docs/technical/`: APIs, storage, architecture, security details, plans, and evidence.
- Component-local docs (for example `apps/desktop/docs/`) retain their implementation contracts.

Update the relevant guide when behavior changes. Keep implementation journals and test inventories
out of user guides. Link to an existing contract rather than duplicating it.

## Development and architecture

- [Development reference](development.md)
- [Testing and test speed](testing.md)
- [Dependency updates](renovate.md)
- [TypeScript dependency audit, 2026-10-29](typescript-dependency-audit.md)
- [Durable operations](durable-operations.md)
- [Tool access by role](tool-access-by-role.md)
- [System prompts by role](system-prompts-by-role.md)

## Chats, context, and source tools

- [First-party code exploration](code-exploration.md)
- [Code and verification evidence capture (disabled)](code-evidence-capture.md)
- [Code relationships and retained comparison evaluation](code-relationships-evaluation.md)
- [Empryo exploration patterns for Pilot](empryo-code-exploration-evaluation.md)
- [Descriptor-anchored source traversal (design only)](descriptor-anchored-source-traversal.md)
- [Experimental automatic handoff](auto-handoff.md)
- [Ordinary-chat context compaction and history recall](context-compaction.md)
- [Passive model and thinking defaults](model-defaults.md)
- [In-place context edits for compaction (design note)](context-edit-compaction.md)
- [Ordinary-chat handoff comparison](handoff-comparison.md)
- [Shared context and independent task execution](shared-context.md)
- [Coordinator summary-tree memory](coordinator-memory.md)
- [Narrow coordinator repository inspection (design only)](coordinator-repository-inspection.md)

## Missions, delivery, and review

- [Proposed mission authority, review and delivery policy](mission-authority-review-policy.md)
- [Proposed cost-aware coordinator wakes and stall recovery](mission-coordinator-wakeups.md)
- [Coordinator-first desktop workflow](mission-desktop-workflow.md)
- [Proposed worker escalation and human handoff contract](mission-escalation-handoff.md)
- [Mission grouping and contextual decisions](mission-grouping-context.md)
- [Proposed mission interview and approval contract](mission-interview-approval.md)
- [Proposed native Review and durable diff annotations](mission-native-review.md)
- [Non-code delivery foundation](mission-non-code-deliveries.md)
- [Production reviewer bridge and independence contract](mission-production-review-bridge.md)
- [Workflow approval, review consent and human-review actions](mission-review-app-actions.md)
- [Proposed review preference memory](mission-review-preference-memory.md)
- [Versioned review profiles and results (internal)](mission-review-records.md)
- [Mission roles and explorer admission](mission-roles.md)
- [Coordinator worker archive and restore](mission-worker-organization.md)
- [Proposed durable worker retirement contract](mission-worker-retirement.md)
- [Non-code policy and explain-only evaluation](non-code-acceptance-policy.md)
- [Explicit non-code acceptance prerequisites](non-code-acceptance-prerequisites.md)
- [Retained contribution allocation (internal)](contribution-allocation.md)
- [Critical review foundation (disabled)](critical-review-foundation.md)
- [Revision-bound delivery evidence (internal)](delivery-evidence.md)
- [Internal jj attribution ledger](jj-ownership.md)
- [Retained review run linkage](retained-review-run-linkage.md)
- [Retained comparison snapshots (internal)](review-snapshots.md)

## Features and integrations

- [Automations (design)](automations.md)
- [Recurring schedules (design)](recurring-schedules.md)
- [Project environment setup (design)](environment-setup.md)
- [Native agent visuals (design proposal)](native-visuals.md)
- [Native Mermaid renderer evaluation](native-mermaid-evaluation.md)
- [Host-owned workspace terminals and maintenance barriers](workspace-terminals.md)
- [Linear pull request safety](linear-pr-safety.md)
- [Linked project knowledge catalog](project-knowledge-catalog.md)
- [Agent-aware sleep](agent-sleep.md)
- [Local Usage dashboard](usage-dashboard.md)

## Diagnostics, telemetry, and accounting

- [Restricted cross-project Insights history (internal)](insights-history.md)
- [Bounded Insights review orchestration (internal)](insights-review.md)
- [Weekly Insights durable enable contract (internal)](insights-enable.md)
- [Insights desired settings and native save contract (internal)](insights-settings.md)
- [Agent diagnostics](agent-diagnostics.md)
- [Native crash, hang and devbox setup diagnostics](native-diagnostics.md)
- [pilotd event-loop stalls](daemon-stalls.md)
- [Local lifecycle diagnostics](lifecycle-diagnostics.md)
- [Local request timings](request-timings.md)
- [Message send tracing](message-send-tracing.md)
- [Chat-open tracing](chat-open-tracing.md)
- [Tool-call diagnostics](tool-call-diagnostics.md)
- [Source refresh health for diagnostics](refresh-health.md)
- [AI usage and cost accounting](ai-usage-accounting.md)
- [Separate background inference](background-inference-accounting.md)
- [Local usage history, version 1](usage-history-contract.md)
- [Usage-store allocation verification](usage-history-performance.md)
- [Local usage query API (version 1)](usage-queries.md)
- [Diagnostics and telemetry contract](telemetry-contract.md)
- [Telemetry controls](telemetry-settings.md)
- [Telemetry starter queries](telemetry-starter-queries.md)
- [Telemetry and diagnostics verification](telemetry-verification.md)
- [Node telemetry foundation](node-telemetry.md)
- [Swift telemetry foundation](swift-telemetry.md)
- [Feature-adoption catalog](feature-adoption.md)

## Performance and experiments

- [CPU and memory audit](performance-check.md)
- [I/O amplification audit](io-performance-check.md)
- [Streaming text sizing](streaming-layout.md)
- [Reused-cell transcript plan](reused-cell-transcript.md)
- [Native transcript: headless attribution follow-up](native-transcript-headless-attribution.md)
- [Opt-in native transcript measurement](native-transcript-measurement.md)
- [Native transcript rows: implementation and release comparison](native-transcript-native-rows.md)
- [Native transcript: rich-scroll follow-up](native-transcript-rich-scroll-follow-up.md)
- [Single-scene transcript measurement](native-transcript-single-scene-measurement.md)

## Historical remote architecture

- [Remote devboxes are retired](devboxes.md)
- [Devbox verification and remaining manual checks](devbox-verification.md)
- [Host-scoped repositories and files](host-repositories.md)
- [Host routing](host-routing.md)
- [Remote attachments and artifacts](host-transfers.md)
- [Remote lifecycle and offline metadata](remote-lifecycle.md)
- [Updating a remote Pilot runtime](safe-remote-updates.md)
- [Initial Linux runtime setup over SSH](ssh-bootstrap.md)
- [Managed SSH transport](ssh-transport.md)
- [Independent host credential setup](credential-setup.md)

## Reference collections

- [Desktop implementation contracts](../../apps/desktop/docs/design-system.md)
- [Reliability roadmap](reliability/roadmap.md) and [testing strategy](reliability/testing-strategy.md)
- [Historical product reference](product-reference.md), preserved from the previous README
- [Screenshot provenance](../screenshots/README.md)

Benchmark data lives beside its reports in `benchmarks/`. Old remote transport documents describe
retired behavior, not supported remote execution. The historical product reference includes legacy
Swift behavior and is not the current user manual.
