# Pilot Day

## Working here

- Keep the default entry mock-only. Do not enable live profiles or treat test
  coverage as production or packaging acceptance.
- Use `./nsh.sh` and `scripts/cargo` for NSH and Rust commands.
  Use `scripts/typecheck.sh` for the workspace TypeScript check, not `pnpm day`.
- Use the verified NSH 0.5.0 (`f4d68f7`) distribution (`NSH_DAY_CLI` can select a local copy). Keep NSH dependencies
  on the pinned release and preserve Cargo locks. Do not rebuild or patch NSH,
  edit shared dependency caches, or install tools to work around a setup failure.
- Keep entries beside `nsh.json`, which supplies their theme and capabilities.
  Keep the default entry's capabilities deny-all.
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
- Writes name the exact identity and revision shown. Refuse stale writes.
  A lost reply stays unknown; Check only looks up its receipt, never resends.
- Opening, reading, saving a draft and restoring a view must not submit,
  approve or start work. Keep those actions separate and explicit.
- Failed, stale or incomplete reads must not look like complete empty results.
  Keep agent reports distinct from verified results, and merged from released.
- Save drafts before close or update. A refused save blocks closing;
  restore sends no user intent. Join native work on close, not just Drop.

## Verification

- Run the relevant commands in [README.md](README.md) and the matching TSX
  or native tests. Use isolated fixtures and faux providers, not real accounts.
- For wrapper changes, run from the repository root:
  `shellcheck -x apps/day/nsh.sh apps/day/scripts/{cargo,build-env.sh,typecheck.sh}`.
- Headless tests do not prove native appearance, focus, scrolling or IME.
  State what was not checked; do not claim visual acceptance from them.
