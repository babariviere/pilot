/** Trusted planning worker lifecycle. No existing chat adoption or generic send fallback. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	assertPlanningBinding,
	PLANNING_PROFILE,
	type PlanningInput,
	type PlanningWorkerBinding,
	type PlanningWorkerReply,
	type PlanningWorkerRequest,
} from "@pilot/kernel";
import type { DurableOperation, MissionPlan, OperationReceipt, PlanQuestion } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { interviewDigest, interviewExact, interviewId, interviewText } from "./mission-interview-contract.ts";
import { MissionInterviews } from "./mission-interviews.ts";
import { PLAN_STATE_LIMIT } from "./mission-plan-store.ts";
import {
	isPlanOperation,
	LINKED_KNOWLEDGE,
	MissionPlans,
	planQuestionDigest,
	planResearchFrontier,
} from "./mission-plans.ts";
import { taskMessage } from "./mission-service.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type {
	MissionFix,
	PlanningRepair,
	PlanningResearch,
	PlanningWorkerState,
	QuestionAsk,
} from "./planning-worker-store.ts";
import type { KnowledgeService } from "./project-knowledge.ts";
import type { ProjectStore } from "./projects.ts";
import { replacedMissionView } from "./replaced-mission.ts";
import type { SessionManager } from "./sessions.ts";
import { trace } from "./trace.ts";
import type { WorkflowConfirmations } from "./workflow-confirmations.ts";

export interface PlanningEnrollment {
	purpose: "planning-enroll";
	projectId: string;
	ownerSessionId: string;
	title: string;
	goal: string;
	model: string;
	profile: typeof PLANNING_PROFILE;
	configurationDigest: string;
	/** An old mission this one re-plans. Linked in the enrollment transaction; the old mission is not changed. */
	replaces?: string;
}
interface Dependencies {
	home: string;
	store: MissionStore;
	journal: OperationJournal;
	projects: ProjectStore;
	sessions: SessionManager;
	confirmations: WorkflowConfirmations;
	/** Saves finished research as Knowledge. Without it, the planner gets the full reports to record. */
	knowledge?: KnowledgeService;
}
const hash = (value: unknown) => payloadHash(canonicalJSON(value));
/**
 * The planner's read of the map: settled questions as one short entry each, not their full text and
 * sources, so the read stays small however long the mission runs. A save keeps them without resending.
 */
export function compactView<T extends { plan: MissionPlan | null }>(view: T) {
	if (!view.plan) return view;
	return {
		...view,
		plan: { ...view.plan, questions: view.plan.questions.filter((q) => !q.resolution) },
		settled: view.plan.questions
			.filter((q) => q.resolution)
			.map(({ id, title, kind, dependsOn, resolution }) => ({ id, title, kind, dependsOn, resolution })),
		settledNote:
			"Settled questions stay on the map without being sent again; plan saves list only open questions. Read with revision for their full text.",
	};
}
/** Planning operations kept per mission for Diagnostics, and missions kept. Memory only: small, and pilotd.log has the rest. */
const RECENT_OPERATIONS = 20;
const RECENT_MISSIONS = 50;
/** Research chats a mission may run at once. The mission's worker cap also applies. */
const RESEARCH_CHATS = 2;
const RESEARCH_RETRY_MS = 60_000;
/** Research chats per question: the first, and one more when the planner unclaims weak findings. */
const RESEARCH_ATTEMPTS = 2;
/** Research findings per planning turn, at most. */
const RESEARCH_BATCH = 3;
/** Final answer characters sent to the planner per research chat. Broad research should be split instead. */
const RESEARCH_REPORT_LIMIT = 48_000;
/** Chats answering the user's questions about interview questions at once, per mission. */
const ASK_CHATS = 2;
/** Questions kept per mission; the oldest finished ones go first. */
const ASKS_KEPT = 60;
/** Answer characters shown to the user. Answers are meant to be short. */
const ASK_ANSWER_LIMIT = 6_000;

/** Longest repair-agent reply Pilot reads. Its JSON block comes last. */
const REPAIR_REPLY_LIMIT = 16_000;
const FIXES = ["continue", "planner-note", "drop-earlier-answers", "code-repair", "none"] as const;
function repairMessage(missionTitle: string, missionId: string): string {
	return [
		`Find why planning for the mission "${missionTitle}" (missionId ${missionId}) is stuck, and propose one fix. This chat is read-only.`,
		`Read diagnostic_context action mission with missionId ${missionId}: its planning field has what Pilot checked, refused saves, counts and recent operations. Read diagnostic_history for the planner's chat (your target) and diagnostic_logs for pilotd lines that name the mission.`,
		"Never answer the planner's questions, settle decisions or start work. Do not call repair_proposal. The user reads your fix and decides.",
		"End your reply with one JSON block:",
		'```json\n{"fix": "continue" | "planner-note" | "drop-earlier-answers" | "code-repair" | "none", "cause": "…", "note": "…", "certainty": "low" | "medium" | "high", "evidence": ["…"]}\n```',
		"- cause: why planning is stuck, in plain words, at most 600 characters.",
		"- note: only with planner-note. What the planner must change, written to the planner, at most 2000 characters.",
		"- continue: the planner only needs to continue. drop-earlier-answers: saved answers belong to an earlier wording of their question. code-repair: a Pilot bug the planner cannot work around; say where in cause. none: nothing to fix from here.",
		'- evidence: 1 to 8 short labels of what you read, for example "plan-map refused: Invalid planning list".',
	].join("\n");
}
/** The last JSON block of the repair agent's reply, if it is a valid fix. */
export function parseMissionFix(reply: string): MissionFix | null {
	const blocks = [...reply.matchAll(/```json\s*\n([\s\S]*?)```/g)];
	const last = blocks.at(-1)?.[1];
	if (!last) return null;
	try {
		const v = JSON.parse(last);
		const text = (s: unknown, max: number) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
		if (
			!v ||
			typeof v !== "object" ||
			Object.keys(v).some((k) => !["fix", "cause", "note", "certainty", "evidence"].includes(k)) ||
			!FIXES.includes(v.fix) ||
			!text(v.cause, 600) ||
			(v.fix === "planner-note" ? !text(v.note, 2000) : v.note !== undefined && v.note !== "") ||
			!["low", "medium", "high"].includes(v.certainty) ||
			!Array.isArray(v.evidence) ||
			v.evidence.length < 1 ||
			v.evidence.length > 8 ||
			!v.evidence.every((e: unknown) => text(e, 200))
		)
			return null;
		return {
			fix: v.fix,
			cause: v.cause.trim(),
			...(v.fix === "planner-note" ? { note: v.note.trim() } : {}),
			certainty: v.certainty,
			evidence: v.evidence.map((e: string) => e.trim()),
		};
	} catch {
		return null;
	}
}

function askMessage(
	missionTitle: string,
	q: { prompt: string; options: { meaning: string }[]; context?: string },
	earlier: QuestionAsk[],
	text: string,
): string {
	return [
		`Answer the user's question about one planning question of the mission "${missionTitle}". This chat is read-only.`,
		`The planning question: ${q.prompt}`,
		q.options.length ? `Suggested answers:\n${q.options.map((o) => `- ${o.meaning}`).join("\n")}` : "",
		q.context ? `Background Pilot gave: ${q.context}` : "",
		earlier.length
			? `Earlier questions about it:\n${earlier.map((a) => `Q: ${a.text}\nA: ${a.answer ?? "(no answer)"}`).join("\n")}`
			: "",
		`The user asks: ${text}`,
		'mission({action:"map"}) shows the planning map; read linked Knowledge with the knowledge tool when it helps. Read source only when needed.',
		"Answer for the user, who has not read the code or the research: plain words, at most 150 words. Prefer the project's GLOSSARY.md terms and the user's own words; explain any other technical term. Explain; do not answer the planning question for the user or change anything. Pilot shows your final answer to the user word for word.",
	]
		.filter(Boolean)
		.join("\n\n");
}

function researchMessage(missionTitle: string, q: PlanQuestion): string {
	return [
		`Research one planning question for the mission "${missionTitle}". This chat is read-only research.`,
		`Question: ${q.title}`,
		q.question,
		'Use source tools and web. mission({action:"map"}) shows the planning map and what is already settled. If this mission re-plans an older one, mission({action:"replaced"}) reads it (brief, decisions, tasks; id for one task with its latest report).',
		"Do not change files, start work or decide for the user. Report facts with their sources.",
		"End with your findings in Markdown: Question; Findings (each labelled observed or inferred, with source paths, records or links); Limitations. Pilot saves your final answer as project Knowledge, word for word.",
	].join("\n\n");
}

/** A short plain summary of a research report: the start of its findings, for the Knowledge synopsis. */
export function researchSynopsis(report: string): string {
	const at = report.search(/^#{1,6}\s+.*(finding|conclusion)/im);
	const text = (at >= 0 ? report.slice(at).replace(/^.*\n/, "") : report)
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 600 ? `${text.slice(0, 599).trimEnd()}…` : text || "Research findings.";
}
/** The map, mission or its controls changed after the round was saved: only the user's Continue sends it. */
class RoundChanged extends Conflict {
	constructor() {
		super("Submitted planning round changed; Continue planning sends it against the current map");
	}
}
export class PlanningWorkers {
	private readonly deps: Dependencies;
	private readonly closing = new AbortController();
	private readonly tasks = new Set<Promise<unknown>>();
	private readonly admissions = new Map<string, Promise<unknown>>();
	private readonly turnAdmissions = new Map<string, Promise<void>>();
	private readonly detach: () => void;
	private readonly offSettled: () => void;
	/** Repair chats are not mission members: their changes reach the mission through this map. */
	private readonly repairChats = new Map<string, string>();
	/** Missions whose submitted round is being sent to the planner now. */
	private readonly continuing = new Set<string>();
	/** Submitted rounds Pilot is sending by itself, or stopped trying because the map changed. */
	private readonly resumeTried = new Set<string>();
	private readonly recentOperations = new Map<
		string,
		{ kind: string; state: string; reason: string | null; operationId: string; at: string }[]
	>();
	private closed?: Promise<void>;
	/** Research dispatch is opt-in (the daemon starts it), so fixtures never start chats by accident. */
	private research?: { dirty: Set<string>; running?: Promise<void>; off: () => void; retryAt: Map<string, number> };
	constructor(deps: Dependencies) {
		this.deps = deps;
		this.detach = deps.sessions.setPlanningBridge({
			assert: (b) => {
				this.scope(b);
			},
			held: (b) => this.scope(b).phase !== "active",
			call: (b, r, guard) => this.call(b, r, guard),
			close: () => this.close(),
		});
		this.offSettled = deps.journal.onSettled((op, receipt) => this.noteOperation(op, receipt));
	}
	/**
	 * Read-only planning facts for a Diagnostics chat: why planning moves, waits or is stuck, with counts and
	 * recent operations. It holds no question, answer or Knowledge text; the planner's history has those.
	 */
	diagnosticPlanning(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state) return null;
		const plan = this.deps.store.plans.get(missionId);
		const interview = this.deps.store.interviews.latest(missionId);
		const earlier = interview
			? interview.answers.filter((a) => {
					const q = interview.questions.find((x) => x.id === a.questionId);
					return !q || a.questionDigest !== interviewDigest(q);
				}).length
			: 0;
		return {
			unstick: this.unstickView(missionId),
			phase: state.phase,
			plannerChatId: state.binding.ownerSessionId,
			lastRefusal: this.deps.store.plans.refusal(missionId) ?? null,
			map: plan
				? {
						revision: plan.revision,
						openQuestions: plan.questions.filter((q) => !q.resolution).length,
						settledQuestions: plan.questions.filter((q) => q.resolution).length,
						fog: plan.fog.length,
						bytes: Buffer.byteLength(JSON.stringify(plan)),
						byteLimit: PLAN_STATE_LIMIT,
						published: !!plan.publication,
					}
				: null,
			round: interview
				? {
						revision: interview.revision,
						questions: interview.questions.length,
						savedAnswers: interview.answers.length,
						answersToEarlierWording: earlier,
						submitted: !!interview.submission,
					}
				: null,
			operations: {
				coverage: "Operations settled since the daemon started, newest first. Older ones are in pilotd.log.",
				items: [...(this.recentOperations.get(missionId) ?? [])].reverse(),
			},
			chats: [
				...Object.entries(state.research ?? {}).map(([questionId, r]) => ({
					kind: "research" as const,
					questionId,
					state: r.state,
					chatId: r.sessionId,
					reason: r.reason ?? null,
				})),
				...Object.values(state.asks ?? {}).map((a) => ({
					kind: "question" as const,
					questionId: a.questionId,
					state: a.state,
					chatId: a.sessionId,
					reason: a.reason ?? null,
				})),
			].slice(-40),
		};
	}
	/** Keeps the last planning operations per mission, for diagnosticPlanning. Memory only. */
	private noteOperation(op: DurableOperation, receipt: OperationReceipt) {
		if (!/^(plan|interview|planning)-/.test(op.kind)) return;
		const list = this.recentOperations.get(op.targetId) ?? [];
		list.push({
			kind: op.kind,
			state: receipt.state,
			reason: receipt.reason?.slice(0, 512) ?? null,
			operationId: op.operationId,
			at: new Date().toISOString(),
		});
		if (list.length > RECENT_OPERATIONS) list.shift();
		this.recentOperations.delete(op.targetId);
		this.recentOperations.set(op.targetId, list);
		if (this.recentOperations.size > RECENT_MISSIONS)
			this.recentOperations.delete(this.recentOperations.keys().next().value!);
	}

	configuration(projectId: string): string {
		return hash({ project: this.deps.projects.require(projectId), profile: PLANNING_PROFILE });
	}
	profile(projectId: string) {
		return { version: 1, projectId, profile: PLANNING_PROFILE, configurationDigest: this.configuration(projectId) };
	}
	private scope(binding: PlanningWorkerBinding): PlanningWorkerState {
		assertPlanningBinding(binding);
		const { store, projects, sessions, journal } = this.deps;
		const state = store.planningWorkers.get(binding.missionId),
			mission = store.require(binding.missionId),
			interview = store.interviews.latest(binding.missionId),
			owner = sessions.get(binding.ownerSessionId),
			member = store.membership(binding.ownerSessionId);
		if (
			this.closing.signal.aborted ||
			binding.home !== resolve(this.deps.home) ||
			!sameHost(binding.host, journal.destination) ||
			!state ||
			canonicalJSON(state.binding) !== canonicalJSON(binding) ||
			mission.projectId !== binding.projectId ||
			mission.status !== "active" ||
			mission.planningVersion !== 1 ||
			mission.coordinatorSessionId !== binding.ownerSessionId ||
			!member?.active ||
			!member.coordinator ||
			member.missionId !== binding.missionId ||
			!interview ||
			interview.fence.enrollmentId !== binding.enrollmentId ||
			canonicalJSON(interview.ownerFence) !==
				canonicalJSON(store.interviewOwnerFence(binding.missionId, binding.ownerSessionId)) ||
			!owner ||
			owner.projectId !== binding.projectId ||
			owner.mode !== "build" ||
			owner.role ||
			owner.control ||
			owner.archivedAt
		)
			throw new Conflict("Current trusted planning owner required");
		projects.require(binding.projectId);
		return state;
	}
	/** `round`: the fingerprint a held round keeps, without chats joining the mission (research, asks,
	 * repair), and pause and resume. They change nothing the user answered; pause is checked at send time. */
	private authority(binding: PlanningWorkerBinding, round = false): string {
		this.scope(binding);
		this.deps.sessions.assertPlanningOpen(binding.ownerSessionId);
		const { store, sessions } = this.deps,
			mission = store.require(binding.missionId),
			control = store.controls.fenceCurrent(binding.missionId);
		const { briefRevision: _brief, memberEventId, ...rest } = store.allocationContextFence(binding.missionId);
		const context = round ? rest : { ...rest, memberEventId };
		if (control.held) throw new Conflict("Mission planning is paused");
		return hash({
			binding,
			project: this.deps.projects.require(binding.projectId),
			session: sessions.planningIdentity(binding.ownerSessionId),
			mission: {
				title: mission.title,
				goal: mission.goal,
				status: mission.status,
				coordinatorSessionId: mission.coordinatorSessionId,
			},
			owner: store.interviewOwnerFence(binding.missionId, binding.ownerSessionId),
			context,
			// A held round keeps only Stop: pause is checked when it is sent, so Resume sends it.
			controls: round ? { stopGeneration: control.stopGeneration } : control,
		});
	}
	/**
	 * What the user answered against: the mission, its controls and the map. Pilot's bookkeeping (the map's
	 * revision and research claims) and chats joining the mission are left out: they change while a round
	 * waits without changing any question.
	 */
	private roundContext(state: PlanningWorkerState, authority: string): string {
		const missionId = state.binding.missionId;
		const plan = this.deps.store.plans.get(missionId);
		return hash({
			authority,
			plan: plan
				? { ...plan, revision: 0, questions: plan.questions.map(({ claimedBy: _claim, ...q }) => q) }
				: null,
			...(this.deps.store.interviews.latest(missionId)?.kind === "revisit"
				? { briefRevision: this.deps.store.brief(missionId)?.revision }
				: {}),
		});
	}
	private input(state: PlanningWorkerState, op: DurableOperation): PlanningInput {
		const submitted = this.deps.store.interviews.latest(state.binding.missionId)?.submission;
		return {
			binding: state.binding,
			operation: op,
			hold:
				op.kind === "interview-continue"
					? state.hold
					: op.kind === "plan-continue" && state.feedback?.operationId === op.operationId
						? state.feedback.hold
						: null,
			content:
				op.kind === "thread-send"
					? this.discussionContent(op)
					: op.kind === "plan-revisit"
						? "The user explicitly requested a planning-only Revisit. Read mission_plan for current agreement, active decisions, tasks and settled answers. Use the trusted upstream skills. Keep settled answers; ask only genuinely new gaps in one saved kind=revisit round. Save an inert revision with action revision when ready. Never publish a creation plan, change agreement, approve or start execution."
						: op.kind === "plan-continue" && JSON.parse(op.payload).feedback !== undefined
							? `The user sent feedback on the current interview instead of answering it. Redo the round with it: reword, split, merge, drop or add questions as asked, and save the whole list again with the action you used for this round. Keep a question's id when its meaning stays, so its saved answer stays. The feedback answers no question and approves nothing. Planning only: no build work or worker starts.\nFeedback: ${JSON.stringify(JSON.parse(op.payload).feedback)}`
							: op.kind === "plan-continue" && JSON.parse(op.payload).note !== undefined
								? `Pilot's repair agent looked at why planning stopped, and the user approved this note. Act on it, then continue planning: read mission_plan, and judge only by Pilot's answers. The note answers no question and approves nothing. Planning only: no build work or worker starts.\nNote: ${JSON.stringify(JSON.parse(op.payload).note)}`
								: op.kind === "plan-continue"
									? `The user asked you to continue planning. Read mission_plan for the current map and answers. Link human answers that settle map questions and save a new round only for real new human questions. Pilot starts read-only research chats for ready research questions and sends you their findings. ${this.refusalHint(state.binding.missionId)} Planning only: no build work or worker starts.`
									: op.kind === "plan-research-result"
										? this.researchContent(state, op)
										: op.kind === "interview-continue"
											? `Continue planning from this exact submitted interview. Answers are not build permission. Use the trusted native planning skills and records only.\n${canonicalJSON(submitted)}`
											: `Plan this requested outcome using the trusted upstream skills. Read mission_plan, then publish the complete first saved round with action questions. Do not ask inside ask_user or start implementation.\n${state.goal}`,
		};
	}
	/** For Continue planning: the last refused save's reason, so the planner changes it instead of resending it. */
	private refusalHint(missionId: string): string {
		const refusal = this.deps.store.plans.refusal(missionId);
		if (!refusal)
			return "A save Pilot refused before may be accepted now: try it again, and judge only by Pilot's answer, not by source code you read.";
		return `Pilot refused your last ${refusal.kind} save: ${JSON.stringify(refusal.reason)}. Change the save so it fits that reason (for example merge or drop open questions); never resend it unchanged, and never drop settled questions. Judge only by Pilot's answer.`;
	}
	/** The saved findings of every research chat in one batch, as one planning input. */
	private researchContent(state: PlanningWorkerState, op: DurableOperation): string {
		const batch = Object.entries(state.research ?? {}).filter(([, r]) => r.operation?.operationId === op.operationId);
		if (!batch.length || batch.some(([, r]) => !r.report)) throw new Error("Saved research findings required");
		const questions = this.deps.store.plans.get(state.binding.missionId)?.questions ?? [];
		return [
			"Research chats finished for these map questions. They ran read-only.",
			"Pilot saved each chat's final answer word for word as project Knowledge, linked to this mission. Read an entry with the knowledge tool when you need its detail; do not copy findings into new entries. For each: cite that Knowledge as the question source with plan-map, then resolve the question with kind knowledge.",
			"Where a full report is included below instead, Pilot could not save it: record it as Knowledge yourself (create, then link to this mission), keeping its text as written.",
			"If a question proved too broad for one chat, split it with plan-map into narrower research questions (one area each, keeping dependent questions linked) instead of retrying it. If the scope was right but findings are thin, say what is missing and unclaim it with plan-claim claimedBy null; Pilot then starts one more research chat for it. Planning only: no build work.",
			...batch.map(([id, r]) => {
				const q = questions.find((x) => x.id === id);
				const head = `# Map question "${id}"${q ? ` (${q.title})` : ""}, research chat ${r.sessionId}`;
				return r.knowledge
					? `${head}\n\nSaved as Knowledge ${r.knowledge.id}, revision ${r.knowledge.revision}. Synopsis: ${r.knowledge.synopsis}`
					: `${head}\n\n${r.report}`;
			}),
		].join("\n\n");
	}

	private discussionContent(op: DurableOperation): string {
		// Reconstruct from the immutable intent, never today's topic revision or a copied transcript.
		const topic = this.deps.store.threads.lookup(op);
		if (!topic) throw new Error("Exact saved topic intent required");
		const context = { id: topic.id, title: topic.title, references: topic.references, inputs: topic.inputs };
		return `Discuss this one mission topic using lightweight clarification. The quoted user text is discussion, not execution, Start, agreement acceptance or approval. Read current mission records; use Wayfinder only if needed. Do not change the agreement or start work. Topic references (not a separate transcript): ${canonicalJSON(context)}\nOriginal input ${op.operationId}: ${JSON.stringify(JSON.parse(op.payload).text)}`;
	}
	private revisitPin(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (
			state?.phase !== "active" ||
			state.hold ||
			state.pendingHold ||
			this.admissions.has(missionId) ||
			this.turnAdmissions.has(missionId)
		)
			throw new Conflict("Revisit needs an active, unheld planner");
		const authority = this.authority(state.binding);
		const identity = this.deps.sessions.planningIdentity(state.binding.ownerSessionId) as { inputGeneration: number };
		const owner = this.deps.sessions.get(state.binding.ownerSessionId);
		if (
			identity.inputGeneration !== 0 ||
			owner?.working ||
			(owner?.state !== "idle" && owner?.state !== "parked") ||
			!this.deps.store.plans.get(missionId)?.publication
		)
			throw new Conflict("Published, unstopped planning owner required");
		return { authority, source: this.deps.store.revisions.source(missionId), revision: state.revision };
	}
	revisitView(missionId: string) {
		try {
			const pin = this.revisitPin(missionId);
			return { available: true, source: pin.source, contextDigest: hash(pin), reason: "" };
		} catch (e) {
			return { available: false, reason: e instanceof Error ? e.message : "Revisit unavailable" };
		}
	}
	/**
	 * An idle, unheld, unpublished planner the user may ask to continue. Published plans use Revisit.
	 * With `feedback`, a round waiting for answers also qualifies: the user's comment on it releases it.
	 */
	private continuePin(missionId: string, feedback = false) {
		const state = this.deps.store.planningWorkers.get(missionId);
		// Submitted answers Pilot never passed on (a restart, or a round check that failed): Continue sends them.
		const stalled = !feedback && !!state && this.stalledRound(state);
		const waiting =
			feedback && state?.phase === "held" && !!state.hold && (!state.continuation || state.continuation.entered);
		if (
			!state ||
			(!waiting && !stalled && (state.phase !== "active" || state.hold)) ||
			state.pendingHold ||
			this.admissions.has(missionId) ||
			this.turnAdmissions.has(missionId)
		)
			throw new Conflict("Pilot is not ready to continue planning");
		const authority = this.authority(state.binding);
		const identity = this.deps.sessions.planningIdentity(state.binding.ownerSessionId) as { inputGeneration: number };
		const owner = this.deps.sessions.get(state.binding.ownerSessionId);
		if (identity.inputGeneration !== 0 || owner?.working || (owner?.state !== "idle" && owner?.state !== "parked"))
			throw new Conflict("Pilot is still planning or was stopped");
		if (this.deps.store.plans.get(missionId)?.publication) throw new Conflict("A published plan uses Revisit");
		return {
			authority,
			revision: state.revision,
			...(waiting ? { round: state.hold!.operationId } : {}),
			...(stalled ? { resumeRound: state.hold!.operationId } : {}),
		};
	}
	/**
	 * A round the user submitted whose answers never reached the planner: the continuation was saved
	 * but never entered, and nothing is sending it now. Sending it is safe: its operation never ran.
	 */
	private stalledRound(state: PlanningWorkerState): boolean {
		const c = state.continuation;
		const submission = this.deps.store.interviews.latest(state.binding.missionId)?.submission;
		return (
			state.phase === "held" &&
			!!state.hold &&
			!!c &&
			!c.entered &&
			!!submission &&
			JSON.parse(c.operation.payload).submissionOperationId === submission.operationId &&
			!this.continuing.has(state.binding.missionId)
		);
	}
	continueView(missionId: string) {
		try {
			return { available: true, contextDigest: hash(this.continuePin(missionId)), reason: "" };
		} catch (e) {
			try {
				// A round waiting for answers takes only a comment on it, not a plain Continue.
				const contextDigest = hash(this.continuePin(missionId, true));
				return { available: true, feedbackOnly: true, contextDigest, reason: "" };
			} catch {
				return { available: false, reason: e instanceof Error ? e.message : "Continue planning unavailable" };
			}
		}
	}
	/** Only authenticated native user ingress enters. Recovery never re-admits a turn. */
	resume(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (this.closing.signal.aborted) return Promise.reject(new Error("Planning host is closing"));
		const work = this.continueEntered(op, firstEntry);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private async continueEntered(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return this.recover(op);
		let pin: ReturnType<PlanningWorkers["continuePin"]>;
		let feedback = false;
		try {
			const payload = JSON.parse(op.payload);
			feedback = payload && typeof payload === "object" && Object.hasOwn(payload, "feedback");
			// A note (from Unstick's repair agent, approved by the user) continues planning; feedback redoes a round.
			const note = payload && typeof payload === "object" && Object.hasOwn(payload, "note");
			interviewExact(payload, feedback ? ["purpose", "feedback"] : note ? ["purpose", "note"] : ["purpose"]);
			if (feedback) interviewText(payload.feedback, 8000);
			if (note) interviewText(payload.note, 2000);
			pin = this.continuePin(op.targetId, feedback);
			if (
				op.kind !== "plan-continue" ||
				JSON.parse(op.payload).purpose !== op.kind ||
				op.bindingId !== hash(pin) ||
				op.bindingGeneration !== 1 ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Exact user Continue planning required");
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		await this.deps.journal.checkpoint(op, { stage: "continue-entered", payloadHash: op.payloadHash });
		if (hash(this.continuePin(op.targetId, feedback)) !== hash(pin)) throw new Conflict("Planning changed");
		let state = this.deps.store.planningWorkers.get(op.targetId)!;
		if (pin.resumeRound) {
			// The user asked again: the submitted round goes on against the map as it is now. The saved
			// hold stays exactly as the planning agent holds it; only the map check is skipped.
			trace(`pilotd: planning ${op.targetId} submitted round resumed by the user (${op.operationId})`);
			try {
				await this.continue(state, true);
			} catch (e) {
				// Not entered: nothing reached the planner, so this is a plain refusal.
				if (!this.deps.store.planningWorkers.get(op.targetId)?.continuation?.entered)
					throw new OperationRejected(String(e));
				throw e;
			}
			// Same receipt shape as every Continue: Day settles a Continue by its admission ID.
			return { admissionId: op.operationId, resumedRound: pin.resumeRound };
		}
		this.deps.store.planningWorkers.retain(op.targetId, `$continue:${op.operationId}`, op);
		if (pin.round) {
			// The comment releases the waiting round: the planner redoes it, as a submission would continue it.
			state = this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
				s.feedback = { operationId: op.operationId, hold: s.hold! };
				s.phase = "continuing";
			});
		}
		let release!: () => void;
		const turn = new Promise<void>((r) => {
			release = r;
		});
		this.turnAdmissions.set(op.targetId, turn);
		const guard = () => {
			if (
				this.closing.signal.aborted ||
				this.authority(state.binding) !== pin.authority ||
				this.scope(state.binding).revision !== state.revision
			)
				throw new Conflict("Continue planning admission changed");
		};
		try {
			await this.deps.store.durable();
			guard();
			let result: unknown;
			try {
				result = await this.admitInput(state, op, guard);
			} catch (e) {
				if (pin.round) await this.feedbackSettled(op, "held");
				throw e;
			}
			if (pin.round) await this.feedbackSettled(op, "active");
			return result;
		} finally {
			this.turnAdmissions.delete(op.targetId);
			release();
		}
	}
	/**
	 * Ends a comment's release of its waiting round: `active` once the planner took the comment,
	 * `held` again when it was refused, so the round still waits for answers.
	 */
	private async feedbackSettled(op: DurableOperation, phase: "active" | "held"): Promise<void> {
		const now = this.deps.store.planningWorkers.get(op.targetId);
		if (now?.phase !== "continuing" || now.feedback?.operationId !== op.operationId) return;
		this.deps.store.planningWorkers.change(op.targetId, now.revision, (s) => {
			s.phase = phase;
			if (phase === "active") s.hold = null;
		});
		await this.deps.store.durable();
	}
	/**
	 * Why this mission's planning moves, waits or is stuck, from saved state only, with at most
	 * one fix the user can apply. "waiting" is normal (it waits for the user or for a chat);
	 * "stuck" means nothing will move without help. Reading this changes nothing.
	 */
	unstickView(missionId: string): {
		state: "moving" | "waiting" | "stuck";
		line: string;
		fix: "continue" | "drop-earlier-answers" | null;
		checks: string[];
	} {
		const checks: string[] = [];
		const result = (
			state: "moving" | "waiting" | "stuck",
			line: string,
			fix: "continue" | "drop-earlier-answers" | null = null,
		) => ({ state, line, fix, checks });
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state) return result("waiting", "This mission has no planning agent.");
		try {
			this.authority(state.binding);
		} catch {
			checks.push("Mission: paused, stopped or moved");
			return result("waiting", "Planning is paused or stopped. Resume the mission first.");
		}
		const owner = this.deps.sessions.get(state.binding.ownerSessionId);
		const idle = !!owner && !owner.working && (owner.state === "idle" || owner.state === "parked");
		checks.push(
			`Planning agent: ${owner ? (idle ? `idle${owner.outcome ? `, last turn ${owner.outcome}` : ""}` : owner.state) : "gone"}`,
		);
		checks.push(`Planning step: ${state.phase}`);
		const research = Object.values(state.research ?? {});
		const asks = Object.values(state.asks ?? {});
		const chats =
			research.filter((r) => r.state === "starting" || r.state === "running").length +
			asks.filter((a) => a.state === "starting" || a.state === "running").length;
		const findings = research.filter((r) => r.state === "reporting").length;
		checks.push(`Chats working for it: ${chats}`);
		if (findings) checks.push(`Research findings not yet read: ${findings}`);
		if (!owner) return result("stuck", "Pilot's planning agent is gone. Report it with Feedback.");
		if (!idle || this.admissions.has(missionId) || this.turnAdmissions.has(missionId))
			return result("moving", "Pilot's planning agent is working.");
		const interview = this.deps.store.interviews.latest(missionId);
		const open = !!interview?.questions.length && !interview.submission;
		if (interview?.questions.length) {
			const stale = interview.answers.filter((a) => {
				const q = interview.questions.find((x) => x.id === a.questionId);
				return !q || a.questionDigest !== interviewDigest(q);
			}).length;
			checks.push(
				`Questions: ${interview.questions.length}, saved answers: ${interview.answers.length}${stale ? `, ${stale} to an earlier wording` : ""}${open ? "" : ", submitted"}`,
			);
			if (open && stale)
				return result(
					"stuck",
					"Some saved answers belong to an earlier wording of their question, so new answers cannot be saved.",
					"drop-earlier-answers",
				);
		}
		if (state.phase === "held" && open) return result("waiting", "Pilot waits for your answers to this round.");
		if (this.stalledRound(state)) {
			checks.push("Submitted answers sent to the planning agent: no");
			return result(
				"stuck",
				"Your answers were submitted, but Pilot did not pass them to its planning agent.",
				this.continueView(missionId).available ? "continue" : null,
			);
		}
		if (state.phase === "held") return result("waiting", "Pilot waits for you.");
		if (state.phase !== "active")
			return result("stuck", "Pilot's planning stopped partway, and its agent is idle. Report it with Feedback.");
		if (this.deps.store.plans.get(missionId)?.publication)
			return result("waiting", "The plan is published. Use Revisit to change it.");
		if (chats) return result("moving", "A chat is working for this mission.");
		const canContinue = this.continueView(missionId).available;
		const refusal = this.deps.store.plans.refusal(missionId);
		if (refusal) {
			checks.push(`Last save refused: ${refusal.kind}`);
			return result(
				"stuck",
				`Pilot refused the planning agent's last save, and it stopped: ${refusal.reason}`,
				canContinue ? "continue" : null,
			);
		}
		if (findings)
			return result(
				"stuck",
				"Research findings wait, but Pilot has not read them.",
				canContinue ? "continue" : null,
			);
		if (owner.outcome === "failed" || owner.outcome === "stopped")
			return result(
				"stuck",
				`Pilot's planning agent ${owner.outcome === "failed" ? "failed" : "was stopped"} and the plan is still open.`,
				canContinue ? "continue" : null,
			);
		return result(
			"stuck",
			"Pilot's planning agent stopped while the plan is still open.",
			canContinue ? "continue" : null,
		);
	}

	/** The user's questions about interview questions, oldest first, with their answers. */
	askView(missionId: string) {
		return Object.entries(this.deps.store.planningWorkers.get(missionId)?.asks ?? {})
			.sort(([, a], [, b]) => a.askedAt - b.askedAt)
			.map(([id, a]) => ({
				id,
				questionId: a.questionId,
				text: a.text,
				state: a.state === "answered" || a.state === "failed" ? a.state : "asking",
				answer: a.answer ?? "",
				reason: a.reason ?? "",
			}));
	}
	/**
	 * Records one user question about a question of the current interview. A read-only chat answers it
	 * (see reconcileAsks). It answers nothing for the user, and never wakes the planner or releases a round.
	 */
	async ask(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) {
			if (!this.deps.store.planningWorkers.get(op.targetId)?.asks?.[op.operationId])
				throw new Error("Unknown question ask; lookup only");
			return { askId: op.operationId };
		}
		let request: { purpose: string; questionId: string; text: string };
		let state: PlanningWorkerState;
		try {
			request = JSON.parse(op.payload);
			interviewExact(request, ["purpose", "questionId", "text"]);
			interviewId(request.questionId);
			interviewText(request.text, 2000);
			const found = this.deps.store.planningWorkers.get(op.targetId);
			if (!found || found.phase === "setup") throw new Conflict("Planning is not ready");
			state = found;
			this.authority(state.binding);
			const q = this.deps.store.interviews.latest(op.targetId)?.questions.find((x) => x.id === request.questionId);
			if (
				op.kind !== "plan-question-ask" ||
				request.purpose !== op.kind ||
				!q ||
				op.bindingId !== interviewDigest(q) ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("This question changed. Read it again.");
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
			s.asks ??= {};
			s.asks[op.operationId] = {
				questionId: request.questionId,
				text: request.text,
				state: "starting",
				sessionId: null,
				askedAt: Date.now(),
			};
			// Keep the newest questions; drop the oldest finished ones first.
			const done = Object.entries(s.asks)
				.filter(([, a]) => a.state === "answered" || a.state === "failed")
				.sort(([, a], [, b]) => a.askedAt - b.askedAt);
			while (Object.keys(s.asks).length > ASKS_KEPT && done.length) delete s.asks[done.shift()![0]];
		});
		await this.deps.store.durable();
		this.scheduleResearch(op.targetId);
		return { askId: op.operationId };
	}
	/** What Unstick's repair agent starts from: the planning state it looks at. */
	private repairPin(missionId: string) {
		return {
			missionId,
			phase: this.deps.store.planningWorkers.get(missionId)?.phase ?? null,
			planRevision: this.deps.store.plans.get(missionId)?.revision ?? 0,
			interviewRevision: this.deps.store.interviews.latest(missionId)?.revision ?? 0,
		};
	}
	/** Unstick's repair agent, for the planning read. Reading changes nothing. */
	repairView(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		const repair = state?.repair;
		const basis = hash(this.repairPin(missionId));
		const busy = repair?.state === "starting" || repair?.state === "looking";
		return {
			available: !!state && !busy && this.unstickView(missionId).state === "stuck",
			contextDigest: basis,
			state: repair?.state ?? null,
			chatId: repair?.sessionId ?? null,
			proposal: repair?.proposal ?? null,
			reason: repair?.reason ?? null,
			/** Whether the proposal still matches the planning state. Apply refuses when it does not. */
			current: !!repair && repair.basis === basis,
		};
	}
	/** The user asks a read-only Diagnostics chat why planning is stuck. It proposes; it never acts. */
	async repairStart(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) {
			if (this.deps.store.planningWorkers.get(op.targetId)?.repair?.operationId !== op.operationId)
				throw new Error("Unknown repair start; lookup only");
			return { repairId: op.operationId };
		}
		let state: PlanningWorkerState;
		let basis: string;
		try {
			const request = JSON.parse(op.payload);
			interviewExact(request, ["purpose"]);
			const found = this.deps.store.planningWorkers.get(op.targetId);
			if (!found || found.phase === "setup") throw new Conflict("Planning is not ready");
			state = found;
			this.authority(state.binding);
			const view = this.repairView(op.targetId);
			basis = view.contextDigest;
			if (
				op.kind !== "plan-repair-start" ||
				request.purpose !== op.kind ||
				!view.available ||
				op.bindingId !== basis ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Planning changed, or an agent already looks. Read the mission again.");
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
			s.repair = { operationId: op.operationId, state: "starting", sessionId: null, basis, startedAt: Date.now() };
		});
		trace(`pilotd: planning ${op.targetId} repair agent requested (${op.operationId})`);
		await this.deps.store.durable();
		this.scheduleResearch(op.targetId);
		return { repairId: op.operationId };
	}
	/** Starts the repair chat, then collects its proposal once it finishes. */
	private async reconcileRepair(missionId: string): Promise<void> {
		const state = this.deps.store.planningWorkers.get(missionId);
		const repair = state?.repair;
		if (!state || !repair) return;
		const set = (change: Partial<PlanningRepair>) => {
			if (change.state)
				trace(
					`pilotd: planning ${missionId} repair agent -> ${change.state}${change.reason ? `: ${change.reason}` : change.proposal ? `: ${change.proposal.fix}, ${change.proposal.certainty}` : ""}`,
				);
			const now = this.deps.store.planningWorkers.get(missionId)!;
			this.deps.store.planningWorkers.change(missionId, now.revision, (s) => {
				if (s.repair?.operationId === repair.operationId) s.repair = { ...s.repair, ...change };
			});
		};
		if (repair.state === "looking" && repair.sessionId) {
			const chat = this.deps.sessions.get(repair.sessionId);
			if (!chat || chat.archivedAt) set({ state: "failed", reason: "The repair chat is gone. Ask again." });
			else if (!chat.working && (chat.state === "idle" || chat.state === "parked") && chat.outcome) {
				const reply =
					chat.outcome === "done"
						? ((await this.deps.sessions.lastAssistantReply(repair.sessionId, REPAIR_REPLY_LIMIT)) ?? "")
						: "";
				const proposal = parseMissionFix(reply);
				set(
					proposal
						? { state: "proposed", proposal }
						: { state: "failed", reason: "The agent gave no fix Pilot can use. Open its chat, or ask again." },
				);
			} else return;
			await this.deps.store.durable();
			return;
		}
		if (repair.state !== "starting") return;
		try {
			const target = this.deps.sessions.diagnosticTargetFor(state.binding.ownerSessionId);
			if (!target) throw new Error("Diagnostics are not available on this host");
			const project = this.deps.projects.require(state.binding.projectId);
			const selection = await this.deps.sessions.selectTaskModel(project.path);
			const mission = this.deps.store.require(missionId);
			const chat = await this.deps.sessions.spawn({
				projectId: state.binding.projectId,
				role: "diagnostics",
				mode: "ask",
				diagnosticTarget: target,
				diagnosticHistoryAccess: true,
				title: `Unstick: ${mission.title}`.slice(0, 200),
				message: repairMessage(mission.title, missionId),
				...selection,
			});
			this.repairChats.set(chat.id, missionId);
			set({ state: "looking", sessionId: chat.id });
		} catch (error) {
			set({ state: "failed", reason: "Pilot could not start the repair agent. Ask again later." });
			console.warn(`pilotd: repair agent for ${missionId} not started: ${error}`);
		}
		await this.deps.store.durable();
	}

	/** Collects finished answers and starts chats for new questions, at most ASK_CHATS at once. */
	private async reconcileAsks(missionId: string): Promise<void> {
		let state = this.deps.store.planningWorkers.get(missionId);
		if (!state?.asks) return;
		const set = (id: string, change: Partial<QuestionAsk>) => {
			if (change.state)
				trace(
					`pilotd: planning ${missionId} question ask ${id} -> ${change.state}${change.reason ? `: ${change.reason}` : ""}`,
				);
			const now = this.deps.store.planningWorkers.get(missionId)!;
			state = this.deps.store.planningWorkers.change(missionId, now.revision, (s) => {
				if (s.asks?.[id]) s.asks[id] = { ...s.asks[id]!, ...change };
			});
		};
		for (const [id, ask] of Object.entries(state.asks)) {
			if (ask.state !== "running" || !ask.sessionId) continue;
			const chat = this.deps.sessions.get(ask.sessionId);
			if (!chat || chat.archivedAt) {
				set(id, { state: "failed", reason: "The chat answering this is gone. Ask again." });
				continue;
			}
			if (chat.working || (chat.state !== "idle" && chat.state !== "parked") || !chat.outcome) continue;
			const answer =
				chat.outcome === "done"
					? ((await this.deps.sessions.lastAssistantReply(ask.sessionId, ASK_ANSWER_LIMIT)) ?? "").trim()
					: "";
			set(
				id,
				answer
					? { state: "answered", answer }
					: { state: "failed", reason: "Pilot could not answer this. Ask again." },
			);
			await this.deps.store.durable();
		}
		let active = Object.values(state.asks ?? {}).filter((a) => a.state === "running").length;
		const waiting = Object.entries(state.asks ?? {})
			.filter(([, a]) => a.state === "starting")
			.sort(([, a], [, b]) => a.askedAt - b.askedAt);
		for (const [id, ask] of waiting) {
			if (active >= ASK_CHATS) return;
			const q = this.deps.store.interviews.latest(missionId)?.questions.find((x) => x.id === ask.questionId);
			if (!q) {
				set(id, { state: "failed", reason: "This question is no longer asked." });
				await this.deps.store.durable();
				continue;
			}
			const earlier = Object.values(state.asks ?? {}).filter(
				(a) => a.questionId === ask.questionId && a.state === "answered",
			);
			try {
				const binding = state.binding;
				const project = this.deps.projects.require(binding.projectId);
				const selection = await this.deps.sessions.selectTaskModel(project.path);
				this.authority(binding);
				const mission = this.deps.store.require(missionId);
				const chat = await this.deps.sessions.spawn(
					{
						projectId: binding.projectId,
						missionId,
						mode: "ask",
						title: `Question: ${ask.text}`.slice(0, 200),
						message: askMessage(mission.title, q, earlier, ask.text),
						...selection,
					},
					false,
					undefined,
					{ role: "explorer", actorSessionId: binding.ownerSessionId, mainView: true },
				);
				set(id, { state: "running", sessionId: chat.id });
				active++;
			} catch (error) {
				set(id, { state: "failed", reason: "Pilot could not start a chat to answer this. Ask again later." });
				console.warn(`pilotd: question chat for ${ask.questionId} not started: ${error}`);
			}
			await this.deps.store.durable();
		}
	}

	/** Same qualified unheld planning boundary as Revisit, with a distinct discussion purpose. */
	discuss(op: DurableOperation, guard: () => void): Promise<unknown> {
		const work = this.planningTurnEntered(op, true, guard);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	/** Only authenticated native user ingress enters. Recovery never re-admits a turn. */
	revisit(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (this.closing.signal.aborted) return Promise.reject(new Error("Planning host is closing"));
		const work = this.planningTurnEntered(op, firstEntry);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private async planningTurnEntered(
		op: DurableOperation,
		firstEntry: boolean,
		discussionGuard?: () => void,
	): Promise<unknown> {
		if (!firstEntry) return this.recover(op);
		const discussion = op.kind === "thread-send" && !!discussionGuard;
		let pin: ReturnType<PlanningWorkers["revisitPin"]>;
		try {
			const request = JSON.parse(op.payload);
			interviewExact(request, discussion ? ["purpose", "source", "topicId", "text"] : ["purpose", "source"]);
			discussionGuard?.();
			pin = this.revisitPin(op.targetId);
			if (
				(!discussion && op.kind !== "plan-revisit") ||
				request.purpose !== op.kind ||
				(!discussion && (request.source !== pin.source || op.bindingId !== hash(pin))) ||
				op.bindingGeneration !== 1 ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Exact user Revisit preview required");
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		await this.deps.journal.checkpoint(op, {
			stage: discussion ? "discussion-entered" : "revisit-entered",
			payloadHash: op.payloadHash,
		});
		discussionGuard?.();
		if (hash(this.revisitPin(op.targetId)) !== hash(pin)) throw new Conflict("Revisit context changed");
		const prior = this.deps.store.planningWorkers.get(op.targetId)!;
		this.deps.store.planningWorkers.retain(
			op.targetId,
			`$${discussion ? "discussion" : "revisit"}:${op.operationId}`,
			op,
		);
		const state = this.deps.store.planningWorkers.change(op.targetId, prior.revision, (s) => {
			if (discussion) s.discussion = { operation: op, admitted: false };
			else s.revisit = { operation: op, admitted: false };
			s.phase = discussion ? "discussing" : "revisiting";
		});
		let release!: () => void;
		const turn = new Promise<void>((r) => {
			release = r;
		});
		this.turnAdmissions.set(op.targetId, turn);
		const guard = () => {
			discussionGuard?.();
			if (
				this.closing.signal.aborted ||
				this.authority(state.binding) !== pin.authority ||
				this.deps.store.revisions.source(op.targetId) !== pin.source ||
				this.scope(state.binding).revision !== state.revision
			)
				throw new Conflict("Revisit admission changed");
		};
		try {
			await this.deps.store.durable();
			guard();
			const receipt = await this.admitInput(state, op, guard);
			guard();
			this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
				if (discussion) s.discussion!.admitted = true;
				else s.revisit!.admitted = true;
				s.phase = "active";
			});
			await this.deps.store.durable();
			return receipt;
		} finally {
			this.turnAdmissions.delete(op.targetId);
			release();
		}
	}
	private async admitInput(state: PlanningWorkerState, op: DurableOperation, guard: () => void) {
		const admission = Promise.resolve().then(() => this.deps.sessions.admitPlanning(this.input(state, op), guard));
		this.admissions.set(state.binding.missionId, admission);
		try {
			const receipt = await admission;
			trace(`pilotd: planning ${state.binding.missionId} planner input ${op.kind} admitted (${op.operationId})`);
			return receipt;
		} catch (error) {
			console.warn(`pilotd: planning ${state.binding.missionId} planner input ${op.kind} refused: ${error}`);
			throw error;
		} finally {
			if (this.admissions.get(state.binding.missionId) === admission)
				this.admissions.delete(state.binding.missionId);
		}
	}
	/** Called only by authenticated native ingress, with an exact retained envelope. */
	async enroll(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return this.recover(op);
		let request: PlanningEnrollment;
		try {
			request = JSON.parse(op.payload);
			const keys = [
				"purpose",
				"projectId",
				"ownerSessionId",
				"title",
				"goal",
				"model",
				"profile",
				"configurationDigest",
			];
			if (request && typeof request === "object" && Object.hasOwn(request, "replaces")) keys.push("replaces");
			interviewExact(request, keys);
			interviewId(op.targetId);
			interviewId(request.projectId);
			interviewId(request.ownerSessionId);
			if (request.replaces !== undefined) interviewId(request.replaces);
			interviewText(request.title, 200);
			interviewText(request.goal, 12000);
			interviewText(request.model, 256);
			if (
				request.purpose !== "planning-enroll" ||
				op.kind !== request.purpose ||
				canonicalJSON(request.profile) !== canonicalJSON(PLANNING_PROFILE) ||
				op.bindingGeneration !== 1 ||
				op.bindingId !== request.configurationDigest ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Trusted planning enrollment required");
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : "Invalid planning enrollment");
		}
		const check = () => {
			if (
				this.closing.signal.aborted ||
				this.configuration(request.projectId) !== request.configurationDigest ||
				this.deps.sessions.get(request.ownerSessionId) ||
				this.deps.store.membership(request.ownerSessionId)
			)
				throw new Conflict("Fresh planning enrollment changed");
			if (request.replaces !== undefined) this.deps.store.assertReplaceable(request.replaces, request.projectId);
		};
		try {
			check();
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : String(e));
		}
		await this.deps.journal.checkpoint(op, { stage: "planning-enrollment-entered", payloadHash: op.payloadHash });
		check();
		const state = this.deps.store.planningWorkers.create(() => {
			check();
			const interview = this.deps.store.interviews.enroll(
				op,
				{ projectId: request.projectId, title: request.title },
				request.ownerSessionId,
			);
			if (request.replaces !== undefined)
				this.deps.store.linkSuccessor(
					request.replaces,
					interview.fence.missionId,
					request.projectId,
					op.operationId,
				);
			return {
				version: 1,
				binding: {
					version: 1,
					profile: PLANNING_PROFILE,
					home: resolve(this.deps.home),
					host: this.deps.journal.destination,
					projectId: request.projectId,
					ownerSessionId: request.ownerSessionId,
					missionId: interview.fence.missionId,
					enrollmentId: op.targetId,
					creationOperationId: op.operationId,
				},
				creation: op,
				goal: request.goal,
				configurationDigest: request.configurationDigest,
				revision: 1,
				phase: "setup",
				hold: null,
				pendingHold: null,
				continuation: null,
			};
		});
		await this.deps.store.durable();
		const setupGuard = () => {
			if (
				this.closing.signal.aborted ||
				this.configuration(request.projectId) !== request.configurationDigest ||
				this.deps.store.planningWorkers.get(state.binding.missionId)?.revision !== state.revision ||
				canonicalJSON(this.deps.store.interviews.latest(state.binding.missionId)?.ownerFence) !==
					canonicalJSON(this.deps.store.interviewOwnerFence(state.binding.missionId, request.ownerSessionId))
			)
				throw new Conflict("Planning setup changed");
		};
		await this.deps.sessions.createPlanningWorker(state.binding, request.title, request.model, setupGuard);
		setupGuard();
		const active = this.deps.store.planningWorkers.change(state.binding.missionId, state.revision, (s) => {
			s.phase = "active";
		});
		const payload = canonicalJSON({ purpose: "planning-generate", enrollmentOperationId: op.operationId });
		const initial: DurableOperation = {
			...op,
			operationId: `generate-${op.operationId}`,
			targetId: state.binding.missionId,
			origin: state.binding.host,
			kind: "planning-generate",
			payload,
			payloadHash: payloadHash(payload),
		};
		this.deps.store.planningWorkers.retain(state.binding.missionId, "$initial", initial);
		await this.deps.store.durable();
		const authority = this.authority(active.binding);
		await this.admitInput(active, initial, () => {
			if (this.authority(active.binding) !== authority || this.scope(active.binding).revision !== active.revision)
				throw new Conflict("Planning admission changed");
		});
		if (this.authority(active.binding) !== authority)
			throw new Error("Unknown changed planning enrollment; lookup only");
		return {
			missionId: active.binding.missionId,
			ownerSessionId: active.binding.ownerSessionId,
			enrollmentId: active.binding.enrollmentId,
		};
	}
	/**
	 * Starts read-only research chats for ready research questions (decision D28) and sends their
	 * findings to the planner. Existing limits still apply: worker slots, Pause, Stop and dispatch holds.
	 */
	startResearch(): void {
		if (this.research || this.closing.signal.aborted) return;
		const research = {
			dirty: new Set<string>(),
			retryAt: new Map<string, number>(),
			off: () => {},
		};
		this.research = research;
		const offStore = this.deps.store.onChange((missionId) => {
			if (this.deps.store.planningWorkers.get(missionId)) this.scheduleResearch(missionId);
		});
		const offSessions = this.deps.sessions.onChange((session) => {
			const missionId = this.deps.store.missionOf(session.id) ?? this.repairChats.get(session.id);
			if (missionId && this.deps.store.planningWorkers.get(missionId)) this.scheduleResearch(missionId);
		});
		research.off = () => {
			offStore();
			offSessions();
		};
		for (const id of this.deps.store.planningWorkers.missionIds()) {
			const repair = this.deps.store.planningWorkers.get(id)?.repair;
			if (repair?.sessionId) this.repairChats.set(repair.sessionId, id);
			this.scheduleResearch(id);
		}
	}
	/** Waits for scheduled research reconciliation (tests and shutdown). */
	async settleResearch(): Promise<void> {
		while (this.research?.running) await this.research.running;
	}
	scheduleResearch(missionId: string): void {
		const research = this.research;
		if (!research || this.closing.signal.aborted) return;
		research.dirty.add(missionId);
		if (research.running) return;
		const running = Promise.resolve()
			.then(async () => {
				while (research.dirty.size && !this.closing.signal.aborted) {
					const ids = [...research.dirty];
					research.dirty.clear();
					for (const id of ids)
						await this.reconcileResearch(id).catch((error: unknown) =>
							console.warn(`pilotd: planning research for ${id} failed: ${error}`),
						);
				}
			})
			.finally(() => {
				research.running = undefined;
				this.tasks.delete(running);
			});
		research.running = running;
		this.tasks.add(running);
	}
	private async reconcileResearch(missionId: string): Promise<void> {
		let state = this.deps.store.planningWorkers.get(missionId);
		if (!state || state.phase === "setup") return;
		try {
			this.authority(state.binding);
		} catch {
			return; // Paused, stopped, changed owner or project: start and report nothing.
		}
		this.resumeStalled(missionId);
		await this.reconcileAsks(missionId);
		await this.reconcileRepair(missionId);
		state = this.deps.store.planningWorkers.get(missionId)!;
		const plan = this.deps.store.plans.get(missionId);
		if (!plan || plan.publication) return;
		const owner = this.deps.sessions.get(state.binding.ownerSessionId);
		const plannerBusy =
			!owner ||
			owner.working ||
			(owner.state !== "idle" && owner.state !== "parked") ||
			this.admissions.has(missionId) ||
			this.turnAdmissions.has(missionId);
		// Findings first: a finished chat frees its slot, and the planner records them.
		for (const [questionId, entry] of Object.entries(state.research ?? {})) {
			if (entry.state !== "running" || !entry.sessionId) continue;
			const chat = this.deps.sessions.get(entry.sessionId);
			if (!chat || chat.archivedAt) {
				state = this.changeResearch(state, questionId, { state: "failed", reason: "Research chat is gone" });
				continue;
			}
			if (chat.working || (chat.state !== "idle" && chat.state !== "parked") || !chat.outcome) continue;
			const report =
				chat.outcome === "done"
					? ((await this.deps.sessions.lastAssistantReply(entry.sessionId, RESEARCH_REPORT_LIMIT)) ?? "")
					: "";
			const found = report.trim();
			const knowledge = found
				? await this.saveFindings(state, questionId, entry.sessionId, found).catch((error: unknown) => {
						console.warn(`[pilotd] research findings for ${questionId} not saved as Knowledge: ${error}`);
						return undefined;
					})
				: undefined;
			state = this.changeResearch(this.deps.store.planningWorkers.get(missionId)!, questionId, {
				state: "reporting",
				report: found || `The research chat ended (${chat.outcome}) without findings.`,
				...(knowledge ? { knowledge } : {}),
			});
			await this.deps.store.durable();
		}
		// Findings go to the planner together, once each: when no research chat of this mission still runs, or
		// when a full batch waits. A batch is limited so many split questions never flood one planning turn.
		const entries = Object.entries(state.research ?? {});
		const running = entries.some(([, e]) => e.state === "starting" || e.state === "running");
		const waiting = entries.filter(([, e]) => e.state === "reporting");
		const pending = waiting.find(([, e]) => e.operation)?.[1].operation;
		const due = !!pending || waiting.length >= RESEARCH_BATCH || (waiting.length > 0 && !running);
		if (due && !plannerBusy && state.phase === "active") {
			let operation = pending;
			if (!operation) {
				const questionIds = waiting
					.slice(0, RESEARCH_BATCH)
					.map(([id]) => id)
					.sort();
				const payload = canonicalJSON({ purpose: "plan-research-result", questionIds });
				const saved: DurableOperation = {
					schemaVersion: 1,
					operationId: randomUUID(),
					producerId: state.binding.enrollmentId,
					sequence: state.revision,
					origin: state.binding.host,
					destination: state.binding.host,
					targetId: missionId,
					kind: "plan-research-result",
					payload,
					payloadHash: payloadHash(payload),
				};
				state = this.deps.store.planningWorkers.change(missionId, state.revision, (s) => {
					for (const id of questionIds) s.research![id]!.operation = saved;
				});
				await this.deps.store.durable();
				operation = saved;
			}
			const binding = state.binding;
			if (!(await this.deps.sessions.lookupPlanning(this.input(state, operation))))
				await this.admitInput(state, operation, () => {
					this.authority(binding);
				});
			const sent = operation.operationId;
			this.deps.store.planningWorkers.change(
				missionId,
				this.deps.store.planningWorkers.get(missionId)!.revision,
				(s) => {
					for (const entry of Object.values(s.research ?? {}))
						if (entry.operation?.operationId === sent) entry.state = "reported";
				},
			);
			await this.deps.store.durable();
			return; // One planning turn; the next change event continues.
		}
		if (plannerBusy || plan.review) return; // Never join members while the planner works or a review is open.
		if (Date.now() < (this.research?.retryAt.get(missionId) ?? 0)) return;
		let active = Object.values(state.research ?? {}).filter(
			(r) => r.state === "starting" || r.state === "running",
		).length;
		for (const q of planResearchFrontier(plan)) {
			if (active >= RESEARCH_CHATS) return;
			// A question unclaimed after weak findings gets one more research chat, never more.
			const prior = state.research?.[q.id];
			if (prior && !(["reported", "failed"].includes(prior.state) && (prior.attempts ?? 1) < RESEARCH_ATTEMPTS))
				continue;
			state = this.changeResearch(state, q.id, {
				questionDigest: planQuestionDigest(q),
				state: "starting",
				sessionId: null,
				attempts: (prior?.attempts ?? 1) + (prior ? 1 : 0),
				operation: undefined,
				report: undefined,
				reason: undefined,
			});
			await this.deps.store.durable();
			let sessionId: string;
			try {
				const project = this.deps.projects.require(state.binding.projectId);
				const selection = await this.deps.sessions.selectTaskModel(project.path);
				this.authority(state.binding);
				const mission = this.deps.store.require(missionId);
				const chat = await this.deps.sessions.spawn(
					{
						projectId: state.binding.projectId,
						missionId,
						mode: "ask",
						title: `Research: ${q.title}`.slice(0, 200),
						message: researchMessage(mission.title, q),
						...selection,
					},
					false,
					undefined,
					{ role: "explorer", actorSessionId: state.binding.ownerSessionId, mainView: true },
				);
				sessionId = chat.id;
			} catch (error) {
				// No slot, paused or held: forget this start and try again later, never in a tight loop.
				const current = this.deps.store.planningWorkers.get(missionId)!;
				this.deps.store.planningWorkers.change(missionId, current.revision, (s) => {
					delete s.research?.[q.id];
				});
				await this.deps.store.durable();
				this.research?.retryAt.set(missionId, Date.now() + RESEARCH_RETRY_MS);
				console.warn(`pilotd: research chat for ${q.id} not started: ${error}`);
				return;
			}
			state = this.changeResearch(this.deps.store.planningWorkers.get(missionId)!, q.id, {
				state: "running",
				sessionId,
			});
			active++;
			await this.deps.store.durable();
			await this.claimResearch(state, q.id, sessionId);
			state = this.deps.store.planningWorkers.get(missionId)!;
		}
	}
	/** Marks the question as worked on by its research chat, so nobody else researches it too. */
	private async claimResearch(state: PlanningWorkerState, questionId: string, sessionId: string): Promise<void> {
		const plan = this.deps.store.plans.get(state.binding.missionId);
		if (!plan) return;
		const authority = this.authority(state.binding);
		const request = { purpose: "plan-claim", expectedRevision: plan.revision, questionId, claimedBy: sessionId };
		const payload = canonicalJSON(request);
		const op: DurableOperation = {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: state.binding.enrollmentId,
			sequence: state.revision,
			origin: state.binding.host,
			destination: state.binding.host,
			targetId: state.binding.missionId,
			kind: "plan-claim",
			payload,
			payloadHash: payloadHash(payload),
			bindingId: authority,
			bindingGeneration: 1,
		};
		this.deps.store.planningWorkers.retain(state.binding.missionId, `$research-claim:${questionId}:${sessionId}`, op);
		await this.deps.store.durable();
		const { plans } = this.services(state.binding, () => {
			if (this.authority(state.binding) !== authority) throw new Conflict("Planning authority changed");
		});
		const receipt = await this.deps.journal.execute(op, (operation, entry) =>
			plans.admit(operation, entry.firstEntry),
		);
		if (receipt.state !== "accepted")
			console.warn(`pilotd: research claim for ${questionId} was ${receipt.state}: ${receipt.reason ?? ""}`);
	}
	/**
	 * Saves a finished research chat's final answer word for word as Knowledge, authored by that chat and
	 * linked to the mission at this revision. Exact retries replay by the chat's own operation ID.
	 */
	private async saveFindings(
		state: PlanningWorkerState,
		questionId: string,
		sessionId: string,
		report: string,
	): Promise<PlanningResearch["knowledge"]> {
		const knowledge = this.deps.knowledge;
		if (!knowledge) return undefined;
		const { missionId, projectId } = state.binding;
		const q = this.deps.store.plans.get(missionId)?.questions.find((x) => x.id === questionId);
		const synopsis = researchSynopsis(report);
		const author = { type: "session" as const, sessionId };
		const written = await knowledge.write(
			projectId,
			undefined,
			{
				operationId: `research-findings-${sessionId}`,
				expectedRevision: 0,
				kind: "investigation",
				title: `Research: ${q?.title ?? questionId}`.slice(0, 200),
				synopsis,
				body: [
					"# Question",
					q ? `${q.title}\n\n${q.question}` : questionId,
					"# Findings",
					report,
					"# Limitations",
					`Pilot saved the final answer of read-only research chat ${sessionId} word for word. Nobody has checked it: these findings are evidence, not acceptance.`,
				].join("\n\n"),
			},
			author,
			{ missionId, sessionId },
		);
		const id = written.entry.id;
		const revision = written.revision.revision;
		const link = knowledge.linkState(missionId, id);
		if (!link.linked)
			await knowledge.link(missionId, id, { expectedLinkRevision: link.linkRevision, revision }, author);
		return { id, revision, synopsis };
	}

	private changeResearch(
		state: PlanningWorkerState,
		questionId: string,
		change: Partial<PlanningResearch>,
	): PlanningWorkerState {
		if (change.state)
			trace(
				`pilotd: planning ${state.binding.missionId} research ${questionId} -> ${change.state}${change.reason ? `: ${change.reason}` : ""}`,
			);
		return this.deps.store.planningWorkers.change(state.binding.missionId, state.revision, (s) => {
			s.research ??= {};
			s.research[questionId] = { ...(s.research[questionId] as PlanningResearch), ...change };
		});
	}

	private services(binding: PlanningWorkerBinding, guard: () => void) {
		const plans = new MissionPlans({
			...this.deps,
			authorize: guard,
			validateRound: (questions) => this.deps.store.interviews.assertNewQuestions(binding.missionId, questions),
		});
		const interviews = new MissionInterviews({
			...this.deps,
			authorize: () => {
				guard();
				return "planning-only";
			},
			adapter: {
				admit: async (op, request, exactGuard) => {
					if (request.purpose !== "interview-continue") throw new Conflict("Planning never admits builders");
					const state = this.scope(binding);
					return this.admitInput(state, op, () => {
						guard();
						exactGuard();
					});
				},
				lookup: async (op) => this.deps.sessions.lookupPlanning(this.input(this.scope(binding), op)),
			},
		});
		return { plans, interviews };
	}
	async call(
		binding: PlanningWorkerBinding,
		request: PlanningWorkerRequest,
		supervisor: () => void = () => {},
	): Promise<PlanningWorkerReply> {
		await this.turnAdmissions.get(binding.missionId);
		await this.admissions.get(binding.missionId);
		supervisor();
		let state = this.scope(binding);
		const authority = this.authority(binding),
			planBefore = hash(this.deps.store.plans.get(binding.missionId) ?? null),
			guard = () => {
				supervisor();
				if (this.authority(binding) !== authority) throw new Conflict("Planning authority changed");
				if (
					request.action === "questions" &&
					hash(this.deps.store.plans.get(binding.missionId) ?? null) !== planBefore
				)
					throw new Conflict("Question context changed");
			};
		const { plans, interviews } = this.services(binding, guard);
		const published = !!this.deps.store.plans.get(binding.missionId)?.publication;
		if (request.action === "read")
			return {
				value:
					published && request.revision === undefined
						? await this.revisitContext(binding, guard)
						: request.revision === undefined
							? compactView(await plans.view(binding.missionId))
							: await plans.read(binding.missionId, request.revision),
			};
		if (request.action === "knowledge")
			return { value: await plans.knowledge(binding.missionId, request.id, request.revision) };
		if (request.action === "replaced") {
			const value = replacedMissionView(this.deps.store, binding.missionId, request.task);
			guard();
			return { value };
		}
		if (request.action === "receipt") {
			const op = this.deps.store.planningWorkers.operation(binding.missionId, request.operationId);
			if (!op) throw new Conflict("Exact retained planning operation required");
			const receipt = await this.deps.journal.lookup(op);
			guard();
			const current = this.scope(binding);
			return {
				value: receipt ?? { state: "pending", operationId: op.operationId },
				...(current.phase === "held" && current.hold?.operationId === op.operationId ? { hold: current.hold } : {}),
			};
		}
		interviewText(request.toolCallId, 256);
		const old = this.deps.store.planningWorkers.call(binding.missionId, request.toolCallId);
		if (old) {
			if (old.payload !== canonicalJSON(request.request)) throw new Conflict("Planning call payload changed");
			return this.call(binding, { action: "receipt", operationId: old.operationId });
		}
		if (
			state.phase !== "active" ||
			(request.action === "revision"
				? !published || !state.revisit?.admitted
				: request.action === "write"
					? !isPlanOperation(request.request.purpose)
					: request.request.purpose !== "interview-questions")
		)
			throw new Conflict("Planning is held or purpose unavailable");
		if (
			published &&
			(request.action === "write" ||
				!state.revisit?.admitted ||
				(request.action === "questions" && request.request.kind !== "revisit"))
		)
			throw new Conflict("Published planning only saves requested Revisit questions or inert revisions");
		if (request.action === "questions")
			this.deps.store.interviews.assertNewQuestions(binding.missionId, request.request.questions);
		const payload = canonicalJSON(request.request),
			op: DurableOperation = {
				schemaVersion: 1,
				operationId: randomUUID(),
				producerId: binding.enrollmentId,
				sequence: state.revision,
				origin: binding.host,
				destination: binding.host,
				targetId: binding.missionId,
				kind: request.request.purpose,
				payload,
				payloadHash: payloadHash(payload),
				bindingId: authority,
				bindingGeneration: 1,
			};
		this.deps.store.planningWorkers.retain(binding.missionId, request.toolCallId, op);
		const opensRound = ["interview-questions", "plan-ask", "plan-review"].includes(op.kind);
		// Every retained call consumes a producer sequence, not only calls opening an interview.
		state = this.deps.store.planningWorkers.change(binding.missionId, state.revision, (s) => {
			if (opensRound) {
				s.phase = "holding";
				s.pendingHold = { operationId: op.operationId, authority, round: this.authority(binding, true) };
				s.continuation = null;
			}
		});
		await this.deps.store.durable();
		guard();
		const receipt = await this.deps.journal.execute(op, (operation, entry) =>
			request.action === "revision"
				? this.revision(operation, entry.firstEntry, binding, guard)
				: request.action === "write"
					? plans.admit(operation, entry.firstEntry)
					: interviews.admit(operation, entry.firstEntry),
		);
		if (opensRound && receipt.state === "accepted") {
			guard();
			state = await this.finishHold(state, op);
			guard();
			return {
				value: {
					receipt,
					interview: this.deps.store.interviews.latest(binding.missionId),
					status: "awaiting-answers",
				},
				hold: state.hold!,
			};
		}
		if (
			opensRound &&
			receipt.state === "rejected" &&
			!this.deps.store.interviews.lookup(op) &&
			!this.deps.store.plans.lookup(op)
		) {
			// A terminal rejection with no saved effect can release this operation's provisional hold.
			// Pending/missing receipts are never absence proof and stay held.
			this.deps.store.planningWorkers.change(binding.missionId, state.revision, (next) => {
				next.phase = "active";
				next.pendingHold = null;
			});
			await this.deps.store.durable();
			guard();
		}
		return { value: receipt, ...(receipt.state === "pending" ? { blocked: true } : {}) };
	}
	private async revisitContext(binding: PlanningWorkerBinding, guard: () => void) {
		const store = this.deps.store;
		const snapshot = () => ({
			mission: store.require(binding.missionId),
			agreement: store.brief(binding.missionId),
			decisions: store.workflowConfirmationState(binding.missionId).decisions,
			tasks: store.tasks(binding.missionId),
			revisionDelta: store.revisions.latestConfirmed(binding.missionId) ?? null,
			revisionSource: store.revisions.source(binding.missionId),
			interview: store.interviews.latest(binding.missionId),
			settledAnswers: store.interviews.history(binding.missionId).map((h) => h.interview.submission),
			knowledge: store.knowledge.list(
				binding.projectId,
				{ missionId: binding.missionId },
				undefined,
				LINKED_KNOWLEDGE,
			),
		});
		const pin = snapshot();
		await store.durable();
		guard();
		if (hash(pin) !== hash(snapshot())) throw new Conflict("Revisit context changed");
		return pin;
	}
	private async revision(
		op: DurableOperation,
		firstEntry: boolean,
		binding: PlanningWorkerBinding,
		guard: () => void,
	) {
		if (!firstEntry) {
			const saved = this.deps.store.revisions.lookup(op.targetId, op.operationId);
			if (!saved) throw new Error("Unknown revision; lookup only");
			await this.deps.store.durable();
			return saved;
		}
		const request: Extract<PlanningWorkerRequest, { action: "revision" }>["request"] = JSON.parse(op.payload);
		try {
			interviewExact(request, ["purpose", "source", "summary", "delta"]);
			if (request.purpose !== "revision-propose") throw new Conflict("Inert revision required");
			guard();
			return await this.deps.store.revisions.propose(
				op.targetId,
				{ operationId: op.operationId, source: request.source, summary: request.summary, delta: request.delta },
				{ sessionId: binding.ownerSessionId },
			);
		} catch (e) {
			if (this.deps.store.revisions.lookup(op.targetId, op.operationId))
				throw new Error("Unknown saved revision; lookup only", { cause: e });
			throw new OperationRejected(String(e));
		}
	}
	private async finishHold(state: PlanningWorkerState, op: DurableOperation): Promise<PlanningWorkerState> {
		const interview = this.deps.store.interviews.lookup(op);
		if (
			!state.pendingHold ||
			state.pendingHold.operationId !== op.operationId ||
			!interview ||
			!interview.questions.length
		)
			throw new Error("Unknown saved planning hold");
		if (this.deps.store.interviews.latest(op.targetId)?.revision !== interview.revision)
			throw new Error("Saved planning round changed before its hold");
		if (
			isPlanOperation(op.kind) &&
			canonicalJSON(this.deps.store.plans.get(op.targetId)) !== canonicalJSON(this.deps.store.plans.lookup(op))
		)
			throw new Error("Saved planning context changed before its hold");
		const round = {
			fence: interview.fence,
			revision: interview.revision,
			operationId: op.operationId,
			contextDigest: this.roundContext(state, state.pendingHold.round ?? state.pendingHold.authority),
		};
		const held = this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
			s.phase = "held";
			s.hold = round;
			s.pendingHold = null;
		});
		await this.deps.store.durable();
		return held;
	}
	/**
	 * A round the user submitted that never reached the planner is sent when the reason clears: the
	 * planning agent loads, planning resumes, or the daemon restarts. A changed map never clears by
	 * itself, so that round waits for the user's Continue. Its continuation never entered: nothing is replayed.
	 */
	private resumeStalled(missionId: string): void {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state || !this.stalledRound(state)) return;
		const id = state.continuation!.operation.operationId;
		if (this.resumeTried.has(id)) return;
		this.resumeTried.add(id);
		trace(`pilotd: planning ${missionId} submitted round was not sent; sending it now`);
		const task = this.continue(state).catch((e) => {
			// Only a changed map stops further tries; anything else is tried again on the next change.
			if (!(e instanceof RoundChanged)) this.resumeTried.delete(id);
		});
		this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task));
	}
	/** Only a fresh explicit submit invokes this. Restarts/status/duplicate POSTs never schedule input. */
	submitted(missionId: string, submissionOperationId: string): void {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (
			!state?.continuation ||
			state.continuation.entered ||
			JSON.parse(state.continuation.operation.payload).submissionOperationId !== submissionOperationId
		)
			return;
		const task = this.continue(state).catch(() => {
			/* Saved pending state remains Unknown; never replay. continue() logs why. */
		});
		this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task));
	}
	private async continue(state: PlanningWorkerState, confirmed = false): Promise<void> {
		const op = state.continuation!.operation,
			binding = state.binding;
		this.continuing.add(binding.missionId);
		try {
			const sent = await this.continueSubmitted(state, op, binding, confirmed);
			trace(
				`pilotd: planning ${binding.missionId} submitted round ${sent === "accepted" ? "sent to the planner" : `not confirmed (${sent})`} (${op.operationId})`,
			);
		} catch (e) {
			console.warn(`pilotd: planning ${binding.missionId} submitted round not sent: ${e}`);
			throw e;
		} finally {
			this.continuing.delete(binding.missionId);
		}
	}
	private async continueSubmitted(
		state: PlanningWorkerState,
		op: DurableOperation,
		binding: PlanningWorkerState["binding"],
		confirmed: boolean,
	): Promise<string> {
		const guard = () => {
			const current = this.scope(binding);
			if (
				!state.hold ||
				current.hold?.operationId !== state.hold.operationId ||
				canonicalJSON(current.continuation?.operation) !== canonicalJSON(op)
			)
				throw new Conflict("Submitted planning round or controls changed");
			// The user's explicit Continue confirms the round against the map as it is now.
			const round = this.authority(binding, true);
			if (!confirmed && this.roundContext(state, round) !== state.hold.contextDigest) throw new RoundChanged();
		};
		guard();
		await this.deps.sessions.planningIdle(binding.ownerSessionId, guard, this.closing.signal);
		guard();
		const latest = this.scope(binding);
		if (latest.continuation?.entered) return "already entered";
		let release!: () => void;
		const turnAdmission = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.turnAdmissions.set(binding.missionId, turnAdmission);
		try {
			this.deps.store.planningWorkers.change(binding.missionId, latest.revision, (s) => {
				s.continuation!.entered = true;
				s.phase = "continuing";
			});
			await this.deps.store.durable();
			guard();
			const service = this.services(binding, guard).interviews;
			const receipt = await this.deps.journal.execute(op, (o, entry) => service.admit(o, entry.firstEntry));
			if (receipt.state === "accepted") {
				const current = this.scope(binding);
				this.deps.store.planningWorkers.change(binding.missionId, current.revision, (s) => {
					s.phase = "active";
					s.hold = null;
				});
				await this.deps.store.durable();
			}
			return receipt.state;
		} finally {
			if (this.turnAdmissions.get(binding.missionId) === turnAdmission)
				this.turnAdmissions.delete(binding.missionId);
			release();
		}
	}
	/** Recovery router only. Retained identities cannot be used by native human ingress. */
	owns(op: DurableOperation): boolean {
		if (op.kind === "planning-enroll") return true;
		const state = this.deps.store.planningWorkers.get(op.targetId);
		return (
			!!state &&
			(canonicalJSON(state.continuation?.operation) === canonicalJSON(op) ||
				canonicalJSON(this.deps.store.planningWorkers.operation(op.targetId, op.operationId)) === canonicalJSON(op))
		);
	}
	async recover(op: DurableOperation): Promise<unknown> {
		if (op.kind === "plan-continue") {
			const state = this.deps.store.planningWorkers.get(op.targetId);
			if (
				!state ||
				canonicalJSON(this.deps.store.planningWorkers.call(op.targetId, `$continue:${op.operationId}`)) !==
					canonicalJSON(op)
			)
				throw new Error("Unknown Continue planning identity; lookup only");
			const receipt = await this.deps.sessions.lookupPlanning(this.input(state, op));
			if (!receipt) throw new Error("Unknown Continue planning admission; no replay");
			await this.feedbackSettled(op, "active");
			return receipt;
		}
		if (op.kind === "plan-revisit" || op.kind === "thread-send") {
			const state = this.deps.store.planningWorkers.get(op.targetId);
			const retained = op.kind === "thread-send" ? state?.discussion : state?.revisit;
			if (!state || canonicalJSON(retained?.operation) !== canonicalJSON(op))
				throw new Error("Unknown Revisit identity; lookup only");
			const receipt = await this.deps.sessions.lookupPlanning(this.input(state, op));
			if (!receipt) throw new Error("Unknown Revisit admission; no replay");
			if (state.phase === (op.kind === "thread-send" ? "discussing" : "revisiting")) {
				this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
					s.phase = "active";
					if (op.kind === "thread-send") s.discussion!.admitted = true;
					else s.revisit!.admitted = true;
				});
				await this.deps.store.durable();
			}
			return receipt;
		}
		if (op.kind === "planning-enroll") {
			if (
				canonicalJSON((await this.deps.journal.lookup(op))?.result) !==
				canonicalJSON({ stage: "planning-enrollment-entered", payloadHash: op.payloadHash })
			)
				throw new Error("Unknown planning enrollment checkpoint");
			const state = this.deps.store.planningWorkers.enrollment(op.targetId);
			if (!state || canonicalJSON(state.creation) !== canonicalJSON(op))
				throw new Error("Unknown planning enrollment; lookup only");
			const initial = this.deps.store.planningWorkers.call(state.binding.missionId, "$initial");
			if (!initial || !(await this.deps.sessions.lookupPlanning(this.input(state, initial))))
				throw new Error("Unknown initial planning admission; no replay");
			return {
				missionId: state.binding.missionId,
				ownerSessionId: state.binding.ownerSessionId,
				enrollmentId: state.binding.enrollmentId,
			};
		}
		const state = this.deps.store.planningWorkers.get(op.targetId);
		if (!state) throw new Error("Unknown planning worker");
		if (op.kind === "interview-continue") {
			if (
				canonicalJSON(this.deps.store.planningWorkers.operation(op.targetId, op.operationId)) !==
					canonicalJSON(op) ||
				canonicalJSON((await this.deps.journal.lookup(op))?.result) !==
					canonicalJSON({ stage: "interview-effect-entered", purpose: op.kind, payloadHash: op.payloadHash })
			)
				throw new Error("Unknown continuation identity or checkpoint");
			const receipt = await this.deps.sessions.lookupPlanning(this.input(state, op));
			if (!receipt) throw new Error("Unknown planning admission; no replay");
			if (canonicalJSON(state.continuation?.operation) === canonicalJSON(op) && state.phase === "continuing") {
				this.deps.store.planningWorkers.change(op.targetId, state.revision, (next) => {
					next.phase = "active";
					next.hold = null;
				});
				await this.deps.store.durable();
			}
			return receipt;
		}
		const retained = this.deps.store.planningWorkers.operation(op.targetId, op.operationId);
		if (canonicalJSON(retained) !== canonicalJSON(op)) throw new Error("Unknown planning operation");
		if (op.kind === "revision-propose") return this.revision(op, false, state.binding, () => {});
		const { plans, interviews } = this.services(state.binding, () => {});
		const receipt = await (isPlanOperation(op.kind) ? plans.admit(op, false) : interviews.admit(op, false));
		if (state.phase === "holding" && state.pendingHold?.operationId === op.operationId)
			await this.finishHold(state, op);
		return receipt;
	}
	status(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state) return { coordinatorProfile: "not-configured", continuation: "unavailable" };
		try {
			this.authority(state.binding);
			return {
				coordinatorProfile: 1,
				continuation: 1,
				phase: state.phase,
				continuationOperationId: state.continuation?.operation.operationId ?? null,
			};
		} catch {
			return { coordinatorProfile: "unavailable", continuation: "unavailable" };
		}
	}
	/** Start uses the existing task model selection and Build policy, not a new budget or grant. */
	private startPin(missionId: string) {
		const { store, sessions, projects } = this.deps;
		const state = store.planningWorkers.get(missionId);
		if (!state) throw new Conflict("Trusted planning owner unavailable");
		this.scope(state.binding);
		sessions.assertPlanningOpen(state.binding.ownerSessionId);
		const control = store.controls.fenceCurrent(missionId),
			plan = store.plans.get(missionId);
		if (
			control.held ||
			!plan?.publication ||
			plan.publication.briefRevision !== store.brief(missionId)?.revision ||
			plan.publication.submissionDigest !== store.interviews.latest(missionId)?.submission?.digest
		)
			throw new Conflict("Current published agreement required; mission may be held");
		const identity = sessions.planningIdentity(state.binding.ownerSessionId) as {
			inputGeneration: number;
			permission?: { level: string };
		};
		if (identity.inputGeneration !== 0)
			throw new Conflict("Planning owner was stopped or reconfigured; Start unavailable");
		const permission = identity.permission;
		if (permission?.level === "investigate") throw new Conflict("Build permission unavailable");
		const { updatedAt: _updated, ...mission } = store.require(missionId);
		return {
			binding: state.binding,
			project: projects.require(state.binding.projectId),
			owner: sessions.planningIdentity(state.binding.ownerSessionId),
			mission,
			ownerFence: store.interviewOwnerFence(missionId, state.binding.ownerSessionId),
			interview: store.interviews.latest(missionId),
			plan,
			brief: store.brief(missionId),
			control,
			tasks: store.tasks(missionId),
			decisions: store.workflowConfirmationState(missionId).decisions,
		};
	}
	async startView(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		const worker = state?.start ? this.deps.sessions.get(state.start.sessionId) : undefined;
		if (state?.start)
			return {
				available: false as const,
				state: state.start.admitted ? "admitted" : "unknown",
				execution: worker?.working ? "working" : worker ? "not-running" : "unavailable",
				operationId: state.start.operation.operationId,
				sessionId: state.start.sessionId,
				taskId: state.start.taskId,
				reason: state.start.admitted
					? worker?.working
						? "One background task admitted and working. Reports show its progress."
						: "One background task admitted, not running now. Read its report."
					: "Start is not confirmed. Check only; do not start again.",
			};
		try {
			const pin = this.startPin(missionId);
			const task = pin.plan
				.publication!.tasks.map(({ taskId }) => pin.tasks.find((t) => t.id === taskId)!)
				.find(
					(t) =>
						t?.status === "todo" &&
						!t.sessionId &&
						!(t.dependsOn ?? []).some((id) => pin.tasks.find((d) => d.id === id)?.status !== "done"),
				);
			if (!task) throw new Conflict("No published task is ready");
			const slice = pin.plan.slices.find((s) =>
				pin.plan.publication!.tasks.some((p) => p.sliceId === s.id && p.taskId === task.id),
			)!;
			const body = `${slice.outcome}\n\nSpec revision: ${pin.plan.publication!.briefRevision}\nStories: ${slice.storyIds.join(", ")}\nOwnership: ${slice.owners.join(", ")}\n\nAcceptance:\n${slice.acceptance.map((s) => `- ${s}`).join("\n")}`;
			const dependencies = slice.dependsOn.map(
				(id) => pin.plan.publication!.tasks.find((p) => p.sliceId === id)!.taskId,
			);
			if (
				task.title !== slice.title ||
				task.body !== body ||
				canonicalJSON(task.dependsOn ?? []) !== canonicalJSON(dependencies) ||
				task.assignment ||
				task.decisionIds?.length
			)
				throw new Conflict("Task scope changed since publication; no Start authority");
			this.deps.store.prepareTaskStart(missionId, [task.id]);
			const selection = await this.deps.sessions.selectTaskModel(
				pin.project.path,
				task.preferredModel,
				task.preferredThinking,
			);
			if (hash(this.startPin(missionId)) !== hash(pin)) throw new Conflict("Start context changed");
			return {
				available: true as const,
				state: "ready",
				revision: pin.plan.revision,
				digest: pin.plan.publication!.digest,
				taskId: task.id,
				title: task.title,
				project: pin.project.name,
				access: (pin.owner as { permission?: { level: string } }).permission?.level ?? "build",
				...selection,
				contextDigest: hash({ pin, selection }),
				reason: "",
			};
		} catch (e) {
			return {
				available: false as const,
				state: "unavailable",
				reason: e instanceof Error ? e.message : "Start authority unavailable",
			};
		}
	}
	/** Only an authenticated, explicit native Start enters this method. No submission calls it. */
	start(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (this.closing.signal.aborted) return Promise.reject(new Error("Planning host is closing; lookup unavailable"));
		const work = this.startEntered(op, firstEntry);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private async startEntered(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return this.recoverStart(op);
		const { store, sessions } = this.deps;
		let pin: ReturnType<PlanningWorkers["startPin"]>, selection: { model: string; thinking: string }, taskId: string;
		try {
			const request = JSON.parse(op.payload);
			interviewExact(request, ["purpose", "expectedRevision", "planDigest", "taskId"]);
			const view = await this.startView(op.targetId);
			if (
				!view.available ||
				op.kind !== "plan-start" ||
				request.purpose !== op.kind ||
				request.expectedRevision !== view.revision ||
				request.planDigest !== view.digest ||
				request.taskId !== view.taskId ||
				op.bindingId !== view.contextDigest ||
				op.bindingGeneration !== 1 ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Exact published Start context changed or unavailable");
			pin = this.startPin(op.targetId);
			selection = { model: view.model!, thinking: view.thinking! };
			taskId = view.taskId!;
			if (hash({ pin, selection }) !== op.bindingId) throw new Conflict("Start context changed");
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : "Invalid Start");
		}
		const sessionId = randomUUID(),
			task = pin.tasks.find((t) => t.id === taskId)!;
		const check = (claimed: boolean) => {
			const current = this.startPin(op.targetId);
			if (claimed) {
				const actual = current.tasks.find((t) => t.id === taskId);
				if (!actual || actual.sessionId !== sessionId || actual.status !== "in_progress")
					throw new Conflict("Start assignment changed");
				// Only this admission's exact claim may differ from the approved task snapshot.
				current.tasks = current.tasks.map((t) =>
					t.id !== taskId
						? t
						: { ...t, sessionId: task.sessionId, status: task.status, updatedAt: task.updatedAt },
				);
			}
			if (hash(current) !== hash(pin)) throw new Conflict("Published plan, owner, project or controls changed");
		};
		try {
			check(false);
			await this.deps.journal.checkpoint(op, { stage: "plan-start-entered", payloadHash: op.payloadHash });
			check(false);
			const state = store.planningWorkers.get(op.targetId)!;
			if (state.start) throw new Conflict("Start already entered; check only");
			store.planningWorkers.change(op.targetId, state.revision, (s) => {
				s.start = { operation: op, sessionId, taskId, admitted: false };
			});
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : "Start refused");
		}
		await store.durable(); // Reservation and immutable identity precede every worker effect.
		check(false);
		const result = await sessions.admitPublishedTask(
			{
				projectId: pin.project.id,
				missionId: op.targetId,
				message: taskMessage([task]),
				title: task.title,
				mode: "build",
				...selection,
			},
			{ sessionId, taskId, operationId: op.operationId, ownerSessionId: pin.binding.ownerSessionId },
			check,
		);
		const state = store.planningWorkers.get(op.targetId)!;
		store.planningWorkers.change(op.targetId, state.revision, (s) => {
			s.start!.admitted = true;
		});
		await store.durable();
		return result;
	}
	private async recoverStart(op: DurableOperation) {
		const start = this.deps.store.planningWorkers.get(op.targetId)?.start;
		if (
			!start ||
			canonicalJSON(start.operation) !== canonicalJSON(op) ||
			!(await this.deps.sessions.lookupPublishedTask(start.sessionId, op.operationId))
		)
			throw new Error("Unknown Start admission; exact lookup only, no replay");
		const state = this.deps.store.planningWorkers.get(op.targetId)!;
		if (!state.start!.admitted)
			this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
				s.start!.admitted = true;
			});
		await this.deps.store.durable();
		return { admissionId: op.operationId, sessionId: start.sessionId };
	}
	close(): Promise<void> {
		if (this.closed) return this.closed;
		this.closing.abort(new Error("Planning worker host is closing"));
		this.research?.off();
		this.closed = Promise.allSettled([...this.tasks, ...this.admissions.values()]).then(() => {
			this.detach();
			this.offSettled();
		});
		return this.closed;
	}
}
