# Upstream provenance

[Design with Intent](https://designwithintent.ai) by Ghaida Zahran: the 18 Intent skills, vendored.

- Repository: https://github.com/ghaida/intent
- Revision: `0c1afeb930eaa936d20e4d27f1df8ead4113dfb4` (2026-10-26, version 1.7.3). Pinned; no automatic updates.
- License: CC0 1.0 Universal (public domain dedication), [LICENSE](LICENSE) copied unchanged. Attribution is kept
  here as a courtesy.

## What is installed

Each `<name>/` directory is a copy of upstream `skills/<name>/`, including its `references/`: `intent` (the entry
point and anti-pattern catalog), `strategize`, `investigate`, `storytelling`, `journey`, `organize`, `wireframe`,
`articulate`, `blueprint`, `transpose`, `localize`, `evaluate`, `fortify`, `include`, `measure`, `specify`,
`present` and `philosopher`. This grouping directory has no `SKILL.md`, so pi discovers each skill under its upstream
name. The layout matches `npx skills add ghaida/intent --all`, apart from this shared directory.

Excluded on purpose: the six Claude subagent prompts (`agents/`: Noor, Ember, Wren, Vigil, Rune, Sage), Claude hooks,
the Claude/Cursor plugin manifests, build and release scripts, tests and docs. Pi has no subagent registry; the skills
the agents combine are all installed. Nothing was installed with `npx` or a plugin manager.

The only adaptation is the delimited `Pilot compatibility` block inserted after each `SKILL.md` title. Deleting it,
from its first marker line through the blank line after the end marker, restores the upstream bytes. Frontmatter is
unchanged. References are byte copies; `present/references/build_deck.py` and the wireframe/deck HTML, CSS and
JavaScript templates are kept as upstream data and are excluded from Biome checks.

| `SKILL.md` | Upstream SHA-256 (before the block) |
| --- | --- |
| `articulate` | `4eae07a56e3d322afa74d586563f3d856650f8bfbd03003b4407aeb5e132dc59` |
| `blueprint` | `e0a622e7e0961ebf27dc874177138ca2a63fa20fb34ba2ce742341c3e5dad6eb` |
| `evaluate` | `afdc292c67e7aa3cf32c88eb7d0fee13f07c1f7b9f5877b94be4b551d6b8baa3` |
| `fortify` | `15259936885af4aedb78ad9ae8e7c3bb09a74f6f994eacb82294f04b287d100d` |
| `include` | `ea146d82ea86ee1f48f8702460f0a0b89ce9a87010868545065507b4ef8f8b14` |
| `intent` | `69b6bc5270ad93785eb560d65fb4f550e763a74387db8bbfba2ff0bb1ab9a9f6` |
| `investigate` | `4c9f4594e9d499f77a105acb69337e82f18f8e1f60d849346b3f6eabe0e8fbfd` |
| `journey` | `92c3f7b4ad8cd2903bc57668f2bc9f3bb544682a67b95b446b6a3cef293dde16` |
| `localize` | `b1dab47db3ee94815262d4e9b148fc0aacc7a3f5f00989c4c08bdda4be3946f1` |
| `measure` | `b5e3f96354b036afef86c29a06d0403088f2b0c1c972de46485a6b870de75a63` |
| `organize` | `8dd0a29ea093456973c0f28c1acf5ff8dc1e1ab8f881186cba523dd6bb1a90fe` |
| `philosopher` | `291cf91f25f48ee97c40230ec3088a31834603c6df886946a81a0e9c655f57e7` |
| `present` | `b980649606e322aa96ce4848d7c28dcaa27df73dcab34c51313a3c955849b028` |
| `specify` | `a3b6e0d05eaa2f496b5280f10ab3ba037c9c71de74199cd777d65592e4c8a121` |
| `storytelling` | `66a7e1669339e8d7e50b040315248a7d34e45b7f9cdc4efe422fc05e793a5a8d` |
| `strategize` | `90d24650f069c9a737fcf5a76381fbe6b2f740ea5b3e98994c5f5f13c1bb28b0` |
| `transpose` | `6a693757f223eadb525afda1328150e7cdc8a294e481c386c8110392aa1cf7db` |
| `wireframe` | `ae99bccc44f920606863792448e19b816d49c9a7a26790a5c8625d11fd9bd1d8` |
| `LICENSE` | `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |

## Applying it here

Intent covers UX strategy: framing problems, flows, information architecture, interface copy, states, accessibility,
measurement and ethics. It is platform-agnostic, so most of it applies directly to Pilot's native apps. Start with
`intent` for orientation or go straight to the specialist skill that fits.

- **Precedence.** The approved product brief and recorded decisions, `DESIGN.md` and
  [pilot-next-design](../pilot-next-design/SKILL.md) win. Use Intent to sharpen a decision inside the approved scope;
  a brief, evaluation or blueprint does not authorize new features, host capabilities or a redesign. Use
  [impeccable](../impeccable/SKILL.md) or [frontend-design](../frontend-design/SKILL.md) for visual craft.
- **Evidence.** Pilot work has no user panel, analytics or live experiments. Evidence is what the user said, recorded
  decisions, existing behavior, tests and measurements. Mark the rest as hypotheses rather than inventing research, and
  do not add telemetry or run live actions on real data to fill gaps.
- **Deliverables.** The skills write Markdown or HTML files to the working directory. Here, keep them out of the
  repository (reply in chat, attach them to the task or use a temporary directory) unless the user names a path.
  Prefer Markdown and native visual artifacts (`ui.mermaid`, tables, charts) for flows, maps and blueprints. Pilot Next
  is native-only and does not render HTML, so build the HTML wireframe viewer, reveal.js or `.pptx` decks (which need
  CDN scripts or `python-pptx`), Figma or Pencil output only when the user asks.
- **Platforms.** macOS comes first; Linux is a later Wayland-only target and iOS is deferred, so `transpose` work for
  those is planning only. In `include`, keyboard navigation, focus, IME, Unicode editing, selection/copy, contrast
  and reduced motion are in scope; dedicated screen-reader work is deferred. WCAG guidance maps to macOS conventions.
- **Commands.** Upstream names skills as `/strategize` or `/intent:strategize`. In pi, use `/skill:strategize` when
  project skills are loaded, or read `<name>/SKILL.md` directly. The `/intent` invocation banner is upstream behavior.
