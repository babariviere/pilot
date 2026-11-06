import { resolve } from "node:path";
import type { InsightsBinding, InsightsHistoryRequest } from "@pilot/protocol";
import { parseDiagnosticContext } from "./diagnostic-context.ts";
import { repairHost } from "./diagnostic-repair-project.ts";
import { Conflict } from "./errors.ts";

/** Private persisted binding adds an exact local storage home, never a model-supplied path. */
export interface InsightsGrant extends InsightsBinding {
	home: string;
	projectPath: string;
	setupDigest: string;
}

/** Backlog writers use this lease inside their transaction and before delivering results. */
export interface InsightsAdmission {
	readonly binding: Readonly<InsightsBinding>;
	revalidate(): void;
}

/** Distinct authority. This is never accepted by the v1 grant parser. */
export interface InsightsOwnerAdmission {
	readonly binding: Readonly<import("@pilot/protocol").InsightsOwnerBinding>;
	revalidate(): void;
}

export type InsightsReviewAdmission = InsightsAdmission | InsightsOwnerAdmission;

export function validateInsightsGrant(value: unknown): asserts value is InsightsGrant {
	const v = value as InsightsGrant;
	if (
		!v ||
		typeof v !== "object" ||
		Array.isArray(v) ||
		Object.keys(v).sort().join(",") !==
			"enabled,grantId,home,host,missionId,projectId,projectPath,reportSessionId,revision,schemaVersion,setupDigest" ||
		v.schemaVersion !== 1 ||
		typeof v.enabled !== "boolean" ||
		!Number.isSafeInteger(v.revision) ||
		v.revision < 1 ||
		![v.grantId, v.reportSessionId].every(
			(x) => typeof x === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(x),
		) ||
		![v.projectId, v.missionId].every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(x)) ||
		![v.home, v.projectPath].every((x) => typeof x === "string" && resolve(x) === x) ||
		typeof v.setupDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(v.setupDigest)
	)
		throw new Conflict("Invalid Insights grant");
	repairHost(v.host);
}

export function parseInsightsHistory(value: unknown): InsightsHistoryRequest {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((k) => !["action", "sessionId", "query", "after", "before", "limit"].includes(k))
	)
		throw new Conflict("Invalid Insights history selector");
	const request = parseDiagnosticContext(value);
	if (!["chats", "history", "search", "projects"].includes(request.action))
		throw new Conflict("Insights permits only local discovery and history");
	return request as InsightsHistoryRequest;
}
