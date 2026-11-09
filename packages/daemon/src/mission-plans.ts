/** Host-only planning adapter. No external tracker, shell, model, subagent or dispatch ports. */
import type {
	DurableOperation,
	InterviewQuestion,
	MissionPlan,
	PlanQuestion,
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
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected } from "./operation-journal.ts";

interface Dependencies {
	store: MissionStore;
	journal: OperationJournal;
	/** Host ingress checks coordinator authority; answer saves/submission MUST be native human actions.
	 * No actor label in a model request can satisfy this check. */
	authorize(purpose: string, missionId: string, ownerSessionId: string): void;
	validateRound?(questions: InterviewQuestion[]): void;
}
const kinds = [
	"plan-map",
	"plan-promote",
	"plan-claim",
	"plan-resolve",
	"plan-propose",
	"plan-ask",
	"plan-review",
	"plan-publish",
];
export const isPlanOperation = (kind: string): boolean => kinds.includes(kind);
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

function list<T>(value: T[], max = 40): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Conflict("Invalid planning list");
	return value;
}
function strings(value: string[], max = 40) {
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
		for (const dependency of list(n.dependsOn)) {
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

export class MissionPlans {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private context(missionId: string) {
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
		return { mission, owner, ownerFence, interview, plan, evidence: store.workflowConfirmationState(missionId) };
	}
	/** Bounded native context. Decision digests and linked Knowledge locators are not new grants. */
	async view(missionId: string) {
		const pin = this.context(missionId),
			{ store } = this.deps;
		const knowledge = store.knowledge.list(pin.mission.projectId, { missionId }, undefined, 40);
		const result = {
			plan: pin.plan ?? null,
			destination: pin.plan?.destination ?? pin.mission.goal,
			decisions: pin.evidence.decisions.map((d) => ({
				decision: d,
				source: { kind: "decision", id: d.id, digest: digest(d) },
			})),
			knowledge,
			interview: pin.interview,
			frontier: pin.plan ? planFrontier(pin.plan) : [],
			activeFog: pin.plan ? activeFog(pin.plan) : [],
			exploration: pin.plan
				? pin.plan.questions
						.filter((q) => !q.resolution)
						.map((q) => ({
							questionId: q.id,
							status: q.kind === "research" ? "needs-research" : "needs-grilling",
							ready: planFrontier(pin.plan!).some((p) => p.id === q.id),
						}))
				: [],
		};
		this.deps.authorize("plan-read", missionId, pin.owner);
		await store.durable();
		this.deps.authorize("plan-read", missionId, pin.owner);
		if (
			canonicalJSON(this.context(missionId)) !== canonicalJSON(pin) ||
			canonicalJSON(store.knowledge.list(pin.mission.projectId, { missionId }, undefined, 40)) !==
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
	private sources(missionId: string, sources: PlanSource[]): void {
		const { store } = this.deps;
		for (const s of list(sources)) {
			id(s.id);
			if (s.kind === "decision") {
				exact(s, ["kind", "id", "digest"]);
				const decision = store.workflowConfirmationState(missionId).decisions.find((d) => d.id === s.id);
				if (!decision || digest(decision) !== s.digest) throw new Conflict("Settled decision changed");
			} else if (s.kind === "knowledge") {
				exact(s, ["kind", "id", "revision", "linkRevision"]);
				const link = store.knowledge.link(missionId, s.id);
				const entry = store.knowledge.detail(store.require(missionId).projectId, s.id, s.revision);
				if (
					!Number.isSafeInteger(s.revision) ||
					s.revision < 1 ||
					!entry ||
					!link.linked ||
					link.linkRevision !== s.linkRevision ||
					(link.pinnedRevision !== undefined && link.pinnedRevision !== s.revision)
				)
					throw new Conflict("Linked Knowledge revision unavailable");
			} else throw new Conflict("Unsupported planning source");
		}
	}
	private validate(plan: MissionPlan): void {
		text(plan.destination, 2000);
		this.sources(plan.missionId, plan.sources);
		for (const q of list(plan.questions)) {
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
			]);
			validateQuestions([this.interviewQuestion(q)]);
			text(q.title, 200);
			text(q.question, 2000);
			if (!["human", "research"].includes(q.kind)) throw new Conflict("Invalid question type");
			this.sources(plan.missionId, q.sources);
		}
		graph(plan.questions);
		const fogIds = new Set<string>();
		for (const f of list(plan.fog)) {
			exact(f, ["id", "area", "why", "readyWhen", "dependsOn", "sources", "promotedTo"]);
			id(f.id);
			text(f.area, 2000);
			text(f.why, 2000);
			text(f.readyWhen, 2000);
			if (fogIds.has(f.id)) throw new Conflict("Duplicate fog identity");
			fogIds.add(f.id);
			this.sources(plan.missionId, f.sources);
			for (const key of [...list(f.dependsOn), ...list(f.promotedTo)])
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
				exact(slice, ["id", "title", "outcome", "acceptance", "storyIds", "dependsOn", "owners"]);
				text(slice.title, 200);
				text(slice.outcome, 2000);
				strings(slice.acceptance);
				strings(slice.storyIds);
				if (
					!slice.acceptance.length ||
					!slice.storyIds.length ||
					!slice.owners.length ||
					list(slice.owners, 2).some((o) => !["opus-ui", "sol-backend"].includes(o)) ||
					slice.storyIds.some((key) => !s.stories.some((story) => story.id === key))
				)
					throw new Conflict("Verifiable slices need story traceability and explicit ownership");
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
			if (canonicalJSON((await this.deps.journal.lookup(op))?.result) !== canonicalJSON(this.marker(op)))
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
				"plan-propose": ["spec", "slices"],
				"plan-review": [],
				"plan-ask": ["topicId", "questions"],
				"plan-publish": [],
			};
			exact(request, ["purpose", "expectedRevision", ...keys[request.purpose]!]);
			const pin = this.context(op.targetId);
			const check = () => {
				this.deps.authorize(request.purpose, op.targetId, pin.owner);
				if (canonicalJSON(this.context(op.targetId)) !== canonicalJSON(pin))
					throw new Conflict("Planning context changed");
				if ((pin.plan?.revision ?? 0) !== request.expectedRevision) throw new Conflict("Planning revision changed");
			};
			check();
			await this.deps.journal.checkpoint(op, this.marker(op));
			const result = this.deps.store.plans.write(op, request.expectedRevision, (state) => {
				check();
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
					const questions = list(request.questions).map((q) => {
						exact(q, [
							"id",
							"title",
							"question",
							"kind",
							"options",
							"recommendedOptionId",
							"dependsOn",
							"sources",
						]);
						const previous = plan.questions.find((p) => p.id === q.id);
						if (previous?.resolution) {
							const { resolution: _r, claimedBy: _c, ...rest } = previous;
							if (canonicalJSON(q) !== canonicalJSON(rest))
								throw new Conflict("Settled question cannot be rewritten");
						}
						return { ...q, resolution: previous?.resolution ?? null, claimedBy: previous?.claimedBy ?? null };
					});
					if (plan.questions.some((q) => q.resolution && !questions.some((n) => n.id === q.id)))
						throw new Conflict("Keep settled decisions");
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
					if (!fog || fog.promotedTo.length || !list(request.questions).length)
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
				else if (request.purpose === "plan-propose") {
					if (!request.spec) throw new Conflict("Spec proposal required");
					plan.spec = request.spec;
					plan.slices = request.slices;
				} else if (request.purpose === "plan-ask") {
					const topic = plan.questions.find((q) => q.id === request.topicId);
					if (
						topic?.kind !== "human" ||
						topic.resolution ||
						topic.dependsOn.some((key) => !plan.questions.find((q) => q.id === key)?.resolution)
					)
						throw new Conflict("Unblocked Needs grilling topic required");
					const questions = request.questions;
					validateQuestions(questions);
					this.deps.validateRound?.(questions);
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
					this.validate(plan);
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
					this.deps.validateRound?.(questions);
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
				} else this.publish(plan);
				if (!["plan-review", "plan-publish"].includes(request.purpose)) {
					plan.review = null;
					plan.publication = null;
				}
				if (["plan-map", "plan-promote", "plan-propose", "plan-review"].includes(request.purpose))
					plan.round = null;
				this.validate(plan);
				return plan;
			});
			// Do not turn durability failure after commit into rejection or safe replay.
			await this.deps.store.durable();
			return { missionId: result.missionId, revision: result.revision };
		} catch (error) {
			if (this.deps.store.plans.lookup(op))
				throw new Error("Unknown planning durability; lookup only", { cause: error });
			if (
				error instanceof Conflict ||
				error instanceof NotFound ||
				error instanceof SyntaxError ||
				error instanceof TypeError
			)
				throw new OperationRejected(error.message);
			throw error;
		}
	}
	private resolve(plan: MissionPlan, questionId: string, resolution: NonNullable<PlanQuestion["resolution"]>): void {
		exact(resolution, ["kind", "id", "digest"]);
		id(resolution.id);
		const q = plan.questions.find((q) => q.id === questionId);
		if (!q || q.resolution || q.dependsOn.some((key) => !plan.questions.find((p) => p.id === key)?.resolution))
			throw new Conflict("Open unblocked question required");
		if (resolution.kind === "decision" && q.kind === "human") {
			this.sources(plan.missionId, [{ kind: "decision", id: resolution.id, digest: resolution.digest }]);
			if (!q.sources.some((s) => s.kind === "decision" && s.id === resolution.id && s.digest === resolution.digest))
				throw new Conflict("Reuse an explicitly linked settled decision only");
		} else if (resolution.kind === "knowledge" && q.kind === "research") {
			const source = q.sources.find((s) => s.kind === "knowledge" && s.id === resolution.id);
			if (!source || digest(source) !== resolution.digest)
				throw new Conflict("Exact linked research evidence required");
			this.sources(plan.missionId, [source]);
		} else if (resolution.kind === "interview" && q.kind === "human") {
			const i = this.context(plan.missionId).interview,
				s = i.submission;
			if (
				!s ||
				!plan.round ||
				plan.round.topicId !== q.id ||
				plan.round.digest !== questionContextDigest(plan) ||
				plan.round.questionSetRevision !== s.fence.questionSetRevision ||
				s.operationId !== resolution.id ||
				s.digest !== resolution.digest
			)
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
	private publish(plan: MissionPlan): void {
		const { store } = this.deps;
		this.validate(plan);
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
		while (remaining.length) {
			const index = remaining.findIndex((s) => s.dependsOn.every((key) => ids.has(key)));
			if (index < 0) throw new Conflict("Invalid slice dependencies");
			const slice = remaining.splice(index, 1)[0]!;
			const task = store.addTask(
				plan.missionId,
				{
					title: slice.title,
					body: `${slice.outcome}\n\nSpec revision: ${brief.revision}\nStories: ${slice.storyIds.join(", ")}\nOwnership: ${slice.owners.join(", ")}\n\nAcceptance:\n${slice.acceptance.map((s) => `- ${s}`).join("\n")}`,
					dependsOn: slice.dependsOn.map((key) => ids.get(key)!),
					status: "todo",
				},
				{ sessionId: plan.ownerSessionId },
			);
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
