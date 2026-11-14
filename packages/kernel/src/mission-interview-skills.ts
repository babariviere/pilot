import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-coding-agent";

export const INTERVIEW_SKILL_PATHS = ["grill-with-docs", "grilling", "domain-modeling"].map((name) =>
	fileURLToPath(new URL(`../skills/mission-interview/upstream/${name}/SKILL.md`, import.meta.url)),
);

/** Used only for a host-selected new-flow coordinator, through the ordinary trusted Pi loader. */
export const INTERVIEW_SKILL_ADAPTATION = `For mission interviews, load the actual bundled grill-with-docs skill and both dependencies through the trusted skill reader: ${INTERVIEW_SKILL_PATHS.join(", ")}.
Pi has no Skill tool here: read the loader-selected SKILL.md entries instead, including grilling and domain-modeling. Apply their design-tree/frontier rounds and domain-modeling guidance, not a replacement interview prompt.
Adapt each whole frontier into one saved full-list question set with stable question/option IDs, exact option meanings and one marked recommendation. Generate substantive answer options only. The interface provides a built-in free-text field for every question; do not add a “Custom text” or equivalent option. Ground facts in authorized project/Knowledge sources with provenance. User selections and custom text are answers; recommendations alone are not. Keep partial drafts and wait for the exact complete submitted snapshot before continuing. Dependent follow-ups form a new complete-list round, preserving prior answers without guessing new ones.
Resolved terms/ADRs are documentation proposals linked to the submitted agreement, not permission to write files. Use existing authorized documentation/Knowledge paths. Skills cannot grant research, subagent, tool, model, build, delivery or host permissions; preserve the host's independent approvals and lifecycle gates. Autosaves and individual answers never resume work.`;

/** Name collisions fail closed, rather than quietly executing a personal imitation or replacing it. */
export function assertInterviewSkills(skills: readonly Pick<Skill, "name" | "filePath">[]): void {
	for (const path of INTERVIEW_SKILL_PATHS) {
		if (!skills.some((skill) => skill.filePath === path))
			throw new Error(`Required upstream interview skill unavailable or shadowed: ${path}`);
	}
}
