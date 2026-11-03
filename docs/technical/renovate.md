# Dependency updates

Renovate's native npm and Cargo managers use `config:recommended`, the existing
24-hour release age and three-PR concurrency limit. Updates require review;
automerge remains disabled. There is no additional Cargo schedule or grouping.
The npm Git dependency pause and Pi SDK grouping are unchanged.

Cargo discovers the desktop workspace (`apps/desktop/Cargo.toml`), its
`visual-worker` member and the independent `updater` workspace. The desktop and
updater each retain their own committed `Cargo.lock`. Ordinary exact dependency
requirements remain exact when updated; this change upgrades no dependencies or
lockfiles and does not enable lockfile maintenance.

Intentional exceptions:

- `gpui-*` dependencies require coordinated updates to checksum-pinned patches in
  `apps/desktop/patches`, generated `.patched` sources and native qualification.
  Renovate must not independently change the Kit 0.8.0 / GPUI 0.3.9 baseline.
- The updater's `zip =8.6.0` stays manual. Its archive admission code deliberately
  mirrors that parser's ZIP32/ZIP64 dispatch and fallback behavior. Re-audit and
  rerun the adversarial archive tests before changing it.
- `experiments/nsh-chat` and its GPUI comparison are baseline fixtures, not
  maintained product dependencies. Their NSH Git revision, local source patches
  and comparison dependencies stay manual.
- The Rust toolchain manager is not enabled. Desktop Rust 1.98.1, experimental
  Rust 1.99.1 and separately pinned build tools remain deliberate manual choices.

`scripts/renovate.test.ts` checks repository policy. The pinned Renovate image in
`.github/workflows/renovate-config.yml` validates configuration and runs
`scripts/renovate-contract.mjs` offline against Renovate's actual extraction and
package-rule APIs. These are contract checks, not a repository Renovate run.
