# Upstream provenance

Anthropic's `frontend-design` skill, vendored without changes.

- Requested source: https://github.com/anthropics/claude-code/blob/65823ec0034ed0aa0266bc43903fefd3ff94a327/plugins/frontend-design/skills/frontend-design/SKILL.md
- Identical Apache-2.0 source: https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design/SKILL.md
- License: https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design/LICENSE.txt
- Authors: Anthropic, Prithvi Rajasekaran and Alexander Bricken.

The requested plugin refers to a missing adjacent `LICENSE.txt`; its repository
root has different terms. We verified the pinned skill is byte-identical to
Anthropic's explicitly Apache-licensed skills collection and included that
collection's unchanged license, rather than assuming a license for the plugin.

## Applying it here

Use the plan, brief review, implementation and screenshot-critique workflow for
native interfaces too. The approved product brief and `DESIGN.md` take
precedence: preserve the calm native workbench, system typography roles, neutral
chrome, meaningful Bayer state and existing interaction/accessibility support.
Do not add web dependencies, fonts, motion, platform capabilities or workflows
merely to imitate a website. Use the target renderer and existing shared tokens.
This project-local skill is not bundled into the agent runtime or installed
globally. Upstream changes are explicit, reviewed updates, never live fetches.
