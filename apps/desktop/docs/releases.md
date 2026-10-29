# Rust GUI release integration

`release.yaml` keeps Swift's `Pilot-arm64.zip` and `appcast.xml`, then requires
both Rust GUI packages before finalizing the same stable `v<version>` draft:

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
toolchain, then assembles the full relocatable GUI layout. CPU2/4GiB bounds
and private targets are retained.

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
- The Linux package policy must affirm bundled Local startup, installer and
  updater; production assembly does so and the signer refuses anything else.
  The development candidate keeps its unqualified policy and cannot be published.
  Native visual execution remains disabled pending separate confinement
  qualification; this release wiring cannot enable it or claim it works.
- Optional platform-specific `PILOT_NEXT_MACOS_ACCEPTED_CAPSULES` and
  `PILOT_NEXT_LINUX_ACCEPTED_CAPSULES` variables are JSON lists of exact
  retained-runtime capsule digests (existing limit: four). They become signed
  candidate policy. macOS packaging also admits the newest published stable
  macOS runtimes with the same protocol, after the configured digests and within
  the same four-capsule limit. It authenticates each release's exact update
  envelope with the configured public key, checks the archive asset identity,
  size and SHA256, then verifies the extracted native code seal, full bundle
  inventory and runtime metadata before hashing the complete retained closure.
  Drafts, prereleases, Swift-only releases and incompatible protocols are not
  admitted. Invalid signed releases or failed discovery fail packaging rather
  than silently producing an empty policy. API credentials are never sent to
  archive downloads or source-build/native-verification subprocesses. Discovery
  is sequential and bounded to 30 release records, 1 GiB per archive and a
  20-minute overall admission deadline; extracted closures keep the existing
  2 GiB bound. Redirects cannot downgrade HTTPS or forward API credentials to
  another origin. This does not weaken startup or change daemon versions.
  Linux packaging also admits, after the configured digests, the
  runtimes of the newest published Linux releases (SHA256 of each release's exact
  `linux-gui-package.json`), so an update can keep using the daemon an earlier
  release started; the app still checks the daemon's protocol when it connects.

Build versions use this workflow's monotonically increasing run number/attempt,
independently of Sparkle. The app still requires explicit **Install and restart**,
fresh durability/admission receipts and retained-runtime verification. Ordinary
Quit never installs. GUI startup, close and update ACK never activate a daemon.
First user-service registration and selected-version changes require separate
explicit consent. The [service handoff](daemon-upgrades.md) requires an exact
daemon-safe reservation and native ownership/exit/new-boot proofs; active or
uninspectable work defers it. Bundling remains the offline seed, not a new
independent daemon update feed.
The Linux updater's native evidence and limits are in [Linux updates](linux-updates.md);
user install steps are in [Install Pilot Next on Linux](linux-install.md).

No release trigger, production variable/secret mutation, published-asset deletion,
live app/daemon installation or restart is part of this change. Retrying an older
tag without the required GUI source/contracts fails rather than mixing source
revisions or relabeling a headless/development package.

An explicitly authorized draft retry runs the packaging-helper overlay from the
selected workflow commit, including `linux_gui_package_native.py`, while keeping
the GUI, updater and runtime inputs at the resolved tag commit. The native probe
compares its explicit `--source` with the checked-out HEAD, not the workflow's
`GITHUB_SHA` (which can be newer). Ordinary CI still passes its tested merge SHA
through `ci.sh`. A source-only probe fix therefore needs a dispatch of the
**updated workflow with the existing draft tag**, not a rerun of the old workflow
commit. Neither an ordinary green Release Please run nor local probe results
qualify the hosted full release payload.
