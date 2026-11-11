/** The shared Wayfinder map: a read-only projection of saved planning records. Never stored or a grant. */
import type {
	KnowledgeSummary,
	MissionDecision,
	MissionInterview,
	MissionPlan,
	MissionPlanMap,
	MissionTask,
	PlanMapFog,
	PlanMapItem,
	PlanMapSource,
	PlanQuestion,
	PlanSource,
} from "@pilot/protocol";
import { interviewDigest as digest } from "./mission-interview-contract.ts";

export interface PlanMapInput {
	plan: MissionPlan | null;
	destination: string;
	/** Active decisions of this read. Replaced or withdrawn ones are absent. */
	decisions: MissionDecision[];
	/** Knowledge linked to this mission, as listed in this read. */
	knowledge: KnowledgeSummary[];
	/** Submitted interview snapshots in append order. */
	history: { interview: MissionInterview }[];
	/** The unresolved, unclaimed questions whose prerequisites are settled. */
	frontier: PlanQuestion[];
	/** Prototype evidence currentness, as the planning service judges it. */
	evidence(question: PlanQuestion): "missing" | "current" | "stale";
	task(taskId: string): MissionTask | undefined;
}

function decisionSource(input: PlanMapInput, id: string, cited: string): PlanMapSource {
	const d = input.decisions.find((d) => d.id === id);
	if (!d) return { kind: "decision", id, label: "A decision that is no longer active", state: "missing" };
	return { kind: "decision", id, label: `Decision ${d.number}`, state: digest(d) === cited ? "current" : "changed" };
}

function knowledgeSource(input: PlanMapInput, s: Extract<PlanSource, { kind: "knowledge" }>): PlanMapSource {
	const entry = input.knowledge.find((k) => k.id === s.id);
	if (!entry?.link)
		return { kind: "knowledge", id: s.id, label: `Knowledge entry, revision ${s.revision}`, state: "missing" };
	const same = entry.revision === s.revision && entry.link.linkRevision === s.linkRevision;
	return {
		kind: "knowledge",
		id: s.id,
		label: `Knowledge: ${entry.title}, revision ${s.revision}`,
		state: same ? "current" : "changed",
		// Freshness describes the entry's current revision only, never an older cited one.
		...(entry.revision === s.revision ? { checked: entry.freshness.state } : {}),
	};
}

function source(input: PlanMapInput, s: PlanSource): PlanMapSource {
	return s.kind === "decision" ? decisionSource(input, s.id, s.digest) : knowledgeSource(input, s);
}

function settledBy(input: PlanMapInput, q: PlanQuestion): PlanMapSource | null {
	const r = q.resolution;
	if (!r) return null;
	if (r.kind === "decision") return decisionSource(input, r.id, r.digest);
	if (r.kind === "knowledge") {
		const cited = q.sources.find(
			(s): s is Extract<PlanSource, { kind: "knowledge" }> =>
				s.kind === "knowledge" && s.id === r.id && digest(s) === r.digest,
		);
		return cited
			? knowledgeSource(input, cited)
			: { kind: "knowledge", id: r.id, label: "A Knowledge entry", state: "missing" };
	}
	const round = input.history.find((h) => h.interview.submission?.operationId === r.id);
	const submission = round?.interview.submission;
	return submission
		? {
				kind: "interview",
				id: r.id,
				label: `Interview round ${submission.fence.questionSetRevision}`,
				state: submission.digest === r.digest ? "current" : "changed",
			}
		: { kind: "interview", id: r.id, label: "An interview round", state: "missing" };
}

function item(input: PlanMapInput, plan: MissionPlan, q: PlanQuestion): PlanMapItem {
	const settled = (key: string) => !!plan.questions.find((p) => p.id === key)?.resolution;
	const state: PlanMapItem["state"] = q.resolution
		? "settled"
		: plan.round?.topicId === q.id
			? "asking"
			: q.claimedBy
				? "claimed"
				: input.frontier.some((f) => f.id === q.id)
					? "ready"
					: "waiting";
	const result = q.prototypeResult;
	return {
		id: q.id,
		title: q.title,
		question: q.question,
		kind: q.kind,
		state,
		dependsOn: [...q.dependsOn],
		waitingOn: q.dependsOn.filter((key) => !settled(key)),
		claimedBy: q.claimedBy,
		fromFog: plan.fog.find((f) => f.promotedTo.includes(q.id))?.id ?? null,
		sources: q.sources.map((s) => source(input, s)),
		settledBy: settledBy(input, q),
		...(q.kind === "prototype"
			? {
					evidence: {
						state: input.evidence(q),
						...(result
							? { verdict: result.verdict, planRevision: result.planRevision, artifact: { ...result.artifact } }
							: {}),
						observations: [...(result?.observations ?? [])],
						unresolvedQuestions: [...(result?.unresolvedQuestions ?? [])],
					},
				}
			: {}),
	};
}

/** Rebuilds the map from one pinned read. Pure: it writes nothing and starts nothing. */
export function planMap(input: PlanMapInput): MissionPlanMap {
	const plan = input.plan;
	const items = plan ? plan.questions.map((q) => item(input, plan, q)) : [];
	const fog: PlanMapFog[] = (plan?.fog ?? []).map((f) => ({
		id: f.id,
		area: f.area,
		why: f.why,
		readyWhen: f.readyWhen,
		dependsOn: [...f.dependsOn],
		sources: f.sources.map((s) => source(input, s)),
		promotedTo: [...f.promotedTo],
	}));
	const claims = [
		...items.flatMap((i) => [...i.sources, ...(i.settledBy ? [i.settledBy] : [])]),
		...fog.filter((f) => !f.promotedTo.length).flatMap((f) => f.sources),
	];
	const count = (state: PlanMapItem["state"]) => items.filter((i) => i.state === state).length;
	const publication = plan?.publication;
	return {
		version: 1,
		planRevision: plan?.revision ?? null,
		destination: input.destination,
		items,
		fog,
		counts: {
			settled: count("settled"),
			asking: count("asking"),
			claimed: count("claimed"),
			ready: count("ready"),
			waiting: count("waiting"),
			activeFog: fog.filter((f) => !f.promotedTo.length).length,
			notCurrent:
				claims.filter((c) => c.state !== "current").length +
				items.filter((i) => i.evidence?.state === "stale").length,
		},
		agreement: !plan?.spec
			? null
			: {
					state: publication ? "published" : plan.review ? "in-review" : "proposed",
					briefRevision: publication?.briefRevision ?? null,
					tasks: (publication?.tasks ?? []).map(({ sliceId, taskId }) => {
						const task = input.task(taskId);
						return {
							sliceId,
							taskId,
							number: task?.number ?? null,
							title: task?.title ?? plan.slices.find((s) => s.id === sliceId)?.title ?? "",
							status: task?.status ?? null,
						};
					}),
				},
	};
}
