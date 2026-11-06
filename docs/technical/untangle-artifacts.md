# Artifact cleanup decisions

## Problems and changes

- Publication validated a write twice and serialized visual check data three times. One internal
  validation/preparation path now carries the normalized write and serialized visual data through
  preparation. Public validation and preparation wrappers keep their result shapes. Input getters
  are materialized once; no cache or bypass flag is used. The supported ArtifactData contract is
  JSON values, not functions or stateful toJSON methods. Their call counts are not a contract.
- Shader and visual errors repeat the same bounded diagnostic formatting. Share the body formatter,
  but keep each caller's prefix and compilation policy.
- Telemetry repeats estimate and billing rejection conditions. Remove only conditions covered by
  the remaining checks, and test status/amount/pricing combinations through recording.
- Test lanes consult an empty macOS-only set. Remove that set without changing lane membership.
- Name the legacy fixture as a helper, not a test. Distinguish the artifact summary projection from
  the store's summary lookup.
- Replace self-counting suite assertions with explicit classifications. Strengthen the retired-path
  subprocess test so its claims match checks for process and worker execution.

## Boundaries kept

Source text is never trimmed or rewritten. Titles keep their existing normalization. Validation
order, limits, public exports and prepared result shapes stay unchanged. No process-global memoization
or added reads of input getters are introduced.
Disk serialization remains the store's existing JSON representation, not a new data conversion.

Passive stored-revision reads keep their byte fidelity, size bounds, identity checks, cancellation
and symlink/race protection. Image HTML reconstruction, shader-checker failure policy, preview
rejection ordering and documented benchmark forwarding entry points remain separate contracts.
Legacy fixtures remain test-only and never publish through the runtime write path.

## Verification

Run focused Node tests with inherited PILOT_* variables removed. Cover validation errors and byte
boundaries, title/source fidelity, visual serialization, diagnostics, telemetry pairing, lane
classification, legacy reads and rejected publication. The parent agent runs workspace typecheck.

Initial focused verification passed: render, retired-path lifecycle, store, shader, stored-revision,
visual check, telemetry and test-suite tests (84 tests). Biome formatting passed for changed
implementation and test files. No live accounts, jobs or external services were used.

After publication consolidation, render/store passed (19 tests), image/shader passed (12 tests),
and store/retired-path lifecycle passed again (12 tests). Store checks include an oversized-data
update that leaves the committed pointer unchanged and creates no next revision.
