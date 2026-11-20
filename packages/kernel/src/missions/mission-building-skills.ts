import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-coding-agent";

/** implement first: it is hidden from the skill list (disable-model-invocation), so builders read it by path. */
export const BUILDING_SKILL_PATHS = ["implement", "tdd", "codebase-design", "code-review", "writing-for-agents"].map(
	(name) => fileURLToPath(new URL(`../../skills/building/${name}/SKILL.md`, import.meta.url)),
);

/** Builder prompt line. Pilot's delivery and question rules win over the upstream steps. */
export const BUILDING_SKILL_ADAPTATION = `- Building: read and follow the implement skill (${BUILDING_SKILL_PATHS[0]}) for your task. It uses tdd at agreed seams, codebase-design when an interface is in question, and code-review before you report. Pilot's rules win. Read the spec with the mission tool: get with your task id (body and acceptance), brief (testing decisions) and decisions. The agreed seams are your task's acceptance and the brief's testing decisions, and you ask the user with ask_user only about a new seam. Commit, PR and ticket steps follow Pilot's delivery rules above. For code-review, that task, brief and decisions are the spec: put their text in the Spec sub-agent's prompt, since sub-agents may not have the mission tool; if you cannot start sub-agents, run both axes yourself, one after the other.`;

export function assertBuildingSkills(skills: readonly Pick<Skill, "name" | "filePath">[]): void {
	for (const path of BUILDING_SKILL_PATHS)
		if (!skills.some((skill) => skill.filePath === path))
			throw new Error(`Required upstream building skill unavailable or shadowed: ${path}`);
}
