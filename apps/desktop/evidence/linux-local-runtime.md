# Native Linux bundled Local qualification

## Exact inputs

- Immutable app/runtime source: `b255baf2f95093215e99ec805cd588241439465a`.
  Tree: `2fd3347495d998ec1710a61f70afc80753b0413f`.
- Native x86-64 Linux, kernel `7.2.9-ogc3.1.fc44.x86_64`, explicit same-user
  Wayland socket. Software rendering requested. Not a distribution/GPU matrix.
- Pinned Rust1.98.1, mbx1.26.0, CPU2/4GiB wrappers, private source/target/profile
  directories and shared verification slots. Real debug GUI/helper, not C stubs.
- GUI:211,484,400 bytes,
  SHA256 `e44865429c28ea592a833b6049dd4931e5b1ab5e217b83519023eb27f3a5cfb3`.
- Visual helper:2,900,312 bytes,
  SHA256 `d67ec7f082d766e84eda5beda9b44ec11bccd78ccea8ce865e08d93ed3f80c2f`.
- Whole package inventory:24,444 entries. Runtime input inventory:24,436 entries.
  Exact manifest/capsule SHA256:
  `8882c1bc9d5e6fbcc950b1fd3e8bc4f410a102bca77d5980b89a0fce40cb2b3a`.

The matching production Node24.21.0 closure was rebuilt from immutable git
objects, using the existing Linux runtime producer in a rootless Debian11/
Python3.13/GCC10 container (image `dfac0f6e0824af83e0737e300092e12fde83f1a9e5be0514a19faed124ad92fa`).
CPU2/4GiB, PID512, dropped capabilities and no-new-privileges; only private fixture
files mounted. No host packages installed. The real Node-PTY build, ABI audit and
offline production smoke before/after relocation passed.

Fixture transport decoded the owned gzip archive once into a seekable tar before
calling the **unchanged** immutable extraction preflight. This avoids repeated
gzip seeks while materializing pnpm hardlinks, without retaining hardlinks or
skipping expanded-byte/link checks. Runtime producer SHA256:
`6f1cdf01e59f8281f918c7d46b0b1ec9aec9d80d9546cc6f8fe225db8868d6b4`;
closure builder:`d3c30e22b317781a3e98211060291c01dc22c2868276881e151bedf079af2bf1`;
separate fixture wrapper:`8d69a8c0302c4ca65dab5fbc490c5a074d5b0beaaa2e7e11f91d6b66babd41ff`.
These bytes were not relabeled as another source or a signed release.

## Actual results

The complete relocated package passed inventory verification and dependency/
RPATH/ELF-architecture/symbol-version auditing of all eight ELFs on this host.
No older-distro minimum is inferred from these native binaries.

The actual GUI and bundled closure, with private HOME/config/data/cache and a
fresh owned profile, passed:

1. Native Wayland rendered-buffer attachment and live source/profile/boot proof.
2. Immutable `payload/runtime` owner root, independent of the GUI path.
3. GUI exit preserving the activated daemon.
4. Renaming the original GUI package, then exact compatible reuse from its new
   path: boot, PID and runtimeRoot unchanged, no second daemon, history marker
   preserved.
5. Owned descendant cleanup through subreaper adoption/pidfds and `waitpid`.
   Subsequent source-owned lease inspection returned **idle**.

The fixture waits for actual daemon adoption after readiness, which can precede
launcher exit. It counts daemon entrypoints, not unrelated short-lived owned
helpers, and drains descendants newly adopted while reaping an owned launcher.
Qualifier SHA256:`5b5046876a3a096719d781e5633f0f750740bca41db02565b2263596c4b36f00`.
The final immutable source includes the corrected fixture and a cancellation/
deadline check immediately before helper spawn. Own startup/ownership code is
byte-identical to this build. Later main composition includes independently
landed conversation read-limit, mission backend and release-version changes;
startup, hello identity and owner/launcher tests cover the relevant seams without
relabeling these native binaries as the later source or claiming a new full
release-payload qualification.

A supplemental earlier-source135 startup worker also returned actual `LocalOptions` success
through the owned diagnostic example in22.7234seconds on the retained managed
profile, preserving its history marker. Its real bundled daemon descendants were
reaped afterward (`qualified-worker-handoff.json`), not merely inferred ready
from a living process or a rendered startup screen.

Native strict library/example Clippy,14 focused Rust tests and the full real
workspace GUI/helper build passed. The explicit full-payload timing test is
ignored in ordinary suites and was run separately with owned paths. The22
native daemon owner/launcher tests passed, covering real lease contention,
unknown/legacy refusal, source-root and HMAC-proof mismatch, preactivation
cancellation/reap, postactivation cancellation/lost-ACK preservation and unchanged
legacy callers. Matching macOS scoped14 tests/strict library Clippy, direct tsgo
and targeted Biome passed. Existing fixture-only dead-code/future-compatibility
warnings and the Biome schema/CLI informational mismatch are not new suppressions.

## Demonstrated failure and correction

The earlier exact-source GUI rendered, but the full payload exceeded its45second
startup budget before daemon activation. Measurement on the same earlier payload:
validation9.8465seconds, per-file-fsync publication71.3037seconds. This was a real
failure, not a passing usable-startup result.

One Linux `syncfs` barrier before publication, followed by publication-directory
fsync, preserved persistence and reduced publication to28.7554seconds on that
same payload. Its separate initial validation took9.1507seconds. Startup now
avoids a redundant validation pass; the original45second budget and cancellation
checks remain. macOS durability code is unchanged. This is a focused startup
correction, not general performance acceptance or a claim about other filesystems.

## Limits and retained outputs

This qualifies the exact development payload's base Local lifecycle, not a
signed optimized release, full updater GUI checkpoint/relaunch acceptance,
native visual confinement, IME/GPU/frame-pacing or other distributions. Linux
update receipts explicitly refuse until the verified updater handoff is composed.
No release qualification variable was set, no release triggered, and no actual
user app/daemon/profile was installed, restarted, stopped or migrated.

Private outputs remain under `~/.cache/linux-local-qualify.sc3RhL/`:
`delivery GUI candidate moved`, `delivery-runtime-inputs`,
`delivery-local-fixture/receipt.json` and `delivery-elf-audit.json`. Earlier
`qualified-*` outputs retain the supplemental worker and before/after evidence.
The existing earlier packaging fixture was read/copied only, never modified.
