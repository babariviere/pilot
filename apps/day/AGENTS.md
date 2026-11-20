# Pilot Day

## Working here

- The default entry (`App.tsx`) is the connected app and never shows mock data.
  Missing or unreadable sources show an honest unavailable state.
- Keep mock worlds test-only (`MockApp.tsx`, scenario and `*Fixture.tsx` entries,
  `app/testing/`, feature `*Demo.ts` files,
  `native/src/testing/fixture.rs`).
  Runtime modules must not import them.
- Do not enable live profiles or treat test coverage as production or packaging
  acceptance.
- Use `./nsh.sh` and `scripts/cargo` for NSH and Rust commands.
  `./nsh.sh check` is Day's TypeScript check. `scripts/typecheck.sh` covers only the workspace
  packages, not `apps/day`.
- Use the verified NSH 0.6.1 (`2f51d86`) distribution (`NSH_DAY_CLI` can select a local copy). Keep NSH dependencies
  on the pinned release and preserve Cargo locks. Do not rebuild or patch NSH,
  edit shared dependency caches, or install tools to work around a setup failure.
- Build screens from the component library in `ui/` (`ui/README.md` is the guide). Screens do not import
  `nsh/base` or restyle a control: add a variant to the library instead. Only single-use overlays
  (the palette, the full-window artifact) assemble `nsh/base` themselves.
- `ui/` is the only place that sets a look. Screens write no look classes (colour, size, weight, font,
  border, radius, fill, padding), only layout ones. [DESIGN.md](../../DESIGN.md#pilot-day) has the intent.
- Artifacts embed `ui/` as it is: its files import only `nsh`, `nsh/base`, `nsh/base/plot`, each other,
  `../icons` and `../fonts`, never Day's feeds, views or `pilot-day/native`.
- `fonts/` holds Geist and Geist Mono under the SIL Open Font License; keep `fonts/OFL.txt` with them.
- Follow "Live data in the UI" in [CODING_STANDARDS.md](../../CODING_STANDARDS.md) for every read, refresh and write.
- Keep entries beside `nsh.json`, which supplies their theme and capabilities.
  Keep the default entry's capabilities deny-all.
- Keep screens and NSH tests in their feature directories. Pass Day-relative
  test paths to `nsh.sh`. In tests, `open()` paths are test-relative, but screenshot
  paths stay under `output/` relative to the command's working directory.
- Preserve stable identities: `pilot-day/native`, `dev.pilot.day`, and existing
  storage, update, profile and receipt identities. Pilot is the product;
  Today is a view.
- Keep the README short: status, setup, commands and source layout. Do not add
  test-run histories, resource tuning or method-by-method API descriptions.

## Boundaries

- Rust owns read models, business rules, revisions and service authority.
  TSX owns presentation and view-local state. Use generated declarations in
  `.nsh/types` and the existing bridge; do not duplicate their API in prose.
- TSX must not choose credentials, service addresses or operation IDs.
  The native host supplies authority and journals commands before sending.
- Writes name the exact identity and revision shown. Rust decides whether that target is
  unchanged and builds every resend and its operation ID; TSX never resends. Check only
  looks up a receipt. The retry and lookup rules are in "Live data in the UI".
- Opening, reading, saving a draft and restoring a view must not submit,
  approve or start work. Keep those actions separate and explicit.
- Failed, stale or incomplete reads must not look like complete empty results.
  Keep agent reports distinct from verified results, and merged from released.
- Save drafts before close or update. A refused save blocks closing;
  restore sends no user intent. Join native work on close, not just Drop.

## Verification

- Run the relevant commands in [README.md](README.md) and the matching TSX
  or native tests. Use isolated fixtures and faux providers, not real accounts.
- For updater or power helper changes, use the
  [standalone crate checks](../../crates/README.md#checks).
- For wrapper changes, run from the repository root:
  `shellcheck -x apps/day/nsh.sh apps/day/scripts/{cargo,build-env.sh,typecheck.sh}`.
- Headless tests do not prove native appearance, focus, scrolling or IME.
  State what was not checked; do not claim visual acceptance from them.
- For a visible change, run the screen's `*Visual.test.tsx` with `--target macos` (see README) and look
  at light and dark, wide and narrow.
