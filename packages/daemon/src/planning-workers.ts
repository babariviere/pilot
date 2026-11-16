/** Trusted planning worker lifecycle. No existing chat adoption or generic send fallback. */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
	assertPlanningBinding,
	PLANNING_PROFILE,
	type PlanningInput,
	type PlanningWorkerBinding,
	type PlanningWorkerReply,
	type PlanningWorkerRequest,
} from "@pilot/kernel";
import type { DurableOperation, MissionPlan, MissionTask, OperationReceipt, PlanQuestion } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { interviewDigest, interviewExact, interviewId, interviewText } from "./mission-interview-contract.ts";
import { MissionInterviews } from "./mission-interviews.ts";
import { PLAN_STATE_LIMIT, publishedDefinition, sliceTaskBody } from "./mission-plan-store.ts";
import {
	isPlanOperation,
	LINKED_KNOWLEDGE,
	MissionPlans,
	planFrontier,
	planQuestionDigest,
	planResearchFrontier,
} from "./mission-plans.ts";
import { taskMessage } from "./mission-service.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import { UnstickLog } from "./planning-unstick-log.ts";
import type {
	MissionFix,
	PlanningRepair,
	PlanningResearch,
	PlanningWorkerState,
	QuestionAsk,
	WaitingThreadMessage,
} from "./planning-worker-store.ts";
import type { KnowledgeService } from "./project-knowledge.ts";
import type { ProjectStore } from "./projects.ts";
import { replacedMissionView } from "./replaced-mission.ts";
import type { SessionManager } from "./sessions.ts";
import type { SourceRegistry } from "./sources.ts";
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
	/** The request in New (a Linear issue or Slack message) this mission is planned from, as the user saw it. */
	request?: { itemId: string; revision: number };
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
	/** Requests in New, for missions planned from one. */
	tracking?: Pick<SourceRegistry, "items" | "patch">;
}
const hash = (value: unknown) => payloadHash(canonicalJSON(value));
/**
 * Thread messages one mission keeps waiting for its planning agent. It protects the agent from a flood of messages
 * in one turn and keeps the waiting list short enough to read. A person writes far fewer while one round waits.
 * Past it, Send is refused with the limit named, and the words stay in the reply box.
 */
export const WAITING_MESSAGES = 20;
/** Each part of a fingerprint, hashed on its own, so a changed fingerprint can say which part changed. */
const digests = (parts: Record<string, unknown>): Record<string, string> =>
	Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, hash(v)]));
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
/** A start Pilot could not make by rule (no worker slot, paused, held) waits this long before the next try. Same as research. */
const EXECUTION_RETRY_MS = RESEARCH_RETRY_MS;
/**
 * What a planner may do with a thread request. A revision proposal is inert: only the user's confirmation applies it.
 */
const THREAD_CHANGES =
	"Do not start work. If the plan is published and the user asks for new work or a change, you may save one revision proposal (mission_plan action revision; newTasks for new work). It changes nothing until the user confirms it in Revisit: say so in your reply.";
/**
 * Whether the user asked the planner about the published plan: a Revisit, or a thread message it took. Only then may
 * it save a revision proposal, which still changes nothing until the user confirms it.
 */
function userAsked(state: PlanningWorkerState): boolean {
	return !!(state.revisit?.admitted || state.discussion?.admitted || state.threadQueue?.some((m) => m.delivered));
}
/** The planning kernel's refusal before it takes an input: nothing was added to the planner's history. */
const REFUSED_BEFORE_ADMISSION = /Planning admission is held or busy/;
/** A thread message the planner could not take now; it was saved to wait for it. */
export class DiscussionQueued extends Error {
	constructor() {
		super("Thread message saved to wait for the planning agent");
	}
}
/** Added to a task Pilot starts by rule, so its worker does not wait for a coordinator that does not exist. */
const RULE_START_NOTE =
	"Pilot started this task because its dependencies are done: the user checked their results. You can rely on them. No coordinator runs this mission: ask the user with `ask_user` when you need a decision.";
/** Research chats per question: the first, and one more when the planner unclaims weak findings. */
const RESEARCH_ATTEMPTS = 2;
/** Research findings per planning turn, at most. */
const RESEARCH_BATCH = 3;
/** Final answer characters sent to the planner per research chat. Broad research should be split instead. */
const RESEARCH_REPORT_LIMIT = 48_000;
/** Prototype chats a mission runs at once: the user reviews one prototype at a time. The worker cap also applies.
 * Attempts per question are RESEARCH_ATTEMPTS, and each chat stops at its question's maxMinutes. */
const PROTOTYPE_CHATS = 1;
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

/**
 * Whether Pilot should make a prototype for open question `q` now: never while the user answers the round about it,
 * and again only after its last chat failed or the planner changed the question (at most RESEARCH_ATTEMPTS).
 * Saving a prototype's result releases the question, so being unclaimed alone never means "make another".
 */
function prototypeDue(plan: MissionPlan, q: PlanQuestion, prior: PlanningResearch | undefined): boolean {
	if (q.kind !== "prototype" || !q.prototype || plan.round?.topicId === q.id) return false;
	if (!prior) return true;
	if ((prior.attempts ?? 1) >= RESEARCH_ATTEMPTS) return false;
	return prior.state === "failed" || (prior.state === "reported" && prior.questionDigest !== planQuestionDigest(q));
}

function prototypeMessage(
	missionTitle: string,
	q: PlanQuestion,
	earlier?: { sessionId: string; artifactId: string; revision: number },
): string {
	const p = q.prototype!;
	return [
		`Make one prototype for a planning question of the mission "${missionTitle}". This chat is read-only: it changes no project files.`,
		`Question: ${q.title}`,
		q.question,
		`What to make (${p.experimentType === "ui" ? "UI" : "logic and state"}): ${p.smallestExperiment}`,
		`Context: ${p.context}`,
		`Limits: about ${p.maxMinutes} minutes and ${p.maxCostUsd}. Pilot stops this chat after ${p.maxMinutes} minutes and passes on what it published.`,
		earlier
			? `An earlier prototype for this question exists: artifact ${earlier.artifactId}, revision ${earlier.revision}, of chat ${earlier.sessionId}. mission({action:"map"}) and the latest interview answers say what the user wants changed. Start from it.`
			: "",
		'Read the bundled pilot-artifacts skill and its NSH guide first. mission({action:"map"}) shows the planning map. Use source tools to match the real app: its layout, words and density.',
		p.experimentType === "ui"
			? "Make several clearly different variants of the same screen, inside a realistic copy of the screen around it, switchable from a small bar. The user flips between them and picks one or combines parts. Start from the skill's nsh/examples/prototype.tsx and switch with its Choices helper."
			: "Make the logic visible: the states, the events between them and a few scenarios the user can step through, with controls to drive them.",
		"Publish exactly one NSH artifact with the artifact tool, with every variant in it. Use mock data that looks real and keep state in memory. No live data, credentials, network or real actions. To fix it, update the same artifact; do not create others.",
		"End with a short report in Markdown: what each variant shows, what the user should compare, and what stays open. Do not decide for the user.",
	]
		.filter(Boolean)
		.join("\n\n");
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
	readonly changes: string[] | null;
	constructor(changes: string[] | null) {
		super(
			`Submitted planning round changed (${changes?.length ? changes.join(", ") : "what changed was not kept"}); Continue planning sends it against the current map`,
		);
		this.changes = changes;
	}
}
export class PlanningWorkers {
	private readonly deps: Dependencies;
	private readonly closing = new AbortController();
	/** Missions whose request this process linked or tried to link, and those it marked started: once each. */
	private readonly requestsSeen = new Set<string>();
	private readonly requestsStarted = new Set<string>();
	private readonly tasks = new Set<Promise<unknown>>();
	private readonly admissions = new Map<string, Promise<unknown>>();
	private readonly turnAdmissions = new Map<string, Promise<void>>();
	private readonly detach: () => void;
	private readonly offSettled: () => void;
	/** Repair chats are not mission members: their changes reach the mission through this map. */
	private readonly repairChats = new Map<string, string>();
	/** Missions whose submitted round is being sent to the planner now. */
	private readonly continuing = new Set<string>();
	/** Time-limit timers of running prototype chats, by chat. Cleared on close. */
	private readonly prototypeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Per mission: no start by rule before this time, after one was refused. */
	private readonly executionRetryAt = new Map<string, number>();
	/** Submitted rounds Pilot is sending by itself, or stopped trying because the map changed. */
	private readonly resumeTried = new Set<string>();
	/** The last time a submitted round was not sent, by mission, for the unstick log. Kept until it is sent. */
	private readonly stalls = new Map<
		string,
		{ at: string; operationId: string; reason: string; changes: string[] | null }
	>();
	private readonly unstickLog: UnstickLog;
	private readonly recentOperations = new Map<
		string,
		{ kind: string; state: string; reason: string | null; operationId: string; at: string }[]
	>();
	private closed?: Promise<void>;
	/** Research dispatch is opt-in (the daemon starts it), so fixtures never start chats by accident. */
	private research?: { dirty: Set<string>; running?: Promise<void>; off: () => void; retryAt: Map<string, number> };
	constructor(deps: Dependencies) {
		this.deps = deps;
		this.unstickLog = new UnstickLog(join(deps.home, "diagnostics", "unstick.jsonl"));
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
	 * repair), artifacts they link (prototypes), and pause and resume. They change nothing the user answered;
	 * pause is checked at send time. */
	private authority(binding: PlanningWorkerBinding, round = false): string {
		return hash(this.authorityParts(binding, round));
	}
	/** What authority() hashes, part by part. */
	private authorityParts(binding: PlanningWorkerBinding, round = false): Record<string, unknown> {
		this.scope(binding);
		this.deps.sessions.assertPlanningOpen(binding.ownerSessionId);
		const { store, sessions } = this.deps,
			mission = store.require(binding.missionId),
			control = store.controls.fenceCurrent(binding.missionId);
		const {
			briefRevision: _brief,
			memberEventId,
			artifactEventId,
			...rest
		} = store.allocationContextFence(binding.missionId);
		const context = round ? rest : { ...rest, memberEventId, artifactEventId };
		if (control.held) throw new Conflict("Mission planning is paused");
		return {
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
		};
	}
	/**
	 * What the user answered against: the mission, its controls and the map. Pilot's bookkeeping (the map's
	 * revision and research claims) and chats joining the mission are left out: they change while a round
	 * waits without changing any question.
	 */
	private roundContext(state: PlanningWorkerState, authority: string): string {
		return hash({ authority, ...this.mapParts(state) });
	}
	/** The map part of a round's fingerprint: the plan without Pilot's bookkeeping, and the brief for a revisit. */
	private mapParts(state: PlanningWorkerState): Record<string, unknown> {
		const missionId = state.binding.missionId;
		const plan = this.deps.store.plans.get(missionId);
		return {
			plan: plan
				? { ...plan, revision: 0, questions: plan.questions.map(({ claimedBy: _claim, ...q }) => q) }
				: null,
			...(this.deps.store.interviews.latest(missionId)?.kind === "revisit"
				? { briefRevision: this.deps.store.brief(missionId)?.revision }
				: {}),
		};
	}
	/**
	 * The parts of a held round's fingerprint that changed since it was asked, by name (`plan`, `session`,
	 * `owner`…), so a stalled round says why. Null when they are unknown: the round was held before Pilot kept
	 * its parts, or planning is paused.
	 */
	private roundChanges(state: PlanningWorkerState): string[] | null {
		const kept = state.holdParts;
		if (!state.hold || kept?.operationId !== state.hold.operationId) return null;
		let now: Record<string, string>;
		try {
			now = digests({ ...this.authorityParts(state.binding, true), ...this.mapParts(state) });
		} catch {
			return null;
		}
		return [...new Set([...Object.keys(kept.parts), ...Object.keys(now)])]
			.filter((k) => kept.parts[k] !== now[k])
			.sort();
	}
	/** Appends one entry to the unstick log (see UnstickLog), with the mission's planning state now. */
	recordUnstick(missionId: string, action: string, detail: Record<string, unknown> = {}): void {
		const state = this.deps.store.planningWorkers.get(missionId);
		let unstick: ReturnType<PlanningWorkers["unstickView"]> | null = null;
		try {
			unstick = this.unstickView(missionId);
		} catch {
			/* The record still says what the user did. */
		}
		this.unstickLog.record({
			missionId,
			mission: this.deps.store.get(missionId)?.title ?? null,
			action,
			phase: state?.phase ?? null,
			unstick,
			stall: this.stalls.get(missionId) ?? null,
			...detail,
		});
	}
	/** Whether a thread message can wait for this mission's planning agent: planning is set up. */
	canQueueMessage(missionId: string): boolean {
		const state = this.deps.store.planningWorkers.get(missionId);
		return !!state && state.phase !== "setup";
	}
	/** Refuses a new waiting message past WAITING_MESSAGES, naming the limit. */
	assertMessageRoom(missionId: string): void {
		if (this.waitingMessages(missionId).length >= WAITING_MESSAGES)
			throw new Conflict(
				`${WAITING_MESSAGES} messages already wait for the coordinator (the limit is ${WAITING_MESSAGES}). Send this one once some went`,
			);
	}
	/** Saves a thread message to wait for the planning agent. The same operation is saved once. */
	queueMessage(missionId: string, message: Omit<WaitingThreadMessage, "at">): void {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state) throw new Conflict("Planning is not set up");
		if (state.threadQueue?.some((m) => m.operationId === message.operationId)) return;
		this.deps.store.planningWorkers.change(missionId, state.revision, (s) => {
			s.threadQueue = [...(s.threadQueue ?? []), { ...message, at: Date.now() }];
		});
		trace(`pilotd: planning ${missionId} thread message waits for the planning agent (${message.operationId})`);
		this.scheduleResearch(missionId);
	}
	/** Whether this thread-send operation was saved to wait (it may have been delivered since). */
	queuedMessage(missionId: string, operationId: string): boolean {
		return !!this.deps.store.planningWorkers.get(missionId)?.threadQueue?.some((m) => m.operationId === operationId);
	}
	/** Thread messages not yet with the planning agent, in the order sent. */
	waitingMessages(missionId: string): WaitingThreadMessage[] {
		return (this.deps.store.planningWorkers.get(missionId)?.threadQueue ?? []).filter((m) => !m.delivered);
	}
	/** Gives every waiting message no input carries yet to input `operationId`. Returns the new state. */
	private carryMessages(state: PlanningWorkerState, operationId: string): PlanningWorkerState {
		if (!state.threadQueue?.some((m) => !m.carriedBy)) return state;
		return this.deps.store.planningWorkers.change(state.binding.missionId, state.revision, (s) => {
			for (const m of s.threadQueue ?? []) if (!m.carriedBy) m.carriedBy = operationId;
		});
	}
	/** Input `operationId` reached the agent (delivered) or was refused before it entered (back to waiting). */
	private settleMessages(missionId: string, operationId: string, delivered: boolean): void {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state?.threadQueue?.some((m) => m.carriedBy === operationId && !m.delivered)) return;
		this.deps.store.planningWorkers.change(missionId, state.revision, (s) => {
			for (const m of s.threadQueue ?? [])
				if (m.carriedBy === operationId) {
					if (delivered) m.delivered = true;
					else delete m.carriedBy;
				}
			// Delivered messages are kept only so their input reads the same on recovery: the latest few are enough.
			const done = (s.threadQueue ?? []).filter((m) => m.delivered);
			const drop = new Set(done.slice(0, Math.max(0, done.length - WAITING_MESSAGES)).map((m) => m.operationId));
			s.threadQueue = (s.threadQueue ?? []).filter((m) => !drop.has(m.operationId));
		});
		if (delivered) trace(`pilotd: planning ${missionId} waiting thread messages delivered with ${operationId}`);
	}
	/** The thread messages input `operationId` carries, as text for the planning agent. Empty when none. */
	private messagesContent(missionId: string, operationId: string): string {
		const carried = (this.deps.store.planningWorkers.get(missionId)?.threadQueue ?? []).filter(
			(m) => m.carriedBy === operationId,
		);
		if (!carried.length) return "";
		return [
			"\n\nThe user also wrote in mission threads while you could not take messages. Each message is discussion, not execution, Start, agreement acceptance or approval. Answer each in your reply, by thread; change the plan only through planning records, and do not start work.",
			...carried.map(
				(m) =>
					`Thread ${JSON.stringify(m.title)} (${m.topicId}), message ${m.operationId}: ${JSON.stringify(m.text)}`,
			),
		].join("\n");
	}
	/**
	 * Delivers waiting thread messages in one planning turn of their own, once the agent is idle and no round waits.
	 * A waiting round carries them with the user's submit or Continue instead.
	 */
	private async deliverMessages(missionId: string): Promise<void> {
		let state = this.deps.store.planningWorkers.get(missionId);
		if (!state || (!state.threadDelivery && !state.threadQueue?.some((m) => !m.carriedBy))) return;
		const owner = this.deps.sessions.get(state.binding.ownerSessionId);
		if (
			state.phase !== "active" ||
			state.hold ||
			state.pendingHold ||
			!owner ||
			owner.working ||
			(owner.state !== "idle" && owner.state !== "parked") ||
			this.admissions.has(missionId) ||
			this.turnAdmissions.has(missionId)
		)
			return;
		let operation = state.threadDelivery;
		if (!operation) {
			const operationIds = state.threadQueue!.filter((m) => !m.carriedBy).map((m) => m.operationId);
			const payload = canonicalJSON({ purpose: "plan-thread-messages", operationIds });
			const saved: DurableOperation = {
				schemaVersion: 1,
				operationId: randomUUID(),
				producerId: state.binding.enrollmentId,
				sequence: state.revision,
				origin: state.binding.host,
				destination: state.binding.host,
				targetId: missionId,
				kind: "plan-thread-messages",
				payload,
				payloadHash: payloadHash(payload),
			};
			state = this.carryMessages(state, saved.operationId);
			state = this.deps.store.planningWorkers.change(missionId, state.revision, (s) => {
				s.threadDelivery = saved;
			});
			await this.deps.store.durable();
			operation = saved;
		}
		const binding = state.binding;
		try {
			if (!(await this.deps.sessions.lookupPlanning(this.input(state, operation))))
				await this.admitInput(state, operation, () => {
					this.authority(binding);
				});
		} catch (error) {
			// Busy or held after all: the same input is tried again on the next change, never twice.
			console.warn(`pilotd: planning ${missionId} waiting thread messages not delivered yet: ${error}`);
			return;
		}
		this.settleMessages(missionId, operation.operationId, true);
		const now = this.deps.store.planningWorkers.get(missionId)!;
		this.deps.store.planningWorkers.change(missionId, now.revision, (s) => {
			delete s.threadDelivery;
		});
		await this.deps.store.durable();
	}
	private input(state: PlanningWorkerState, op: DurableOperation): PlanningInput {
		return {
			binding: state.binding,
			operation: op,
			hold:
				op.kind === "interview-continue"
					? state.hold
					: op.kind === "plan-continue" && state.feedback?.operationId === op.operationId
						? state.feedback.hold
						: null,
			content: this.inputContent(state, op),
		};
	}
	/** What the planning agent reads for input `op`, with any waiting thread messages it carries. */
	private inputContent(state: PlanningWorkerState, op: DurableOperation): string {
		const submitted = this.deps.store.interviews.latest(state.binding.missionId)?.submission;
		const messages = this.messagesContent(state.binding.missionId, op.operationId);
		if (op.kind === "plan-thread-messages")
			return `The user wrote in mission threads while you could not take messages. Read current mission records; use Wayfinder only if needed. ${THREAD_CHANGES}${messages}`;
		return (
			(op.kind === "thread-send"
				? this.discussionContent(op)
				: op.kind === "plan-revisit"
					? "The user explicitly requested a planning-only Revisit. Read mission_plan for current agreement, active decisions, tasks and settled answers. Use the trusted upstream skills. Keep settled answers; ask only genuinely new gaps in one saved kind=revisit round. Save an inert revision with action revision when ready. Never publish a creation plan, change agreement, approve or start execution."
					: op.kind === "plan-continue" && JSON.parse(op.payload).feedback !== undefined
						? `The user sent feedback on the current interview instead of answering it. Redo the round with it: reword, split, merge, drop or add questions as asked, and save the whole list again with the action you used for this round. Keep a question's id when its meaning stays, so its saved answer stays. The feedback answers no question and approves nothing. Planning only: no build work or worker starts.\nFeedback: ${JSON.stringify(JSON.parse(op.payload).feedback)}`
						: op.kind === "plan-continue" && JSON.parse(op.payload).note !== undefined
							? `Pilot's repair agent looked at why planning stopped, and the user approved this note. Act on it, then continue planning: read mission_plan, and judge only by Pilot's answers. The note answers no question and approves nothing. Planning only: no build work or worker starts.\nNote: ${JSON.stringify(JSON.parse(op.payload).note)}`
							: op.kind === "plan-continue"
								? `The user asked you to continue planning. Read mission_plan for the current map and answers. Link human answers that settle map questions and save a new round only for real new human questions. Pilot starts read-only research chats for ready research questions and prototype chats for ready prototype questions, and sends you their results. ${this.modelHint(state.binding.missionId)}${this.refusalHint(state.binding.missionId)} Planning only: no build work or worker starts.`
								: op.kind === "plan-research-result"
									? this.researchContent(state, op)
									: op.kind === "interview-continue"
										? `Continue planning from this exact submitted interview. Answers are not build permission. Use the trusted native planning skills and records only.\n${canonicalJSON(submitted)}`
										: `Plan this requested outcome using the trusted upstream skills. Read mission_plan, then publish the complete first saved round with action questions. Do not ask inside ask_user or start implementation.\n${state.goal}`) +
			messages
		);
	}
	/** For Continue planning: ready prototype questions that wait for the planner to choose their model. */
	private modelHint(missionId: string): string {
		const plan = this.deps.store.plans.get(missionId);
		const waiting = plan ? planFrontier(plan).filter((q) => q.kind === "prototype" && !q.prototype?.model) : [];
		if (!waiting.length) return "";
		return `These prototype questions wait for you to choose the model of the chat that makes them: ${waiting.map((q) => JSON.stringify(q.id)).join(", ")}. Set prototype.model (and optional prototype.thinking) with plan-map; a refused save lists the allowed models. `;
	}
	/** For Continue planning: the last refused save's reason, so the planner changes it instead of resending it. */
	private refusalHint(missionId: string): string {
		const refusal = this.deps.store.plans.refusal(missionId);
		if (!refusal)
			return "A save Pilot refused before may be accepted now: try it again, and judge only by Pilot's answer, not by source code you read.";
		return `Pilot refused your last ${refusal.kind} save: ${JSON.stringify(refusal.reason)}. Change the save so it fits that reason (for example merge or drop open questions); never resend it unchanged, and never drop settled questions. Judge only by Pilot's answer.`;
	}
	/** The saved results of every research and prototype chat in one batch, as one planning input. */
	private researchContent(state: PlanningWorkerState, op: DurableOperation): string {
		const batch = Object.entries(state.research ?? {}).filter(([, r]) => r.operation?.operationId === op.operationId);
		if (!batch.length || batch.some(([, r]) => !r.report)) throw new Error("Saved research findings required");
		const questions = this.deps.store.plans.get(state.binding.missionId)?.questions ?? [];
		const research = batch.filter(([, r]) => r.kind !== "prototype");
		const prototypes = batch.filter(([, r]) => r.kind === "prototype");
		return [
			...(research.length
				? [
						"Research chats finished for these map questions. They ran read-only.",
						"Pilot saved each chat's final answer word for word as project Knowledge, linked to this mission. Read an entry with the knowledge tool when you need its detail; do not copy findings into new entries. For each: cite that Knowledge as the question source with plan-map, then resolve the question with kind knowledge.",
						"Where a full report is included below instead, Pilot could not save it: record it as Knowledge yourself (create, then link to this mission), keeping its text as written.",
						"If a question proved too broad for one chat, split it with plan-map into narrower research questions (one area each, keeping dependent questions linked) instead of retrying it. If the scope was right but findings are thin, say what is missing and unclaim it with plan-claim claimedBy null; Pilot then starts one more research chat for it. Planning only: no build work.",
					]
				: []),
			...(prototypes.length
				? [
						"Prototype chats finished for these map questions. They ran read-only and published a mock, not production code.",
						"For each prototype with an artifact: save plan-prototype-result with exactly that artifact pin, observations from the report and a verdict. Then ask the user about it with plan-ask (topicId = the question id), with clickable choices for the variants and free text. Pilot Day shows the prototype with that round. Settle the question only from the user's answer.",
						"For changes (from the user's answers, or with no artifact or a weak prototype): edit the question with plan-map to say what to change; Pilot then starts one more prototype chat, which starts from the earlier prototype. After two, ask the user how to go on. Planning only: no build work.",
					]
				: []),
			...batch.map(([id, r]) => {
				const q = questions.find((x) => x.id === id);
				if (r.kind === "prototype") {
					const head = `# Prototype for map question "${id}"${q ? ` (${q.title})` : ""}, prototype chat ${r.sessionId}`;
					const made = r.artifact
						? `Artifact pin, linked to this mission: ${canonicalJSON(r.artifact)}`
						: "The chat published no NSH artifact.";
					const stopped = r.timedOut
						? `\n\nPilot stopped the chat at its ${q?.prototype?.maxMinutes ?? "time"}-minute limit.`
						: "";
					return `${head}\n\n${made}${stopped}\n\nThe chat's report:\n\n${r.report}`;
				}
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
		return `Discuss this one mission topic using lightweight clarification. The quoted user text is discussion, not execution, Start, agreement acceptance or approval. Read current mission records; use Wayfinder only if needed. ${THREAD_CHANGES} Topic references (not a separate transcript): ${canonicalJSON(context)}\nOriginal input ${op.operationId}: ${JSON.stringify(JSON.parse(op.payload).text)}`;
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
		const purpose = JSON.parse(op.payload);
		this.recordUnstick(
			op.targetId,
			feedback
				? "continue-with-feedback"
				: Object.hasOwn(purpose, "note")
					? "continue-with-repair-note"
					: pin.resumeRound
						? "continue-submitted-round"
						: "continue",
			{ operationId: op.operationId },
		);
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
		// Waiting thread messages go with the user's Continue.
		state = this.carryMessages(state, op.operationId);
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
				this.settleMessages(op.targetId, op.operationId, false);
				if (pin.round) await this.feedbackSettled(op, "held");
				throw e;
			}
			this.settleMessages(op.targetId, op.operationId, true);
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
		const messages = this.waitingMessages(missionId).length;
		if (messages) checks.push(`Thread messages waiting for the planning agent: ${messages}`);
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
		if (state.phase === "held") {
			let stale = false;
			try {
				stale = this.roundContext(state, this.authority(state.binding, true)) !== state.hold?.contextDigest;
			} catch {
				/* Paused or moved: said above. */
			}
			if (stale)
				checks.push(
					`Changed since this round was asked: ${this.roundChanges(state)?.join(", ") || "not known (asked before Pilot kept what it checks)"}`,
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
		const plan = this.deps.store.plans.get(missionId);
		const titleOf = (id: string) => plan?.questions.find((q) => q.id === id)?.title ?? id;
		const prototyping = Object.entries(state.research ?? {}).find(
			([, r]) => r.kind === "prototype" && (r.state === "starting" || r.state === "running"),
		);
		if (prototyping) return result("moving", `A prototype chat is working on "${titleOf(prototyping[0])}".`);
		const ready = plan && planFrontier(plan).find((q) => prototypeDue(plan, q, state.research?.[q.id]));
		if (ready?.prototype?.model) return result("moving", `Pilot starts a prototype chat for "${ready.title}".`);
		if (chats) return result("moving", "A chat is working for this mission.");
		const canContinue = this.continueView(missionId).available;
		if (ready)
			return result(
				"stuck",
				`"${ready.title}" waits for the planning agent to choose the model that makes the prototype. Continue asks it to.`,
				canContinue ? "continue" : null,
			);
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
		const spent = Object.entries(state.research ?? {}).find(
			([id, r]) =>
				r.kind === "prototype" &&
				r.state === "reported" &&
				(r.attempts ?? 1) >= RESEARCH_ATTEMPTS &&
				!plan?.questions.find((q) => q.id === id)?.resolution,
		);
		if (spent)
			return result(
				"stuck",
				`Pilot made ${RESEARCH_ATTEMPTS} prototypes for "${titleOf(spent[0])}". Continue asks the planning agent to ask you how to go on.`,
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
		this.recordUnstick(op.targetId, "repair-agent", { operationId: op.operationId });
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
			if (change.proposal || change.state === "failed")
				this.recordUnstick(missionId, "repair-agent-answer", {
					operationId: repair.operationId,
					proposal: change.proposal ?? null,
					reason: change.reason ?? null,
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

	/**
	 * A thread message the planner refused before taking it (busy or held): the discussion turn ends, and the
	 * message waits to go with the next planning input. Only a refusal counts; a missing receipt stays Unknown.
	 */
	private async waitRefusedMessage(op: DurableOperation): Promise<void> {
		const request = JSON.parse(op.payload) as { topicId: string; text: string };
		const state = this.deps.store.planningWorkers.get(op.targetId)!;
		this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
			if (canonicalJSON(s.discussion?.operation) === canonicalJSON(op)) {
				delete s.discussion;
				if (s.phase === "discussing") s.phase = "active";
			}
		});
		this.queueMessage(op.targetId, {
			operationId: op.operationId,
			topicId: request.topicId,
			title: this.deps.store.threads.get(op.targetId, request.topicId).title,
			text: request.text,
		});
		await this.deps.store.durable();
		console.log(`pilotd: planning ${op.targetId} thread message waits for the planning agent (${op.operationId})`);
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
			let receipt: Awaited<ReturnType<PlanningWorkers["admitInput"]>>;
			try {
				receipt = await this.admitInput(state, op, guard);
			} catch (error) {
				// The planner refused before taking it: the message waits for it instead of becoming Unknown.
				if (discussion && REFUSED_BEFORE_ADMISSION.test(String(error))) {
					await this.waitRefusedMessage(op);
					throw new DiscussionQueued();
				}
				throw error;
			}
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
			if (request && typeof request === "object" && Object.hasOwn(request, "request")) keys.push("request");
			interviewExact(request, keys);
			interviewId(op.targetId);
			interviewId(request.projectId);
			interviewId(request.ownerSessionId);
			if (request.replaces !== undefined) interviewId(request.replaces);
			if (request.request !== undefined) {
				interviewExact(request.request, ["itemId", "revision"]);
				interviewId(request.request.itemId);
				if (!Number.isSafeInteger(request.request.revision) || request.request.revision < 1)
					throw new Conflict("Invalid request revision");
			}
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
			if (request.request !== undefined) await this.requestOpen(request.projectId, request.request);
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
				...(request.request ? { request: { ...request.request } } : {}),
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
		await this.linkRequest(active.binding.missionId);
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
					for (const id of ids) {
						await this.reconcileResearch(id).catch((error: unknown) =>
							console.warn(`pilotd: planning research for ${id} failed: ${error}`),
						);
						await this.reconcileExecution(id).catch((error: unknown) =>
							console.warn(`pilotd: planning work for ${id} failed: ${error}`),
						);
					}
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
		await this.deliverMessages(missionId);
		await this.linkRequest(missionId);
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
			if (entry.kind === "prototype" && !entry.timedOut) {
				const minutes = plan.questions.find((q) => q.id === questionId)?.prototype?.maxMinutes ?? 0;
				const deadline = (entry.startedAt ?? Date.now()) + minutes * 60_000;
				const busy = chat.working || (chat.state !== "idle" && chat.state !== "parked") || !chat.outcome;
				if (busy && Date.now() >= deadline) {
					state = this.changeResearch(state, questionId, { timedOut: true });
					await this.deps.store.durable();
					trace(
						`pilotd: planning ${missionId} prototype chat for ${questionId} reached its ${minutes}-minute limit; stopping it`,
					);
					await this.deps.sessions.stop(entry.sessionId).catch((error: unknown) => {
						console.warn(`pilotd: prototype chat ${entry.sessionId} not stopped: ${error}`);
					});
					continue;
				}
				if (busy) this.prototypeTimer(missionId, entry.sessionId, deadline);
			}
			if (chat.working || (chat.state !== "idle" && chat.state !== "parked") || !chat.outcome) continue;
			if (entry.kind === "prototype") {
				const reply = (await this.deps.sessions.lastAssistantReply(entry.sessionId, RESEARCH_REPORT_LIMIT)) ?? "";
				const artifact = await this.linkPrototype(missionId, entry.sessionId).catch((error: unknown) => {
					console.warn(`pilotd: prototype for ${questionId} not linked to the mission: ${error}`);
					return undefined;
				});
				state = this.changeResearch(this.deps.store.planningWorkers.get(missionId)!, questionId, {
					state: "reporting",
					report: reply.trim() || `The prototype chat ended (${chat.outcome}) without a report.`,
					...(artifact ? { artifact } : {}),
				});
				await this.deps.store.durable();
				continue;
			}

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
		const working = (kind?: "prototype") =>
			Object.values(this.deps.store.planningWorkers.get(missionId)?.research ?? {}).filter(
				(r) => r.kind === kind && (r.state === "starting" || r.state === "running"),
			).length;
		// The planner chooses each prototype's model; a question without one waits for it (Unstick and Continue say so).
		for (const q of planFrontier(plan).filter((x) => x.kind === "prototype" && x.prototype?.model)) {
			if (working("prototype") >= PROTOTYPE_CHATS) break;
			if (!prototypeDue(plan, q, state.research?.[q.id])) continue;
			if (!(await this.startExplorer(state, missionId, q, "prototype"))) return;
			state = this.deps.store.planningWorkers.get(missionId)!;
		}
		let active = working();
		for (const q of planResearchFrontier(plan)) {
			if (active >= RESEARCH_CHATS) return;
			// A question unclaimed after weak findings gets one more research chat, never more.
			const prior = state.research?.[q.id];
			if (prior && !(["reported", "failed"].includes(prior.state) && (prior.attempts ?? 1) < RESEARCH_ATTEMPTS))
				continue;
			if (!(await this.startExplorer(state, missionId, q))) return;
			active++;
			state = this.deps.store.planningWorkers.get(missionId)!;
		}
	}
	/**
	 * Starts a research or prototype chat for map question `q` and claims the question for it. False when Pilot
	 * could not start it (no slot, paused or held): it tries again later, never in a tight loop.
	 */
	private async startExplorer(
		state: PlanningWorkerState,
		missionId: string,
		q: PlanQuestion,
		kind?: "prototype",
	): Promise<boolean> {
		const prior = state.research?.[q.id];
		const earlier = prior?.artifact ?? prior?.earlier;
		state = this.changeResearch(state, q.id, {
			questionDigest: planQuestionDigest(q),
			state: "starting",
			sessionId: null,
			attempts: (prior?.attempts ?? 1) + (prior ? 1 : 0),
			operation: undefined,
			report: undefined,
			reason: undefined,
			kind,
			startedAt: undefined,
			timedOut: undefined,
			artifact: undefined,
			earlier: kind ? earlier : undefined,
		});
		await this.deps.store.durable();
		let sessionId: string;
		try {
			const project = this.deps.projects.require(state.binding.projectId);
			const p = kind ? q.prototype! : undefined;
			// A prototype uses the model its planner chose; research uses the project's task model.
			const selection = await this.deps.sessions.selectTaskModel(project.path, p?.model, p?.thinking);
			this.authority(state.binding);
			const mission = this.deps.store.require(missionId);
			const chat = await this.deps.sessions.spawn(
				{
					projectId: state.binding.projectId,
					missionId,
					mode: "ask",
					title: (p
						? `Prototype: ${q.title} (up to ${p.maxMinutes} min, $${p.maxCostUsd})`
						: `Research: ${q.title}`
					).slice(0, 200),
					message: p ? prototypeMessage(mission.title, q, earlier) : researchMessage(mission.title, q),
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
				if (prior) s.research![q.id] = prior;
				else delete s.research?.[q.id];
			});
			await this.deps.store.durable();
			this.research?.retryAt.set(missionId, Date.now() + RESEARCH_RETRY_MS);
			console.warn(`pilotd: ${kind ?? "research"} chat for ${q.id} not started: ${error}`);
			return false;
		}
		state = this.changeResearch(this.deps.store.planningWorkers.get(missionId)!, q.id, {
			state: "running",
			sessionId,
			...(kind ? { startedAt: Date.now() } : {}),
		});
		await this.deps.store.durable();
		await this.claimResearch(state, q.id, sessionId);
		return true;
	}
	/** Links the newest NSH artifact a prototype chat published to the mission, at its current revision. */
	private async linkPrototype(
		missionId: string,
		sessionId: string,
	): Promise<{ sessionId: string; artifactId: string; revision: number } | undefined> {
		const newest = (await this.deps.sessions.artifacts(sessionId))
			.filter((a) => a.kind === "nsh")
			.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (!newest) return undefined;
		this.deps.store.linkArtifact(
			missionId,
			{ sessionId, artifactId: newest.id, title: newest.title, kind: newest.kind, revision: newest.revision },
			{ sessionId },
		);
		await this.deps.store.durable();
		return { sessionId, artifactId: newest.id, revision: newest.revision };
	}
	/** Wakes the mission's reconcile when a running prototype chat reaches its time limit. */
	private prototypeTimer(missionId: string, sessionId: string, deadline: number): void {
		if (this.prototypeTimers.has(sessionId) || this.closing.signal.aborted) return;
		const timer = setTimeout(
			() => {
				this.prototypeTimers.delete(sessionId);
				this.scheduleResearch(missionId);
			},
			Math.max(0, deadline - Date.now()) + 1000,
		);
		timer.unref?.();
		this.prototypeTimers.set(sessionId, timer);
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
			checkModel: async (model, thinking) => {
				await this.deps.sessions.selectTaskModel(
					this.deps.projects.require(binding.projectId).path,
					model,
					thinking,
				);
			},
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
				? !published || !userAsked(state)
				: request.action === "write"
					? !isPlanOperation(request.request.purpose)
					: request.request.purpose !== "interview-questions")
		)
			throw new Conflict("Planning is held or purpose unavailable");
		if (
			published &&
			(request.action === "write" ||
				(request.action === "revision" ? !userAsked(state) : !state.revisit?.admitted) ||
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
				s.pendingHold = {
					operationId: op.operationId,
					authority,
					round: this.authority(binding, true),
					roundParts: digests(this.authorityParts(binding, true)),
				};
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
			const asked = state.pendingHold?.roundParts;
			if (asked)
				s.holdParts = { operationId: round.operationId, parts: { ...asked, ...digests(this.mapParts(state)) } };
			else delete s.holdParts;
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
			this.stalls.delete(binding.missionId);
			trace(
				`pilotd: planning ${binding.missionId} submitted round ${sent === "accepted" ? "sent to the planner" : `not confirmed (${sent})`} (${op.operationId})`,
			);
		} catch (e) {
			console.warn(`pilotd: planning ${binding.missionId} submitted round not sent: ${e}`);
			const reason = e instanceof Error ? e.message : String(e);
			const seen = this.stalls.get(binding.missionId);
			if (!confirmed && (seen?.operationId !== op.operationId || seen.reason !== reason)) {
				const changes = e instanceof RoundChanged ? e.changes : null;
				this.stalls.set(binding.missionId, {
					at: new Date().toISOString(),
					operationId: op.operationId,
					reason,
					changes,
				});
				this.recordUnstick(binding.missionId, "stalled", { operationId: op.operationId });
			}
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
			if (!confirmed && this.roundContext(state, round) !== state.hold.contextDigest)
				throw new RoundChanged(this.roundChanges(state));
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
				// Thread messages that waited for this round go with the answers.
				for (const m of s.threadQueue ?? []) if (!m.carriedBy) m.carriedBy = op.operationId;
			});
			await this.deps.store.durable();
			guard();
			const service = this.services(binding, guard).interviews;
			const receipt = await this.deps.journal.execute(op, (o, entry) => service.admit(o, entry.firstEntry));
			if (receipt.state === "accepted") {
				this.settleMessages(binding.missionId, op.operationId, true);
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
						? "Work started. When you mark a task's result done, Pilot starts the next ready tasks."
						: "Work started. When you mark a task's result done, Pilot starts the next ready tasks. Read the reports."
					: "Start is not confirmed. Check only; do not start again.",
			};
		try {
			const { pin, task, selection } = await this.nextStart(missionId);
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
	/** The first published task that is ready to start, with its pin and model. Throws when none is. */
	private async nextStart(missionId: string) {
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
		const entry = pin.plan.publication!.tasks.find((p) => p.taskId === task.id)!;
		if (entry.definition !== undefined) {
			// A confirmed revision published this definition; any later change outside a revision shows here.
			if (publishedDefinition(task) !== entry.definition || task.assignment)
				throw new Conflict("Task scope changed since its confirmed revision; no Start authority");
		} else this.matchesSlice(pin, task);
		this.deps.store.prepareTaskStart(missionId, [task.id]);
		const selection = await this.deps.sessions.selectTaskModel(
			pin.project.path,
			task.preferredModel,
			task.preferredThinking,
		);
		if (hash(this.startPin(missionId)) !== hash(pin)) throw new Conflict("Start context changed");
		return { pin, task, selection };
	}
	/** A task published with the plan must still be its slice, as published. */
	private matchesSlice(pin: ReturnType<PlanningWorkers["startPin"]>, task: MissionTask): void {
		const slice = pin.plan.slices.find((s) =>
			pin.plan.publication!.tasks.some((p) => p.sliceId === s.id && p.taskId === task.id),
		)!;
		const body = sliceTaskBody(pin.plan, slice, pin.plan.publication!.briefRevision);
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
	}
	/**
	 * After the user's first Start, Pilot keeps the published plan moving by rule, with no agent. Each time a task is
	 * done (in these missions, the user marked its result done), it starts every published task whose dependencies are
	 * done. Only in planned missions with no execution coordinator. Worker slots, Pause, Stop, dispatch holds and the
	 * published-agreement checks of Start still apply. A refused start is forgotten and tried again on a later change,
	 * at most once per EXECUTION_RETRY_MS.
	 */
	private async reconcileExecution(missionId: string): Promise<void> {
		const { store, sessions } = this.deps;
		const state = store.planningWorkers.get(missionId);
		if (!state?.start?.admitted || !store.plannedWithoutCoordinator(missionId)) return;
		// A start this host entered but did not finish is lookup-only, like the user's Start.
		for (const s of state.autoStarts ?? []) {
			if (s.state !== "starting") continue;
			const admitted = await sessions.lookupPublishedTask(s.sessionId, s.operationId);
			this.changeAutoStart(
				missionId,
				s.operationId,
				admitted ? "admitted" : sessions.get(s.sessionId) ? "failed" : null,
			);
			await store.durable();
		}
		if ((this.executionRetryAt.get(missionId) ?? 0) > Date.now()) return;
		const tried = new Set<string>();
		for (;;) {
			let next: Awaited<ReturnType<PlanningWorkers["nextStart"]>>;
			try {
				next = await this.nextStart(missionId);
			} catch {
				return; // Nothing ready, held, or the published agreement changed.
			}
			if (tried.has(next.task.id)) return;
			tried.add(next.task.id);
			if (!(await this.autoStart(missionId, next))) return;
		}
	}
	private changeAutoStart(
		missionId: string,
		operationId: string,
		next: "admitted" | "failed" | null,
		reason?: string,
	): void {
		const current = this.deps.store.planningWorkers.get(missionId)!;
		this.deps.store.planningWorkers.change(missionId, current.revision, (s) => {
			const list = s.autoStarts ?? [];
			const at = list.findIndex((a) => a.operationId === operationId);
			if (at < 0) return;
			if (next === null) list.splice(at, 1);
			else list[at] = { ...list[at]!, state: next, ...(reason ? { reason } : {}) };
		});
	}
	private async autoStart(
		missionId: string,
		next: Awaited<ReturnType<PlanningWorkers["nextStart"]>>,
	): Promise<boolean> {
		const { store, sessions } = this.deps;
		const { pin, task, selection } = next;
		const operationId = randomUUID(),
			sessionId = randomUUID();
		const current = store.planningWorkers.get(missionId)!;
		store.planningWorkers.change(missionId, current.revision, (s) => {
			s.autoStarts = [
				...(s.autoStarts ?? []),
				{ operationId, sessionId, taskId: task.id, state: "starting", at: Date.now() },
			];
		});
		await store.durable(); // The record precedes every worker effect, so a crash leaves a lookup.
		const check = (claimed: boolean) => {
			const live = this.startPin(missionId);
			if (claimed) {
				const actual = live.tasks.find((t) => t.id === task.id);
				if (!actual || actual.sessionId !== sessionId || actual.status !== "in_progress")
					throw new Conflict("Start assignment changed");
				live.tasks = live.tasks.map((t) =>
					t.id !== task.id
						? t
						: { ...t, sessionId: task.sessionId, status: task.status, updatedAt: task.updatedAt },
				);
			}
			if (hash(live) !== hash(pin)) throw new Conflict("Published plan, owner, project or controls changed");
		};
		try {
			await sessions.admitPublishedTask(
				{
					projectId: pin.project.id,
					missionId,
					message: taskMessage([task], RULE_START_NOTE),
					title: task.title,
					mode: "build",
					...selection,
				},
				{ sessionId, taskId: task.id, operationId, ownerSessionId: pin.binding.ownerSessionId },
				check,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.changeAutoStart(missionId, operationId, sessions.get(sessionId) ? "failed" : null, reason);
			await store.durable();
			this.executionRetryAt.set(missionId, Date.now() + EXECUTION_RETRY_MS);
			console.warn(`pilotd: planning ${missionId} could not start #${task.number} by rule: ${reason}`);
			return false;
		}
		this.changeAutoStart(missionId, operationId, "admitted");
		await store.durable();
		await this.markRequestStarted(missionId, sessionId);
		console.log(`pilotd: planning ${missionId} started #${task.number} ${task.title} by rule`);
		return true;
	}
	/**
	 * Links the Linear issue or Slack request a mission was planned from, once: the request leaves New, and the
	 * mission keeps its link as a reference. Nothing changes in Linear or Slack until the first task starts.
	 * Its progress is read from the request itself, so the planning record's revision never changes for it.
	 */
	private async linkRequest(missionId: string): Promise<void> {
		const { store, tracking } = this.deps;
		const state = store.planningWorkers.get(missionId);
		const request = state?.request;
		if (!state || !request || !tracking || this.requestsSeen.has(missionId)) return;
		// Not during setup or an admission: the added link can change what an admission checks.
		if (state.phase === "setup" || this.admissions.has(missionId) || this.turnAdmissions.has(missionId)) return;
		this.requestsSeen.add(missionId);
		const operationId = state.creation.operationId;
		try {
			let item = await tracking.items.require(request.itemId);
			if (item.missionIds?.includes(missionId) || item.missionId === missionId) return;
			if (item.startOperationId !== operationId)
				item = await tracking.items.intakeWrite(
					state.binding.projectId,
					request.itemId,
					request.revision,
					undefined,
					operationId,
				);
			await tracking.patch(item.id, { missionId }, operationId);
			try {
				store.addResource(missionId, { url: item.url, title: item.title });
			} catch (error) {
				console.warn(`pilotd: planning ${missionId} could not link ${item.url}: ${String(error)}`);
			}
		} catch (error) {
			console.warn(`pilotd: planning ${missionId} could not take its request ${request.itemId}: ${String(error)}`);
		}
	}
	/**
	 * The first task worker marks the mission's request started in Linear or Slack, best effort. A request that
	 * already has a start result or a chat was started before, and is left as it is.
	 */
	private async markRequestStarted(missionId: string, sessionId: string): Promise<void> {
		const { store, tracking } = this.deps;
		const request = store.planningWorkers.get(missionId)?.request;
		if (!request || !tracking || this.requestsStarted.has(missionId)) return;
		this.requestsStarted.add(missionId);
		try {
			const item = await tracking.items.require(request.itemId);
			if (
				!item.missionIds?.includes(missionId) ||
				item.sessionIds?.length ||
				item.metadata.linearStart ||
				item.metadata.slackStart
			)
				return;
			await tracking.patch(request.itemId, { start: true, sessionId });
		} catch (error) {
			console.warn(`pilotd: planning ${missionId} could not mark its request started: ${String(error)}`);
		}
	}
	/** A request the user plans from must still be new in New, in this project, as they saw it. */
	private async requestOpen(projectId: string, request: { itemId: string; revision: number }): Promise<void> {
		if (!this.deps.tracking) throw new Conflict("Requests are unavailable here");
		const item = await this.deps.tracking.items.require(request.itemId);
		if (item.projectId !== projectId) throw new Conflict("That request belongs to another project");
		if (
			item.revision !== request.revision ||
			item.triageState !== "new" ||
			item.startOperationId ||
			item.sessionId ||
			item.missionId ||
			item.sessionIds?.length ||
			item.missionIds?.length
		)
			throw new Conflict("That request changed or already started. Look at it again in New.");
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
		await this.markRequestStarted(op.targetId, sessionId);
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
		for (const timer of this.prototypeTimers.values()) clearTimeout(timer);
		this.prototypeTimers.clear();
		this.closed = Promise.allSettled([...this.tasks, ...this.admissions.values()]).then(() => {
			this.detach();
			this.offSettled();
		});
		return this.closed;
	}
}
