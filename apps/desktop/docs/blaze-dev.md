# Local Blaze development

Opt in explicitly, from `apps/desktop`:

```sh
bash scripts/bootstrap.sh --blaze
bash scripts/cargo.sh --blaze build --locked
bash scripts/cargo.sh --blaze run --locked  # Visible app: arrange with user first.
bash scripts/cargo.sh --blaze status
bash scripts/cargo.sh --blaze stop
```

This path is **local development only**, not CI, release or a replacement for
pinned verification. `CI`/`GITHUB_ACTIONS` refuse it. Ordinary `cargo.sh` and
`check-scoped.py` keep mbx1.26.0/Rust1.98.1 and explicitly disable ambient
`MBX_BLAZE`. GitHub Actions runs plain Cargo 1.98.1 with a dependency build cache
instead of mbx. No release profile, global Cargo config, shell shim,
service or existing app/daemon is changed. Do not use `mbx setup` or `ra-jit enable`.

## Actual supported integration

mbx1.26.0 has no Blaze setting. The separate `.tools/blaze` installation pins
mbx**1.28.0**, whose Cargo shim supports `MBX_BLAZE=1`. Bootstrap copies that mbx
binary under the local name `shim/cargo`, the shim dispatch upstream supports.
The shim invokes **`ra-jit cargo`**, not Bazel or a guessed mbx flag. The existing
shared mbx store and CPU2/4GiB scheduler remain; `mbx reserve` covers the external
Blaze command and nested cached Cargo work without nested admission deadlock.
Admission remains an estimate, not an OS CPU/RSS limit.

After acquiring that existing scheduler, the child uses a separate shared store,
`${XDG_CACHE_HOME:-$HOME/.cache}/gpui-fixture-blaze-mbx-v1`, with the same2GiB
budget and4GiB free-space reserve. This keeps mbx1.28 metadata migration away
from pinned1.26 cache state. Blaze worktrees share eligible outputs with each
other, not incompatible compiler outputs from the ordinary path.

The available upstream `nightly` binary archive is older than current Blaze
documentation: it is from **8b15e4b406f010f98eb456ec867e16e0a9ebb0d5**,
published2026-10-20, reports `ra-jit0.0.0` and requires **Rust1.99.0 + rust-src**.
Bootstrap pins each platform archive's SHA-256, including that mutable nightly
URL: a changed archive fails, never silently upgrades. It does not build current
Blaze main or claim its newer own-nightly toolchain/borrow-checker features.
Both Rust versions live in this checkout's ignored `.tools/rustup`; normal
commands still explicitly select1.98.1. Blaze builds have a separate
`target/blaze`, not `target/dev`. Never use Blaze artifacts for release.

The published engine has **no borrow checker**. Treat its build/test results as
edit-loop feedback only; rerun ordinary pinned checks before delivery. The
wrapper accepts only dev build/run/test/check, or status/stop. Release, named
profiles, Clippy, toolchain prefixes and flags before the command are rejected;
use the ordinary wrapper for those.

Each worktree gets a short private daemon/socket directory under
`~/.cache/pb/<worktree-path-hash>`. It never connects to the user's general ra-jit
daemon. The engine retains compiler state in memory for warm rebuilds and stops
after its upstream30-minute idle timeout; `--blaze stop` releases it earlier.
Spare speculative workers are disabled. The engine's separate unbudgeted disk
store is disabled; eligible Cargo outputs share the bounded Blaze mbx store.
Private target files need their own disk headroom. No global cleanup runs.
Initial builds may warm the workspace after Cargo returns. The lease covers
the foreground command, not the daemon's retained memory/background warmup.
This is not an OS resource limit; stop the private daemon when done developing.
The published archive lacks `ra-jit-rustc-first`, so do not enable the upstream
experimental `RA_JIT_FIRST_BUILD` mode with this installation.

## Verification and limits

Script coverage exercises actual wrapper dispatch under system Bash3.2 and PATH
Bash, default pins, private targets, resource reservation, CI/profile refusal,
missing setup, program-argument boundaries, status/stop and scoped-check isolation:

```sh
python3 -m unittest discover -s scripts -p test_blaze.py
python3 -m unittest discover -s scripts -p test_check_scoped.py
shellcheck scripts/{cargo,bootstrap,bootstrap-blaze}.sh
```

No desktop speedup is implied by enabling this path. First use must load the
workspace and may be slower. A useful claim requires comparable commands,
compiler/profile/cache state and an actual `[ra-jit]` rebuild, not just a shim
invocation or ordinary Cargo fallback. Full desktop cold builds, native UI,
Linux platform qualification and CI remain separate.

### Observed tiny fixture, macOS arm64

The real production `cargo.sh --blaze` dispatch was copied into an owned
temporary crate with only patch preparation replaced by a no-op (this tiny
crate has no GPUI patches). Actual mbx1.28 and the checksum-pinned engine ran
under CPU2/4GiB admission with Rust1.99.0 and dev/debug0. Logs showed:

```text
mbx[cache]: 0 hits, 0 misses, 1 bypassed
Finished `dev` profile [ra-jit] target(s) in 1.86s
```

The final first build took1.744s wall time, the immediate unchanged command0.650s,
and the single-function edit1.980s. The edited executable printed the expected
`11`; the private daemon was then stopped. The unchanged command still used
Cargo while the daemon loaded. These are dispatch/build observations, **not a
comparable before/after speedup**, a cache-hit claim or desktop qualification.
Private raw receipts are in `evidence/local/blaze-probe.json` and matching logs.
Final script checks:7 dispatch tests,23 scoped-runner tests,57 existing CI-script
regressions, ShellCheck, Python compilation and Bash3.2 syntax passed. Rationale:
only developer dispatch/environment/setup changed; no app Rust or CI workflow
changed, so no cold GPUI/full native suite was needed.

**Investigation side effect:** before separating the stores, the first mbx1.28
probe against the normal shared store reported discarding incremental state
from61 older-version checkouts as its upstream hard-linked-seed safety
migration. This was not an explicit cleanup; no active local Cargo build was
present, no job was stopped, and no application data/source was changed. The
final path uses the separate store above to avoid further cross-version
metadata migrations. Do not point the experiment at the pinned cache directly.

Upstream references:
- [mbx1.28.0 release](https://github.com/jdx/mr-boxington/releases/tag/v1.28.0)
- [Supported shim routing](https://github.com/jdx/mr-boxington/blob/v1.28.0/crates/mbx/src/cli/blaze.rs)
- [Published engine source](https://github.com/indexable-inc/blaze/tree/8b15e4b406f010f98eb456ec867e16e0a9ebb0d5)
- [Current Blaze toolchain documentation, not the published binary's pin](https://github.com/indexable-inc/blaze/blob/main/docs/toolchain.md)
