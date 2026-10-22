# Native text scaling investigation

Experimental debug observations, not visible frame pacing, release performance,
matched Swift comparison or permission to replace the renderer. No accounts,
Local transport, real mutations, visible windows or external assets are used.

## Method

`tests/scaling.rs` uses a single native fit-content TextView in a960x760 offscreen
window, images disabled, retained per-document selection and built-in word fade.
Source shapes: rich paragraphs, one long Unicode paragraph, closed Rust fence
and an open Rust fence. Target sizes64/256/1024KiB; initial source is400 bytes
smaller, then four fully settled100-byte appends reach the existing1MiB bound.
Every initial/update frame requires exact `rendered_text().source()` readiness.
Three additional warm frame calls are recorded. GPU capture and explicit
Source-format select-all/copy projection are checked after timings. Source and
copy are not truncated. These are settled updates, not a live4/s stream test.

Ready-to-park wall time includes any framework-scheduled layout/render work
drained by `run_until_parked`; **it is not isolated parser CPU**. Frame values
time the synchronous render-frame call, not display/swap timing. Peak RSS covers
the whole isolated process, including later updates/capture/copy, not just parse
or production app memory. No visual helper process runs in this probe.

The wrapper freezes the executable, uses an allowlisted credential-free
environment/private temporary HOME, reverses run order on alternating repeats,
runs sequentially and kills its owned process group on timeout/cancellation.
Build-time patch SHA is explicit, never inferred from a later working file.
Raw samples/logs/binaries/results remain ignored; publish only aggregates.

## Baseline and negative evidence

Baseline Base specification SHA:
`19e55509d990dc48a98712b0e83cec435ba8562f916fb2b1c9d7ee4caba9e50b`.
Phase-instrumented frozen binary SHA:
`6125be7fd5155066bfde7fabe36983aa1a387e1d79378645421d71a6d1b965b5`.
Apple M3 Pro/36GiB, macOS27, Rust1.98.1/Kit0.8/GPUI0.3.9, unoptimized test build.
No concurrent build was run during the frozen matrices. Three runs per cell:

| Final KiB | Shape | Ready wall ms | First frame call ms | Warm call median ms | Peak MiB |
|---|---|---:|---:|---:|---:|
|64|paragraphs|81.6|23.1|21.7|93.6|
|64|long line|103.5|49.5|49.2|94.6|
|64|closed fence|43.2|7.9|7.8|124.0|
|64|open fence|43.0|8.1|7.9|123.9|
|256|paragraphs|263.4|84.2|80.2|132.6|
|256|long line|853.0|680.9|697.5|166.3|
|256|closed fence|242.7|28.4|28.5|273.4|
|256|open fence|242.0|28.1|28.1|273.2|

Two1MiB rich-paragraph attempts hit the120s whole-process deadline. The second
passed initial/append readiness and capture, then stalled in the selected-source
frame. One1s/10ms sample of the exact owned frozen process placed58of60 sampled
main-thread stacks under retained-layout cleanup (`HashMap::retain` and weak
liveness checks). This diagnostic sample is not a whole-run CPU percentage.
Do not replace either timeout with an invented numeric result.

The frozen1MiB long-line case also exceeded120s, during its third append drain;
the later giant fence cases in that aborted command did not run. This is separate
negative evidence, not resolved by a retained-layout cleanup guard.

An initial probe incorrectly expected raw Markdown from ordinary plain-text
selection. That harness assertion was corrected to use explicit Source selection
after timings; it was not a production copy fix. A plain-source mapper fast-path
idea was excluded after the cleanup cliff was identified; no unrelated parser
rewrite or cache-size workaround is included.

## Scoped cleanup fix

The existing4096 retained-layout sweep trigger is unchanged; it is not a live
cache capacity. Previously every inline retention above it rescanned every
entry, even when all states remained alive. A zero-sized destruction marker
increments an atomic epoch; each UI thread skips only redundant sweeps when no
state has died since the last scan. Dead-state eligibility, weak identity checks,
live retention, source mappings, selection/fade and all input bounds remain.
The pre-walk epoch preserves a concurrent destruction for the next scan.

The zero-sized lifetime signal is tested with real cross-thread state destruction;
the actual predicate verifies unchanged threshold/dead-entry eligibility and live
retention, including128 redundant-scan skips. A test-support-only seam lets the
desktop library run that assertion against the patched dependency. Direct
`cargo test -p gpui-base` was rejected because the dependency is not a workspace
member; it was not reported as a passed upstream suite.

After Base specification SHA:
`3f18dc15b868abd947365cc1338e38ed93154408b0ae2fc6b1e7a8bea31d86b9`.
Frozen after binary SHA:
`dbc8cf2636fa18577a6f449c56466242ae7fab1eacdf92064f4c456cec04adbd`.
Identical cases/order, three repeats per smaller cell, exact source hashes checked:

| Final KiB | Shape | Ready wall ms after | First call ms after | Warm before → after ms | Peak MiB after |
|---|---|---:|---:|---:|---:|
|64|paragraphs|82.3|22.9|21.7 →21.5|93.5|
|64|long line|103.1|48.9|49.2 →48.6|94.6|
|64|closed fence|43.0|8.0|7.8 →7.8|124.2|
|64|open fence|44.4|8.0|7.9 →7.8|124.0|
|256|paragraphs|267.1|84.6|80.2 →80.7|132.6|
|256|long line|861.3|718.6|697.5 →724.9|165.9|
|256|closed fence|241.1|28.1|28.5 →27.9|273.4|
|256|open fence|241.0|28.1|28.1 →27.9|273.6|

No broad smaller-case speedup is established. The256KiB long-line warm median
rose3.9%; keep that observation, without assigning causality from three runs.

Three1MiB rich-paragraph after runs all pass readiness, four appends, native GPU
capture and full exact Source-copy projection. Median ready wall1039.6ms,
first call326.4ms, warm317.9ms and peak292.5MiB. A preliminary single run completed
the whole process in7.76s. This removes the reproduced selected-frame timeout in
this synthetic case; no invented before duration or speedup ratio is used.

After-only exploratory1MiB closed/open-fence cases each pass once: ready wall
2715.6/2774.2ms, warm116.2/117.5ms, peak871.4/872.5MiB. They have no matched giant
before result. The1MiB long line was not rerun after; the256KiB result and earlier
120s timeout remain unresolved negative evidence.

Long-line wrapping, synchronous highlighting, giant fit-content layout,
macOS15/Wayland and visible release/Swift comparisons remain separate gaps. This
is not general responsiveness, memory-efficiency or replacement acceptance proof.
Full scoped regression gates pass:99 library tests, one opt-in disk workload
ignored, four mocked runner tests, fmt-all, strict workspace and explicit scaling
Clippy, native fixture/browser,16 chrome and40 visual scenes, locked app/helper
builds and engine-symbol separation. No Source/copy/selection/tail/fade or bounds
regression was found by those checks. Existing `block0.1.6` future-compatibility
notice remains. This is not platform/user acceptance or a full upstream test run.

## Reproduce

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --test scaling --no-run
# Pass the exact executable printed above, frozen before any further build.
python3 scripts/measure-scaling.py /path/to/frozen-scaling \
  --base-patch-sha256 BUILD_TIME_SPEC_SHA256 > evidence/local/scaling.json
```

The scaling executable is opt-in and excluded from the ordinary test run.
Lint it explicitly with `bash scripts/cargo.sh clippy --locked --test scaling -- -D warnings`.
`python3 scripts/test_measure_scaling.py` uses mocked subprocesses to cover the
allowlisted environment, parent-exited timeout, cancellation kill/join and failure
reporting, without starting native processes.
