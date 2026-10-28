/** Agent write limits only. Reads and stored legacy content are deliberately not validated. */
export const MISSION_AUTHORING_LIMITS = { decision: 1000, title: 200, body: 4000, brief: 12000 } as const;

/** Count Unicode code points, including whitespace, without normalization or truncation. */
export function validateMissionAuthoring(action: string, args: Record<string, unknown>): void {
	const check = (value: unknown, field: string, limit: number) => {
		if (typeof value !== "string") return; // Existing shape validation owns non-string errors.
		const count = Array.from(value).length;
		if (count > limit)
			throw new Error(
				`${field} has ${count} characters; limit is ${limit} (Unicode code points). Summarize and link supporting material.`,
			);
	};
	const task = (draft: Record<string, unknown>, prefix = "Task") => {
		check(draft.title, `${prefix} title`, MISSION_AUTHORING_LIMITS.title);
		check(draft.body, `${prefix} body`, MISSION_AUTHORING_LIMITS.body);
	};
	if (action === "task") task(args);
	if (action === "split" && Array.isArray(args.tasks))
		for (const [index, draft] of args.tasks.entries())
			if (draft && typeof draft === "object" && !Array.isArray(draft))
				task(draft as Record<string, unknown>, `Task ${index + 1}`);
	if (action === "brief") check(args.markdown, "Brief", MISSION_AUTHORING_LIMITS.brief);
	if (action === "decide" || action === "propose")
		check(args.text, "Decision text", MISSION_AUTHORING_LIMITS.decision);
}
