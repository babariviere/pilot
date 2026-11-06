import type { InsightsOwnerBinding } from "@pilot/protocol";

const exact = (value: unknown, keys: string) =>
	!!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const uuid = (value: unknown) =>
	typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const host = (value: unknown): value is InsightsOwnerBinding["host"] =>
	exact(value, "daemonId,hostId,lineageId") &&
	Object.values(value as object).every((v) => typeof v === "string" && !!v && v.length <= 128);

/** Independent closed v2 parser. It neither accepts nor changes the v1 binding contract. */
export function validateInsightsOwnerBinding(value: unknown): asserts value is InsightsOwnerBinding {
	const b = value as InsightsOwnerBinding;
	if (
		!exact(b, "enabled,grantId,host,owner,projectId,reportSessionId,revision,schemaVersion") ||
		b.schemaVersion !== 2 ||
		b.enabled !== true ||
		!Number.isSafeInteger(b.revision) ||
		b.revision < 1 ||
		!uuid(b.grantId) ||
		!uuid(b.reportSessionId) ||
		typeof b.projectId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/u.test(b.projectId) ||
		!host(b.host) ||
		!exact(b.owner, "context,expectedHome,projectId,reportSessionId,scheduleId,schemaVersion,workspaceId") ||
		b.owner.schemaVersion !== 2 ||
		![b.owner.workspaceId, b.owner.reportSessionId, b.owner.scheduleId].every(uuid) ||
		new Set([b.owner.workspaceId, b.owner.reportSessionId, b.owner.scheduleId]).size !== 3 ||
		b.owner.projectId !== b.projectId ||
		b.owner.reportSessionId !== b.reportSessionId ||
		typeof b.owner.context !== "string" ||
		!/^[0-9a-f]{64}$/u.test(b.owner.context) ||
		!host(b.owner.expectedHome) ||
		["hostId", "daemonId", "lineageId"].some(
			(key) => b.host[key as keyof typeof b.host] !== b.owner.expectedHome[key as keyof typeof b.host],
		)
	)
		throw new Error("Invalid owner Insights binding");
}
