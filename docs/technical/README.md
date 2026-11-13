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
- [Codebase cleanup decisions](untangle-codebase.md)
- [Durable operations](durable-operations.md)
- [Decision help and human-action contracts (host seam)](decision-assistance.md)
- [Upgrade readiness and blocker audit](upgrade-readiness.md)
- [Resumable upgrade checkpoints and native host APIs](resumable-upgrades.md)
- [Day update pipeline qualification and remaining host/package seams](day-update-pipeline.md)
- [Global pause-first update preparation and native acceptance gates](day-global-updates.md)
- [Verified NSH app-relative daemon handoff](day-bundled-service.md)
- [Day executable self-update handoff and exact production blockers](day-executable-handoff.md)
- [Source-matched Day executable and package inputs](day-package-inputs.md)
- [Day CI and release preparation, with unchanged shipping selection](day-ci-packaging.md)
- [Connected native candidate preparation and launch](day-connected-candidate.md)
- [Tool access by role](tool-access-by-role.md)
- [System prompts by role](system-prompts-by-role.md)
- [Skill and prompt review index](skill-prompt-review.md)

## Chats, context, and source tools

- [First-party code exploration](code-exploration.md)
- [Code and verification evidence capture (disabled)](code-evidence-capture.md)
- [Code relationships and retained comparison evaluation](code-relationships-evaluation.md)
- [Empryo exploration patterns for Pilot](empryo-code-exploration-evaluation.md)
- [Descriptor-anchored source traversal (design only)](descriptor-anchored-source-traversal.md)
- [Posthorse context management](posthorse.md)
- [Small project preferences and canonical context](project-preferences.md)
- [Passive model and thinking defaults](model-defaults.md)
- [Shared context and independent task execution](shared-context.md)
- [Narrow coordinator repository inspection (design only)](coordinator-repository-inspection.md)

## Missions, delivery, and review

- [Proposed mission authority, review and delivery policy](mission-authority-review-policy.md)
- [Proposed cost-aware coordinator wakes and stall recovery](mission-coordinator-wakeups.md)
- [Coordinator-first desktop workflow](mission-desktop-workflow.md)
- [Proposed worker escalation and human handoff contract](mission-escalation-handoff.md)
- [Mission grouping and contextual decisions](mission-grouping-context.md)
- [Decision notice routing and durable batches](mission-decision-routing.md)
- [Confirmed mission revisions and current-only context](mission-revisions.md)
- [Focused mission discussion API and history](mission-threads.md)
- [Authorized work continuation and current-policy source](mission-continuation.md)
- [Mission Pause/Resume and versioned agent reports](mission-controls-reports.md)
- [Mission results and failure visibility audit](day-results-visibility.md)
- [Proposed mission interview and approval contract](mission-interview-approval.md)
- [Day interview and agreement backend (host-only)](day-mission-agreements.md)
- [Native mission planning and Fog of war (host-only)](day-mission-planning.md)
- [Native Today intake, triage and Start receipts](day-intake.md)
- [Project-pinned standalone New chat](day-new-chat.md)
- [Explicit user verification and delivered outputs (host-only)](day-user-verification.md)
- [Captured result artifact reads](day-captured-artifacts.md): exact native-user source-text reads without execution or acceptance.
- [Captured NSH source foundation](nsh-artifact-source.md): immutable scratch-file capture and source-only compiler boundary; execution stays refused.
- [Proposed native Review and durable diff annotations](mission-native-review.md)
- [Global optional Review request producer and read API](global-review-requests.md)
- [Retained changes and landing observations](landed-changes.md)
- [Non-code delivery foundation](mission-non-code-deliveries.md)
- [Production reviewer bridge and independence contract](mission-production-review-bridge.md)
- [Workflow approval, review consent and human-review actions](mission-review-app-actions.md)
- [Host workflow confirmation receipts (no active gates)](workflow-confirmation-receipts.md)
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
- [Exact stored visual acquisition (host-only)](retained-artifact-acquisition.md)
- [Retained visual precheck (host-only, not installed)](retained-visual-precheck.md)
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
- [Confirmed deleted-report replacement contract (internal)](insights-replacement.md)
- [App-owned Insights workspace and reservation contract (v2)](insights-workspace.md)
- [Owner execution and legacy transfer](insights-owner-execution.md)
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
- [Feature-adoption catalog](feature-adoption.md)

## Performance and experiments

- [Archived automatic handoff experiment](auto-handoff.md)
- [Archived deterministic compaction measurements](context-compaction.md)
- [Archived in-place context edits proposal (never implemented)](context-edit-compaction.md)
- [Historical handoff comparison (not Posthorse evidence)](handoff-comparison.md)

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
- [Pilot Day, the upcoming Native Shell TSX app](../../apps/day/README.md)
- [Day authenticated native host and control journal](day-native-host.md)
- [Day Native Shell release qualification](day-nsh-release.md)
- [Day released public JSON bridge and lifecycle limits](day-public-bridge.md)
- [NSH artifact helpers and examples](nsh-artifact-helpers.md): trusted diagram/chart helpers, not a runtime.
- [Reliability roadmap](reliability/roadmap.md) and [testing strategy](reliability/testing-strategy.md)
- [Historical product reference](product-reference.md), preserved from the previous README
- [Screenshot provenance](../screenshots/README.md)

Benchmark data lives beside its reports in `benchmarks/`. Old remote transport documents describe
retired behavior, not supported remote execution. The historical product reference includes legacy
Swift behavior and is not the current user manual.
