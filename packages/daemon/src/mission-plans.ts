/** Host-only planning adapter. No external tracker, shell, model, subagent or dispatch ports. */
import type {
	DurableOperation,
	InterviewQuestion,
	MissionPlan,
	PlanPrototypeResult,
	PlanQuestion,
	PlanSlice,
	PlanSource,
	PlanWrite,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import {
	interviewDigest as digest,
	interviewExact as exact,
	interviewId as id,
	interviewText as text,
	validateQuestions,
} from "./mission-interview-contract.ts";
import { planMap } from "./mission-plan-map.ts";
import { sliceTaskBody } from "./mission-plan-store.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected } from "./operation-journal.ts";

interface Dependencies {
	store: MissionStore;
	journal: OperationJournal;
	/** Host ingress checks coordinator authority; answer saves/submission MUST be native human actions.
	 * No actor label in a model request can satisfy this check. */
	authorize(purpose: string, missionId: string, ownerSessionId: string): void;
	validateRound?(questions: InterviewQuestion[]): void;
	/** Checks a prototype's model and thinking level against the project's task models. Throws with the allowed ones. */
	checkModel?(model: string, thinking?: string): Promise<void>;
	/** IDs of the work profiles a new slice may name. */
	profiles?(): Promise<string[]>;
}
const kinds = [
	"plan-map",
	"plan-promote",
	"plan-claim",
	"plan-resolve",
	"plan-prototype-result",
	"plan-propose",
	"plan-ask",
	"plan-review",
	"plan-publish",
];
export const isPlanOperation = (kind: string): boolean => kinds.includes(kind);
/**
 * Linked Knowledge summaries the planner reads each turn (the page says when there are more). It protects
 * model tokens: a summary is about 300 bytes (measured: title and synopsis average 210 characters), so 100
 * cost about 30 KB per read. The Pilot Day mission links 24 entries and grows with each research answer.
 */
export const LINKED_KNOWLEDGE = 100;
/** Routing is a host choice, never an upstream instruction to start a worker. */
export const planningRoute = (unclear: boolean, multipleSessions: boolean): "wayfinder" | "grill-with-docs" =>
	unclear && multipleSessions ? "wayfinder" : "grill-with-docs";
export const planFrontier = (plan: MissionPlan): PlanQuestion[] =>
	plan.questions.filter(
		(q) =>
			!q.resolution &&
			!q.claimedBy &&
			q.dependsOn.every((key) => !!plan.questions.find((p) => p.id === key)?.resolution),
	);
export const activeFog = (plan: MissionPlan) => plan.fog.filter((f) => !f.promotedTo.length);
/** Research-only dispatchers must use this filter, never the mixed planning frontier. */
export const planResearchFrontier = (plan: MissionPlan): PlanQuestion[] =>
	planFrontier(plan).filter((q) => q.kind === "research");
export const planQuestionDigest = (q: PlanQuestion): string => {
	const { resolution: _r, claimedBy: _c, prototypeResult: _p, ...input } = q;
	return digest(input);
};
export const planDigest = (plan: MissionPlan): string =>
	digest({
		destination: plan.destination,
		sources: plan.sources,
		questions: plan.questions,
		fog: plan.fog,
		spec: plan.spec,
		slices: plan.slices,
	});
const questionContextDigest = (plan: MissionPlan): string =>
	digest({
		destination: plan.destination,
		sources: plan.sources,
		questions: plan.questions.map(({ resolution: _r, claimedBy: _c, ...q }) => q),
		fog: plan.fog,
		spec: plan.spec,
		slices: plan.slices,
	});
/** Results bind the surrounding map as well as the exact question, but not their own output. */
export const prototypeContextDigest = (plan: MissionPlan): string =>
	questionContextDigest({
		...plan,
		questions: plan.questions.map(({ prototypeResult: _p, ...q }) => q),
	});

/**
 * A list in a planning save. Counts are not limited by default: the saved map's byte limit
 * (PLAN_STATE_LIMIT) bounds every list, and a count limit only ends long missions early.
 */
function list<T>(value: T[], max = Number.MAX_SAFE_INTEGER, what = "a list"): T[] {
	if (!Array.isArray(value)) throw new Conflict(`Invalid planning list: ${what} is not a list`);
	if (value.length > max)
		throw new Conflict(`Invalid planning list: ${what} has ${value.length} items, at most ${max}`);
	return value;
}
/**
 * The map's questions. No count limit: settled questions stay on the map for good, so a count limit
 * ends every long mission. The saved state's byte limit (mission-plan-store.ts) bounds the map instead.
 */
function questionList<T>(value: T[]): T[] {
	return list(value, Number.MAX_SAFE_INTEGER, "questions");
}
function strings(value: string[], max = Number.MAX_SAFE_INTEGER) {
	for (const s of list(value, max)) text(s, 2000);
}
function graph(nodes: { id: string; dependsOn: string[] }[]): void {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	if (byId.size !== nodes.length) throw new Conflict("Duplicate planning identity");
	const done = new Set<string>(),
		visiting = new Set<string>();
	const visit = (key: string) => {
		if (done.has(key)) return;
		const n = byId.get(key);
		if (!n || visiting.has(key)) throw new Conflict("Missing dependency or planning cycle");
		visiting.add(key);
		if (new Set(n.dependsOn).size !== n.dependsOn.length) throw new Conflict("Duplicate dependency");
		for (const dependency of list(n.dependsOn, undefined, `dependsOn of ${n.id}`)) {
			id(dependency);
			visit(dependency);
		}
		visiting.delete(key);
		done.add(key);
	};
	for (const n of nodes) {
		id(n.id);
		visit(n.id);
	}
}
/** Spec stays in the existing brief record. Fog is explicit, not a made-up agreement or blocker. */
export function planMarkdown(plan: MissionPlan): string {
	if (!plan.spec) throw new Conflict("Spec proposal required");
	const s = plan.spec;
	return [
		"# Mission spec",
		"## Problem Statement",
		s.problem,
		"## Solution",
		s.solution,
		"## User Stories",
		...s.stories.map((s) => `- ${s.id}: ${s.text}`),
		"## Implementation Decisions",
		...s.implementation.map((s) => `- ${s}`),
		"## Testing Decisions",
		...s.testing.map((s) => `- ${s}`),
		"## Out of Scope",
		...s.exclusions.map((s) => `- ${s}`),
		"## Unresolved Fog of war",
		...activeFog(plan).map((f) => `- ${f.area}: ${f.why}. Explore when: ${f.readyWhen}`),
	].join("\n\n");
}

/** Canonical read projection. This reader has no journal or mutation port. */
export class MissionPlanReader {
	protected readonly deps: Pick<Dependencies, "store" | "authorize">;
	constructor(deps: Pick<Dependencies, "store" | "authorize">) {
		this.deps = deps;
	}
	private ownerContext(missionId: string) {
		const { store } = this.deps;
		const mission = store.require(missionId),
			interview = store.interviews.latest(missionId);
		const owner = mission.coordinatorSessionId,
			member = owner ? store.membership(owner) : undefined;
		if (
			mission.planningVersion !== 1 ||
			mission.status !== "active" ||
			!owner ||
			!member?.active ||
			!member.coordinator ||
			member.missionId !== missionId ||
			!interview ||
			interview.fence.ownerSessionId !== owner
		)
			throw new Conflict("Current enrolled planning coordinator required");
		const ownerFence = store.interviewOwnerFence(missionId, owner);
		if (canonicalJSON(ownerFence) !== canonicalJSON(interview.ownerFence))
			throw new Conflict("Interview owner changed");
		const plan = store.plans.get(missionId);
		if (plan && (plan.ownerSessionId !== owner || canonicalJSON(plan.ownerFence) !== canonicalJSON(ownerFence)))
			throw new Conflict("Planning owner changed");
		return { mission, owner, ownerFence, interview, plan };
	}
	protected context(missionId: string) {
		return { ...this.ownerContext(missionId), evidence: this.deps.store.workflowConfirmationState(missionId) };
	}
	/** Saved round and plan only. Batch readers must await durable() and recheck the snapshot before returning. */
	summary(missionId: string) {
		const pin = this.ownerContext(missionId);
		this.deps.authorize("plan-read", missionId, pin.owner);
		return { interview: pin.interview, plan: pin.plan ?? null, ownerFence: pin.ownerFence };
	}
	/** Full saved planning context for the selected mission only. */
	async view(missionId: string) {
		const pin = this.context(missionId),
			{ store } = this.deps;
		const knowledge = store.knowledge.list(pin.mission.projectId, { missionId }, undefined, LINKED_KNOWLEDGE);
		const interviewHistory = store.interviews.history(missionId);
		const frontier = pin.plan ? planFrontier(pin.plan) : [];
		const destination = pin.plan?.destination ?? pin.mission.goal;
		const evidence = (q: PlanQuestion): "missing" | "current" | "stale" =>
			!q.prototypeResult ? "missing" : this.prototypeCurrent(pin.plan!, q) ? "current" : "stale";
		const tasks = pin.plan?.publication ? store.tasks(missionId) : [];
		const result = {
			plan: pin.plan ?? null,
			destination,
			decisions: pin.evidence.decisions.map((d) => ({
				decision: d,
				source: { kind: "decision", id: d.id, digest: digest(d) },
			})),
			knowledge,
			interview: pin.interview,
			interviewHistory,
			frontier,
			activeFog: pin.plan ? activeFog(pin.plan) : [],
			exploration: pin.plan
				? pin.plan.questions
						.filter((q) => !q.resolution)
						.map(
							(
								q,
							): {
								questionId: string;
								status: string;
								ready: boolean;
								questionDigest?: string;
								contextDigest?: string;
								evidence?: "missing" | "current" | "stale";
								resolveWith?: { kind: "knowledge"; id: string; digest: string }[];
							} => ({
								questionId: q.id,
								status:
									q.kind === "prototype"
										? "needs-prototype"
										: q.kind === "research"
											? "needs-research"
											: "needs-grilling",
								ready: planFrontier(pin.plan!).some((p) => p.id === q.id),
								...(q.kind === "prototype"
									? {
											questionDigest: planQuestionDigest(q),
											contextDigest: prototypeContextDigest(pin.plan!),
											evidence: evidence(q),
										}
									: q.kind === "research"
										? {
												// The exact plan-resolve resolutions this question accepts: its linked findings.
												resolveWith: q.sources
													.filter((s) => s.kind === "knowledge")
													.map((s) => ({ kind: "knowledge" as const, id: s.id, digest: digest(s) })),
											}
										: {}),
							}),
						)
				: [],
			// The shared map: the same projection the native page shows. Derived, never stored.
			map: planMap({
				plan: pin.plan ?? null,
				destination,
				decisions: pin.evidence.decisions,
				knowledge: knowledge.entries,
				history: interviewHistory,
				frontier,
				evidence,
				task: (taskId) => tasks.find((t) => t.id === taskId),
				findingsWaiting: (q) => {
					const research = store.planningWorkers.get(missionId)?.research?.[q.id];
					return research?.state === "reporting" && research.sessionId === q.claimedBy;
				},
			}),
		};
		this.deps.authorize("plan-read", missionId, pin.owner);
		await store.durable();
		this.deps.authorize("plan-read", missionId, pin.owner);
		if (
			canonicalJSON(this.context(missionId)) !== canonicalJSON(pin) ||
			canonicalJSON(store.knowledge.list(pin.mission.projectId, { missionId }, undefined, LINKED_KNOWLEDGE)) !==
				canonicalJSON(knowledge)
		)
			throw new Conflict("Planning context changed");
		return result;
	}
	async knowledge(missionId: string, knowledgeId: string, revision: number) {
		const pin = this.context(missionId),
			{ store } = this.deps;
		const link = store.knowledge.link(missionId, knowledgeId);
		const source: PlanSource = { kind: "knowledge", id: knowledgeId, revision, linkRevision: link.linkRevision };
		this.sources(missionId, [source]);
		this.deps.authorize("plan-read", missionId, pin.owner);
		const result = store.knowledge.detail(pin.mission.projectId, knowledgeId, revision)!;
		await store.durable();
		this.sources(missionId, [source]);
		this.deps.authorize("plan-read", missionId, pin.owner);
		if (canonicalJSON(this.context(missionId)) !== canonicalJSON(pin)) throw new Conflict("Planning context changed");
		return { source, ...result };
	}
	async read(missionId: string, revision?: number): Promise<MissionPlan | undefined> {
		const pin = this.context(missionId);
		const check = () => {
			this.deps.authorize("plan-read", missionId, pin.owner);
			if (canonicalJSON(this.context(missionId)) !== canonicalJSON(pin))
				throw new Conflict("Planning state changed");
		};
		check();
		const result = this.deps.store.plans.get(missionId, revision);
		await this.deps.store.durable();
		check();
		return result;
	}
	protected sources(missionId: string, sources: PlanSource[]): void {
		const { store } = this.deps;
		for (const s of list(sources, undefined, "sources")) {
			id(s.id);
			if (s.kind === "decision") {
				exact(s, ["kind", "id", "digest"]);
				const decision = store.workflowConfirmationState(missionId).decisions.find((d) => d.id === s.id);
				if (!decision || digest(decision) !== s.digest) throw new Conflict("Settled decision changed");
			} else if (s.kind === "knowledge") {
				exact(s, ["kind", "id", "revision", "linkRevision"]);
				const link = store.knowledge.link(missionId, s.id);
				const entry = store.knowledge.detail(store.require(missionId).projectId, s.id, s.revision);
				// Says which source and why, so the planner can fix its sources itself.
				const why =
					!Number.isSafeInteger(s.revision) || s.revision < 1 || !entry
						? "no such revision"
						: !link.linked
							? "not linked to this mission"
							: link.linkRevision !== s.linkRevision
								? `the link changed (linkRevision ${s.linkRevision}, now ${link.linkRevision}); cite it again`
								: link.pinnedRevision !== undefined && link.pinnedRevision !== s.revision
									? `the link is pinned to revision ${link.pinnedRevision}`
									: "";
				if (why)
					throw new Conflict(
						`Linked Knowledge revision unavailable: Knowledge ${s.id} revision ${s.revision}: ${why}`,
					);
			} else throw new Conflict("Unsupported planning source");
		}
	}
	protected prototypeCurrent(plan: MissionPlan, q: PlanQuestion): boolean {
		const r = q.prototypeResult;
		return (
			!!r &&
			r.questionDigest === planQuestionDigest(q) &&
			r.contextDigest === prototypeContextDigest(plan) &&
			this.deps.store
				.artifactReferences(plan.missionId, r.artifact.artifactId)
				.some((link) => link.sessionId === r.artifact.sessionId && link.revision === r.artifact.revision)
		);
	}
}

/** Coordinator writes remain separate from the member's read-only reader. */
export class MissionPlans extends MissionPlanReader {
	private readonly journal: OperationJournal;
	private readonly validateRound?: Dependencies["validateRound"];
	private readonly checkModel?: Dependencies["checkModel"];
	private readonly profiles?: Dependencies["profiles"];
	constructor(deps: Dependencies) {
		super(deps);
		this.journal = deps.journal;
		this.validateRound = deps.validateRound;
		this.checkModel = deps.checkModel;
		this.profiles = deps.profiles;
	}
	/**
	 * `kept`: settled questions' sources already saved before this write (canonical JSON). They were checked
	 * when written and cannot be edited, so a cited record that changed since shows on the map and never
	 * blocks unrelated writes. Open questions, fog and the plan's own sources stay current.
	 */
	private validate(plan: MissionPlan, kept: ReadonlySet<string> = new Set()): void {
		const fresh = (sources: PlanSource[]) => list(sources).filter((s) => !kept.has(canonicalJSON(s)));
		text(plan.destination, 2000);
		this.sources(plan.missionId, plan.sources);
		for (const q of questionList(plan.questions)) {
			exact(q, [
				"id",
				"title",
				"question",
				"kind",
				"options",
				"recommendedOptionId",
				"dependsOn",
				"claimedBy",
				"sources",
				"resolution",
				...(Object.hasOwn(q, "prototype") ? ["prototype"] : []),
				...(Object.hasOwn(q, "prototypeResult") ? ["prototypeResult"] : []),
			]);
			validateQuestions([this.interviewQuestion(q)]);
			text(q.title, 200);
			text(q.question, 2000);
			if (!["human", "research", "prototype"].includes(q.kind)) throw new Conflict("Invalid question type");
			if (q.kind === "prototype") {
				const p = q.prototype;
				exact(p, [
					"context",
					"experimentType",
					"smallestExperiment",
					"maxCostUsd",
					// maxMinutes: saved by older plans only. Pilot no longer stops prototype chats on time.
					...(["maxMinutes", "model", "thinking"] as const).filter((k) => !!p && Object.hasOwn(p, k)),
				]);
				if (p.model !== undefined) text(p.model, 256);
				if (p.thinking !== undefined) text(p.thinking, 32);
				text(p.context, 2000);
				text(p.smallestExperiment, 2000);
				if (
					!["logic-state", "ui"].includes(p.experimentType) ||
					!Number.isFinite(p.maxCostUsd) ||
					p.maxCostUsd < 0 ||
					p.maxCostUsd > 10
				)
					throw new Conflict("Prototype needs an experiment type and a small cost bound");
			} else if (Object.hasOwn(q, "prototype") || Object.hasOwn(q, "prototypeResult"))
				throw new Conflict("Prototype fields require a prototype question");
			this.sources(plan.missionId, q.resolution ? fresh(q.sources) : q.sources);
		}
		graph(plan.questions);
		const fogIds = new Set<string>();
		for (const f of list(plan.fog, undefined, "fog")) {
			exact(f, ["id", "area", "why", "readyWhen", "dependsOn", "sources", "promotedTo"]);
			id(f.id);
			text(f.area, 2000);
			text(f.why, 2000);
			text(f.readyWhen, 2000);
			if (fogIds.has(f.id)) throw new Conflict("Duplicate fog identity");
			fogIds.add(f.id);
			this.sources(plan.missionId, f.sources);
			for (const key of [
				...list(f.dependsOn, undefined, "fog dependsOn"),
				...list(f.promotedTo, undefined, "fog promotedTo"),
			])
				if (!plan.questions.some((q) => q.id === key)) throw new Conflict("Fog link missing");
		}
		if (plan.spec) {
			const s = plan.spec;
			exact(s, ["problem", "solution", "stories", "implementation", "testing", "exclusions"]);
			text(s.problem, 4000);
			text(s.solution, 4000);
			for (const story of list(s.stories)) {
				exact(story, ["id", "text"]);
				id(story.id);
				text(story.text, 2000);
			}
			if (!s.stories.length || new Set(s.stories.map((s) => s.id)).size !== s.stories.length || !s.testing.length)
				throw new Conflict("Stories and test seams required");
			strings(s.implementation);
			strings(s.testing);
			strings(s.exclusions);
			for (const slice of list(plan.slices)) {
				exact(slice, [
					"id",
					"title",
					"outcome",
					"acceptance",
					"storyIds",
					"dependsOn",
					// Older plans name owners; new slices name at most one profile and a size.
					...(Object.hasOwn(slice, "owners") ? ["owners"] : []),
					...(Object.hasOwn(slice, "profile") ? ["profile"] : []),
					...(Object.hasOwn(slice, "size") ? ["size"] : []),
					...(Object.hasOwn(slice, "files") ? ["files"] : []),
					...(Object.hasOwn(slice, "prototypes") ? ["prototypes"] : []),
				]);
				text(slice.title, 200);
				text(slice.outcome, 2000);
				strings(slice.acceptance);
				strings(slice.storyIds);
				if (slice.files !== undefined) {
					// Cap repeated stored/model context at 51,200 path characters per slice.
					if (!Array.isArray(slice.files)) throw new Conflict("Owned files must be a list of paths");
					if (slice.files.length < 1 || slice.files.length > 100)
						throw new Conflict(
							`Owned files hold 1 to 100 paths; got ${slice.files.length}. Use directory prefixes for large scopes.`,
						);
					for (const path of slice.files)
						if (typeof path === "string" && path.length > 512)
							throw new Conflict(
								`Owned paths hold at most 512 characters; got ${path.length}. Use a shorter directory prefix.`,
							);
					if (
						slice.files.some(
							(p) =>
								typeof p !== "string" ||
								!p ||
								p.length > 512 ||
								p.startsWith("/") ||
								/[\\\u0000*?[\]{}]/.test(p) ||
								p.split("/").some((s, i, all) => s === "." || s === ".." || (!s && i !== all.length - 1)),
						)
					)
						throw new Conflict(
							"Owned files need exact relative paths or directory prefixes, without traversal or globs",
						);
				}
				if (
					!slice.acceptance.length ||
					!slice.storyIds.length ||
					(slice.owners !== undefined &&
						(slice.profile !== undefined ||
							!slice.owners.length ||
							list(slice.owners, 2).some((o) => !["opus-ui", "sol-backend"].includes(o)))) ||
					(slice.profile !== undefined &&
						(typeof slice.profile !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(slice.profile))) ||
					(slice.size !== undefined && slice.size !== "large" && slice.size !== "small") ||
					slice.storyIds.some((key) => !s.stories.some((story) => story.id === key))
				)
					throw new Conflict(
						"Verifiable slices need story traceability, at most one work profile and a size of large or small",
					);
				if (slice.prototypes !== undefined) this.slicePrototypes(plan, slice);
			}
			if (!plan.slices.length) throw new Conflict("Vertical slices required");
			graph(plan.slices);
			text(planMarkdown(plan), 28 * 1024);
		}
	}
	private marker(op: DurableOperation) {
		return { stage: "planning-entered", purpose: op.kind, payloadHash: op.payloadHash };
	}
	async admit(op: DurableOperation, firstEntry = false): Promise<unknown> {
		if (!isPlanOperation(op.kind)) throw new OperationRejected("Unsupported planning operation");
		if (!firstEntry) {
			if (canonicalJSON((await this.journal.lookup(op))?.result) !== canonicalJSON(this.marker(op)))
				throw new Error("Unknown planning entry; no replay");
			const prior = this.deps.store.plans.lookup(op);
			if (!prior) throw new Error("Unknown planning effect; lookup only");
			await this.deps.store.durable();
			return { missionId: prior.missionId, revision: prior.revision };
		}
		try {
			const request = JSON.parse(op.payload) as PlanWrite;
			if (
				request.purpose !== op.kind ||
				!Number.isSafeInteger(request.expectedRevision) ||
				request.expectedRevision < 0
			)
				throw new Conflict("Invalid planning purpose/revision");
			const keys: Record<string, string[]> = {
				"plan-map": ["destination", "sources", "questions", "fog"],
				"plan-promote": ["fogId", "questions"],
				"plan-claim": ["questionId", "claimedBy"],
				"plan-resolve": ["questionId", "resolution"],
				"plan-prototype-result": ["questionId", "result"],
				"plan-propose": ["spec", "slices"],
				"plan-review": [],
				"plan-ask": ["topicId", "questions"],
				"plan-publish": [],
			};
			exact(request, ["purpose", "expectedRevision", ...keys[request.purpose]!]);
			if (this.checkModel && (request.purpose === "plan-map" || request.purpose === "plan-promote"))
				for (const q of Array.isArray(request.questions) ? request.questions : []) {
					const p = (q as PlanQuestion).prototype;
					if (typeof p?.model !== "string") continue;
					await this.checkModel(p.model, typeof p.thinking === "string" ? p.thinking : undefined).catch(
						(e: unknown) => {
							throw new Conflict(
								`Prototype "${(q as PlanQuestion).id}": ${e instanceof Error ? e.message : String(e)}`,
							);
						},
					);
				}
			if (this.profiles && request.purpose === "plan-propose") {
				const known = await this.profiles();
				for (const slice of Array.isArray(request.slices) ? (request.slices as PlanSlice[]) : []) {
					const profile = (slice as { profile?: unknown })?.profile;
					if (
						Object.hasOwn(slice ?? {}, "owners") ||
						(known.length ? !known.includes(profile as string) : profile !== undefined) ||
						(slice as { size?: unknown })?.size === undefined
					)
						throw new Conflict(
							known.length
								? `Slice "${slice?.id}": pick one profile from the profiles allowed in this project (${known.join(", ")}) and a size, large or small. Split slices that mix profiles.`
								: `Slice "${slice?.id}": this project allows no work profiles, so leave profile out and give a size, large or small.`,
						);
				}
			}
			const pin = this.context(op.targetId);
			const check = () => {
				this.deps.authorize(request.purpose, op.targetId, pin.owner);
				if (canonicalJSON(this.context(op.targetId)) !== canonicalJSON(pin))
					throw new Conflict("Planning context changed");
				if ((pin.plan?.revision ?? 0) !== request.expectedRevision) throw new Conflict("Planning revision changed");
			};
			check();
			await this.journal.checkpoint(op, this.marker(op));
			const result = this.deps.store.plans.write(op, request.expectedRevision, (state) => {
				check();
				const kept = new Set(
					questionList(state?.questions ?? [])
						.filter((q) => q.resolution)
						.flatMap((q) => list(q.sources).map((s) => canonicalJSON(s))),
				);
				const plan: MissionPlan = state ?? {
					version: 1,
					missionId: op.targetId,
					revision: 0,
					ownerSessionId: pin.owner,
					ownerFence: pin.ownerFence,
					destination: "",
					sources: [],
					questions: [],
					fog: [],
					spec: null,
					slices: [],
					round: null,
					review: null,
					publication: null,
				};
				if (request.purpose === "plan-map") {
					const sent = questionList(request.questions).map((q) => {
						exact(q, [
							"id",
							"title",
							"question",
							"kind",
							"options",
							"recommendedOptionId",
							"dependsOn",
							"sources",
							...(Object.hasOwn(q, "prototype") ? ["prototype"] : []),
						]);
						const previous = plan.questions.find((p) => p.id === q.id);
						if (previous?.resolution) {
							const { resolution: _r, claimedBy: _c, prototypeResult: _p, ...rest } = previous;
							// A settled question keeps what it asked and why. Only its Knowledge citations may move to a
							// newer revision of the same entries, so a restored or corrected entry can be cited again.
							const cited = (x: { sources: PlanSource[] }) =>
								canonicalJSON({
									...x,
									sources: list(x.sources).map((s) =>
										s.kind === "knowledge" ? { kind: s.kind, id: s.id } : s,
									),
								});
							if (cited(q) !== cited(rest))
								throw new Conflict(
									"Settled question cannot be rewritten; only its Knowledge citations may move to a newer revision",
								);
							for (const s of list(q.sources) as PlanSource[]) {
								const was = list(rest.sources).find((p: PlanSource) => p.kind === "knowledge" && p.id === s.id);
								if (s.kind === "knowledge" && was?.kind === "knowledge" && s.revision < was.revision)
									throw new Conflict("A settled question cites the same or a newer Knowledge revision");
							}
						}
						if (previous?.prototypeResult && q.kind !== "prototype")
							throw new Conflict("Keep prototype evidence and its question identity");
						return {
							...q,
							resolution: previous?.resolution ?? null,
							claimedBy: previous?.claimedBy ?? null,
							...(previous?.prototypeResult ? { prototypeResult: previous.prototypeResult } : {}),
						};
					});
					// Settled questions (and prototype evidence) stay without being sent again: the planner
					// saves only what it changes, so the save stays small however long the mission runs.
					const questions = [
						...plan.questions.filter(
							(q) => (q.resolution || q.prototypeResult) && !sent.some((n) => n.id === q.id),
						),
						...sent,
					];
					const fog = list(request.fog).map((f) => {
						exact(f, ["id", "area", "why", "readyWhen", "dependsOn", "sources"]);
						if (plan.fog.some((p) => p.id === f.id && p.promotedTo.length))
							throw new Conflict("Fog already promoted");
						return { ...f, promotedTo: [] };
					});
					plan.destination = request.destination;
					plan.sources = request.sources;
					plan.questions = questions;
					plan.fog = [...plan.fog.filter((f) => f.promotedTo.length), ...fog];
				} else if (request.purpose === "plan-promote") {
					const fog = plan.fog.find((f) => f.id === request.fogId);
					if (!fog || fog.promotedTo.length || !questionList(request.questions).length)
						throw new Conflict("Active fog required");
					for (const q of request.questions) {
						exact(q, [
							"id",
							"title",
							"question",
							"kind",
							"options",
							"recommendedOptionId",
							"dependsOn",
							"sources",
							...(Object.hasOwn(q, "prototype") ? ["prototype"] : []),
						]);
						plan.questions.push({ ...q, claimedBy: null, resolution: null });
					}
					fog.promotedTo = request.questions.map((q) => q.id);
				} else if (request.purpose === "plan-claim") {
					const q = plan.questions.find((q) => q.id === request.questionId);
					if (!q || q.resolution || (request.claimedBy && !planFrontier(plan).includes(q)))
						throw new Conflict("Unclaimed frontier question required");
					if (request.claimedBy !== null) {
						id(request.claimedBy);
						const member = this.deps.store.membership(request.claimedBy);
						if (!member?.active || member.missionId !== plan.missionId)
							throw new Conflict("Current planning member required");
					}
					q.claimedBy = request.claimedBy;
				} else if (request.purpose === "plan-resolve") this.resolve(plan, request.questionId, request.resolution);
				else if (request.purpose === "plan-prototype-result")
					this.prototypeResult(plan, request.questionId, request.result);
				else if (request.purpose === "plan-propose") {
					if (!request.spec) throw new Conflict("Spec proposal required");
					plan.spec = request.spec;
					plan.slices = request.slices;
				} else if (request.purpose === "plan-ask") {
					const topic = plan.questions.find((q) => q.id === request.topicId);
					if (
						(topic?.kind !== "human" && topic?.kind !== "prototype") ||
						topic.resolution ||
						(topic.kind === "prototype" && !this.prototypeCurrent(plan, topic)) ||
						topic.dependsOn.some((key) => !plan.questions.find((q) => q.id === key)?.resolution)
					)
						throw new Conflict("Unblocked grilling topic or current prototype evidence required");
					const questions = request.questions;
					validateQuestions(questions);
					this.validateRound?.(questions);
					const i = pin.interview;
					const updated = this.deps.store.interviews.write(
						op,
						{ purpose: "interview-questions", expected: { fence: i.fence, revision: i.revision }, questions },
						check,
					);
					plan.round = {
						topicId: topic.id,
						digest: questionContextDigest(plan),
						questionSetRevision: updated.fence.questionSetRevision,
					};
				} else if (request.purpose === "plan-review") {
					this.validate(plan, kept);
					if (!plan.spec || plan.questions.some((q) => !q.resolution))
						throw new Conflict("Resolve precise questions before spec review");
					const proposalDigest = planDigest(plan),
						questionId = `plan-${proposalDigest.slice(0, 24)}`;
					const questions: InterviewQuestion[] = [
						{
							id: questionId,
							section: "acceptance",
							prompt: `Review the complete saved native spec, test seams, vertical-slice breakdown, dependency edges, ownership and unresolved fog shown with this round. Proposal ${proposalDigest}. Approval is for these native planning records only, not execution.`,
							options: [
								{ id: "approve", meaning: `Approve planning proposal ${proposalDigest}` },
								{ id: "revise", meaning: "Revise this proposal" },
							],
							recommendedOptionId: null,
						},
					];
					const i = pin.interview;
					// Same transaction: no round without its native proposal binding. Prior answers stay saved.
					this.validateRound?.(questions);
					const updated = this.deps.store.interviews.write(
						op,
						{ purpose: "interview-questions", expected: { fence: i.fence, revision: i.revision }, questions },
						check,
					);
					plan.review = {
						digest: proposalDigest,
						questionId,
						questionSetRevision: updated.fence.questionSetRevision,
					};
				} else this.publish(plan, kept);
				if (!["plan-review", "plan-publish"].includes(request.purpose)) {
					plan.review = null;
					plan.publication = null;
				}
				if (
					["plan-map", "plan-promote", "plan-propose", "plan-review", "plan-prototype-result"].includes(
						request.purpose,
					)
				)
					plan.round = null;
				this.validate(plan, kept);
				return plan;
			});
			// Do not turn durability failure after commit into rejection or safe replay.
			await this.deps.store.durable();
			this.deps.store.plans.refused(op.targetId, null);
			return { missionId: result.missionId, revision: result.revision };
		} catch (error) {
			if (this.deps.store.plans.lookup(op))
				throw new Error("Unknown planning durability; lookup only", { cause: error });
			if (
				error instanceof Conflict ||
				error instanceof NotFound ||
				error instanceof SyntaxError ||
				error instanceof TypeError
			) {
				this.deps.store.plans.refused(op.targetId, { kind: op.kind, reason: error.message.slice(0, 512) });
				throw new OperationRejected(error.message);
			}
			throw error;
		}
	}
	private prototypeResult(plan: MissionPlan, questionId: string, result: PlanPrototypeResult): void {
		const q = plan.questions.find((q) => q.id === questionId);
		if (
			q?.kind !== "prototype" ||
			q.resolution ||
			q.dependsOn.some((key) => !plan.questions.find((p) => p.id === key)?.resolution)
		)
			throw new Conflict("Open unblocked prototype question required");
		exact(result, [
			"planRevision",
			"questionDigest",
			"contextDigest",
			"artifact",
			"observations",
			"verdict",
			"unresolvedQuestions",
		]);
		exact(result.artifact, ["sessionId", "artifactId", "revision"]);
		id(result.artifact.sessionId);
		id(result.artifact.artifactId);
		if (
			!Number.isSafeInteger(result.artifact.revision) ||
			result.artifact.revision < 1 ||
			result.planRevision !== plan.revision ||
			result.questionDigest !== planQuestionDigest(q) ||
			result.contextDigest !== prototypeContextDigest(plan)
		)
			throw new Conflict("Exact prototype question/context/revision required");
		strings(result.observations, 12);
		strings(result.unresolvedQuestions, 12);
		if (!result.observations.length || !["supported", "not-supported", "inconclusive"].includes(result.verdict))
			throw new Conflict("Prototype observations and verdict required");
		if (
			!this.deps.store
				.artifactReferences(plan.missionId, result.artifact.artifactId)
				.some((link) => link.sessionId === result.artifact.sessionId && link.revision === result.artifact.revision)
		)
			throw new Conflict("Exact revision-pinned mission artifact link required");
		// Metadata only. Never load or execute artifact code, promote production code, or answer for a user.
		q.prototypeResult = result;
		q.claimedBy = null;
	}
	private resolve(plan: MissionPlan, questionId: string, resolution: NonNullable<PlanQuestion["resolution"]>): void {
		exact(resolution, ["kind", "id", "digest"]);
		id(resolution.id);
		const q = plan.questions.find((q) => q.id === questionId);
		if (!q || q.resolution || q.dependsOn.some((key) => !plan.questions.find((p) => p.id === key)?.resolution))
			throw new Conflict("Open unblocked question required");
		if (q.kind === "prototype" && !this.prototypeCurrent(plan, q))
			throw new Conflict("Current prototype evidence required before human feedback");
		if (resolution.kind === "decision" && (q.kind === "human" || q.kind === "prototype")) {
			this.sources(plan.missionId, [{ kind: "decision", id: resolution.id, digest: resolution.digest }]);
			if (
				q.kind === "prototype" &&
				this.deps.store.workflowConfirmationState(plan.missionId).decisions.find((d) => d.id === resolution.id)
					?.authorSessionId
			)
				throw new Conflict(
					"Prototype preferences require a user-authored decision or explicit interview submission",
				);
			if (!q.sources.some((s) => s.kind === "decision" && s.id === resolution.id && s.digest === resolution.digest))
				throw new Conflict("Reuse an explicitly linked settled decision only");
		} else if (resolution.kind === "knowledge" && q.kind === "research") {
			const source = q.sources.find((s) => s.kind === "knowledge" && s.id === resolution.id);
			if (!source || digest(source) !== resolution.digest)
				throw new Conflict(
					"Exact linked research evidence required: link the finding in the question's sources, then pass a resolution from the question's exploration resolveWith",
				);
			this.sources(plan.missionId, [source]);
		} else if (resolution.kind === "interview" && (q.kind === "human" || q.kind === "prototype")) {
			const i = this.context(plan.missionId).interview,
				s = i.submission;
			// A plan-ask round is bound to its topic. A plain questions round has no topic, so the coordinator
			// links its exact latest submission to the human question it answers. Topic and review rounds never
			// fall back to this, so a changed map cannot inherit their answers.
			const asked = plan.round
				? plan.round.topicId === q.id &&
					plan.round.digest === questionContextDigest(plan) &&
					plan.round.questionSetRevision === s?.fence.questionSetRevision
				: q.kind === "human" &&
					!!s &&
					!this.deps.store.plans.boundRound(plan.missionId, s.fence.questionSetRevision);
			if (!s || !asked || s.operationId !== resolution.id || s.digest !== resolution.digest)
				throw new Conflict("Exact complete human submission required");
			this.deps.store.interviews.binding(plan.missionId, this.deps.store.brief(plan.missionId)!);
		} else throw new Conflict("Research cannot answer a human decision");
		q.resolution = resolution;
		q.claimedBy = null;
	}
	private interviewQuestion(q: PlanQuestion): InterviewQuestion {
		return {
			id: q.id,
			section: "outcome",
			prompt: q.question,
			options: q.options,
			recommendedOptionId: q.recommendedOptionId,
		};
	}
	/**
	 * A slice names only UI prototype questions the user already settled with a made prototype, so its task can
	 * point the worker at the chosen artifact and answers.
	 */
	private slicePrototypes(plan: MissionPlan, slice: PlanSlice): void {
		const ids = list(slice.prototypes!, 8, `slice "${slice.id}" prototypes (at most 8: one per screen it changes)`);
		if (!ids.length || new Set(ids).size !== ids.length)
			throw new Conflict(`Slice "${slice.id}" prototypes must be omitted or list distinct question ids`);
		for (const id of ids) {
			const q = plan.questions.find((q) => q.id === id);
			if (q?.kind !== "prototype" || q.prototype?.experimentType !== "ui")
				throw new Conflict(`Slice "${slice.id}" prototypes: "${id}" is not a UI prototype question of this map`);
			if (q.resolution?.kind !== "interview" || !q.prototypeResult)
				throw new Conflict(
					`Slice "${slice.id}" prototypes: "${id}" has no prototype the user chose yet. Settle it from the user's answer first`,
				);
		}
	}

	/** `kept`: as in validate. A settled question's changed citation shows on the map; it never blocks publishing. */
	private publish(plan: MissionPlan, kept: ReadonlySet<string>): void {
		const { store } = this.deps;
		this.validate(plan, kept);
		const review = plan.review,
			i = this.context(plan.missionId).interview,
			submission = i.submission;
		if (
			plan.publication ||
			store.plans.hasPublication(plan.missionId) ||
			!review ||
			review.digest !== planDigest(plan) ||
			!submission ||
			submission.fence.questionSetRevision !== review.questionSetRevision ||
			submission.questions.length !== 1 ||
			submission.questions[0]!.id !== review.questionId ||
			submission.answers[0]?.selectedOption?.id !== "approve"
		)
			throw new Conflict("Exact submitted proposal approval required");
		store.interviews.binding(plan.missionId, store.brief(plan.missionId)!);
		const markdown = planMarkdown(plan),
			brief = store.writeBrief(plan.missionId, markdown, submission.briefRevision);
		const ids = new Map<string, string>(),
			remaining = [...plan.slices];
		const origin = store.planningWorkers.get(plan.missionId)?.request;
		const managed = origin?.manageStatus ? store.linearPlanOrigin(plan.missionId) : undefined;
		while (remaining.length) {
			const index = remaining.findIndex((s) => s.dependsOn.every((key) => ids.has(key)));
			if (index < 0) throw new Conflict("Invalid slice dependencies");
			const slice = remaining.splice(index, 1)[0]!;
			const task = store.addTask(
				plan.missionId,
				{
					title: slice.title,
					body: sliceTaskBody(plan, slice, brief.revision),
					dependsOn: slice.dependsOn.map((key) => ids.get(key)!),
					status: "todo",
				},
				{ sessionId: plan.ownerSessionId },
			);
			if (managed)
				store.addResource(plan.missionId, { url: managed.url, taskId: task.id, linearRole: "contribution" });
			for (const id of slice.prototypes ?? []) {
				const q = plan.questions.find((q) => q.id === id)!;
				const a = q.prototypeResult!.artifact;
				// The prototype chat linked it to the mission when it finished; this pins it on the task too.
				store.linkArtifact(
					plan.missionId,
					{
						sessionId: a.sessionId,
						artifactId: a.artifactId,
						title: q.title,
						kind: "nsh",
						revision: a.revision,
						taskId: task.id,
					},
					{ sessionId: plan.ownerSessionId },
				);
			}
			ids.set(slice.id, task.id);
		}
		plan.publication = {
			digest: review.digest,
			submissionDigest: submission.digest,
			briefRevision: brief.revision,
			markdown,
			tasks: [...ids].map(([sliceId, taskId]) => ({ sliceId, taskId })),
		};
		// The complete operation's native snapshot is the publication receipt. No worker starts here.
	}
}
