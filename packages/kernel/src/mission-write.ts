/** The mission tool contract shared by the kernel tool and pilotd: actions, statuses and write limits. */

/** Agent write limits only, in Unicode code points. Reads and stored legacy content are deliberately not validated. */
export const MISSION_WRITE_LIMITS = { decision: 1000, title: 200, body: 4000, brief: 12000 } as const;

/**
 * Limits pilotd enforces on saved mission text for every writer (the user, the app and agents; agents also meet the
 * smaller MISSION_WRITE_LIMITS). "text" covers task bodies, decisions, comments, reasons and log entries. The brief
 * limit keeps one row and its prompt copies small. Reads never check them.
 */
export const MISSION_STORE_LIMITS = { title: 200, text: 8000, goal: 4000, brief: 256 * 1024 } as const;

/** Worker report fields. They keep coordinator notices and report reads small. */
export const MISSION_REPORT_LIMITS = {
	id: 128,
	summary: 2000,
	nextStep: 1000,
	evidence: 1000,
	evidenceItems: 16,
} as const;

/** Delivery facts, in worker reports and in the coordinator's task completion. */
export const MISSION_DELIVERY_LIMITS = { checks: 2000, issues: 1000 } as const;

/** A builder's task prototype request. requestId is the builder's own retry key. */
export const TASK_PROTOTYPE_LIMITS = {
	requestId: /^[A-Za-z0-9_-]{1,128}$/,
	question: 4000,
	model: 256,
	thinking: 32,
	/** Prototypes per task, so a builder cannot loop on prototypes without the user. */
	attempts: 3,
} as const;

/** Keep the composed opening prompt small. Larger context belongs in the brief or linked material. */
export const MISSION_OPENING_MESSAGE_LIMIT = 4000;

/** Allow a second independent code task without letting one mission take every coding slot. */
export const MISSION_WORKER_CAP = 2;

export const MISSION_TASK_STATUSES = [
	"todo",
	"in_progress",
	"blocked",
	"in_review",
	"delegated",
	"done",
	"dropped",
] as const;

/** Actions only the mission coordinator may take. Members also get the rest of the mission tool. */
export const COORDINATOR_ACTIONS = [
	"checkIn",
	"complete",
	"revision-source",
	"revision-propose",
	"revision",
	"claim",
	"release",
	"propose",
	"supersede",
	"delete",
	"group",
	"phase",
	"start",
	"send",
	"status",
	"bindPr",
	"unbindPr",
	"split",
	"updateLink",
	"answer",
	"archiveWorker",
	"restoreWorker",
	"requestReview",
	"retireReview",
] as const;

/** Task fields only the coordinator may set with the task action. */
export const COORDINATOR_TASK_FIELDS = ["order", "model", "thinking"] as const;

/** Count Unicode code points, including whitespace, without normalization or truncation. */
export function validateMissionWrite(action: string, args: Record<string, unknown>): void {
	const check = (value: unknown, field: string, limit: number) => {
		if (typeof value !== "string") return; // Existing shape validation owns non-string errors.
		const count = Array.from(value).length;
		if (count > limit)
			throw new Error(
				`${field} has ${count} characters; limit is ${limit} (Unicode code points). Summarize and link supporting material.`,
			);
	};
	const task = (draft: Record<string, unknown>, prefix = "Task") => {
		check(draft.title, `${prefix} title`, MISSION_WRITE_LIMITS.title);
		check(draft.body, `${prefix} body`, MISSION_WRITE_LIMITS.body);
	};
	if (action === "task") task(args);
	if (action === "split" && Array.isArray(args.tasks))
		for (const [index, draft] of args.tasks.entries())
			if (draft && typeof draft === "object" && !Array.isArray(draft))
				task(draft as Record<string, unknown>, `Task ${index + 1}`);
	if (action === "brief") check(args.markdown, "Brief", MISSION_WRITE_LIMITS.brief);
	if (action === "decide" || action === "propose") check(args.text, "Decision text", MISSION_WRITE_LIMITS.decision);
}
