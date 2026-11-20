# Skill and prompt review index

This is a source navigation aid, not a second instruction set or a complete inventory of every
rendered request. Code and skill files are authoritative. [System prompts by role](system-prompts-by-role.md)
explains the role layers with synthetic examples; [tool access by role](tool-access-by-role.md)
covers tool boundaries. A listed source is not evidence that a feature is enabled or authorized.

## Bundled runtime skills

The interview, planning and building bundles contain unmodified [mattpocock/skills](https://github.com/mattpocock/skills),
MIT, Copyright 2026 Matt Pocock. [SOURCE.md](../../skills/SOURCE.md) records each pinned commit and
the copied files; each bundle keeps its license beside its skills.

| Source and purpose | Consumer, boundary and focused checks |
| --- | --- |
| [grill-with-docs](../../skills/interview/grill-with-docs/SKILL.md) challenges an agreement; [grilling](../../skills/interview/grilling/SKILL.md) and [domain-modeling](../../skills/interview/domain-modeling/SKILL.md) supply dependencies, including [ADR](../../skills/interview/domain-modeling/ADR-FORMAT.md) and [glossary](../../skills/interview/domain-modeling/GLOSSARY-FORMAT.md) formats. | `INTERVIEW_SKILL_ADAPTATION` and `INTERVIEW_SKILL_PATHS` in [mission-interview-skills.ts](../missions/mission-interview-skills.ts); [native-adapter.ts](../native-adapter.ts) selects the trusted loader, uses the bundled paths instead of same-named personal skills and refuses missing paths. [Interview checks](../missions/mission-interview-skills.test.ts); [agreement contract](../../../../apps/day/missions/interviews/day-mission-agreements.md). |
| [Wayfinder](../../skills/planning/wayfinder/SKILL.md) and its [reference](../../skills/planning/wayfinder/REFERENCE.md) structure uncertain routes; [research](../../skills/planning/research/SKILL.md), [to-spec](../../skills/planning/to-spec/SKILL.md), and [to-tickets](../../skills/planning/to-tickets/SKILL.md) cover evidence and handoff. Interview dependencies above also apply. | `PLANNING_SKILL_ADAPTATION` and `PLANNING_SKILL_PATHS` in [mission-planning-skills.ts](../missions/mission-planning-skills.ts) override external publication and execution instructions. The trusted loader and [skill resource reader](../missions/coordinator-skill-resources.ts) restrict reads; [mission-plan-tool.ts](../missions/mission-plan-tool.ts) supplies native operations. [Planning checks](../missions/mission-planning-skills.test.ts); [record checks](../../../daemon/src/missions/planning/mission-plans.test.ts). |
| [implement](../../skills/building/implement/SKILL.md) is the builder entry point; it names [tdd](../../skills/building/tdd/SKILL.md) and [code-review](../../skills/building/code-review/SKILL.md), and tdd names [codebase-design](../../skills/building/codebase-design/SKILL.md). | Every Build chat loads them (not coordinator, Ask, interview or planning chats), and the bundled files win over same-named personal skills. `BUILDING_SKILL_ADAPTATION` in [mission-building-skills.ts](../missions/mission-building-skills.ts) is one builder line in `missionPrompt`: seams come from the task and brief, delivery follows Pilot. [Building checks](../missions/mission-building-skills.test.ts). |
| Prototype skill, LOGIC and UI resources | The exact source, adaptation, consumers, checks and execution gap are in the [prototype review trail](../../../../apps/day/missions/planning/day-mission-planning.md#prototype-skill-and-prompt-review-trail). Do not copy that contract here. |
| [pilot-artifacts](../../skills/pilot-artifacts/SKILL.md) and its [references](../../skills/pilot-artifacts/references) guide native artifact authors. | The adapter selects bundled resources according to role; artifact tool schemas enforce their own boundary. See [artifact-skill.fast.test.ts](../artifacts/artifact-skill.fast.test.ts) and [artifact-tools.integration.test.ts](../artifacts/artifact-tools.integration.test.ts). |

These are selected through the normal Pi resource loader, not a global install. Source instructions
do not grant tool access, external writes, execution, or admission. For the prototype's native
preview and sandbox limitations, follow the linked trail rather than assuming tests prove acceptance.

## Repository-local development skills

These are project context for agents working in this repository, not the bundled mission profile.
Discovery and use depend on the trusted loader and session settings. Their `SKILL.md` files and
references are the sources; [AGENTS.md](../../../../AGENTS.md) sets project precedence.

| Skills and purpose | Provenance, adaptations and checks |
| --- | --- |
| [frontend-design](../../../../.agents/skills/frontend-design/SKILL.md), native interface design | [UPSTREAM.md](../../../../.agents/skills/frontend-design/UPSTREAM.md) records Anthropic sources, exact revisions, Apache-2.0 attribution and local precedence. |
| [NSH](../../../../.agents/skills/nsh/SKILL.md), [NSH design](../../../../.agents/skills/nsh-design-guides/SKILL.md) | Day coding and design guidance. [skills-lock.json](../../../../skills-lock.json) records the upstream paths and content hashes. |

The provenance manifests provide the source URLs, precise pins, attribution, licenses, adaptations
and hash manifests where recorded. Review those and adjacent references when changing a skill.
No blanket automated verification of all project-local skill copies was established here.

## Prompt sources and composition

| Source | Role and assembly / focused checks |
| --- | --- |
| [policy.ts](policy.ts): `pilotPrompt`, `missionPrompt` | Code-generated Pilot and mission overlays vary with role, workspace, delivery policy and current mission data. The extension appends them to the SDK context. [Decision guidance and injection/permission seams](../../../daemon/src/missions/interviews/mission-decision-routing.md#canonical-injection-and-permission-seams) cover mission conversion, examples, stable selection, live deltas and limits. [policy.fast.test.ts](policy.fast.test.ts), [mission-tools.test.ts](../missions/mission-tools.test.ts). |
| [native-adapter.ts](../native-adapter.ts): resource loader and `preparePrompt` | Selects restricted Ask/Insights bases or SDK resources and conditional interview/planning adapters. SDK settings, extensions, tools, project instructions, skill selection, prompt templates and current context affect composition. [Ask](../tools/ask/ask.integration.test.ts), [Insights](../insights/insights-role.integration.test.ts) and skill tests exercise selected boundaries. |
| [review-boundary.ts](../reviews/review-boundary.ts): `REVIEW_BASELINE` | Checked-in fixed restricted reviewer baseline; [review-boundary.test.ts](../reviews/review-boundary.test.ts). It is not the Build prompt. |
| [history-recall.ts](../history/history-recall.ts), tool descriptions and schemas | Tool snippets/guidelines are additional instructions exposed with tools, not necessarily system-prompt prose. [history-recall.fast.test.ts](../history/history-recall.fast.test.ts); consult [tool access](tool-access-by-role.md) for role-specific surfaces. |

The SDK can load user/project templates and instructions at runtime; their contents are not a
checked-in Pilot template inventory. Mission state, task text and Knowledge are dynamic data, not
static prompt copies. The [role examples](system-prompts-by-role.md) are synthetic and may drift;
compare them with current source before using them as evidence. Historical docs, fixtures and
test canaries are not production instructions.

## Review and maintenance

For a change, inspect the canonical skill or prompt, its adaptation and loader call site, then run
the focused tests named above where relevant. Check local Markdown links and source symbols after
renames; update this index and the provenance manifest when sources, pins or consumers change.
For composition, use source and synthetic fixtures with placeholders, not a live provider or a real
session dump. Never publish credentials, personal instructions, Knowledge or private session
content. A source scan cannot prove the complete dynamic SDK prompt or enumerate external skills,
extension-provided text, tool descriptions and user templates; those remain coverage gaps.
