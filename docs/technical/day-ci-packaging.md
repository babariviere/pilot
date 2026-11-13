# Day CI and release preparation

This prepares **unsigned build inputs**, not a release or desktop cutover.
The shipping GPUI path stays selected and usable. No Day lane publishes,
uploads, signs, installs, opens a window, contacts a daemon or changes a service.

## CI paths

`tests.yaml` now runs `day-contracts` on Linux, without a desktop change filter.
It checks Day's candidate/preview scripts, immutable Day build inputs, resource
inventory and existing bundle/release contracts. Both `main.yaml` and `pr.yaml`
already call this workflow. Fixture success is not native or signing evidence.
Required command failures propagate; this lane uses no credentials or compiler.

`day-qualification.yml` is **workflow_call only, with no caller**. It has no
push, tag or dispatch trigger, secret inputs, write permission or upload step.
It additionally refuses forks/non-main/PR invocations. Adding a caller is a
separate authorization step, not an automatic result of passing these tests.
Its prepared macOS arm64 recipe:

1. Checks out the supplied full commit, checks equality with HEAD, and uses
   that commit's tools. It does not overlay current helpers on older app source.
2. Uses Rust 1.99.1, global MBX defaults and frozen, ignore-scripts pnpm inputs.
   Downloads the complete official Longbridge NSH v0.5.0 distribution, verifying
   both archive and CLI digests. It preserves its `nsh/bin/nsh` layout and bundled
   runtime. No CLI rebuild, runtime patch or tool-cache repair is permitted.
3. Runs NSH/native and TypeScript checks, native library tests, then focused
   App, Plan, Intake and Update headless suites. `Native.test.tsx` requires a
   visible target and is deliberately outside this hidden lane, not silently
   counted as passed. These checks do not establish visual/native acceptance.
4. Fetches locked dependencies separately, including the isolated existing
   visual worker. The immutable builder remains offline. It builds Day's own
   native bootstrap, updater helper, visual worker and exact `Connected.tsx`
   resources, not the GPUI workspace or a renamed stock NSH runner.
5. Writes a runner-local qualification receipt. It binds the immutable recipe,
   real Cargo outputs/compiled app and helper diagnostics, official CLI,
   source-matched host grant, app identity and exact resource inventory.
   It always reports `installable_update`, `signed_package` and
   `native_acceptance` as false. There is no archive upload.

The native workflow is prepared but has **not been dispatched or qualified on
GitHub**. Missing tool/dependency inputs fail, not skip or fixture-fallback.

## Reusing the package pipeline

The [immutable input builder](day-package-inputs.md) already selects Day with
`bundle_runtime.py rust --gui day`. GPUI remains the default. The existing
assembler accepts Day's explicit `--gui-resources INPUTS/nsh` together with
source-matched runtime and native-helper inputs. It preserves `Pilot Next.app`,
`com.babariviere.pilot-next`, `pilot-desktop`, helper paths, runtime manifest,
compatibility capsule policy and app/helper compiled-trust equality.

`day_qualification.py --source SHA --inputs INPUTS --output RECEIPT` checks
unsigned Day inputs. Adding **both** `--runtime RUNTIME --native HELPERS`
checks the existing runtime version/source/resource contract and both native
helper receipts before any assembly. Partial runtime/helper input is refused.
This is package-input evidence only, never signature verification or an
installed-payload acceptance receipt. Assembly itself signs the output and is
not called by qualification.

## Shipping workflow audit

| Existing path | Actual behavior and preparation boundary |
| --- | --- |
| `release.yaml` | Main pushes run Release Please. Created stable drafts or explicit retries resolve a tag to an immutable SHA; macOS and Linux packages build that SHA, then upload/sign manifests and publish. Unchanged. Tests do not gate publication. Do not insert Day here before acceptance and explicit cutover. |
| `gui-package.yml` | Existing GPUI macOS/Linux builders. Uses tagged app source with a current packaging-helper overlay. Only the Linux inventory-signing step receives the updater private key; publication has its separate key scope. No Day selection, added secrets or key inheritance. |
| `linux-package.yml` | Reusable x64 headless runtime build in pinned manylinux, relocated runtime checks and CI artifact upload. Still called by PR CI, not changed into a Day desktop. |
| `main.yaml`, `pr.yaml` | Existing shared tests. PRs also build the Linux runtime. No call to the new native qualification workflow. |
| `tests.yaml` | Existing Node/GPUI/native helper checks kept, plus portable Day package regressions. No release permissions. |

Linux GPUI release inventory already checks bundled-launch, installer and
updater capability flags and refuses an unqualified package. Those existing
gates/support remain unchanged. **Day production replacement is unsupported**
on Linux x64/arm64, Intel/universal macOS, Windows and other targets. Upstream
NSH availability does not establish Pilot package, confinement or update
qualification on those platforms. Never distribute GPUI with a Day label.

## Shared inputs that must survive Swift GUI removal

| Shared input | Current consumer |
| --- | --- |
| `apps/macos/scripts/bundle-runtime.sh`, `check-runtime.sh` and their shared helpers | `bundle_runtime.snapshot_build`, GPUI release and relocated runtime checks |
| `apps/macos/scripts/release_metadata.py`, `finalize-release.sh`, release tests | Current release publication/metadata contracts |
| `apps/macos/Resources/AppIcon.icns` and required license/attribution assets | Immutable runtime/package assets, not a new Day identity |
| `apps/macos/Sources/PilotSystemEvents/{main.swift,SystemPowerMonitor.swift}` | `build-native-helpers.sh`, authenticated system-event accessory |
| `apps/macos/Sources/PilotVisualEngine` (C source and headers) | Existing isolated `pilot-visual-worker` build |
| `apps/power`, `apps/desktop/updater`, `apps/desktop/visual-worker` | Shared native power, verification/update and artifact execution inputs |

Keep these consumers intact or update them together if paths move. Directory
names alone do not identify obsolete GUI-only code.

## Gates that remain open

- Genuine production updater key/configuration and signed payload. Qualification
  compiles unconfigured trust, never a fixture production key. Existing private
  ad-hoc policy is not Developer ID/notarization; no new signing policy is assumed.
- Signed app/resource/version validation, update-manifest format and genuine
  official NSH 0.5 update archives, not a legacy GPUI manifest renamed for Day.
- Global pause/save/drain, exact-target Force consent, safe process exit,
  verified GUI-bundled daemon handoff, successor startup, rollback/recovery and
  selective resume, including broken chats and Unknown/no replay. Existing
  [global update contracts](day-global-updates.md) and daemon-runtime handoff
  work remain required; input inventories do not prove these behaviors.
- Native daily-driver acceptance and explicit release/default-switch authority.
  Preserve the current app, working chats and frozen development candidates.
