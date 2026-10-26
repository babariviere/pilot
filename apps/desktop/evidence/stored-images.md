# Stored raster verification

Runtime qualification used immutable source
`45c450dc09634851932e30f3166036c1cdeacfea`, tree
`207413b21ae3d2d1aca134009f95e124f822c928`, on base
`cb4ae09305fb7ac0edcfc64dbcf09889b6f67ee8`.
Each command retained matching PRE/POST commit, tree, diff and input hashes.

| Change / risk | Selected check | Actual result |
| --- | --- | --- |
| Raster admission, codecs, raw/frame buffers, identity/type quotas, stale publication | `--unit artifact_image --native-probes` | 19 passed |
| Reader/pane rendering, sizing, scroll, keyboard, copy, revision/close lifetime | `--test artifact_images` | All four 680/1100 light/dark cases passed |
| Matching production/native source | Scoped library/native Clippy, `-D warnings` | Passed |
| Shared `get_bytes` extraction | `local_client::network_tests::capture_opens_only_the_exact_requested_chat_and_never_a_fallback` | 1 passed |
| Existing visual/control reader compatibility | `artifact_view::tests::generation_revision_and_typed_event_fences_and_bounded_state_cache` | 1 passed |
| New native target registration | Four selected fake CI inventory/execution/failure contracts on `/bin/bash` | 4 passed |
| Owned Rust formatting | Pinned rustfmt, `skip_children=true`, explicit owned files | Passed after native export-order correction |

The final source-only delta after runtime qualification is the CI inventory
registration (`scripts/check.sh`, `scripts/ci.sh`, `scripts/test_ci.py`), ordering/
spacing of two independent `native-probes` exports in `src/lib.rs`, and this
evidence document. CI cases used byte-identical registration source; formatting
was checked on the final export order. The formatting-only command intentionally
selected no CI tests and is **not** counted as another passing test run.

The native cases use the actual selected-reader thread and pane against an
owned faux HTTP server. They check real BGRA screenshot pixels, a 2560×1600
image that overflows both axes at actual device-pixel size, independent native
wheel axes, fit reset/containment, tab-focus then Space, explicit exact source
copy, previous revision's changed pixels, old decoded-image weak ownership,
Back, PNG/JPEG/GIF, early unsupported WebP, malformed input and copy completion
after close/chat change. Native source is never an evaluated program.

Eight fit/actual-size captures were inspected. The four attached fit captures
from source `ed50ad1b` are byte-identical to the final qualification captures.
Those older captures are explicitly reused, not described as a different build.

Unchanged source on the base retains the existing visual helper/sandbox limits,
visual runtime/session, composer/model/project interactions, draft/delivery
stores, selection/transcript and contextual navigation/history behavior. No
model/project/history/native-suite sweep was repeated. The two compatibility
cases above cover the changed shared reader/pane seams. No production profile,
account, user content, live mutation or service/application lifecycle action was
used. Existing full CI remains and now explicitly includes `artifact_images`.

## Retained receipts and limitations

The delivery handoff supplies the frozen candidate/path hashes and local
`/tmp/image98-{final,shared-read,visual-fence}.{pre,post}.json` observations,
their scoped `*-report.json` files, CI-stage output and final formatting receipt.
Preliminary failed source/compile/fixture runs remain failed. In particular,
the first reports did not execute image tests, and the aggregate sixth report
failed native keyboard setup despite its 19 passing unit tests. The final
qualification above passed both the units and all native cases together.

See [the allocation audit](../docs/image-allocation-audit.md): raw/native/frame
limits are separate from the advisory codec setting. No hard total-memory/RSS
ceiling is claimed. Metal's atlas `contains` query is unsupported; retirement
uses source/API evidence, not measured VRAM. Offscreen screenshots do not prove
OS IME/accessibility, visible motion, Linux, application performance, full Swift
parity or user acceptance. WebP, embedded visual image nodes and the separate
gallery remain outside this preview implementation.
