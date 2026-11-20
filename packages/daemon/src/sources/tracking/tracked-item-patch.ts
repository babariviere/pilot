import type { TrackedItemPatch } from "@pilot/protocol";

export function validatePatch(value: unknown): asserts value is TrackedItemPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tracked item patch");
	const patch = value as TrackedItemPatch;
	if (
		Object.keys(value).some(
			(key) => !["dismissed", "sessionId", "missionId", "slack", "start", "linearSize"].includes(key),
		)
	)
		throw new Error("Unknown tracked item field");
	if (patch.linearSize !== undefined && !["quick_fix", "needs_planning", "unknown"].includes(patch.linearSize))
		throw new Error("Invalid Linear size");
	if (patch.start !== undefined && typeof patch.start !== "boolean") throw new Error("start must be a boolean");
	if (
		patch.start &&
		(Number(!!patch.sessionId) + Number(!!patch.missionId) !== 1 ||
			patch.dismissed !== undefined ||
			patch.sessionId === null ||
			patch.missionId === null)
	)
		throw new Error("start requires exactly one chat or mission link");
	if (patch.slack !== undefined) {
		const fields = patch.slack;
		if (
			!fields ||
			typeof fields !== "object" ||
			Array.isArray(fields) ||
			Object.keys(fields).some((key) => !["type", "label", "severity", "status", "details"].includes(key))
		)
			throw new Error("Invalid Slack overrides");
		if (fields.details !== undefined) {
			const details = fields.details;
			if (
				!details ||
				typeof details !== "object" ||
				Array.isArray(details) ||
				Object.keys(details).some((key) => !["client", "issue", "reporter"].includes(key))
			)
				throw new Error("Invalid Slack details");
			for (const detail of Object.values(details)) {
				if (detail === null) continue;
				if (
					!detail ||
					typeof detail !== "object" ||
					Array.isArray(detail) ||
					Object.keys(detail).sort().join(",") !== "evidence,value" ||
					typeof detail.value !== "string" ||
					!detail.value.trim() ||
					detail.value.length > 240 ||
					/[\x00-\x1f\x7f]/.test(detail.value) ||
					typeof detail.evidence !== "string" ||
					!detail.evidence.trim() ||
					detail.evidence.length > 500 ||
					/[\x00-\x08\x0b-\x1f\x7f]/.test(detail.evidence)
				)
					throw new Error("Invalid Slack details");
			}
		}
		if (fields.type !== undefined && !["bug", "question", "request", "unknown"].includes(fields.type))
			throw new Error("Invalid Slack type");
		if (fields.severity !== undefined && !["low", "medium", "high", "critical"].includes(fields.severity))
			throw new Error("Invalid Slack severity");
		if (
			fields.status !== undefined &&
			!["open", "in_progress", "waiting", "done", "dismissed"].includes(fields.status)
		)
			throw new Error("Invalid Slack status");
		if (
			fields.status !== undefined &&
			patch.dismissed !== undefined &&
			patch.dismissed !== (fields.status === "dismissed")
		)
			throw new Error("Conflicting Slack status and dismissed fields");
		if (
			fields.label !== undefined &&
			fields.label !== null &&
			(typeof fields.label !== "string" ||
				!fields.label.trim() ||
				fields.label.length > 80 ||
				/[\x00-\x1f]/.test(fields.label))
		)
			throw new Error("Invalid Slack label");
	}
	if (patch.dismissed !== undefined && typeof patch.dismissed !== "boolean")
		throw new Error("dismissed must be a boolean");
	for (const link of [patch.sessionId, patch.missionId])
		if (link !== undefined && link !== null && (typeof link !== "string" || !link.trim() || link.length > 200))
			throw new Error("Invalid tracked item link");
}
