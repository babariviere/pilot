# Upstream provenance

[Impeccable](https://impeccable.style) by Paul Bakaus, vendored from its pi build.

- Repository: https://github.com/pbakaus/impeccable
- Revision: `d34c87e1a00989ae8dbdd7f6b30b70f23319e860` (2026-10-27, skill version 4.8.0). Pinned; no automatic updates.
- Source directory: `.pi/skills/impeccable/` at that revision, the build upstream generates for pi.
- License: Apache-2.0, [LICENSE](LICENSE) copied unchanged. [NOTICE.md](NOTICE.md) is copied unchanged; it credits
  ehmo's MIT-licensed [platform-design-skills](https://github.com/ehmo/platform-design-skills) for
  `reference/ios.md` and `reference/android.md`.

## What is installed

| Local path | Upstream path | State |
| --- | --- | --- |
| `SKILL.md` | `.pi/skills/impeccable/SKILL.md` | Adapted, see below |
| `reference/**` | `.pi/skills/impeccable/reference/**` | Byte copies |
| `LICENSE`, `NOTICE.md` | `LICENSE`, `NOTICE.md` | Byte copies |

Excluded on purpose: `scripts/` (a launcher that downloads and runs a prebuilt engine binary, the HTML/CSS
detector, live-browser JavaScript and a 1 MB font index), the CLI, design hooks, browser extension, Codex/Claude
subagent definitions and plugin manifests. Nothing upstream was installed with `npx`, and no installer was run.
Some references still name `.pi/skills/impeccable/scripts/impeccable`; those commands are unavailable here.

The only adaptation is the delimited `Pilot compatibility` block inserted after the frontmatter of `SKILL.md`.
Deleting it, from its first marker line through the blank line after the end marker, restores the upstream bytes.
Frontmatter, including upstream's `allowed-tools` list, is unchanged; neither pi nor Pilot grants tools from it.

| File | Upstream SHA-256 |
| --- | --- |
| `SKILL.md` (before the block) | `1771f63c1b51d5546399698b981da70e601662997045ba67215338a5435b6279` |
| `LICENSE` | `02bb8c3b4e70190e3986c0404ad2fd8d639b4f534252d82379cc1b502b6d1812` |
| `NOTICE.md` | `c60a093c2845fd9fb82f9c6f742ece31f379f8190b535309d32d66c45ccffdcb` |

To compare with upstream: clone the repository at the pinned revision, remove the block from a copy of
`SKILL.md`, then `diff -r <clone>/.pi/skills/impeccable .agents/skills/impeccable`. Only `scripts/` and the files
listed above as local (`LICENSE`, `NOTICE.md`, this file) should differ.

## Applying it here

Impeccable is a visual design and craft workflow written mostly for web frontends, with native guidance for iOS and
Android. Pilot's interfaces are native desktop apps: the Swift macOS app and Pilot Next (Rust, GPUI, GPUI-Kit). Use it
for its design judgment, critique structure and craft floor, inside the project's existing direction.

- **Precedence.** `DESIGN.md`, [Desktop UI vocabulary](../../../apps/desktop/docs/design-system.md), the approved
  product brief and recorded decisions, and [pilot-next-design](../pilot-next-design/SKILL.md) win over Impeccable.
  Pilot's `DESIGN.md` is the project's own UI intent, not an Impeccable-generated file. Pilot is an **Operate** surface:
  precision, restraint and familiar native patterns. `bolder`, `colorize`, `delight` and `overdrive` apply only when
  the user asks, and still within the approved calm workbench.
- **Setup.** There is no launcher, so there is no `impeccable context` output. Read `DESIGN.md`, the desktop design
  system and the nearest real view instead, then load the command reference and `reference/craft-floor.md` as
  upstream describes. Do not invent a `PRODUCT.md`; the approved product brief serves that role.
- **Commands that work as written:** `shape`, `critique`, `polish`, `quieter`, `distill`, `clarify`, `harden`,
  `onboard`, `layout`, `typeset` and `animate` (as design reasoning). Use `audit.native.md` and `adapt.native.md`
  rather than the web variants; their iOS/Android specifics become macOS conventions. For critique, use the
  single-context path in `reference/degraded/` unless the harness can spawn reviewers.
- **Unavailable or user-request only:** `live`, `generate`, `hooks`, `pin` and `doctor` need the excluded scripts
  or a browser. `init`, `document` and `extract` write `PRODUCT.md`, `DESIGN.md` or design-system files, so run them
  only when asked. Image-generated comps and `.impeccable/` review folders are not part of this workflow.
- **Translating web advice.** CSS variables, Tailwind, OKLCH tokens and web font loading map onto the app-owned theme
  and components (`apps/desktop/src/ui.rs` and its catalog, or `Theme.swift`); add missing tokens centrally, not as
  one-off styles. Breakpoints become window, pane and sidebar widths. Web performance metrics become frame time, input
  latency and off-main-thread work. Verify with real native rendering, not a browser screenshot.
- **Scope.** Pilot Next renders natively only: no HTML, React, WebView or browser runtime, and shaders and dedicated
  screen-reader work are deferred. Keyboard, focus, IME, Unicode editing and selection/copy stay in scope. A design
  suggestion does not authorize a missing feature, a new dependency or a redesign of approved direction.
