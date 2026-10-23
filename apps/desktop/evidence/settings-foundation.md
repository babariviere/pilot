# Isolated Settings foundation

Scope: four new paths only, originally based on exact published
`5bd2498d2cd71fc3b4f864620c31deff2576c2a3`. At the user's request, only the four
Settings-owned commits were rebased and squashed onto main
`46923720ea3a23f8e3d7f3f48e0005fffecfab6c` after the former stacked parent merged.
The rebased diff is still exactly these four additions, not inherited ancestor changes.
Implementation/test bytes and the desktop dependency lock are unchanged from the focused
verified inputs below. No new whole-app/native verification is claimed for the new base.
No shared lib/Cargo/check registration,
UI/components/theme/shell/editor/runtime/draft-store changes, new dependencies or production
state access. **Foundation only, not reachable Settings UI/full parity.** The real Swift
inventory, authority matrix and API/path contract are in `../docs/settings-parity.md`.

## Verification ledger

Frozen implementation/tests: `36d70aa69f480fd8aaaaba36080c3570822c7f93`, descendant of
initial checkpoint `a740658033ec2d006b92a1da34eb43d02eaf97b6`, on exact base above.

Pre-build SHA-256:

```text
342aa20de4061281e04ea9822111a38ebf3f3c4dd4d4dffc30a477afbdc4a8e5  src/settings_state.rs
24a5ed7484f1c8bb63b70425c85bff132537a1e258683dc3f522d0244950c065  tests/settings_state.rs
```

Final job `10dbb005-709f-4816-970d-8fbd2e14be32` completed **EXIT0**, 2026-10-23
15:05:15 UTC. All17 tests passed (0.32s), strict standalone all-target Clippy and rustfmt
passed, all12 dependency versions/checksums matched, and pre/post source hashes were unchanged.
The single shared slot was then released. A benign mbx build-script cache bypass warning
remained; no cache-hit/speedup or full-app verification is claimed. Publication adds only
inventory/evidence documentation after this frozen source.

The harness path-imports only `src/settings_state.rs`; its dependencies are the existing exact
`libc=0.2.191`, `serde=1.0.229` (derive), `serde_json=1.0.154`. No GPUI/native/helper/Swift
build, global install, full suite or real preferences read/write is needed for this foundation.
Synthetic tests create uniquely named private temporary roots and sentinel neighbors only.

Tests cover pure state/load/edit/explicit-save/error/retry, newer edits versus stale completion,
defaults/missing/no writes, all appearance roundtrips/restart, private modes, invalid/future/
unknown/duplicate/oversized input and exact read bound, failed write/last commit retention,
post-rename uncertainty/reconciliation, conflicting writers/lock contention, replaced roots,
symlinks/hardlinks/public directories/nonregular state, preserved pre-existing staging and
neighbor Swift/draft/auth sentinels. No theme application, real sends, real account actions,
actual app preferences, native visual/motion or full integration checks are claimed.

The initial job `5473dc98-9695-4ede-a56a-00799ab178a1` on `a7406580` passed all16 tests,
then exited101 on one test-only needless-borrow Clippy lint. It is not cited as a final pass.
The successor fixes that lint, adds an explicit preserved-staging recovery error and a17th
regression proving removed initialized directories are not recreated. First-run `rust-objcopy`
emitted a missing-libLLVM stripping warning; the test binary executed successfully. The
temporary final harness sets `strip="none"`, without repairing/installing any toolchain.

Checks use Rust1.98.1, the existing installed toolchain/mbx binaries, private temporary target,
the shared `verification-slot.py swift` lock and mbx CPU2/4GiB limits, with the UI owner's
explicit admission. No source from another changing workspace is compiled. All12 temporary
harness dependency versions/checksums are checked against the repository Cargo.lock before
verification; the temporary manifest/lock/target are not shipped or a second package setup.

## Reproduce the isolated check

From `apps/desktop`, with the existing project-local tools prepared, create a temporary
manifest outside the repository (no shared Cargo/lib registration):

```sh
root="$PWD"
scratch="$(mktemp -d)"
cat > "$scratch/Cargo.toml" <<EOF
[package]
name = "settings-foundation-check"
version = "0.0.0"
edition = "2024"
publish = false
autotests = false
[workspace]
[dependencies]
libc = "=0.2.191"
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.154"
[[test]]
name = "settings_state"
path = "$root/tests/settings_state.rs"
[profile.dev]
debug = 0
strip = "none"
[profile.test]
debug = 0
strip = "none"
EOF
```

Use the standard serial resource admission and wrapper environment from `scripts/cargo.sh`
(CPU2/4GiB, private target), without its GPUI patch preparation. Run mbx
`generate-lockfile --offline --manifest-path "$scratch/Cargo.toml"`, verify the resolved
package versions/checksums against the committed lock, then mbx
`test --offline --locked --manifest-path "$scratch/Cargo.toml" --test settings_state -- --test-threads=1`
and `clippy --offline --locked --manifest-path "$scratch/Cargo.toml" --all-targets -- -D warnings`.
Run `rustfmt --edition 2024 --check src/settings_state.rs tests/settings_state.rs` and verify
the frozen source hashes before and after. The main application full/native suites are
intentionally not part of this foundation-only check.
