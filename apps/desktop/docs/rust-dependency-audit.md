# Rust dependency audit

Audited 2026-10-29 with cargo-audit 0.22.2 and the freshly fetched RustSec
database at `ee1a49a2769a24a596afc1c20cb33748d2769586` (1,386 advisories).
No advisory ignores, platform filters, stale-database allowance or yanked-check
exclusions were used. Maintenance warnings are not security-fix claims.

## Inventory and result

| Lockfile | Workspace/manifests | Vulnerabilities before → after | Maintenance warnings after |
| --- | --- | --- | --- |
| `apps/desktop/Cargo.lock` | Desktop and `visual-worker/Cargo.toml` | 3 → 0 | 8 |
| `apps/desktop/updater/Cargo.lock` | Independent updater, also a desktop path dependency | 3 → 0 | 0 |
| `apps/power/Cargo.lock` | Independent PilotPower | 0 → 0 | 0 |
| `experiments/nsh-chat/Cargo.lock` | Independent NSH prototype | 0 → 0 | 2 |
| `experiments/nsh-chat/gpui/Cargo.lock` | Independent GPUI comparison | 0 → 0 | 8 |

These are all five tracked Cargo lockfiles and six tracked manifests. Generated
patch/bootstrap manifests are build inputs, not additional maintained workspaces.
Neither audit reported yanked packages.

## Fixed security advisories

Both desktop and updater lockfiles originally resolved
`pilot-desktop-updater 0.1.0 → zip 8.6.0`:

| Advisory | Issue | Updated version |
| --- | --- | --- |
| RUSTSEC-2026-0367 | Extraction preserves SUID/SGID bits | zip 9.1.3 |
| RUSTSEC-2026-0368 | Extraction allows symlink targets outside destination | zip 9.1.3 |
| RUSTSEC-2026-0369 | Extraction applies permissions through unconfined symlinks | zip 9.1.3 |

RustSec specifies `>=9.0.0` as patched. The security-driven major upgrade uses
the current stable 9.1.3, including later extraction fixes. The updater keeps its
own bounded extractor, permission masking, deferred/confined symlinks, ZIP32/64
admission and cancellation. It does not switch to the crate's extraction API.
The metadata-transfer API and ZIP64 dispatch predicate were reviewed against
9.1.3; the admission guard remains necessary before parser allocation.

After the initial security update, the user expanded the request to all Rust
dependencies. All registry dependencies declared directly by repository crates
now resolve to their current stable releases, including base64 0.23.1,
reqwest 0.13.5, sha2 0.11.1, tokio-tungstenite 0.30.0, uuid 1.29.0,
unicode-normalization 0.1.26, cc 1.10.0, signal-hook 0.4.5 and zbus 6.1.0.
Existing lockfiles were updated in place, including the latest transitive
versions allowed by their upstream constraints. Those constraints can retain
older major versions; no unqualified upstream replacements were forced.

The reqwest migration explicitly retains native certificate roots and the ring
crypto provider via a preconfigured Rustls client, instead of adopting 0.13's
default platform-verifier/AWS-LC policy. Redirect, proxy, credential and timeout
rules remain unchanged. Rustls 0.23.46 and rustls-native-certs 0.8.5 were already
transitive dependencies and are now explicit owners of that unchanged policy.
The zbus migration uses its merged wire module and removes all three Power
maintenance warnings (RUSTSEC-2026-0370/0371/0372), verified by a fresh audit.

## Retained pins and patches

Desktop and comparison upgrade Kit 0.8.0 → 0.8.1 and GPUI-pre 0.3.9 → 0.3.10.
The migrated checksummed Base/Component 0.8.1 patch specifications remain authoritative; generated
`.patched/` files and Cargo's shared sources are not edited. GPUI-fast entries
in the desktop lockfile are optional dependencies, not a renderer switch.

Base's selection lifecycle changed upstream. The patch now detaches selected
unmounted participants through the new end-of-frame bookkeeping, retaining
logical copy/clear and excluding stale geometry. Input, image policy, scrolling
and source-range patches are preserved. Upstream's new retained-layout cleanup
task replaces the old local destruction marker; the local no-repeat-live-sweep
optimization and cross-thread regression remain.

The three native-glass patches are also migrated to GPUI 0.3.10. The macOS
backend has moved to objc2, so observer registration, callback types and teardown
use its current pointer/Bool APIs. The default-false capability, Reduce
Transparency handling, Wayland regions and the app's GlassRoot remain intact.
The concurrent Find source-mapping patches are preserved in Base 0.8.1.

SHA-2 0.11 no longer implements LowerHex for its output array. Compatibility
sites explicitly encode each byte as two lowercase hexadecimal digits, keeping
stored/source/artifact/guard fingerprints byte-for-byte in their existing format.
GPUI 0.3.10 reserves static keybinding construction for explicit modifiers;
platform-relative shortcuts now use its host-aware loader, preserving their
actions, context predicates and macOS Command/Linux Control behavior.

The NSH prototype retains revision
`c7b249970c2f9a15e20c5a461a7324ea9227c08f` of `longbridge/nsh`, including
its two tracked local patches for nsh-core and nsh-platform-macos. This revision
is already 137 commits newer than the latest stable v0.3.0 tag; updating to the
current development HEAD would not be a stable-release update. Its registry
dependencies are refreshed without changing the experimental API or patches.
No floating
Git dependencies or new vendored forks were introduced. Desktop Rust 1.98.1,
NSH Rust 1.99.1, macOS 15 minimum, Wayland-only guards and existing feature sets
are unchanged.

## Remaining maintenance advisories

All warnings below occur both before and after the update. Power's three
warnings were removed by zbus 6.1.0. There is no patched
release of the named crate reported by RustSec. Paths describe the locked graph
across platforms, not proof that every dependency is active on macOS.

For the desktop and GPUI comparison, let **G** mean
`pilot-desktop 0.1.0 → gpui-kit 0.8.1` or
`chat-gpui-comparison 0.1.0 → gpui-kit 0.8.1`, respectively.

| Advisory | Exact remaining version and dependency path | Why retained |
| --- | --- | --- |
| RUSTSEC-2024-0384 | G → gpui-base 0.8.1 → instant 0.1.13 | Framework owns clock API; no compatible maintained release. |
| RUSTSEC-2024-0436 | G → gpui-component 0.8.1 → paste 1.0.15 | Macro dependency requires upstream replacement, not a version update. |
| RUSTSEC-2025-0134 | G → gpui-kit-assets 0.8.1 → gpui-pre-reqwest 0.12.15 → rustls-pemfile 2.2.0 | GPUI's maintained HTTP fork owns PEM migration; do not replace it with upstream reqwest. |
| RUSTSEC-2026-0206 | G → gpui-pre 0.3.10 → usvg 0.46.0 → rustybuzz 0.20.1 | Font-shaping migration to harfrust is not a compatible leaf update. |
| RUSTSEC-2026-0192 | G → gpui-pre 0.3.10 → ttf-parser 0.25.1 | Font-parser replacement requires framework changes and rendering qualification. |
| RUSTSEC-2026-0371 | G → gpui-base 0.8.1 → ashpd 0.13.13 → zbus 5.19.0 → zbus_names 4.3.5 | Merged into zbus 6; upstream portal migration required. |
| RUSTSEC-2026-0370 | G → gpui-pre-platform 0.3.10 → gpui-pre-linux 0.3.10 → oo7 0.6.0 → zvariant 5.15.1 | Merged into zbus 6; upstream keyring migration required. |
| RUSTSEC-2026-0372 | Previous path → zvariant_derive 5.15.1 | Same zbus 6 migration. |

Desktop also locks analogous optional gpui-fast 0.1.12/platform/Linux paths
to rustybuzz, ttf-parser and oo7. Keeping those warnings visible is intentional.

Additional paths outside GPUI:

| Advisory | Exact remaining version and dependency path | Why retained |
| --- | --- | --- |
| RUSTSEC-2025-0141 | nsh-chat-prototype 0.1.0 → nsh-base 0.3.0 → syntect 5.3.0 → bincode 1.3.3 | Replacing serialization is an upstream prototype dependency change. |
| RUSTSEC-2026-0192 | nsh-chat-prototype 0.1.0 → nsh-core 0.3.0 → nsh-macros 0.3.0 → ttf-parser 0.25.1 | Preserve source-pinned prototype; requires upstream font-parser replacement. |

## Reproduce

For each lockfile above, with an installed cargo-audit:

```sh
cargo audit --file <lockfile> --json
```

Default auditing includes all locked platforms and checks yanked crates.
Exit zero means no reported security vulnerabilities, not no maintenance warnings.

## Verification boundary

macOS desktop/worker all-target compilation and strict Clippy pass with and
without native probes. Updater: 132 tests pass (four explicit native-fixture
ignores); Power: 35 tests pass, including private fake D-Bus ownership tests.
Both independent crates pass all-target Clippy. After reconciling upstream, the focused desktop matrix
passes 127 of 128 tests, covering Unicode/IME/undo, scrolling, retained selection,
readonly copy, hash golden values and durable input identities.

`transcript_view::tests::selection_in_streaming_message_keeps_source_range_and_copy`
still fails with `None` instead of `Some(3..9)`. An isolated unchanged
`35d19c5d` baseline reproduces the same failure with the old dependencies.
The test remains enabled and is not treated as a passing result.

The offscreen renderer, hidden real AppKit material/notification/teardown
fixture, and GPUI comparison all-target compile pass. Hidden native checks do
not establish visible blur or smoothness qualification. Cargo also retains a
future-incompatibility warning for transitive `block 0.1.6`; it is not reported
as a security advisory or claimed fixed.

Linux verification uses an isolated aarch64 container with Rust 1.98.1,
read-only sources, a private target and a CPU2/4 GiB host mbx reservation.
At audit time, `native-probes` compilation failed because the sidebar scroll
probe used macOS-only instruction and cycle counters. The probe now explicitly
fails on Linux rather than reporting fabricated counters; Linux CI compiles the
feature and tests that failure. This is not x86-64 release, Wayland compositor,
confinement or Linux scroll-measurement qualification.

Linux/aarch64 normal desktop/worker all-target compilation passes. Independent
native-Linux updater and Power all-target Clippy pass; ten ZIP admission tests
and the Power synthetic suite pass. No real session bus, compositor, service,
sleep policy, installation or release was changed.
