import type {
	DurableOperation,
	InsightsCreatePayload,
	InsightsDisclosure,
	InsightsFindingDraft,
	InsightsFindingSummary,
	InsightsFindingsPage,
	InsightsLifecycle,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { InsightsBacklog } from "./insights-backlog.ts";
import { OperationRejected } from "./operation-journal.ts";
import type { SessionManager } from "./sessions.ts";

/** Protocol remains types-only; native callers acknowledge this literal version. */
export const INSIGHTS_DISCLOSURE: InsightsDisclosure = "insights-history-v1";
export const INSIGHTS_SETUP_MESSAGE =
	"This chat is set up for Pilot Insights. Briefly confirm your role and limits. Do not read chat history or start a review until a review is requested.";

export function isInsightsOperation(kind: string): boolean {
	return ["insights-create", "insights-revoke", "insights-lifecycle"].includes(kind);
}

function exact(payload: Record<string, unknown>, keys: string[], optional: string[] = []): void {
	if (
		keys.some((key) => !Object.hasOwn(payload, key)) ||
		Object.keys(payload).some((key) => !keys.includes(key) && !optional.includes(key))
	)
		throw new OperationRejected("Expected exact Insights payload");
}

/** Only previously reserved native-confirmed operations reach this recovery-safe handler. */
export async function admitInsightsOperation(
	sessions: SessionManager,
	backlog: InsightsBacklog,
	op: DurableOperation,
	payload: Record<string, unknown>,
): Promise<unknown> {
	try {
		if (op.kind === "insights-create") {
			exact(payload, ["projectId", "missionId", "model", "disclosure"], ["thinking"]);
			if (
				![payload.projectId, payload.missionId].every(
					(value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value),
				) ||
				typeof payload.model !== "string" ||
				!payload.model.trim() ||
				(payload.thinking !== undefined &&
					(typeof payload.thinking !== "string" ||
						!["off", "minimal", "low", "medium", "high", "xhigh"].includes(payload.thinking))) ||
				payload.disclosure !== INSIGHTS_DISCLOSURE
			)
				throw new OperationRejected("Invalid Insights setup or disclosure");
			const { projectId, missionId, model, thinking } = payload as unknown as InsightsCreatePayload;
			const session = await sessions.spawnInsightsDurable(
				{ projectId, missionId, model, thinking, message: INSIGHTS_SETUP_MESSAGE },
				op.targetId,
				op.operationId,
			);
			return { sessionId: session.id };
		}
		exact(payload, op.kind === "insights-revoke" ? ["expectedRevision"] : ["key", "expectedRevision", "lifecycle"]);
		if (!Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 1)
			throw new OperationRejected("expectedRevision must be an integer >= 1");
		const expectedRevision = payload.expectedRevision as number;
		const status = sessions.insightsStatus(op.targetId);
		if (!status) throw new OperationRejected("Not an Insights session");
		if (op.kind === "insights-revoke") {
			if (!status.enabled && status.revision === expectedRevision + 1)
				return { sessionId: op.targetId, revision: status.revision };
			await sessions.revokeInsights(op.targetId, expectedRevision);
			return { sessionId: op.targetId, revision: expectedRevision + 1 };
		}
		if (
			typeof payload.key !== "string" ||
			!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(payload.key) ||
			!["proposed", "approved", "in_progress", "shipped", "verified", "deferred", "dismissed"].includes(
				payload.lifecycle as string,
			)
		)
			throw new OperationRejected("Invalid finding key or lifecycle");
		const receipt = await backlog.confirmLifecycle(
			sessions.insightsHostAdmission(op.targetId),
			payload.key,
			expectedRevision,
			payload.lifecycle as InsightsLifecycle,
			op.operationId,
		);
		return { sessionId: op.targetId, ...(receipt as object) };
	} catch (error) {
		// Validation/CAS failures are stable rejections, not indefinitely retryable receipts.
		// I/O and durability failures remain pending so journal recovery can find their receipts.
		if (error instanceof Conflict || error instanceof NotFound) throw new OperationRejected(error.message);
		throw error;
	}
}

/** List is metadata-only. Resolve at most twenty own records, never history or source workers. */
export async function insightsFindingsPage(
	sessions: SessionManager,
	backlog: InsightsBacklog,
	id: string,
	cursor: number,
): Promise<InsightsFindingsPage> {
	const admission = sessions.insightsHostAdmission(id);
	const page = (await backlog.call(admission, { action: "list", kind: "finding", cursor, limit: 20 })) as {
		items: Array<{ key: string }>;
		nextCursor: number | null;
	};
	const items: InsightsFindingSummary[] = [];
	for (const row of page.items) {
		const item = (await backlog.call(admission, { action: "get", kind: "finding", key: row.key })) as {
			key: string;
			revision: number;
			taskId: string;
			lifecycle: InsightsLifecycle;
			payload: InsightsFindingDraft;
		};
		items.push({
			key: item.key,
			revision: item.revision,
			taskId: item.taskId,
			lifecycle: item.lifecycle,
			title: item.payload.title,
			priority: item.payload.priority,
			targets: item.payload.targets,
			cost: item.payload.cost ?? null,
		});
	}
	admission.revalidate();
	return { items, nextCursor: page.nextCursor };
}
