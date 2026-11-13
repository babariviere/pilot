# Dependency updates

Renovate's native npm and Cargo managers use `config:recommended`, the existing
24-hour release age and three-PR concurrency limit. Updates require review;
automerge remains disabled. Minor and patch updates are grouped by purpose:

- npm runtime dependencies.
- JavaScript tooling (`@biomejs/*`, `@types/*`, `@typescript/*` and `tsx`), even
  when a tool is also a runtime dependency.
- OpenTelemetry packages, separate from other runtime dependencies.
- Rust dependencies across maintained workspaces and their lockfiles.

Major upgrades stay separate, except for the existing coordinated Pi SDK group.
Pi SDK rules take precedence over routine groups and still pin dependencies and
overrides together, including mixed major/minor updates. Git digest updates
track upstream pi-extensions separately with pnpm artifact generation. Grouping
adds no schedule and does not enable any paused dependency.

Pi SDK dependencies and overrides currently share 1.5.0. The pi-extensions Git
pin includes its embedding exports and host lifecycle/tool-drain fixes. Pilot
no longer carries an extension patch; these APIs are maintained upstream.

Cargo discovers the desktop workspace (`apps/desktop/Cargo.toml`), its
`visual-worker` member and the independent `updater` workspace. The desktop and
updater each retain their own committed `Cargo.lock`. Ordinary exact dependency
requirements remain exact when updated. Native artifact generation keeps
`Cargo.lock` and `pnpm-lock.yaml` in sync with manifest updates. Lockfile
maintenance also refreshes locked versions without requiring manifest changes,
using Renovate's default weekly schedule (before 04:00 on Monday, UTC).
Maintenance PRs require review, just like dependency updates.

Intentional exceptions:

- `gpui-*` dependencies require coordinated updates to checksum-pinned patches in
  `apps/desktop/patches`, generated `.patched` sources and native qualification.
  Renovate must not independently change the Kit 0.8.0 / GPUI 0.3.9 baseline.
- The updater's `zip =8.6.0` stays manual. Its archive admission code deliberately
  mirrors that parser's ZIP32/ZIP64 dispatch and fallback behavior. Re-audit and
  rerun the adversarial archive tests before changing it.
- The Rust toolchain manager is not enabled. Desktop Rust 1.98.1, experimental
  Rust 1.99.1 and separately pinned build tools remain deliberate manual choices.

`scripts/renovate.test.ts` checks repository policy. The pinned Renovate image in
`.github/workflows/renovate-config.yml` validates configuration and runs
`scripts/renovate-contract.mjs` offline against Renovate's actual extraction and
package-rule APIs. These are contract checks, not a repository Renovate run.
