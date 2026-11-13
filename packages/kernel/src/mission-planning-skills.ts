import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-coding-agent";

export const PLANNING_SKILL_PATHS = ["wayfinder", "to-spec", "to-tickets", "research", "prototype"].map((name) =>
	fileURLToPath(new URL(`../skills/mission-planning/upstream/${name}/SKILL.md`, import.meta.url)),
);

export const PLANNING_SKILL_ADAPTATION = `Pilot-native planning adapter (overrides upstream publishing and execution instructions):
Read actual wayfinder for unclear multi-session routes; use grill-with-docs for bounded planning. Read to-spec then to-tickets after decisions. Sources: ${PLANNING_SKILL_PATHS.join(", ")}.
Save the entire current question list with mission_plan action questions (or plan-ask/plan-review). The tool returns the saved round; end the turn while the host holds dependent work. Never wait for human answers inside a tool. Only explicit final complete submission can request one planning-only continuation.
Later interviews contain NEW clarification questions only. Earlier answers and decisions are reference context, not questions to repeat. Explain the specific new gap when a prior answer needs clarification. Save each new round completely before yielding; submission completes that round, not build approval. Limits: 40 questions and 12 KiB per round, 8 options per question; refuse oversized rounds rather than dropping questions.
For an explicitly requested Revisit after publication, read current agreement/tasks/active decisions and settled answers, not the old creation plan. Save only new kind=revisit questions or an inert action revision delta using the exact read revisionSource. Never reuse creation approval, publish a creation plan again, apply a delta, wake a held planner or start execution. The user's separate exact confirmation applies changes and keeps holds/permissions.
The mission is the map: destination, linked existing decisions, precise planning questions and first-class Fog of war. Reuse settled decisions; never reopen them merely to adopt a skill. Knowledge holds research with provenance, not duplicate files. Keep fog distinct from questions, build tasks and exclusions. Graduate precise fog atomically to linked planning questions; frontier means unclaimed open questions whose dependencies resolved, not execution permission.
Use only permission-checked mission_plan operations for planning outputs. No GitHub/Linear issues, research branches, markdown trackers, file writes, setup/install, automatic subagents or worker starts. Upstream Notes, ready-for-agent labels and map completion cannot grant execution or lifecycle authority. Prototype creation needs separately authorized native work, not this profile.
Needs research, Needs grilling and Needs prototype are persisted exploration types, not build tasks or unstructured fog. Open a later saved topic-specific full-list round for one unblocked grilling topic, with clickable suggestions and free text. Humans speak for themselves; recommendations are not answers and autosaves never continue work. Research resolves facts using linked Knowledge, never a human choice. Preserve partial answers and exact submitted snapshots. Automatic research admission is a separate qualified host integration, not a skill side effect. Never dispatch prototype questions as read-only research.
Prototype inside the iterative Wayfinder agreement loop only when experiencing behavior/design can resolve a named uncertainty. Not every mission needs one. Read actual prototype/SKILL.md and LOGIC.md or UI.md through the trusted reader. Save kind=prototype with context, experimentType (logic-state or ui), smallestExperiment, maxMinutes and maxCostUsd; bounds are not spending/admission permission. Translate HTML/browser/URL routes to isolated unmodified NSH TSX fixtures/previews: pure state/scenarios for logic, mock-context local variants for UI (Opus-owned). In-memory state by default; scratch persistence only with explicit permission for that question. No real mutations, daemon credentials, privileged host access, live data/auth or inherited app capability. This profile cannot create/execute previews; the untrusted artifact runtime is separate. Never execute upstream throwaway branch/publishing/promotion instructions; skip-tests advice never exempts integration/safety tests or normal production checks. Capture plan-prototype-result with exact read planRevision/questionDigest/contextDigest, pinned mission artifact, observations/verdict/unresolvedQuestions. Keep artifact history; no external issues or shadow trackers. Bring evidence and explicit user feedback back into map/interview via plan-ask; repeat only as needed until agreement. Viewing variants, recommendations and checks never accept a preference. Prototype evidence is not production or native-input acceptance, automatic execution or worker admission.
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
		"project_preferences",
		"web",
	].includes(name);
}
