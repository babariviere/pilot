# Day Native Shell release qualification

## Current release migration

The app is moving as one closure to unmodified `longbridge/nsh` **v0.5.0**
for its official app-update APIs. This is a source/tooling migration, not a
release, installation, visible native acceptance or live update.

- Annotated tag object: `729ea4c6810112160e890684e8a8d34528ec6da9`.
- Peeled commit: `f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`.
- Official macOS arm64 archive SHA-256:
  `e6722427b391b00cf7ec13137db9366e78d1e7a045f2933cf00b340365309d9d`.
- Extracted CLI: `nsh 0.5.0 (f4d68f7)`, executable SHA-256
  `694ab2f1e4b97871e42399ae55a916f4fb528df8319eb2c0965f9c68331ebdb8`.
  Verification used an OS-temporary official distribution, not a CLI rebuild,
  Homebrew/global replacement, source patch or dependency-cache edit.
- Native, optional fixture, generated runner, engine, testing and platform
  dependencies move together to `=0.5.0`. Published archive checksums live in
  `apps/desktop/scripts/day_build_inputs.py`. Every used NSH archive was hashed
  and its `.cargo_vcs_info.json` checked against the peeled tag above, including
  new `nsh-updater`, `nsh-i18n` and `nsh-platform-apple` crates.

The native macOS-host/all-target compatibility check and actual 0.5 CLI
declaration/TSX check pass through global MBX. Native lifecycle/runtime tests
and final source-matched package checks qualify their own scope separately.
See [global updates](day-global-updates.md) for operation, process-evidence and
signed/distribution gates. Upstream install swaps before quit and removes the
old app after a successful swap. Its quit callbacks have only 200 ms total and
cannot veto. They are not a save/drain or verified-successor rollback boundary.

## Historical 0.4 release qualification

The remainder records the earlier 0.4 evidence, not the current dependency pin.

## Release identity

Checked 2026-11-10 against `longbridge/nsh`, not the unrelated `nuta/nsh`
command shell published as crates.io `nsh` 0.4.2.

- Tag: [`v0.4.0`](https://github.com/longbridge/nsh/releases/tag/v0.4.0).
- Annotated tag object: `06771fff7150e9ae115a0edde2ab764ec4e8454d`.
- Peeled commit: `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`.
- The tag is unsigned. Matching GitHub API and `git ls-remote` results prove
  identity only, not a verified release signature.
- Release macOS arm64 archive SHA-256:
  `f63c3d57c31b28c9b34227aac81f099d1e0e61f1db552a6ec5127d114eaf59cb`.
  The original longbridge Homebrew formula matches GitHub's asset digest.
- Installed official `~/.nsh/bin/nsh`: `nsh 0.4.0 (e626a8d)`, executable SHA-256
  `cc9676f7d8f763e6903e1b4b1d8f4f21376689e16381a6fe77e68861da106416`.
  This matches the earlier longbridge Homebrew executable. Its runtime/embed
  resources stay in their original installation. No local CLI build.
- Release `Cargo.lock` SHA-256:
  `3e613f0b6940be5d83676f48771b461b122e0732f652ce4de20b4978b2015d34`.

Day's manifests use exact crates.io versions (`=0.4.0`) for all NSH crates,
including its optional Rust fixture, declarations and testing. They used the
peeled Git commit until 2026-11-12. Blaze, mbx's source loader, failed on six
crates from one Git repository ("asked for git repository ... again"), and
registry sources avoid that path. Each 0.4.0 archive was checked on
2026-11-12: its `.cargo_vcs_info.json` names commit
`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3` and its SHA-256 equals the
checksum in both Day locks (nsh-base, -bundler, -core, -dev, -engine, -js,
-macros, -package, -platform-macos, -testing). The installed CLI must match
that same release. Sources are not mixed: no NSH crate comes from Git.
The fixture lock is seeded from the native lock, so shared crates keep the
same versions. 0.5.0 exists on crates.io but is not qualified.
Never substitute the crate named `nsh`.

## Source/API audit

The following files refer to the
[unmodified release tree](https://github.com/longbridge/nsh/tree/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3).
These are source observations, not compiled or native acceptance claims.

| Day requirement | Release source | Result |
| --- | --- | --- |
| Typed feeds, exact intent props, callbacks/disposal | `nsh-core/src/element/{class,callback,system,prop}.rs`, `nsh-macros` | Present: classes, `JsObject`, exact props, `Callback::post`, `Stop`. Boundary tests still required. |
| Planning/attention inputs and choices | `nsh-base/src/lib.rs`, core input/keymap modules | Present: Input, Button, Toggle, Radio/RadioGroup and keymaps. Keyboard/IME acceptance remains separate. |
| Declarations and headless TSX tests | `nsh-core` declarations feature; `nsh-testing/src/lib.rs` | Present: declaration registry, `compile_tsx`, headless driver. Generate declarations with the release, never reuse main's as release evidence. |
| One runtime source in generated hosts | `nsh-cli/src/rust_app.rs`, `Nsh::of`, `write_workspace_manifest` | Source resolved through Cargo (Git until 2026-11-12, now crates.io); generated hosts and app share that source. Mismatched versions/sources fail. The real generated runner lock is kept as `apps/day/runner.Cargo.lock` and seeds fresh workspaces. |
| mbx compiler adapter | `nsh-cli/src/{check,rust_app}.rs` | Supported `CARGO` hook covers native check, metadata and generated runners. The installed CLI itself is never compiled. |
| Entrance/layout motion | `nsh-core/src/js/animation.rs`, `nsh-js` bindings | Present: `createMotion`, motion keyframes, `LayoutAnimation.configureNext`, `reduceMotion`. Restrained Day motion still needs interruption/performance and native visual checks. |
| Deferred Changes reader | `nsh-base/src/diff/{mod,view}.rs` | DiffView patch, soft wrap and part classes exist. Preserve Changes/Insights work; this migration does not expand it. |
| Root-owned context | `nsh-engine/src/lib.rs`, `nsh-core/src/element/engine_context.rs` | `EngineConfig.context` and `EngineContext` exist for headless/embedding hosts. Not proof of packaged macOS injection. |

### macOS host gap

Release test parsing rejects the newer `nsh.json` `window` key. Day and its
optional fixture omit it. `nsh run --window-size 1100x820` supplies the former
preview size; minimum-size/custom-title configuration needs a supported native
host path. This migration does not claim that window acceptance is complete.

Release `nsh-platform-macos/src/app.rs` has no context field on `AppOptions`;
`AppView::load` sets `EngineConfig.context` to its default. A headless test
that directly supplies a `DayRoot` context can pass while the stock generated
GUI runner remains disconnected. A supported application-owned integration
must be qualified before native/root/update acceptance. Do not patch NSH, add
a global credential-bearing root or silently return to main to hide this gap.

## Verification state

Installed-CLI dispatch and pin tests pass (15 tests). They verify exact release
refusal, no CLI compilation/download, offline nested Cargo, existing mbx
limits, quoted arguments, exit status and signal delivery, not real native UI.

Release Git objects were materialized in private TMPDIR storage. Existing
registry/Git resolver inputs were independently copied into a private
`CARGO_HOME`; per-file source/copy hashes and archive lock checksums matched.
No credentials, user Cargo configuration or shared-cache writes were used.
Initial logical input copies total 244,009,402 bytes; after resolution, the
private source/resolver and audit trees total 515,053,214 bytes, below the approved 10 GiB growth
limit with more than 15 GiB free. Later resolution/build growth must be
counted too. Native compilation requires its separate release.

Both real Cargo locks resolve offline with private inputs: 574 packages for
the native crate, 282 for the optional Rust fixture. Every NSH source is the
peeled release commit; no `nsh-i18n` from main remains. All registry archives
needed by these two lock graphs exist privately and match their lock
checksums. The broader upstream workspace has uncached Linux/Android entries;
that is not a missing artifact in either Day lock graph.

Fresh native lock generation refuses upstream's yanked `crypto-bigint` 0.7.5.
The scoped `cargo update --offline -p nsh-core` instead preserves the existing
authentic locked selection, also present in upstream's release lock, and
resolves the changed release graph normally. No index/yank edits, source
patches or invented lock entries were used. The fixture lock was generated
offline. Keep these locks: fresh unconstrained resolution is not equivalent.

During lock resolution Cargo's only compiler command was a permitted metadata query: the installed
Rust 1.99.1 `rustc` with exactly `[-vV]`, through a hash-checked wrapper that
rejects every other argv and disconnects stdin. Locked/offline no-deps metadata
succeeds. The user later released native app compilation, never CLI compilation.

### Executed release checks

- Installed release CLI `check` passes: native all-targets check, generated
  describe runner, fresh declarations and TypeScript check.
- Installed release CLI `build` passes: native describe and App.tsx bundle.
- Headless tests pass: App 26, Plan 19, Attention 4.
- Direct native library and boundary tests pass: 47 + 2.
- Optional Rust fixture `cargo check --locked --all-targets` passes.
- Actual owned compiler subprocesses used the mbx wrapper, private output
  paths, debug-zero/no-incremental settings. Every command joined its children.
- No `nsh-cli` build, dependency download, shared-cache write, visible window,
  service restart, update, packaging, release or default switch occurred.

Final measured logical growth, counting the private dependencies, source,
mbx cache, targets and generated workspaces, was 8,364,165,628 bytes (under
10 GiB), with 83,630,919,680 bytes free. Original shared resolver-input hashes
were unchanged. The final repeated `check` and `build` passed after the release
config fix; all remaining child processes joined before publication.

The generated runner initially refused fresh resolution of the same yanked
crypto dependency. Seeding the app-owned generated lock from the genuine
native lock allowed normal resolution. Its real 604-package result is kept as
`runner.Cargo.lock`; the wrapper copies it only into absent generated locks,
including the optional fixture. It never edits dependency source or overwrites
an existing workspace lock. Generated `nsh-app-*` packages have version 0.0.0;
all actual NSH path crates have version 0.4.0 and resolve through the CLI's
release source unification. The seed contains no machine-specific paths.

The installed Rust toolchain warns that `rust-objcopy` cannot load
`libLLVM.dylib` when stripping debug information. Executables still build and
tests pass. No toolchain files were changed to suppress it. Large Mach-O
unwind and unavailable-cache warnings are not speed or native-acceptance proof.

The 604-package cross-platform runner graph also names archives absent from
the private cache. None was needed by the passing macOS/headless checks. Linux
and Android remain unqualified, with no download/fallback attempted:

```text
cairo-rs@0.22.9 cairo-sys-rs@0.22.9 cfg-expr@0.20.10 combine@4.6.9
gdk-pixbuf@0.22.0 gdk-pixbuf-sys@0.22.9 gdk4@0.11.5 gdk4-sys@0.11.5
gio@0.22.10 gio-sys@0.22.9 glib@0.22.10 glib-macros@0.22.9
glib-sys@0.22.9 gobject-sys@0.22.9 graphene-rs@0.22.8 graphene-sys@0.22.9
gsk4@0.11.5 gsk4-sys@0.11.5 gtk4@0.11.5 gtk4-macros@0.11.5 gtk4-sys@0.11.5
javascriptcore6@0.6.0 javascriptcore6-sys@0.6.0 pango@0.22.9 pango-sys@0.22.9
pangocairo@0.22.9 pangocairo-sys@0.22.9 soup3@0.9.0 soup3-sys@0.9.0
system-deps@7.0.8 system-deps@9.0.1 target-lexicon@0.13.5
webkit6@0.6.1 webkit6-sys@0.6.0
```

Historical `530b7317` check/build evidence in Day's README is not release
qualification, and mock/headless evidence is not native acceptance.
