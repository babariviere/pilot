# NSH for embedded interactive artifacts

Source review, 2026-10-28. **Recommendation: reuse ideas, adapt selectively,
defer runtime adoption.** Keep Pilot's bounded visual protocol and confined
QuickJS helper. NSH offers substantially richer TSX authoring and native
components, but embedding it unchanged would regress our untrusted-code boundary
and require a different GPUI dependency. This evaluates artifact views only,
not the app shell, mobile migration or an implementation proposal.

For trusted whole-app code, see the separate
[shared desktop/mobile foundation assessment](nsh-app-foundation-evaluation.md).
Its capability requirements differ from untrusted generated artifacts.

No installs, builds, prototypes, runtime execution or product changes were
performed. All behavior below is source-supported unless labelled proposed or
unmeasured. Upstream tests and vendor benchmarks were read, not run.

## Source pins and change since the initial notes

The initial NSH pin `68531fb4216b9536521ebb4f76549ddda5950640` is the
0.2.0 release preparation. Its GPUI manifest and sandbox notes already require
Fast and distinguish embedded limits from unrestricted standalone limits.
Current upstream HEAD was independently read as
[`c7b249970c2f9a15e20c5a461a7324ea9227c08f`](https://github.com/longbridge/nsh/tree/c7b249970c2f9a15e20c5a461a7324ea9227c08f).
The latest published release API reports v0.3.0 (2026-10-26), tag
`efd351328711843baa6b7eb129e22502696ca88e`. HEAD is newer than that release;
do not assume every reviewed feature ships in 0.3.0.

Current source has plots, tables, a native host channel, storage overrides and
expanded grants. It does not remove the original compatibility/isolation
obstacles. The 0.3.0 release explicitly says it is **not a frozen compatibility
release**. The compatibility document promises recorded-release preservation,
but says nothing is frozen until recorded; the Rust embedding API is outside
that contract.

Pilot baseline: `25aa8a09f6038998f31819503ebee04da606407f`,
GPUI-Kit 0.8.0, baseline `gpui-pre` 0.3.9. References:
[inline visuals](inline-visuals.md),
[native visual evidence](../evidence/native-visuals.md),
[protocol fixtures](../../../packages/protocol/fixtures/visual/README.md).
The evidence document contains historical checkpoints, not a current parity
inventory; inline-visuals.md and current implementation supersede its early gaps.
Earlier evaluations #8/#9 explain the protocol and renderer choices.

## Fit and actual migration work

| Area | Existing Pilot approach | NSH source-supported fit and missing adapter |
| --- | --- | --- |
| Authoring | One function, frozen data, JSON state, closed api-1 tree and draw commands | TSX compiled to `nsh:rt`, native signals/computed/effects, conditional/keyed views. New compiler, module/type allowlist, diagnostics and publication check required. Not arbitrary React, hooks, DOM, CSS or browser-library compatibility; even `solid-js` imports are refused. |
| Controls and layout | Trusted Kit controls with typed, revision/version-fenced events | Rich unstyled `nsh/base` controls, flex/grid, menus and tables. Theme tokens and behavior need a Pilot UI set or narrowly registered Kit component adapters. NSH controls do not automatically become our Kit controls. Focus, Tab, shortcuts, IME, selection and transcript scroll handoff need verification. |
| Charts and drawing | Native charts, bounded PD canvas, native Mermaid | `nsh/base/plot` has line/area/bar, axes/grid/labels and radial marks. Rows/scales and hover animation run in Rust. GPUI canvas rasterizes with tiny-skia then uploads an image, unlike our native geometry path. Need api-1 chart semantics (nulls, stacking, duplicate categories, scatter), canvas codec/limits and Mermaid adapters; no assumed conformance. |
| Images | Exact-revision stored raster read, bounded decode, native fit/zoom/pan | PNG/JPEG/GIF/WebP and more, SVG, assets/HTTP/data/blob sources, background decode and cached variants. Preserve our source/pixel bounds and exact owner identity; do not expose arbitrary URI loading. NSH's image caches, animation frames and filtered variants add memory outside VM heap. |
| Events/state | Validated tree and JSON state committed together; recovery reconstructs a fresh VM | NSH signals/closures, timers, frame callbacks and native mount batches. No reviewed adapter implements Pilot's transactional tree/state snapshot or deterministic reconstruction. TSX flexibility is real, but closure state is not automatically serializable. |
| Persistence/history | Original source/data/provenance/revisions stay authoritative; reader state qualified by exact resource | NSH `StorageBackend` is overridable; default native storage is per app-id JSON written asynchronously via temporary-file rename. It is not artifact history, a durable ACK or an atomic visual-state transaction. Host must own namespace and commit semantics, never trust generated app ids. |

Do not translate or rewrite old artifacts. Keep api-1 on its existing engine,
images on the raster path, unsupported HTML/React/SwiftUI/shader sources inert
and inspectable. Any later NSH format would need an explicit versioned kind/
engine discriminator, compiler/runtime pin and source map retained beside the
original source/data/revision. It also needs publication validation compatible
with reading historical revisions. NSH package build-number anti-rollback is
not a substitute for intentional access to older artifact revisions.

**Cost:** borrowing design/component ideas is small and incremental. A restricted
TSX-to-existing-protocol adapter is medium-to-large work and discards NSH features
outside that protocol. Full NSH runtime embedding with equivalent confinement,
validated IPC, state recovery and baseline GPUI support is large integration
work, not “add one view.” These are qualitative assessments, not estimates.

## Concrete embedding and platform blockers

1. **Different GPUI types.** Current `crates/gpui/Cargo.toml` aliases
   `gpui-fast`/`gpui-fast-platform` 0.1.9 as GPUI; its lockfile resolves 0.1.9.
   `AppView::new` takes that crate's Window/Context and returns its entity.
   Pilot's baseline types are `gpui-pre` 0.3.9 through Kit 0.8.0, so these are
   different Rust types, not interchangeable views. Upstream's embedding example
   explicitly enables Kit's `gpui-fast` feature (on Kit 0.7.3).
   Pilot's lockfile also contains optional Fast 0.1.10; presence in a lockfile
   does **not** mean the baseline app selected it. No Fast switch is recommended
   or authorized. Supporting baseline requires a backend port and input/text/
   paint compatibility review, or bypassing AppView via a protocol adapter.
2. **Browser-free is possible in feature intent, not yet qualified here.**
   `nsh-platform-gpui` defaults to `js + webview`; a later experiment must
   disable defaults and enable only `js`, leaving `webview`, `video`,
   `dev` and `shot` off. WebView's wry/GTK/WebKit and video's GStreamer are
   optional. However the backend unconditionally enables engine `net + shader`,
   GPUI `wayland + x11`, and a Linux x11rb dependency. Removing browser/video
   features alone is not a minimal shader-free or Wayland-only integration.
   Upstream Linux instructions use Xwayland for screenshots/WebViews, not proof
   of browser-free Wayland embedding. A future baseline port must preserve the
   app's Wayland-only backend guard, clear child DISPLAY where applicable and
   verify the actual backend. No XWayland fallback or new GTK app loop.
   A compositor serving unrelated X11 clients is not itself a failure.
3. **Maintenance/license.** NSH declares Apache-2.0, as does the GPUI workspace.
   This is compatible in principle, not a complete transitive license audit.
   Pin and inventory the new quickjs-jit/stdlib, compiler, rasterizer and platform
   dependencies before copying/adopting code. NSH uses exact
   `quickjs-jit = 0.14.1`, not Pilot's shared QuickJS-NG 0.17.0 engine/runtime
   contract. Same “QuickJS” name does not establish parity or security.
   Active upstream releases and CI are encouraging, not an embedding API
   stability, maintenance SLA or independent safety guarantee.

## Untrusted-code boundary: what must not regress

- **Thread is not isolation.** Engine::start creates an 8 MiB-stack thread in the
  host process. Mount batches cross to the UI thread; this keeps ordinary JS
  work off UI but an engine/native bridge bug has app authority. Pilot's current
  confined child has no daemon/files/network/tool bridge and can be killed.
  NSH AppView is not an out-of-process renderer. Its in-process mount/view/
  text/component objects are not a drop-in IPC protocol.
- **Explicit empty host ceiling is mandatory.** Bundle::source uses
  Policy::default: declared=None, granted=None. Missing declaration allows broad
  network, clipboard, picker and openUrl access; host/process/filesystem grants
  have stricter explicit requirements. Do not treat defaults as deny-all.
  Force a host-owned empty granted policy independent of generated declarations;
  register no native modules/components/host handlers exposing app entities,
  services or data. Host channel grants do not automatically police arbitrary
  custom Rust UI-set functions. Params/context/events are also data exposure.
- **Assets are a concrete review blocker.** Access::allows_media accepts
  `asset:` and strings without `://`. GPUI image resolve accepts absolute
  paths and `file:`; AssetBase::file joins the supplied path without containment
  checks, then read uses std::fs::read. Thus `asset:/../...`, symlinks and bare
  absolute media paths need explicit rejection/confinement, not just empty fs
  grants. This is a source-supported unsafe integration path, not an executed
  exploit or a complete upstream security audit. Do not supply real directories,
  HTTP asset bases, system caches or credentials to untrusted views.
- **Bounds are useful but not aggregate containment.** Embedded defaults are
  256 MiB heap, 4 MiB JS stack, 10 s load, 2 s calls, 200k nodes,
  8m op values and 1m canvas ops. They are far looser than Pilot's
  32 MiB/512 KiB, 250 ms setup/view, 100 ms event and 8 ms draw budgets.
  Native buffers are not fully counted in heap; docs explicitly acknowledge
  that Buffer allocations are bounded per call, not per VM total. Engine/main
  queues use unbounded channels. Images, canvas raster surfaces, layouts and
  queued commits need byte/work accounting across views, not only node counts.
  Keep Pilot's worker concurrency as scheduling, never a content-visibility cap.
- **Cancellation is cooperative, not hard kill.** The interrupt handler checks
  deadline/stop flags. Engine::drop signals shutdown and joins the thread on
  the platform main thread. This cannot safely kill a stuck native function,
  allocator, rasterizer or bridge. A process watchdog/deadline and bounded
  kill/reap path remain necessary for hostile programs.
- **Interrupted state is not rolled back.** NSH documentation says a timed-out
  call throws and the VM continues; OOM/quota overrun stops it with the last
  views retained. Neither proves signal/closure/native state still matches
  that view. Pilot must discard the VM after failed work and reconstruct only
  from validated committed state; async timers/promises/storage make this
  adapter nontrivial. Last-good display must not leave unsafe controls live.
- **Signing answers origin/integrity, not behavior safety.** Verified packages
  can include QuickJS bytecode, which NSH documents as unsafe to load from
  untrusted authors. A signature over agent-supplied bytes does not make crafted
  bytecode safe. Initially accept source only and compile inside confinement.
  NSH package verification/distribution is separate from Pilot's whole-app
  updater, runtime/helper matching and native platform qualification.

## Smallest later validation slice (requires separate authorization)

First choose the boundary, not a migration: a restricted NSH compiler/core
experiment **inside a disposable confined helper**, outputting only our existing
validated protocol, with source input, empty grants, no bridge, disk or network.
One form (text/button/toggle/slider), a 100-point line chart and one supplied
bounded image is enough. The image can remain host-rendered. Unsupported nodes
must report unsupported, not silently grow the protocol.

Start with a source-level feasibility check that those controls/state can export
a stable snapshot without in-process GPUI objects. Stop if this needs importing
AppView/Fast or a broad new protocol. Only a separately approved alternative
would port AppView to baseline GPUI; do not undertake both paths at once.

After authorization, validate synthetic infinite loops, OOM, stale events,
asset traversal, absent capabilities, rapid close/navigation and helper death.
Require last-good tree/state recovery, no side effects, no UI blocking, unchanged
historical api-1 behavior and actual native Wayland proof before enablement.
Dedicated accessibility engineering, shaders, video, WebViews/browser React,
mobile and app-shell assessment remain outside this slice.

## Measurement plan, not results

Compare the existing engine with the approved restricted candidate on identical
data, viewport, fonts and build profile, on macOS 15+ and native Wayland separately.
Use a paired baseline/candidate order, warmups plus at least five recorded runs:

- 1, 4 and 10 visible artifacts, then 50 stored/mostly offscreen; idle, typing
  beside animation, control bursts, transcript scroll, hide/show and revision swap.
- Record input-to-present p50/p95/p99, main/engine CPU per frame, missed display
  deadlines at 60/120 Hz, cold load and warm event latency, layout/raster/upload
  cost and queue depth. Separate actual presentation from headless draw time.
- Measure total app **plus helpers** RSS/peak, per-view incremental memory,
  image/native buffers, thread count and post-close recovery. Track cold-start
  scheduling and visible previews under contention, not just one hot demo.
- Treat unchanged safety/recovery/history as gates. Agree performance budgets
  from the measured Pilot baseline before accepting a candidate.

No Pilot NSH timings, memory figures, smoothness or compatibility measurements
exist from this review. nsh.dev's benchmark comparison is vendor evidence about
different applications/backends (including GTK quote tables), not Pilot or
embedded GPUI artifact results.

## Upstream source map

All paths below refer to the pinned HEAD above, not moving website claims:

- [Architecture](https://github.com/longbridge/nsh/blob/c7b249970c2f9a15e20c5a461a7324ea9227c08f/docs/dev/architecture.md),
  `docs/dev/{embedding,gpui,native-pipeline,compatibility,sandbox,signed-packages}.md`;
  `website/docs/comparison.md`.
- [GPUI manifest](https://github.com/longbridge/nsh/blob/c7b249970c2f9a15e20c5a461a7324ea9227c08f/crates/gpui/Cargo.toml),
  `crates/gpui/nsh-platform-gpui/{Cargo.toml,src/app.rs,src/surface.rs,src/rt.rs,src/image.rs}`;
  `examples/embed-gpui/Cargo.toml`.
- [Engine and policy](https://github.com/longbridge/nsh/blob/c7b249970c2f9a15e20c5a461a7324ea9227c08f/crates/nsh-engine/src/lib.rs):
  Policy/Bundle, Engine::start/Drop; `storage.rs`, `access.rs`.
- [Access checks](https://github.com/longbridge/nsh/blob/c7b249970c2f9a15e20c5a461a7324ea9227c08f/crates/nsh-core/src/access.rs):
  Access::allows_media/allows_http; `js/limits.rs`;
  `crates/nsh-js/src/sandbox.rs`; `crates/nsh-base/src/plot/`.
