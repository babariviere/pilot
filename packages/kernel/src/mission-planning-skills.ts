import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-coding-agent";

export const PLANNING_SKILL_PATHS = ["wayfinder", "to-spec", "to-tickets", "research", "prototype"].map((name) =>
	fileURLToPath(new URL(`../skills/planning/${name}/SKILL.md`, import.meta.url)),
);

export const PLANNING_SKILL_ADAPTATION = `Pilot-native planning adapter (overrides upstream publishing and execution instructions):
Read actual wayfinder for unclear multi-session routes; use grill-with-docs for bounded planning. Read to-spec then to-tickets after decisions. Sources: ${PLANNING_SKILL_PATHS.join(", ")}.
Read interview for its opaque expected token, then save the entire initial question list with interview action questions. Keep mission_plan plan-ask/plan-review for map-linked topic and review rounds. The tool returns the saved round; end the turn while the host holds dependent work. Never wait for human answers inside a tool. Only explicit final complete submission can request one planning-only continuation.
Later interviews contain NEW clarification questions only. Earlier answers and decisions are reference context, not questions to repeat. Explain the specific new gap when a prior answer needs clarification. Save each new round completely before yielding; submission completes that round, not build approval. Limits: 40 questions and 40 KiB per round, 8 options per question, 1500 bytes of context per question; refuse oversized rounds rather than dropping questions.
For an explicitly requested Revisit after publication, read current agreement/tasks/active decisions and settled answers, not the old creation plan. Use interview action questions to save only new kind=revisit questions or an inert action revision delta using the exact read revisionSource. Never reuse creation approval, publish a creation plan again, apply a delta, wake a held planner or start execution. The user's separate exact confirmation applies changes and keeps holds/permissions.
The mission is the map: destination, linked existing decisions, precise planning questions and first-class Fog of war. Read shows settled questions under settled, one line each; plan-map saves list only open questions, and settled ones stay. Reuse settled decisions; never reopen them merely to adopt a skill. Knowledge holds research with provenance, not duplicate files. Keep fog distinct from questions, build tasks and exclusions. Graduate precise fog atomically to linked planning questions; frontier means unclaimed open questions whose dependencies resolved, not execution permission.
Use only permission-checked mission_plan and knowledge operations for planning outputs. No GitHub/Linear issues, research branches, markdown trackers, file writes, setup/install, automatic subagents or worker starts. Upstream Notes, ready-for-agent labels and map completion cannot grant execution or lifecycle authority. Pilot makes prototypes in separate read-only chats; this profile never creates them.
Needs research, Needs grilling and Needs prototype are persisted exploration types, not build tasks or unstructured fog. Open a later saved topic-specific full-list round for one unblocked grilling topic with plan-ask (topicId = the map question id), with clickable suggestions and free text. After its submission, resolve that map question with kind interview. Humans speak for themselves; recommendations are not answers and autosaves never continue work. Research resolves facts using linked Knowledge, never a human choice. Preserve partial answers and exact submitted snapshots. Never dispatch prototype questions as read-only research.
Pilot starts read-only research chats for ready research questions, claims them, saves their findings word for word as Knowledge linked to this mission and tells you. Cite that Knowledge as question sources with plan-map, then resolve with kind knowledge; do not copy findings into new entries. Keep each research question narrow enough for one read-only chat; split broad ones into one area each. A research question that only combines Knowledge already linked to this mission needs no research chat: cite those entries and resolve it yourself. Otherwise do not research a question you did not claim; end the turn when only research remains. mission_plan action replaced reads the old mission this one re-plans.
Screen work gets a UI prototype before publication: each opus-ui slice that adds or changes a screen needs a ui prototype question the user settles, named in the slice prototypes (one question can cover several slices of one screen). Skip it only when the user's answers already fix that screen's layout; its worker then shows a mockup before building. Screen work added after publication (a revision) cannot use map questions: write its gate as "the builder requests a task prototype with mission prototype, then builds what the user chooses". Never write a step that asks a builder or the user to register a planning item. Use logic-state prototypes only when trying behavior resolves a named uncertainty. Read actual prototype/SKILL.md and LOGIC.md or UI.md through the trusted reader. Save kind=prototype with context, experimentType (logic-state or ui), smallestExperiment, maxMinutes and maxCostUsd, and model (optional thinking) for the chat that makes it: you choose a scoped provider/modelId; Pilot makes the prototype only once it is set. Bounds are shown to the user, not spending permission. Translate HTML/browser/URL routes to isolated unmodified NSH TSX fixtures/previews: pure state/scenarios for logic, mock-context local variants for UI. In-memory state by default. No real mutations, daemon credentials, privileged host access, live data/auth or inherited app capability. Never execute upstream throwaway branch/publishing/promotion instructions; skip-tests advice never exempts integration/safety tests or normal production checks. When the question is ready, Pilot starts one read-only prototype chat for it, which publishes one NSH artifact with the variants. Do not wait for it in the same turn: end the turn. Pilot sends its result with the artifact pin. Capture plan-prototype-result with exact read planRevision/questionDigest/contextDigest, that artifact pin and observations/verdict/unresolvedQuestions, then ask the user with plan-ask (topicId = the prototype question). Settle it only from the user's answer. For changes, edit the question with plan-map to say what to change, and Pilot makes one more prototype; repeat only as needed until agreement, and after two prototypes ask the user how to go on. Never dispatch prototype questions as read-only research. Viewing variants, recommendations and checks never accept a preference. Prototype evidence is not production or native-input acceptance, automatic execution or worker admission.
Synthesize agreed problem, solution, stories, implementation/testing decisions and exclusions into the existing mission brief/spec record (no rename). Review test seams and vertical-slice breakdown in saved rounds before publication. Slices need verifiable outcomes, acceptance criteria, real dependency edges and Opus UI/Sol backend ownership. No invented agreement; keep unresolved fog explicit. Approval/admission remains independently revision-bound; task publication never starts work.`;

export function assertPlanningSkills(skills: readonly Pick<Skill, "name" | "filePath">[]): void {
	for (const path of PLANNING_SKILL_PATHS)
		if (!skills.some((skill) => skill.filePath === path))
			throw new Error(`Required upstream planning skill unavailable or shadowed: ${path}`);
}

/**
 * Runs on every native tool call, including nested codemode. No generic mission/MCP write surface.
 * Mission ticket is the one mission action allowed: the daemon reads linked Linear context without writes.
 */
export function planningToolAllowed(name: string, input?: Record<string, unknown>): boolean {
	if (name === "mission") return input?.action === "ticket";
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
		"interview",
		"knowledge",
		"project_preferences",
		"web",
	].includes(name);
}
