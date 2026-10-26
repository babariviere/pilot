# Readonly task browser qualification

Base: accepted `90d2661ec9d9a1897ee6e6730bafc573d33785b6` (main).
Scope: new `mission_tasks*` model/reader/view/tests/probe/docs plus only Browser
child/init/source/render wiring, lib export, named Cargo/native registry and
helper-free scoped-check registration. No backend, LocalViewer, composer,
editor, store, interaction, questions, navigation, inspector or conversion edits.

## Source to check mapping

- `mission_tasks_tests.rs`: three passing cases. Same-title independent exact
  IDs/order/body/Unicode; foreign/duplicate/malformed/row/body caps; source and
  generation/closed target, retained error and removed selection transitions.
- `mission_tasks_reader_tests.rs`: three passing owned-faux cases. Only hello
  and existing mission-detail GET; pinned home/identity, unsupported/status/error/
  redirect/malformed/declared+chunked wire/per-body caps; actual superseded slow
  read cancellation and closed-worker refusal. No real account or mutation.
- `mission_tasks_probe.rs`: four passing mounted production Browser journeys,
  680/1100 logical widths, light/dark verified after window creation. Pointer
  and Up/Down/Return select separate same-title tasks; Escape returns to list;
  Copy preserves exact description/ID and Unicode; real wheel reaches task40
  beyond the former24-row preview; 503 retains selected task40 and shows stale/
  error, explicit retry works; closing performs zero reads; mission switch
  clears disclosure/selection/snapshot during a pending read. The independent
  worker case proves cancellation of an actually admitted in-flight request.
- Matching production lib/native Clippy `-D warnings`, named test compilation,
  selected rustfmt and native CI registry/faux command checks. No full/all-target/
  all-native sweep, Swift check, live service action, CI wait or profiling.

## Frozen receipts

Private `/tmp/tasks114-evidence` retains all attempts and source hashes.
`check5.json/log`: EXIT0, six unit/faux tests, zero ignored, one1100-light mounted
journey and matching lib/native lint;221 PRE5/POST5 inputs exact.
`check6.json/log`: EXIT0, only this feature's four native layouts plus matching
lint;221 PRE6/POST6 exact. Only the native probe changed between5 and6, adding
task40 wheel/ID/copy assertions. Model/reader/view/Browser/unit/transport sources
remain exact; six unit/faux results are reused rather than redundantly rerun.

Earlier compile-only failures remain recorded, not called passing: missing
ListDelegate setter/event annotation, probe delimiter, missing trait imports/
owned test selectors, then test-only dead-code cfg. No assertion was weakened
or safety guard suppressed. Unknown/zero native case selections fail; the
scoped wrapper checks nonzero standard-harness counts.

Fake native registry contracts passed for PATH bash and system `/bin/bash`,
as did shell syntax, the scoped-helper fail-closed contract and diff whitespace.
Existing broad CI remains. Final rustfmt may reorder module declarations in
`lib.rs` only; no module, path, feature guard or export is removed or altered.

Eight `png6` native PNGs are static production-view captures of synthetic data,
not SwiftUI mocks. Narrow dark details and narrow light task40 stale states are
attached to the task. Theme/bounds, exact pointer/keyboard/copy, scroll and stale
assertions passed. Captures show calm unboxed disclosure with shared tokens.
They do not establish OS IME/accessibility, motion/performance, live Local
acceptance or full Swift parity. Protected owner sources remain unchanged;
their prior behavior is preserved by source, not claimed rerun by this journey.

## Boundaries

No task paging endpoint exists. UI reports received snapshot count and byte/row
limits without claiming a capped subset is complete. Larger replies/bodies fail
closed and retain stale previous content when available. Creation/edit/delete,
status/ownership/model/dependency/phase changes and starts are separate work.
No PR, production update, install, restart or expanded authority is included.
