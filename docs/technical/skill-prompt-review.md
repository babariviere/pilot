# Skill and prompt review index

This is a source navigation aid, not a second instruction set or a complete inventory of every
rendered request. Code and skill files are authoritative. [System prompts by role](system-prompts-by-role.md)
explains the role layers with synthetic examples; [tool access by role](tool-access-by-role.md)
covers tool boundaries. A listed source is not evidence that a feature is enabled or authorized.

## Bundled runtime skills

The interview and planning bundles contain unmodified [mattpocock/skills](https://github.com/mattpocock/skills)
at `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`, MIT, Copyright 2026 Matt Pocock.
See their [interview provenance](../../packages/kernel/skills/mission-interview/UPSTREAM.md) and
[planning provenance](../../packages/kernel/skills/mission-planning/UPSTREAM.md) and adjacent licenses.

| Source and purpose | Consumer, boundary and focused checks |
| --- | --- |
| [grill-with-docs](../../packages/kernel/skills/mission-interview/upstream/grill-with-docs/SKILL.md) challenges an agreement; [grilling](../../packages/kernel/skills/mission-interview/upstream/grilling/SKILL.md) and [domain-modeling](../../packages/kernel/skills/mission-interview/upstream/domain-modeling/SKILL.md) supply dependencies, including [ADR](../../packages/kernel/skills/mission-interview/upstream/domain-modeling/ADR-FORMAT.md) and [glossary](../../packages/kernel/skills/mission-interview/upstream/domain-modeling/GLOSSARY-FORMAT.md) formats. | `INTERVIEW_SKILL_ADAPTATION` and `INTERVIEW_SKILL_PATHS` in [mission-interview-skills.ts](../../packages/kernel/src/mission-interview-skills.ts); [native-adapter.ts](../../packages/kernel/src/native-adapter.ts) selects the trusted loader, uses the bundled paths instead of same-named personal skills and refuses missing paths. [Interview checks](../../packages/kernel/src/mission-interview-skills.test.ts); [agreement contract](day-mission-agreements.md). |
| [Wayfinder](../../packages/kernel/skills/mission-planning/upstream/wayfinder/SKILL.md) and its [reference](../../packages/kernel/skills/mission-planning/upstream/wayfinder/REFERENCE.md) structure uncertain routes; [research](../../packages/kernel/skills/mission-planning/upstream/research/SKILL.md), [to-spec](../../packages/kernel/skills/mission-planning/upstream/to-spec/SKILL.md), and [to-tickets](../../packages/kernel/skills/mission-planning/upstream/to-tickets/SKILL.md) cover evidence and handoff. Interview dependencies above also apply. | `PLANNING_SKILL_ADAPTATION` and `PLANNING_SKILL_PATHS` in [mission-planning-skills.ts](../../packages/kernel/src/mission-planning-skills.ts) override external publication and execution instructions. The trusted loader and [skill resource reader](../../packages/kernel/src/coordinator-skill-resources.ts) restrict reads; [mission-plan-tool.ts](../../packages/kernel/src/mission-plan-tool.ts) supplies native operations. [Planning checks](../../packages/kernel/src/mission-planning-skills.test.ts); [record checks](../../packages/daemon/src/mission-plans.test.ts). |
| Prototype skill, LOGIC and UI resources | The exact source, adaptation, consumers, checks and execution gap are in the [prototype review trail](day-mission-planning.md#prototype-skill-and-prompt-review-trail). Do not copy that contract here. |
| [pilot-artifacts](../../packages/kernel/skills/pilot-artifacts/SKILL.md) and its [references](../../packages/kernel/skills/pilot-artifacts/references) guide native artifact authors. | The adapter selects bundled resources according to role; artifact tool schemas enforce their own boundary. See [artifact-skill.test.ts](../../packages/kernel/src/artifact-skill.test.ts) and [artifact-tools.integration.test.ts](../../packages/kernel/src/artifact-tools.integration.test.ts). |

These are selected through the normal Pi resource loader, not a global install. Source instructions
do not grant tool access, external writes, execution, or admission. For the prototype's native
preview and sandbox limitations, follow the linked trail rather than assuming tests prove acceptance.

## Repository-local development skills

These are project context for agents working in this repository, not the bundled mission profile.
Discovery and use depend on the trusted loader and session settings. Their `SKILL.md` files and
references are the sources; [AGENTS.md](../../AGENTS.md) sets project precedence.

| Skills and purpose | Provenance, adaptations and checks |
| --- | --- |
| [frontend-design](../../.agents/skills/frontend-design/SKILL.md), native interface design | [UPSTREAM.md](../../.agents/skills/frontend-design/UPSTREAM.md) records Anthropic sources, exact revisions, Apache-2.0 attribution and local precedence. |
| [impeccable](../../.agents/skills/impeccable/SKILL.md), visual critique; [Intent skills](../../.agents/skills/intent), UX disciplines | Their [Impeccable](../../.agents/skills/impeccable/UPSTREAM.md) and [Intent](../../.agents/skills/intent/UPSTREAM.md) manifests pin versions, licenses, references and compatibility blocks. |
| [rust-best-practices](../../.agents/skills/rust-best-practices/SKILL.md), [rust-port](../../.agents/skills/rust-port/SKILL.md), [rust-review](../../.agents/skills/rust-review/SKILL.md) | Their respective [best-practices](../../.agents/skills/rust-best-practices/UPSTREAM.md), [port](../../.agents/skills/rust-port/UPSTREAM.md), and [review](../../.agents/skills/rust-review/UPSTREAM.md) manifests pin BeautifulRust, attribution, licenses and compatibility blocks. |
| [NSH](../../.agents/skills/nsh/SKILL.md), [NSH design](../../.agents/skills/nsh-design-guides/SKILL.md), [GPUI Kit](../../.agents/skills/gpui-kit/SKILL.md), [Pilot Next design](../../.agents/skills/pilot-next-design/SKILL.md) | Local coding/design guidance and adjacent references. Exact upstream provenance and separate skill-level automated checks were not established in this audit; do not infer a pin from runtime dependency versions. GPUI guidance concerns the retained legacy desktop, not Day's NSH UI. |

The provenance manifests provide the source URLs, precise pins, attribution, licenses, adaptations
and hash manifests where recorded. Review those and adjacent references when changing a skill.
No blanket automated verification of all project-local skill copies was established here.

## Prompt sources and composition

| Source | Role and assembly / focused checks |
| --- | --- |
| [policy.ts](../../packages/kernel/src/policy.ts): `pilotPrompt`, `missionPrompt` | Code-generated Pilot and mission overlays vary with role, workspace, delivery policy and current mission data. The extension appends them to the SDK context. [Decision guidance and injection/permission seams](mission-decision-routing.md#canonical-injection-and-permission-seams) cover mission conversion, examples, stable selection, live deltas and limits. [policy.test.ts](../../packages/kernel/src/policy.test.ts), [mission-tools.test.ts](../../packages/kernel/src/mission-tools.test.ts). |
| [native-adapter.ts](../../packages/kernel/src/native-adapter.ts): resource loader and `preparePrompt` | Selects restricted Ask/Insights bases or SDK resources, memory and conditional interview/planning adapters. SDK settings, extensions, tools, project instructions, skill selection, prompt templates and current context affect composition. [Ask](../../packages/kernel/src/ask.integration.test.ts), [Insights](../../packages/kernel/src/insights-role.integration.test.ts) and skill tests exercise selected boundaries. |
| [review-boundary.ts](../../packages/kernel/src/review-boundary.ts): `REVIEW_BASELINE` | Checked-in fixed restricted reviewer baseline; [review-boundary.test.ts](../../packages/kernel/src/review-boundary.test.ts). It is not the Build prompt. |
| [history-recall.ts](../../packages/kernel/src/history-recall.ts), tool descriptions and schemas | Tool snippets/guidelines are additional instructions exposed with tools, not necessarily system-prompt prose. [history-recall.test.ts](../../packages/kernel/src/history-recall.test.ts); consult [tool access](tool-access-by-role.md) for role-specific surfaces. |

The SDK can load user/project templates and instructions at runtime; their contents are not a
checked-in Pilot template inventory. Mission state, task text and memory are dynamic data, not
static prompt copies. The [role examples](system-prompts-by-role.md) are synthetic and may drift;
compare them with current source before using them as evidence. Historical docs, fixtures and
test canaries are not production instructions. Retained legacy desktop guidance is labeled above.

## Review and maintenance

For a change, inspect the canonical skill or prompt, its adaptation and loader call site, then run
the focused tests named above where relevant. Check local Markdown links and source symbols after
renames; update this index and the provenance manifest when sources, pins or consumers change.
For composition, use source and synthetic fixtures with placeholders, not a live provider or a real
session dump. Never publish credentials, personal instructions, project memory or private session
content. A source scan cannot prove the complete dynamic SDK prompt or enumerate external skills,
extension-provided text, tool descriptions and user templates; those remain coverage gaps.
