# Rust GUI release integration

`release.yaml` keeps Swift's `Pilot-arm64.zip` and `appcast.xml`, then requires
both real Rust GUI packages before finalizing the same stable `v<version>` draft:

| Platform | Full app archive | Signed update envelope |
| --- | --- | --- |
| macOS arm64, macOS 15+ | `Pilot-Next-macos-arm64.zip` | `desktop-macos-arm64-update.json` |
| native Wayland Linux x86_64 | `Pilot-Next-linux-x64.zip` | `desktop-linux-x64-update.json` |

Future releases no longer upload or require standalone `Pilot-linux-x64.tar.gz`,
`runtime-manifest.json` or its signature. Historical assets are untouched.
`scripts/linux` and the reusable Linux runtime CI job remain: the headless
archive is a **private staging input**, not the Linux desktop distribution.

The reusable `gui-package.yml` builds the exact resolved tag commit. macOS uses
`bundle_runtime.py`'s immutable runtime/native/Rust input pipeline, optimized
GUI/visual/updater binaries, matching compiled configuration receipts and the
separate `Pilot Next.app` identity. Development assembly stays unconfigured.
The relocated native dependency/minOS closure, resource inventory, code seal and
offline Node/runtime smoke are checked before ZIP creation. No C stand-ins are
accepted as qualification. Linux builds real optimized GPUI/visual/updater
executables and the existing production runtime in the pinned manylinux ABI
toolchain, then assembles the full relocatable GUI layout. CPU2/4GiB bounds,
private targets and verification slots are retained.

The Rust updater discovers the same stable `v<version>` release, selects only its
own exact archive/envelope names and matches the signed short version to the tag.
It never consumes Swift's ZIP or Sparkle feed. The envelope signs the archive's
GitHub numeric asset ID, name, size, hash, platform, app identity and versions.
Linux also binds source, and separately signs the exact full-payload inventory.
Node crypto signs/verifies Ed25519; the app uses its existing ring verifier.
The private signing key must match the public key compiled into GUI and helper.

## Required configuration and acceptance

This source wiring does **not** provision production trust or qualify a release.
Missing prerequisites fail, leaving the release draft unpublished:

- `PILOT_NEXT_UPDATER_PUBLIC_KEY` repository variable, raw32-byte Ed25519 public
  key in base64, and matching `PILOT_NEXT_UPDATER_PRIVATE_KEY` PEM secret.
  Existing Sparkle/Linux-runtime keys are **not** silently reused or rotated.
- macOS `PILOT_NEXT_SIGNING_POLICY=private-adhoc` must be an explicit approved
  distribution-policy choice. This lane uses ad-hoc native code seals plus
  authenticated signed update metadata, not Developer ID or notarization. If
  Developer ID/Gatekeeper distribution is required, its credentials and native
  signing/notarization lane remain a concrete prerequisite, not an unsigned fallback.
- `PILOT_NEXT_MACOS_QUALIFIED_SOURCE` and `PILOT_NEXT_LINUX_QUALIFIED_SOURCE` must
  equal the full immutable release commit **after actual full GUI/runtime and
  update-lifecycle qualification**. These are maintainer acceptance acknowledgements,
  not evidence manufactured by this workflow. Fixture rendering or a green
  portable build is insufficient. See [macOS limits](updates.md) and
  [Linux evidence](linux-gui-package.md). An old acknowledgement cannot approve
  a newer release commit.
- Linux package policy must itself affirm qualified bundled Local startup,
  installer/updater. Today's unqualified candidate explicitly refuses publication.
  The Linux lifecycle owners must deliver and natively validate those capabilities
  first. Native visual execution remains disabled pending separate confinement
  qualification; this release wiring cannot enable it or claim it works.
- Optional platform-specific `PILOT_NEXT_MACOS_ACCEPTED_CAPSULES` and
  `PILOT_NEXT_LINUX_ACCEPTED_CAPSULES` variables are JSON lists of exact already
  qualified retained-runtime manifest digests (existing limit: four). They become
  signed candidate policy. Empty lists never authorize replacing an app while
  using an unaccepted retained daemon capsule. Compatibility must be established
  for the actual prior payload; never infer it from a version or source label.

Build versions use this workflow's monotonically increasing run number/attempt,
independently of Sparkle. The app still requires explicit **Install and restart**,
fresh durability/admission receipts and retained-runtime verification. Ordinary
Quit never installs; existing daemons are never stopped, migrated or replaced.
Linux updater wiring is conditional on its separate native implementation and
qualification, not a claim it works today.

No release trigger, production variable/secret mutation, published-asset deletion,
live app/daemon installation or restart is part of this change. Retrying an older
tag without the required GUI source/contracts fails rather than mixing source
revisions or relabeling a headless/development package.
