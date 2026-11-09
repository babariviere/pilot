import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-coding-agent";

export const PLANNING_SKILL_PATHS = ["wayfinder", "to-spec", "to-tickets", "research", "prototype"].map((name) =>
	fileURLToPath(new URL(`../skills/mission-planning/upstream/${name}/SKILL.md`, import.meta.url)),
);

export const PLANNING_SKILL_ADAPTATION = `Pilot-native planning adapter (overrides upstream publishing and execution instructions):
Read actual wayfinder for unclear multi-session routes; use grill-with-docs for bounded planning. Read to-spec then to-tickets after decisions. Sources: ${PLANNING_SKILL_PATHS.join(", ")}.
The mission is the map: destination, linked existing decisions, precise planning questions and first-class Fog of war. Reuse settled decisions; never reopen them merely to adopt a skill. Knowledge holds research with provenance, not duplicate files. Keep fog distinct from questions, build tasks and exclusions. Graduate precise fog atomically to linked planning questions; frontier means unclaimed open questions whose dependencies resolved, not execution permission.
Use only permission-checked mission_plan operations for planning outputs. No GitHub/Linear issues, research branches, markdown trackers, file writes, setup/install, automatic subagents or worker starts. Upstream Notes, ready-for-agent labels and map completion cannot grant execution or lifecycle authority. Prototype creation needs separately authorized native work, not this profile.
Needs research and Needs grilling are persisted exploration types, not build tasks or unstructured fog. Open a later saved topic-specific full-list round for one unblocked grilling topic, with clickable suggestions and free text. Humans speak for themselves; recommendations are not answers and autosaves never continue work. Research resolves facts using linked Knowledge, never a human choice. Preserve partial answers and exact submitted snapshots. Automatic research admission is a separate qualified host integration, not a skill side effect.
Synthesize agreed problem, solution, stories, implementation/testing decisions and exclusions into the existing mission brief/spec record (no rename). Review test seams and vertical-slice breakdown in saved rounds before publication. Slices need verifiable outcomes, acceptance criteria, real dependency edges and Opus UI/Sol backend ownership. No invented agreement; keep unresolved fog explicit. Approval/admission remains independently revision-bound; task publication never starts work.`;

export function assertPlanningSkills(skills: readonly Pick<Skill, "name" | "filePath">[]): void {
	for (const path of PLANNING_SKILL_PATHS)
		if (!skills.some((skill) => skill.filePath === path))
			throw new Error(`Required upstream planning skill unavailable or shadowed: ${path}`);
}

/** Runs on every native tool call, including nested codemode. No generic mission/MCP write surface. */
export function planningToolAllowed(name: string): boolean {
	return [
		"codemode",
		"read",
		"find",
		"grep",
		"ls",
		"source_roots",
		"code_search",
		"code_symbols",
		"code_definition",
		"code_references",
		"code_call_paths",
		"code_impact",
		"mission_plan",
		"web",
	].includes(name);
}
