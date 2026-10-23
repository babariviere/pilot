# macOS Rust CI, source-frozen verification ledger

## Scope and status

Adds `.github/workflows/desktop-rust.yml` and `scripts/ci.sh`, independent of
Node/Swift green checks. Base: published
`5bd2498d2cd71fc3b4f864620c31deff2576c2a3`. No app/library/Cargo/patch/helper
source or existing workflow changes. No history repair, signing, release/feed
publication, app installation/restart, service or production credential access.

**Initial checkpoint: remote Rust run pending.** A mocked runner pass is not a
Rust build or native-renderer pass. Actual normal PR results will be added after
completion notification, without polling or manually rerunning CI.

## Gates and limits

- One `macos-15` Apple Silicon job, macOS 15+ host/architecture guard, Xcode
  26.2, Python 3.13, existing pinned Rust **1.98.1** and SHA-verified mbx
  **1.26.0** bootstrap. Deployment target **15.0**, native host target
  **aarch64-apple-darwin**. No Intel or Linux/Wayland support claim.
- Existing bootstrap, private crate patch preparation, pinned QuickJS-NG
  preparation and Cargo/mbx wrapper are reused unchanged. No `rustup default`,
  global mbx setup, sudo or local shared build-slot bypass.
- rustfmt, strict workspace/all-target/native-probe Clippy, real debug helper
  build, app library tests and helper binary test harness, then Python runner
  tests. Library tests include GPUI's synthetic test platform and real confined
  helper runtime/conformance checks, not just pure functions. The helper binary
  currently defines **zero direct unit tests**; its real behavior is exercised
  by the library's runtime tests. Existing explicit ignored disk workloads stay
  ignored, not claimed passed. Cargo logs provide actual test/ignored counts.
- `build --locked --release --workspace --bins` builds **both** ordinary app
  and visual helper without native-probes/test-support features. No debug-only
  build substituted for an optimized build.
- All 14 ordinary offscreen native probes compile even without a GPU. An
  Objective-C Metal preflight checks `MTLCreateSystemDefaultDevice()`: only
  a nil device (exit 78) produces explicit **UNSUPPORTED**, a warning, step
  summary and status artifact. That is not native test execution or success.
  Compiler errors, preflight crashes and actual test failures fail the job,
  never become unsupported or continue-on-error. On a capable runner all
  rendering/chrome/visual/disclosure/style/icon/motion/control/history/shell/
  navigation/Inbox/jump/workbench probes execute serially. Private captures,
  scaling benchmarks and large-render workloads are not launched.
- CPU: existing wrapper's **2** Cargo jobs/mbx CPU shares and **4 GiB admission
  estimate**, not an OS memory limit. One serial workflow job, cancellation on
  newer PR/main source; outer **90 min** limit, bootstrap **10**, check **35**,
  release **35**, native **20** minute step ceilings. These are watchdog limits,
  **not measured cold-build times**. Cold build/runtime/disk feasibility remains
  unproven until the first remote run; no previous local warm build is evidence
  for that. No duplicate local full/native/Swift suites were run.

## Inputs, cache and trust

PR and main triggers cover the desktop workspace (including lock/toolchain,
source, fixtures, patches and scripts), shared visual runtime/fixtures, C engine
and headers, root Cargo/config/toolchain inputs, and this workflow. Desktop
`evidence/**` is documentation/output only and excluded so a result-only ledger
update does not start another expensive Rust run. In particular, compiled
`fixtures/reply.md` is **not** excluded by a broad Markdown filter.

Permissions are `contents: read`; checkout credentials are not persisted.
Normal `pull_request`, never `pull_request_target`, with no secrets. Only Cargo
registry **archives** and checksum-verified preparation downloads are cached.
Exact OS/architecture/Rust/mbx + workspace/transitive-input hash key, no restore
prefix. Generated Python bytecode/evidence are excluded from identity. No
toolchain, registry source, Cargo target/incremental, mbx object, auth, signing,
HOME or user-state cache. Every runner's compiled objects start cold. PR cache
scope cannot promote its outputs to the default branch; existing release jobs
do not consume these caches/artifacts. This workflow never promotes anything.

## Artifact contract for later packaging integration

`desktop-rust-unsigned-aarch64-apple-darwin-<tested SHA>` (7-day retention):

- `pilot-desktop`, `pilot-visual-worker`, sibling raw release executables.
- `manifest.json`: schema 1, kind `unsigned-ci-executables`,
  `installable_update: false`, tested checkout SHA/tree, separately recorded
  PR head SHA (null on main), package versions, target/deployment/profile,
  empty app features, actual Rust/mbx/Xcode/SDK versions, lock hash and each
  binary's byte size/SHA-256. `lipo` rejects non-arm64 binaries.

The default PR checkout is GitHub's **merge commit**, not its head. Both
identities are explicit. The artifact is uploaded after build/check success,
before native verification; its manifest explicitly does **not** imply native
success. Read the separate `desktop-rust-native-status-<tested SHA>` artifact
and workflow conclusion. Failed native execution cannot hide behind successful
binary upload. Artifacts contain no chat/source dumps, logs, credentials,
signed bundles, updater frameworks or feeds.

These are **non-release CI outputs, not a signed installable update**. No
Developer ID signing/notarization is performed (Apple's linker may produce an
ad-hoc signature). ZIP download may lose executable modes. Later packaging must
build/verify a separate app identity/version/feed, updater native resources,
signing/notarization, safe lifecycle and immutable source provenance. Never
install or publish these raw binaries as an updater payload.

## Local checks and frozen inputs

Before first publication, 2026-10-23:

```sh
bash -n apps/desktop/scripts/ci.sh
python3 -m unittest discover -s apps/desktop/scripts -p 'test_*.py' -v
git diff --check
```

**19 passed**, including 15 new CI/workflow contracts and 4 existing mocked
measurement-runner contracts. Tests use temporary fake tools, not Rust/native
processes or real state. Ruby's YAML parser also accepted the workflow document
(its YAML 1.1 representation treats `on` as a boolean; GitHub uses its own
workflow parser). No actionlint/schema or remote execution claim from that
syntax check. An initial test's overbroad cache-comment assertion failed and
was corrected to assert exact cached paths; no production guard was weakened.

Pre-publication SHA-256 identity (these files frozen before remote run):

| Input | SHA-256 |
| --- | --- |
| `.github/workflows/desktop-rust.yml` | `dbfa32cafbd5243af20910cd14634ee57e0db1a52cbc40491990d8baa7b54aa5` |
| `apps/desktop/scripts/ci.sh` | `1d1d787971396dc95a876b7df840d96faafeb0039aee018a55636537ba20e45f` |
| `apps/desktop/scripts/test_ci.py` | `20801115838d270e35cda3520f734c4c100ffe095e5ed29d14d1093dcb319fe8` |
| `apps/desktop/Cargo.lock` | `c2ed69e73723fb4318ea842349350a95336a745ef7c8f1e0628b457a9b0c291e` |
| `apps/desktop/rust-toolchain.toml` | `887f9be066a15585a2c583578e84b0fcb541126d81546276bad3d2ff00d61167` |
| `scripts/bootstrap.sh` (desktop-relative) | `cb2602da76b4cbd5c88d6e743c49d2d97ccdfbc9c650228d0b237dab7448abee` |
| `scripts/cargo.sh` | `f14d6f931fa61566557d2e620d258248a3d3661a46e625bd1ca24d5fd4352a65` |
| `scripts/check.sh` (not changed/invoked wholesale) | `bbc3f7f278eee39430fd60b70e4922b54f8856380e602a744b06a77d72ce1ec3` |
| `scripts/prepare-patches.py` | `9d8cb445d7fd78d4e2fef5fee74ddad3f08de7525de42e602ada75ac1fb0788a` |
| `scripts/prepare-visual-worker.py` | `e479b0640b76bd622aafa3f5e8e80466419db3faf22575f4b66251827f6192fe` |

All other desktop/shared-engine/runtime/fixture inputs are unchanged from the
exact published base above; the eventual tested commit tree freezes them.
Existing Node/Swift checks, previous warm local GPUI checks and parent PR green
statuses establish none of this workflow's Rust/cold/native results.
