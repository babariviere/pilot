# Day design system

Status: current for Pilot Day (`apps/day`). [DESIGN.md](../../DESIGN.md#pilot-day) holds the intent. The
[library guide](../../apps/day/ui/README.md) lists every part, its props, sizes and rules, and how to move a screen.
This page covers the layers, how NSH artifacts get the same library, and how to change it.

## Layers

1. **Tokens.** `apps/day/theme.json` holds the colours for light and dark, `radius`, `radius-panel`, `font-sans`
   (Geist) and `font-mono` (Geist Mono). `apps/day/nsh.json` names it as the app's theme. Classes name tokens
   (`bg-card`, `text-faint`); `token("grid")` reads one in a drawing.
2. **Parts.** `apps/day/ui` wraps each `nsh/base` behaviour once and draws it with the tokens. `ui/index.ts` exports
   the parts. `ui/fonts.ts` registers the bundled fonts (`apps/day/fonts`, SIL Open Font License in `OFL.txt`).
   Icons are SVG files in `apps/day/icons`. Every interactive part registers with the screen agent
   ([day-screen-agent.md](day-screen-agent.md#component-registry)).
3. **Screens.** The TSX files in `apps/day` import parts from `./ui` and pick roles, kinds and tones. They write
   only layout classes. The window root (`DayScreen.tsx`) draws the grid canvas once, and `Chrome.tsx` is the top
   bar. The Wayfinder chart (`ExpeditionChart.tsx`) draws on its own paper with the `map-*` tokens.

## The library in artifacts

Artifacts import the library from `pilot-day/ui`. `apps/day/native/src/artifact_library.rs` provides it:

- **One source.** The files of `apps/day/ui` are compiled into the binary (`include_str!`) and become trusted
  chunks `pilot-day/ui/<file>`. There is no copy for artifacts.
- **The allowlist comes from `ui/index.ts`.** The code parses `index.ts` and the files it re-exports. The facade
  chunk `pilot-day/ui` re-exports those names, without the screen agent's registry: from `agent.ts` only
  `useAgent` and `AgentScope`. `artifact_source.rs` refuses a name outside the list ("pilot-day/ui has no …")
  and any other `pilot-day/` module.
- **Icons are data chunks.** A preview has no asset reader, so each SVG becomes `pilot-day/icons/<name>.svg`, a
  `data:` URL and its size.
- **Fonts by family name.** A preview cannot register fonts. Each font chunk `pilot-day/fonts/<file>.ttf` exports
  only its family name ("Geist" or "Geist Mono"). Day's window registers the files for the whole process when it
  imports them.
- **Theme at start.** The preview bundle calls `setTheme` with `apps/day/theme.json` before it imports the
  artifact, so token classes and fonts resolve as in the app.

The skill project in `packages/kernel/skills/pilot-artifacts/nsh` maps `pilot-day/ui` to `apps/day/ui/index.ts`
for its type checks only. [NSH artifact helpers](nsh-artifact-helpers.md) and
[captured NSH source](nsh-artifact-source.md) have the runtime boundary.

## Import rule for `ui/` files

Files in `apps/day/ui` import only `nsh`, `nsh/base`, `nsh/base/plot`, other `ui/` files, `../icons/<name>.svg`
and `../fonts/<file>.ttf`. They never import Day's feeds, navigation, views or `pilot-day/native`; give the library
its own structural types instead. They make no host, storage, file or network call. A test in
`artifact_library.rs` fails on any other import.

## Adding a part

1. Write it in the fitting `ui/*.tsx` file, with a doc comment that states its rule. Draw only with tokens, and
   register an interactive part with `useAgent`.
2. Export it from `ui/index.ts`. Artifacts can then import it; no list needs editing.
3. A new `ui/` file goes into `FILES` in `artifact_library.rs`, a new icon into `ICONS`, a new font into `FONTS`
   and `ui/fonts.ts`. Tests keep these lists equal to the folders.
4. A new token goes into `theme.json` for light and dark, and into the guide's token table with its use.
5. Describe the part in [the guide](../../apps/day/ui/README.md). If artifacts should use it, add it to the short
   parts table in `packages/kernel/skills/pilot-artifacts/references/nsh.md`.

Until a part exists, screens mark the gap with a `LIBRARY GAP:` comment. `rg 'LIBRARY GAP' apps/day` lists them.

## Verification

The move added these checks:

- `apps/day/nsh.sh check` type-checks Day, `ui/` included. `scripts/typecheck.sh` does not cover `apps/day`.
- Each moved screen has a capture test, run with `--target macos`: the `*Visual.test.tsx` files, plus "on the
  parts" tests in `SchedulesNative.test.tsx` and `SlackReportsNative.test.tsx`. They capture light and dark, wide
  and narrow (1100 and 480 points for most). `FontProbe.test.tsx` captures the bundled Geist faces. Captures are
  evidence for a review by eye, not an automatic pass.
- The headless `*.test.tsx` files check behaviour and words, not looks.
- In `apps/day/native`, `../scripts/cargo test --locked --test artifact_library --test artifact_examples` and the
  unit tests in `artifact_library.rs` check that the embedded files equal `ui/`, that imports follow the rule, that
  the exports equal `ui/index.ts` without the registry, that every icon and font has a chunk, that previews draw
  with Day's theme and fonts, and that the bundled examples and older `pilot-artifact/ui` names still render.
- `node --test packages/kernel/src/artifact-skill.test.ts` keeps the bundled file list and import allowlist.

Headless tests do not prove native appearance, fonts, focus or scrolling.
