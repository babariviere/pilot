# Day CI and release preparation

This prepares **unsigned build inputs**, not a release or desktop cutover.

For the separate opt-in credential setup and qualification limits,
see [Day signing secrets](day-signing-secrets.md). The manual readiness workflow
does not sign bundles or change this unsigned workflow.
The shipping GPUI path stays selected and usable. No Day lane publishes,
uploads, signs, installs, opens a window, contacts a daemon or changes a service.

## CI paths

`tests.yaml` now runs `day-contracts` on Linux, without a desktop change filter.
It checks Day's candidate/preview scripts, immutable Day build inputs, resource
inventory and existing bundle/release contracts. Both `main.yaml` and `pr.yaml`
already call this workflow. Fixture success is not native or signing evidence.
Required command failures propagate; this lane uses no credentials or compiler.

`main.yaml` and `pr.yaml` call `day-qualification.yml` for unsigned checks.
Main release-only commits are skipped, as with the existing test job. The native
lane accepts Main pushes and same-repository PRs targeting Main, never fork PRs,
tags, dispatches or `pull_request_target`. Portable tests still cover fork PRs.
The reusable workflow sees the caller's event name, not `workflow_call`.
It checks the supplied commit against `github.sha` and checkout HEAD; PRs build
the merge SHA, not the head or a mutable branch. A tested runtime policy also
checks event/repository/ref identity before dependency setup. No secret inputs,
write permissions, shared build cache or uploads enter this lane. PR code runs
only on ephemeral GitHub-hosted runners, never as trusted release code.

The native recipe supports **macOS arm64 only**, on standard `macos-15`:

- GitHub's [hosted runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  identifies `macos-15` as M1/arm64 for public and private repositories;
  `macos-15-intel` is a different lane and is not used here.
- The [arm64 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)
  (image `20261104.0514.1`, checked 2026-11-13) includes Xcode 26.2 at
  `/Applications/Xcode_26.2.app`, with macOS SDK 26.2. The default is Xcode 16.4,
  so the job selects and verifies 26.2 explicitly. Isolated builds keep
  `DEVELOPER_DIR`; they must not silently revert to the default toolchain.
- Runtime architecture, Xcode, SDK, clang and swiftc checks fail on missing or
  changed images. Hosted images are not immutable; this is an explicit gate,
  not a claim that all future images will keep these prerequisites.

The source-matched unsigned steps:

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
   Also compiles the shared Rust power helper and the two kept SystemEvents
   Swift files directly. It does not resolve/build the removed Swift GUI.
   Day also builds the source-only `pilot-artifact-host` with its own feature.
   Its strict protocol adds compiled source/recipe evidence, not another command
   or a preview permission. Unsigned qualification checks that evidence too.
   These checks reuse the existing Node transport; no separate Python helper
   supervisor or staging wrapper is used.
5. Writes a runner-local qualification receipt. It binds the immutable recipe,
   real Cargo outputs/compiled app and helper diagnostics, official CLI,
   source-matched host grant, app identity and exact resource inventory.
   It always reports `installable_update`, `signed_package` and
   `native_acceptance` as false. There is no archive upload.
   Unsigned debug executables alone have a 1 GiB diagnostic per-file limit,
   within the existing 2 GiB total closure limit. Resources/logs/runtime and
   signed/shared assembly inventories keep their 256 MiB per-file limit.
   Qualification never strips, re-signs or changes shared compiler outputs.

The callers now schedule these checks automatically. Local checks and workflow
validation are not evidence of a green remote execution. Missing tool/dependency
inputs fail, not skip or fixture-fallback. No remote CI polling is required.

## Reusing the package pipeline

The [immutable input builder](day-package-inputs.md) already selects Day with
`bundle_runtime.py rust --gui day`. GPUI remains the default. The existing
assembler accepts Day's explicit `--gui-resources INPUTS/nsh` together with
source-matched runtime and native-helper inputs. It preserves `Pilot Next.app`,
`com.babariviere.pilot-next`, `pilot-desktop`, helper paths, runtime manifest,
compatibility capsule policy and app/helper compiled-trust equality.
Only the explicit Day-resource branch stages the artifact source helper under
runtime's `packages/artifacts/native`, includes it in existing native verification
and seals a final-byte binding before the outer signature. The GPUI branch is
unchanged. This path does not enable executable NSH artifact previews; see
[source foundation and remaining gates](nsh-artifact-source.md).

`day_qualification.py --source SHA --inputs INPUTS --output RECEIPT` checks
unsigned Day inputs. Adding **both** `--runtime RUNTIME --native HELPERS`
checks the existing runtime version/source/resource contract and both native
helper receipts before any assembly. Partial runtime/helper input is refused.
This is package-input evidence only, never signature verification or an
installed-payload acceptance receipt. Default assembly signs the output and is
not called by qualification.

For unsigned CI only, the existing assembler has an explicit Day mode:

```sh
python3 apps/desktop/scripts/bundle_runtime.py bundle --unsigned-day \
  --source "$SOURCE" --runtime "$RUNTIME" --executables "$INPUTS" \
  --native "$HELPERS" --gui-resources "$INPUTS/nsh" \
  --output "$OUTPUT/Pilot Next.app"
python3 apps/desktop/scripts/bundle_runtime.py verify --unsigned-day "$OUTPUT/Pilot Next.app"
```

This requires development, unconfigured inputs and checked Day resources. It
keeps source/runtime/helper receipts, native architecture/dependency checks and
the copied helper's exact-byte binding, but invokes no signing command. The
output manifest kind is `unsigned-day-bundled-runtime`; ordinary verification
and shipping consumers refuse it. Only the four exact Day executable paths get
the existing 1 GiB debug allowance. Resources, other binaries, runtime inputs
and signed/shared inventories keep 256 MiB per file; the total stays 2 GiB.
This is assembly evidence, not a signed, launchable or accepted release.

The Main and same-repository PR qualification uploads
`Pilot-Day-unsigned.zip` as `pilot-day-unsigned-<commit>`. It contains
`Pilot Next.app`, not a signed update. The workflow keeps the standalone
updater and power checks and Day's headless boundary and connected tests.
It no longer runs the GPUI-only visual runtime, visual session, artifact
worker, NSH adapter or rendered Wayland probes. Day's headless checks do not
replace production confinement, GPU or native platform acceptance.

For the separately gated configured full-runtime producer, use the
[direct production commands](day-package-inputs.md#configured-full-bundle-separate-gated-production-action).
`bundle --production` now exposes the existing assembly API with the same
explicit public environment parser as `day_build_inputs.py --production`.
No workflow change, signing secret, dispatch or automatic live release is added.
The documented official-manifest/resource prerequisites remain separate; this
CLI change does not claim a genuinely produced signed bundle.

## Shipping workflow audit

| Existing path | Actual behavior and preparation boundary |
| --- | --- |
| `release.yaml` | Main pushes run Release Please. Created stable drafts or explicit retries resolve a tag to an immutable SHA; macOS and Linux packages build that SHA, then upload/sign manifests and publish. Unchanged. Tests do not gate publication. Do not insert Day here before acceptance and explicit cutover. |
| `gui-package.yml` | Existing GPUI macOS/Linux builders. Uses tagged app source with a current packaging-helper overlay. Only the Linux inventory-signing step receives the updater private key; publication has its separate key scope. No Day selection, added secrets or key inheritance. |
| `linux-package.yml` | Reusable x64 headless runtime build in pinned manylinux, relocated runtime checks and CI artifact upload. Still called by PR CI, not changed into a Day desktop. |
| `main.yaml`, `pr.yaml` | Existing shared tests plus exact-source unsigned Day qualification. PRs also build the Linux runtime. No Day release or production selection. |
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
