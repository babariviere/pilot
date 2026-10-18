# Devbox verification and remaining manual checks

Keep four kinds of evidence separate: exact-head CI, post-merge integration, signed release
publication, and an actual devbox deployment. A green source test or static SwiftUI mock does not
establish the latter three. Heavy Swift/full Node/package checks belong in GitHub CI, not a local
agent session.

## Automated coverage

PR and main CI keep the portable Node suite, Darwin native lane, complete Swift tests and Linux headless
checks (supported SDK, native ABI, real isolation and independent daemon/kernel execution). PRs and
releases build and verify the relocated Mac app and Linux production package. Tests do not block releases.
Do not replace any of these with mocks.

The Linux package job builds once, extracts the production runtime, then runs
`scripts/linux/verify-service.sh` on a disposable SSH/PAM user with a real systemd user manager.
Its explicit privileged fixture provisioning is CI-only, not production onboarding behavior.

`verify-workflow.mjs` now exercises the packaged daemon and native kernel through an owned SSH
control-master forward. The forward command must acknowledge ownership before `/api/hello` is
read. A target-resolved faux provider and disposable configuration need no account or copied secret.
The test covers repository registration, local image upload, durable attached chat creation, a real
native shell tool paused at a file barrier, terminal detachment, closing every app forward,
independent tool completion, reconnect to the same daemon/shell, exactly-once receipt recovery,
files/changes and pinned HTML/React/image downloads. A separate extracted packaged daemon verifies
that Local's identity and chat list are independent while the remote forward exists and after it closes.

The same service fixture verifies missing linger, repeat/lost-reply setup without restarting active
work, SSH logout survival and persistent identity across user-manager restart. `verify-update.mjs`
then exercises an actual replacement production package, live terminal/transfer blockers, updater
SIGKILL recovery and a completed update surviving manager restart. Its signing keys are throwaway
fixture keys, not release secrets or evidence that public signed assets exist.

React compilation releases its build helper after all concurrent artifact/library builds settle.
`render-lifecycle.test.ts` checks success, failure and reuse without killing unrelated children;
the packaged update runs after React publication, so a leaked helper must still block and fail it.

### Fault matrix

| Contract/boundary | Automated evidence |
| --- | --- |
| Capability-based setup, dnf plans, unavailable signing/assets, archive substitution | `scripts/linux/contracts.test.mjs`, `test_ssh_bootstrap.py`; `RemoteSetupTests`, `DevboxSettingsModelTests` |
| Independent provider setup, unsupported flows, cancellation/redaction | `setup.test.ts`, `setup-provider.test.ts`; `DevboxProviderModelTests` |
| Independent GitHub browser/key approval, ambiguous upload, identity mismatch, cancellation and transport isolation | `github-setup.test.ts`; `GitHubSetupModelTests`, mounted key-approval interaction in `DevboxSettingsInteractionTests` |
| Git server destination pattern, selected-host tilde preview, clone/reuse safety, cancelled/lost registration and no checkout filters | `github-import.test.ts`; `GitHubImportModelTests`, mounted reuse-confirmation interaction in `DevboxSettingsInteractionTests` |
| Colliding IDs, drafts, feeds, subscriptions, caches/exports and host replacement | `HostRoutingTests`, `HostClientsTests`, `HostDraftMigrationTests`, `HostSubscriptionTests`, `QualifiedNativeTests`, artifact tests |
| Disconnect/offline relaunch, local-only sleep/quit control, Stop requested vs acknowledged | `OfflineHostsTests`, `RemoteLifecycleTests`, `RemoteOperationRecoveryTests`; packaged forward closure/logout checks |
| Lost acceptance/receipt, immutable explicit retry, target/lineage mismatch | `operation-journal.test.ts`, `operation-admission.test.ts`, `RemoteOperationRecoveryTests`; packaged attached create/receipt replay |
| D19: complete durable context before acceptance, provisional offline writes, repeated bidirectional sync and lost acknowledgments | `shared-context.test.ts`, especially accepted-session recovery, checkpoint recovery, and repeated-partition regression; `SharedContextCourierTests`, `SharedProjectModelTests` |
| D19/D22: concurrent edits, revision CAS, memory-file/SQLite recovery, conflicts/tombstones | `shared-context.test.ts`, `shared-context-store.test.ts`, `shared-context.stress.test.ts`; `SharedContextTests`, shared edit/placement state tests |
| D20: sole grant, accept/result/import/seal, delayed starts, no disconnected failover, pending cancellation | `shared-context.test.ts` delayed placement, cancel-before-offer, actual child seal and late-evidence tests; `SharedProjectModelTests` |
| D21: pinned home coordinator, replicas cannot canonically claim/dispatch siblings or elect an authority | shared-context real-store/bridge and repeated-partition tests; Linux/macOS coordinator isolation tests |
| D22: explicit linking, partial enrollment, revoked links, late evidence and no silent credential/workspace copying | shared-context authorization/revocation/unknown-field tests, `SharedProjectModelTests` enrollment recovery |
| D23: concurrent rotating refresh, authoritative restart/SIGKILL, ambiguous exchange, login/logout/revocation generations | `credential-broker.test.ts` actual Pi OAuth, lost exchange, stale commit and real authority SIGKILL tests |
| D23: session authorization, unavailable broker, oversized frames, denied arbitrary paths/config writes | credential broker capability/schema tests, `readonly-settings.test.ts`, Linux coordinator sandbox fixtures |
| Safe update admissions, process/boot fencing, live shell/job/transfer cleanup | runtime admission/update/terminal tests, `render-lifecycle.test.ts`, `scripts/linux/update.test.mjs`, packaged `verify-update.mjs` after artifact publication |

The matrix combines packaged, service integration, deterministic fault injection and native state
tests. It does **not** claim every D19–D23 fault is injected through a packaged SSH UI session.
Existing full suites remain the gate for local regressions. Fixture helper unit tests bound child
deadlines/output and HTTP responses; they are not substitutes for executing the package lane.

## Manual/deployment checklist (not established by CI)

Use only a separately authorized dedicated test devbox and test accounts. Record app/runtime
versions, exact commit, asset hashes and observed results. Do not change a user's machine just to
fill this checklist.

- Confirm the stable release contains all signed assets and the installed app's pinned public key.
  Verify the downloaded app actually contains the reviewed code. CI's throwaway signing is not this check.
- Run native onboarding using the real SSH alias and review prerequisite plans without weakening
  host security. Verify provider/device/browser prompts with supported independent test accounts.
- Keep Local and remote chats open together. Check focus/project/command-palette navigation,
  attachment pixels, file paths, Changes, terminal working directory, artifact viewing and exported bytes.
- Check keyboard access, VoiceOver, reduced motion, long names, narrow windows and light/dark UI.
  The attached SwiftUI artifact uses sample data, not the running views.
- During a harmless long tool, interrupt Wi-Fi, sleep/wake the Mac, quit/relaunch the app offline,
  and reconnect. Verify independent completion and cached summaries/drafts without fabricated failure
  notifications. Synthetic forward closure is not a physical sleep test.
- With explicit linking, inspect committed/pending/conflicting context, required artifacts and a
  bounded delegated task. Disconnect both ways, request cancellation/revocation, reconnect and verify
  no duplicate dispatch or automatic reassignment before the old target's durable release.
- Request an update with a live terminal/job/transfer. Inspect blockers and cancel/finish deliberately.
  Verify independent update recovery after disconnect, then retained agent/subagent work. Do not
  mistake records for preservation of live OS processes.

Source tests do not validate an arbitrary distro, network, filesystem, SSH configuration, actual
provider account, signed publication or production deployment. Report gaps explicitly rather than
marking unperformed checks passed.
