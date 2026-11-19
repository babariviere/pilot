import type {
	DeliveredWork,
	DeliveredWorkList,
	DurableOperation,
	SessionSummary,
	UserVerificationIntent,
	UserVerificationLookup,
	VerificationSubject,
} from "@pilot/protocol";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
/** How many delivered results one discovery page reads at most, checked or not. */
const DISCOVERY_SCAN = 200;
export const verificationKey = (subject: VerificationSubject) => payloadHash(canonicalJSON(subject));
/**
 * How much of a finished chat's last reply a result shows: about four screens of text. An answer fits; a longer one
 * is cut and says so, and the chat keeps it whole. It keeps each result read small, since Day reads it when it opens.
 */
export const FINAL_REPLY_CHARS = 16_000;

/**
 * Where a chat with no delivered result is, from its summary, so the page can name the action that moves it. A chat
 * waiting for a reply shows even with an earlier result: it has nothing new for the user to check.
 */
export function chatState(chat: SessionSummary | undefined): DeliveredWork["chat"] {
	if (!chat || chat.archivedAt !== undefined) return undefined;
	const reason = chat.outcomeReason ?? chat.error;
	const state: NonNullable<DeliveredWork["chat"]>["state"] = chat.codingQueueReason
		? "queued"
		: chat.working || chat.state === "working" || chat.state === "starting"
			? "working"
			: chat.outcome === "question" || chat.attentionReason?.kind === "asks"
				? "question"
				: chat.waitsForReply
					? "waiting"
					: chat.outcome === "stopped" || chat.workHolds?.includes("User Stop hold")
						? "stopped"
						: chat.outcome === "failed" || chat.state === "failed"
							? "failed"
							: chat.outcome === "done"
								? "done"
								: "idle";
	return {
		state,
		...(state === "queued" ? { reason: chat.codingQueueReason } : reason && state === "failed" ? { reason } : {}),
		...(state === "queued" && chat.codingQueue ? { queue: chat.codingQueue } : {}),
		...(chat.canContinue ? { canContinue: true as const } : {}),
	};
}
interface Dependencies {
	store: MissionStore;
	journal: OperationJournal;
	projects: Pick<ProjectStore, "require">;
	sessions: Pick<SessionManager, "get" | "sendDurable" | "lastAssistantReply" | "chatReport"> &
		Partial<Pick<SessionManager, "waitingSays">>;
}

/** User assessment is independent of agent completion, review, task status and production. */
export class UserVerifications {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	/** Passive discovery. Only the first-use cutoff is saved, never acceptance or a moving read cursor. */
	async list(projectId: string, after?: number): Promise<DeliveredWorkList> {
		if (!id(projectId) || (after !== undefined && (!Number.isSafeInteger(after) || after < 0)))
			throw new OperationRejected("Invalid delivery discovery cursor");
		this.deps.projects.require(projectId);
		await this.deps.store.durable();
		const source = this.deps.store.userVerifications;
		const baseline = source.discoveryBaseline();
		// Do not acknowledge a cutoff that is only in the in-memory replica.
		await this.deps.store.durable();
		const through = source.sourceCursor();
		if (after !== undefined && (after < baseline || after > through))
			throw new OperationRejected("Invalid delivery discovery cursor");
		const items: DeliveredWorkList["items"] = [];
		const observed: DeliveredWork[] = [];
		// A page holds results that still wait for a check. Results already checked are passed over, up to
		// DISCOVERY_SCAN of them, so pending results do not hide behind pages of done ones.
		let cursor = after ?? baseline;
		let more = false;
		let scanned = 0;
		scan: for (;;) {
			const candidates = source.discoveryCandidates(projectId, cursor, through, 21);
			for (const c of candidates) {
				if (items.length === 20 || scanned === DISCOVERY_SCAN) {
					more = true;
					break scan;
				}
				const subject: VerificationSubject = { kind: "task", projectId, missionId: c.missionId, taskId: c.taskId };
				const snapshot = await this.read(subject);
				observed.push(snapshot);
				cursor = c.sequence;
				scanned++;
				// Unknown/missing outer receipts never hide a pending check.
				if (
					snapshot.deliveryId &&
					!(
						snapshot.verificationCurrent &&
						!snapshot.pendingOperationId &&
						(snapshot.verification?.state === "done" || snapshot.verification?.state === "sent_back")
					)
				)
					items.push({
						subject,
						title: this.deps.store.task(c.missionId, c.taskId).title,
						snapshot,
						sourceSequence: c.sequence,
					});
			}
			if (candidates.length < 21) break;
		}
		if (Buffer.byteLength(JSON.stringify(items)) > 1024 * 1024)
			throw new OperationRejected("Delivery discovery page exceeds capacity; inspect results in their missions");
		await this.deps.store.durable();
		this.deps.projects.require(projectId);
		const unchanged = () =>
			observed.every((shown) => {
				const now = this.readNow(shown.subject);
				const pending =
					now.pendingOperationId ??
					(shown.verificationReceiptState === "unknown" ? (now.verification?.operationId ?? null) : null);
				return (
					now.deliveryId === shown.deliveryId &&
					now.ownerSessionId === shown.ownerSessionId &&
					now.verificationRevision === shown.verificationRevision &&
					now.reviewQueue === shown.reviewQueue &&
					pending === shown.pendingOperationId
				);
			});
		const selections = source.reviewSelections(projectId);
		const selected: NonNullable<DeliveredWorkList["selected"]> = [];
		let selectedUnavailable = false;
		for (const entry of selections.slice(0, 20)) {
			let snapshot: DeliveredWork;
			try {
				snapshot = await this.read(entry.subject);
			} catch {
				selectedUnavailable = true;
				continue;
			}
			observed.push(snapshot);
			if (
				snapshot.deliveryId !== entry.deliveryId ||
				(snapshot.verificationCurrent && snapshot.verification?.state !== "open")
			)
				continue;
			selected.push({
				subject: entry.subject,
				snapshot,
				title:
					entry.subject.kind === "task"
						? this.deps.store.task(entry.subject.missionId, entry.subject.taskId).title
						: (snapshot.title ?? "Standalone result"),
			});
		}
		await this.deps.store.durable();
		this.deps.projects.require(projectId);
		const currentness = source.sourceCursor() === through && unchanged() ? "live" : "stale";
		if (Buffer.byteLength(JSON.stringify({ items, selected })) > 1024 * 1024)
			throw new OperationRejected(
				"Delivery discovery including selected older work exceeds 1 MiB; inspect individual results in their missions",
			);
		return {
			version: 1,
			projectId,
			baseline: { mode: "start_fresh", sourceSequence: baseline },
			sourceCursor: through,
			nextCursor: more ? cursor : null,
			more,
			complete: !more && currentness === "live",
			currentness,
			items,
			selected,
			selectedMore: selections.length > 20,
			selectedUnavailable,
		};
	}
	private subject(s: VerificationSubject) {
		if (
			!s ||
			typeof s !== "object" ||
			Array.isArray(s) ||
			!id(s.projectId) ||
			(s.kind === "task"
				? !id(s.missionId) || !id(s.taskId) || Object.keys(s).sort().join() !== "kind,missionId,projectId,taskId"
				: s.kind !== "chat" || !id(s.sessionId) || Object.keys(s).sort().join() !== "kind,projectId,sessionId")
		)
			throw new OperationRejected("Exact task or standalone chat subject required");
	}
	/** Caller crosses the shared durability barrier before this synchronous, indexed projection. */
	readNow(subject: VerificationSubject): DeliveredWork {
		this.subject(subject);
		this.deps.projects.require(subject.projectId);
		let ownerSessionId: string | null = null;
		let revisionRecipientSessionId: string | undefined;
		let title: string | undefined;
		let scope: string | undefined, taskState: string | undefined;
		let identity: unknown = null;
		let outputs: Pick<
			DeliveredWork,
			| "completion"
			| "nonCodeDelivery"
			| "pullRequests"
			| "artifacts"
			| "outcome"
			| "submissionId"
			| "submission"
			| "workerDelivery"
			| "coordinatorRequests"
			| "screens"
		> = { pullRequests: [], artifacts: [] };
		if (subject.kind === "task") {
			const mission = this.deps.store.require(subject.missionId);
			if (mission.projectId !== subject.projectId) throw new OperationRejected("Task belongs to another project");
			const task = this.deps.store.task(subject.missionId, subject.taskId);
			title = task.title;
			scope = task.body;
			taskState = task.status;
			ownerSessionId = task.sessionId ?? null;
			// Routing follows the assigned coordinator, not their current availability.
			// Admission refuses a missing/retired recipient instead of bypassing them.
			if (mission.coordinatorSessionId && !this.deps.store.plannedWithoutCoordinator(subject.missionId))
				revisionRecipientSessionId = mission.coordinatorSessionId;
			outputs = this.deps.store.taskOutputs(subject.missionId, subject.taskId);
			// The current worker's latest named screens. A later report without them does not hide them.
			const screensReport = task.sessionId
				? this.deps.store.controls.latestScreensReport(subject.missionId, subject.taskId, task.sessionId)
				: undefined;
			if (screensReport?.write.delivery?.screens)
				outputs.screens = {
					...screensReport.write.delivery.screens,
					reportId: screensReport.write.reportId,
					reportedAt: screensReport.reportedAt,
				};
			const screens = outputs.screens ? { screens: outputs.screens.reportId } : {};
			const submission = this.deps.store
				.currentDeliveryEvidence(subject.missionId, subject.taskId)
				.find((r) => r.type === "submission");
			if (submission) {
				outputs.submissionId = submission.id;
				outputs.submission = {
					id: submission.id,
					kind: submission.request.kind,
					claim: submission.request.claim,
					limitations: submission.request.limitations,
					evidence: submission.request.evidence,
				};
			}
			if (outputs.completion || outputs.nonCodeDelivery || submission)
				identity = {
					completion: outputs.completion ?? null,
					nonCodeDelivery: outputs.nonCodeDelivery ?? null,
					submissionId: submission?.id ?? null,
					definition: { title: task.title, body: task.body, assignment: task.assignment ?? null },
					// Pins change delivery identity; PR tracking state is separate and must not imply production.
					artifacts: outputs.artifacts.map((a) => [a.sessionId, a.artifactId, a.revision ?? null]),
					pullRequests: outputs.pullRequests.map((r) => r.id),
					...screens,
				};
			// A planned mission whose coordinator is its planning chat has no one to complete tasks or read workers'
			// requests. The current worker's latest delivery report is then the result, and its requests are shown.
			if (this.deps.store.plannedWithoutCoordinator(subject.missionId)) {
				const report = this.deps.store.controls.latestReport(subject.missionId, subject.taskId);
				const delivery = report?.write.delivery;
				if (!identity && report && delivery && report.sessionId === task.sessionId) {
					const { screens: _named, ...facts } = delivery;
					outputs.workerDelivery = {
						reportId: report.write.reportId,
						reportedAt: report.reportedAt,
						summary: report.write.summary,
						nextStep: report.write.nextStep,
						evidence: report.write.evidence,
						...facts,
					};
					identity = {
						workerReport: report.write.reportId,
						definition: { title: task.title, body: task.body, assignment: task.assignment ?? null },
						artifacts: outputs.artifacts.map((a) => [a.sessionId, a.artifactId, a.revision ?? null]),
						pullRequests: outputs.pullRequests.map((r) => r.id),
						...screens,
					};
				}
				const requests = task.sessionId
					? this.deps.store.openCoordinatorComments(subject.missionId, task.sessionId)
					: [];
				if (requests.length) outputs.coordinatorRequests = requests;
			}
		} else {
			const chat = this.deps.sessions.get(subject.sessionId);
			if (!chat || chat.projectId !== subject.projectId || this.deps.store.membership(chat.id))
				throw new OperationRejected("Standalone chat belongs to another scope");
			ownerSessionId = chat.id;
			// The chat's own title names its result, so the page keeps it after a restart.
			if (chat.title) title = chat.title;
			if (
				chat.outcome === "done" &&
				Number.isSafeInteger(chat.outcomeAt) &&
				!chat.working &&
				chat.state !== "working"
			) {
				outputs.outcome = {
					outcomeAt: chat.outcomeAt!,
					...(chat.outcomeReason ? { reason: chat.outcomeReason } : {}),
				};
				identity = { ...outputs.outcome, inputGeneration: chat.inputGeneration ?? 0 };
			}
		}
		const deliveryId = identity ? payloadHash(canonicalJSON({ subject, ownerSessionId, identity })) : null;
		const owner = ownerSessionId ? this.deps.sessions.get(ownerSessionId) : undefined;
		const chat = !deliveryId || owner?.waitsForReply ? chatState(owner) : undefined;
		const key = verificationKey(subject),
			verification = this.deps.store.userVerifications.current(key);
		const queue = this.deps.store.userVerifications.reviewQueue(key, deliveryId);
		return {
			version: 1,
			subject,
			targetId: key,
			deliveryId,
			ownerSessionId,
			...(revisionRecipientSessionId ? { revisionRecipientSessionId } : {}),
			...(chat ? { chat } : {}),
			...(title ? { title } : {}),
			...(scope ? { scope } : {}),
			...(taskState ? { taskState } : {}),
			...(queue ? { reviewQueue: queue } : {}),
			...outputs,
			production: "not_tracked",
			verification,
			verificationCurrent: deliveryId !== null && verification?.deliveryId === deliveryId,
			verificationReceiptState: "unknown",
			verificationRevision: verification?.revision ?? 0,
			pendingOperationId: this.deps.store.userVerifications.pending(key),
		};
	}
	async read(subject: VerificationSubject): Promise<DeliveredWork> {
		await this.deps.store.durable();
		const before = this.readNow(subject);
		const domain = before.verification
			? this.deps.store.userVerifications.operation(before.verification.operationId)
			: null;
		const outer = domain ? await this.deps.journal.lookup(domain.operation) : undefined;
		await this.deps.store.durable();
		const current = this.readNow(subject);
		const exact =
			!!current.verification &&
			current.verification.operationId === domain?.operationId &&
			domain.state === "accepted" &&
			outer?.state === "accepted" &&
			outer.payloadHash === domain.payloadHash &&
			canonicalJSON(outer.result) === canonicalJSON(current.verification);
		// A finished job chat's report counts only when its latest run saved it. Without one, its answer is its last
		// reply. Both are read only for this one result, never for discovery pages.
		const chatId = current.subject.kind === "chat" && current.outcome ? current.subject.sessionId : undefined;
		const saved = chatId ? await this.deps.sessions.chatReport(chatId).catch(() => undefined) : undefined;
		const askedAt = chatId ? (this.deps.sessions.get(chatId)?.lastUserMessageAt ?? 0) : 0;
		const chatReport = saved && saved.at >= askedAt && saved.at <= current.outcome!.outcomeAt ? saved : undefined;
		const reply =
			chatId && !chatReport
				? await this.deps.sessions.lastAssistantReply(chatId, FINAL_REPLY_CHARS + 1).catch(() => undefined)
				: undefined;
		// A chat waiting for a reply shows its last message, so the user can answer it here.
		const says =
			current.chat?.state === "waiting" && current.ownerSessionId
				? await this.deps.sessions.waitingSays?.(current.ownerSessionId)
				: undefined;
		return {
			...current,
			...(says && current.chat ? { chat: { ...current.chat, says } } : {}),
			...(chatReport ? { chatReport } : {}),
			...(reply?.trim()
				? {
						finalReply: {
							text: reply.slice(0, FINAL_REPLY_CHARS),
							shortened: reply.length > FINAL_REPLY_CHARS,
						},
					}
				: {}),
			verificationReceiptState: exact ? "accepted" : "unknown",
			verificationCurrent: exact && current.verificationCurrent,
			pendingOperationId:
				current.pendingOperationId ?? (current.verification && !exact ? current.verification.operationId : null),
		};
	}
	/**
	 * In a planned mission with no execution coordinator, no one else finishes tasks, so the user's check moves the
	 * task: Done finishes it, and a send-back or reopen of a finished task puts it back in progress. The planning host
	 * then starts the next ready tasks. The check stays saved if this fails; marking it again retries.
	 */
	private followCheck(missionId: string, taskId: string, state: "done" | "sent_back" | "open"): void {
		try {
			if (!this.deps.store.plannedWithoutCoordinator(missionId)) return;
			const task = this.deps.store.task(missionId, taskId);
			if (state === "done" && task.status !== "done")
				this.deps.store.updateTask(missionId, taskId, { status: "done" });
			else if (state !== "done" && task.status === "done")
				this.deps.store.updateTask(missionId, taskId, { status: "in_progress" });
		} catch (error) {
			console.warn(`pilotd: could not follow the user's check of task ${taskId}: ${error}`);
		}
	}
	private request(op: DurableOperation): UserVerificationIntent {
		let p: UserVerificationIntent;
		try {
			p = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid verification payload");
		}
		if (
			!p ||
			typeof p !== "object" ||
			Array.isArray(p) ||
			Object.keys(p)
				.filter((k) => k !== "revisionRecipientSessionId")
				.sort()
				.join() !== "action,deliveryId,expectedRevision,note,purpose,subject" ||
			(p.revisionRecipientSessionId !== undefined &&
				(p.action !== "send_back" || !id(p.revisionRecipientSessionId))) ||
			p.purpose !== "user-verification" ||
			op.kind !== p.purpose ||
			!hash(p.deliveryId) ||
			!Number.isSafeInteger(p.expectedRevision) ||
			p.expectedRevision < 0 ||
			!["done", "send_back", "reopen"].includes(p.action) ||
			typeof p.note !== "string" ||
			Buffer.byteLength(p.note) > 8000 ||
			(p.action === "send_back" ? !p.note.trim() : p.note !== "") ||
			!op.origin ||
			op.origin.hostId !== "local" ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			op.bindingId !== p.deliveryId ||
			op.bindingGeneration !== 1
		)
			throw new OperationRejected("Invalid native verification intent");
		this.subject(p.subject);
		if (op.targetId !== verificationKey(p.subject)) throw new OperationRejected("Verification target changed");
		return p;
	}
	/** Lookup returns both receipts. It never sends, settles, or re-enters a handler. */
	async lookup(op: DurableOperation): Promise<UserVerificationLookup> {
		const p = this.request(op);
		const receipt = await this.deps.journal.lookup(op);
		await this.deps.store.durable();
		// Scope authorization still applies to historical receipts, not delivery currentness.
		this.readNow(p.subject);
		const domain = this.deps.store.userVerifications.operation(op.operationId);
		if (domain && (domain.payloadHash !== op.payloadHash || canonicalJSON(domain.intent) !== canonicalJSON(p)))
			throw new OperationRejected("Verification operation identity reused");
		return { receipt: receipt ?? { state: "unknown" }, verificationReceipt: domain };
	}
	async admit(op: DurableOperation, firstEntry: boolean) {
		const p = this.request(op);
		if (!firstEntry) throw new Error("Verification may have entered; Check only");
		const acknowledged = await this.read(p.subject);
		const current = this.readNow(p.subject),
			key = verificationKey(p.subject);
		if (acknowledged.pendingOperationId) throw new OperationRejected("Prior verification is uncertain; Check only");
		if (
			current.deliveryId !== p.deliveryId ||
			current.verificationRevision !== p.expectedRevision ||
			current.pendingOperationId
		)
			throw new OperationRejected("Delivery or verification changed; refresh before acting");
		if (
			p.action === "reopen"
				? !current.verificationCurrent || current.verification?.state === "open"
				: current.verificationCurrent && current.verification?.state !== "open"
		)
			throw new OperationRejected("Reopen a checked result before changing its assessment");
		const sessionId = current.revisionRecipientSessionId ?? current.ownerSessionId;
		if (p.action === "send_back" && (p.revisionRecipientSessionId ?? current.ownerSessionId) !== sessionId)
			throw new OperationRejected("Revision recipient changed; refresh before sending");
		const missionId = p.subject.kind === "task" ? p.subject.missionId : undefined;
		const workHeld = () =>
			!!missionId &&
			(this.deps.store.require(missionId).status !== "active" ||
				this.deps.store.controls.fenceCurrent(missionId).held);
		// The broad native definition fence also catches owner/Stop ABA during admission.
		// Keep it separate from delivery identity: task status changes are not a new result.
		const definitionRevision =
			p.subject.kind === "task" ? this.deps.store.sharedDefinitionRevision(p.subject.taskId) : null;
		const chat = sessionId ? this.deps.sessions.get(sessionId) : undefined;
		if (
			p.action === "send_back" &&
			(!chat ||
				chat.projectId !== p.subject.projectId ||
				(p.subject.kind === "task" && this.deps.store.missionOf(chat.id) !== p.subject.missionId) ||
				chat.archivedAt !== undefined ||
				chat.sleepPaused ||
				chat.offlinePaused ||
				chat.subscriptionPause ||
				workHeld())
		)
			throw new OperationRejected("Revision recipient is unavailable or held; no automatic restore or resume");
		const reservation = {
			operation: op,
			operationId: op.operationId,
			payloadHash: op.payloadHash,
			intent: p,
			state: "pending" as const,
			verification: {
				version: 1 as const,
				subject: p.subject,
				deliveryId: p.deliveryId,
				revision: p.expectedRevision + 1,
				operationId: op.operationId,
				state:
					p.action === "send_back"
						? ("sent_back" as const)
						: p.action === "reopen"
							? ("open" as const)
							: ("done" as const),
				note: p.note,
				createdAt: Date.now(),
			},
		};
		this.deps.store.userVerifications.reserve(key, reservation);
		await this.deps.store.durable();
		// After durable reservation, every failure is uncertain, never a safe-to-retry rejection.
		const guard = () => {
			const live = this.readNow(p.subject);
			if (
				live.deliveryId !== p.deliveryId ||
				(p.action === "send_back" && (live.revisionRecipientSessionId ?? live.ownerSessionId) !== sessionId) ||
				live.verificationRevision !== p.expectedRevision ||
				live.pendingOperationId !== op.operationId ||
				(p.subject.kind === "task" &&
					this.deps.store.sharedDefinitionRevision(p.subject.taskId) !== definitionRevision)
			)
				throw new Error("Delivery changed after verification entered; Check only");
			if (p.action === "send_back") {
				const now = this.deps.sessions.get(sessionId!);
				if (
					!now ||
					now.projectId !== p.subject.projectId ||
					now.archivedAt !== undefined ||
					now.sleepPaused ||
					now.offlinePaused ||
					now.subscriptionPause ||
					(p.subject.kind === "task" && this.deps.store.missionOf(now.id) !== p.subject.missionId) ||
					(now.inputGeneration ?? 0) !== (chat!.inputGeneration ?? 0) ||
					workHeld()
				)
					throw new Error("Revision recipient changed or is held; Check only");
			}
		};
		try {
			guard();
			if (p.action === "send_back") {
				await this.deps.sessions.sendDurable(sessionId!, p.note, "followUp", op.operationId, {
					inputGeneration: chat!.inputGeneration ?? 0,
					admissionGuard: guard,
				});
			}
			const verification = {
				...reservation.verification,
				...(p.action === "send_back"
					? { messageReceipt: { sessionId: sessionId!, requestId: op.operationId, state: "admitted" as const } }
					: {}),
			};
			this.deps.store.userVerifications.settle(key, { ...reservation, verification });
			await this.deps.store.durable();
			if (p.subject.kind === "task") this.followCheck(p.subject.missionId, p.subject.taskId, verification.state);
			return verification;
		} catch (error) {
			throw new Error("Verification outcome is uncertain; Check only", { cause: error });
		}
	}
}
