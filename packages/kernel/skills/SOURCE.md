# Skill sources

The `interview`, `planning` and `building` bundles are word-for-word copies from
[mattpocock/skills](https://github.com/mattpocock/skills). MIT, Copyright 2026 Matt Pocock. Each bundle keeps
the upstream `LICENSE` beside its skills. `pilot-artifacts` is Pilot's own skill.

Pilot does not install or overwrite personal skills. A bundled copy wins over a personal skill with the same
name. Pilot adapts the copies only through prompt text in kernel code, never by editing them. The
`*-skills.test.ts` files check every copied file byte for byte.

## interview

Commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`, inspected 2026-11-09.

- `skills/engineering/grill-with-docs/SKILL.md`
- `skills/productivity/grilling/SKILL.md`
- `skills/engineering/domain-modeling/{SKILL.md,ADR-FORMAT.md,GLOSSARY-FORMAT.md}`

Adapter: `src/missions/mission-interview-skills.ts`. It changes the interaction surface, not these sources.

## planning

Commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`, inspected 2026-11-09.

- `skills/engineering/{wayfinder,to-spec,to-tickets,research}/SKILL.md`
- `skills/engineering/prototype/{SKILL.md,LOGIC.md,UI.md}`
- `docs/engineering/wayfinder.md`, copied as `wayfinder/REFERENCE.md`
- The grilling and domain-modeling dependencies are in `interview`, at the same commit. grill-with-docs is
  the limited route.

No setup or install skill is needed: Pilot supplies the native storage adapter. Tracker, branch, local
markdown, subagent and execution instructions are not authority. `src/missions/mission-planning-skills.ts` supplies
the native adapter and the deny-by-default tool profile. Research is linked project Knowledge, prototypes are
linked native artifacts from separately authorized work, and planning hands off through existing agreements.

## building

Commit `5863806dd4e15c63174bee4e7515a4256792ecfa`, inspected 2026-11-17.

- `skills/engineering/implement/SKILL.md`
- `skills/engineering/tdd/{SKILL.md,tests.md,mocking.md}`
- `skills/engineering/codebase-design/{SKILL.md,DEEPENING.md,DESIGN-IT-TWICE.md}`
- `skills/engineering/code-review/SKILL.md`
- `skills/productivity/writing-for-agents/{SKILL.md,SKILL-MECHANICS.md}`

Every Build chat loads them, except coordinator chats. Ask, interview and planning chats do not. `BUILDING_SKILL_ADAPTATION` in
`src/missions/mission-building-skills.ts` is one line in the mission builder prompt:

- `implement` is the entry point. It names `tdd` and `code-review`; `tdd` names `codebase-design`.
- The spec is read with the mission tool: `get` with the task id, `brief` and `decisions`.
- Agreed seams are the task's acceptance and the brief's testing decisions. A new seam is asked with `ask_user`.
- Commit, PR and ticket steps follow Pilot's delivery rules, not upstream.
- `code-review` uses the task, brief and decisions as its spec, passes their text to its Spec sub-agent, and
  runs both axes in one chat when sub-agents are not available.

`writing-for-agents` needs no prompt line: its own description triggers it.
