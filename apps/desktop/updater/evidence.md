# App-owned updater evidence

Initial source checkpoint was based on exact published
`5bd2498d2cd71fc3b4f864620c31deff2576c2a3`; only new updater-subtree paths are owned.
The user subsequently explicitly requested an app-owned updater. The earlier native
Sparkle probe was replaced, not layered alongside a second production updater.

App-owned signed manifest/transport/bounded ZIP staging, Security validation, native
atomic swap, explicit COMMIT+OS parent-exit helper and typed scheduler/worker are now
implemented. No gpui-updater/Sparkle dependency, custom cryptographic primitive or
shared UI/manifest/Settings/CI/packaging seam is adopted here.

## Verification

Compilation/tests are pending focused resource admission. Formatting and offline
dependency resolution have run; Cargo.lock pins the standalone dependency graph.
No compile/test pass is claimed yet. Final record will include frozen source and logs.

## Acceptance gaps

- No production credentials/key/feed/release, signing secrets, real installed app or
  daemon mutation, global install, local Swift test/build or Linux validation.
- Source is not registered/reachable in GPUI; compiled release identity/key are absent
  by default. Worker/helper fail closed, not silently using a development feed.
- No integrated draft/delivery/Settings acknowledgement+admission fence, actual shared
  daemon stop, GUI clean quit, helper packaging or post-restart durability receipt.
- Unit tests exercise real maintained cryptographic verification and synthetic transport;
  TLS network deployment/private-host authentication and an actual N→N+1 GUI launch
  are not inferred. Native component tests do not establish a production lifecycle.
- Failed launch retains old/new bundles; no automatic rollback or automatic cleanup
  promise. See README for recovery-required states and integration contracts.
