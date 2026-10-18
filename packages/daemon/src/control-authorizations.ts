import type {
	ControlAuthorization,
	ControlAuthorizationLevel,
	ControlUserMessageRef,
	Watch,
	WatchTarget,
} from "@pilot/protocol";
import type { ControlMemory } from "./control-memory.ts";
import type { WatchService } from "./watch-service.ts";

// Provisional policy, pending user decisions. Implement never implies permission to publish.
export const CONTROL_DEFAULT_FOLLOW_UPS = 2;
export const CONTROL_DEFAULT_BUDGET_USD: undefined = undefined;
export const CONTROL_DEFAULT_AUTHORIZATION_TTL_MS = 24 * 60 * 60_000;
export const CONTROL_IMPLEMENT_INCLUDES_PUBLISH = false;
export const CONTROL_LEVELS: readonly ControlAuthorizationLevel[] = ["investigate", "implement", "publish", "merge"];

export type ControlAuthorizationCreate = Omit<ControlAuthorization, "revokedAt" | "usage" | "budget" | "spend">;
export function legacyWatchAuthorization(watch: Watch): ControlAuthorizationCreate {
	return {
		id: `watch:${watch.id}`,
		watchId: watch.id,
		scope: watch.note,
		level: "publish",
		targets: [watch.target],
		limits: { followUps: CONTROL_DEFAULT_FOLLOW_UPS },
		createdAt: watch.createdAt,
		...(watch.expiresAt === undefined ? {} : { expiresAt: watch.expiresAt }),
	};
}
/** Existing watches are visible/revocable immediately, with no reapproval. Bounded pages, no live cache. */
export async function importLegacyWatchAuthorizations(
	memory: () => ControlMemory,
	watches: Pick<WatchService, "page">,
): Promise<void> {
	let after: string | undefined;
	do {
		const page = await watches.page(after, 100);
		const records = page.watches.filter((watch) => !watch.authorizationId).map(legacyWatchAuthorization);
		if (records.length) await memory().authorizationImport(records);
		after = page.next;
	} while (after);
}
export interface ControlAuthorizationUse {
	authorizationId: string;
	level: ControlAuthorizationLevel;
	/** Every actual target must match one of its daemon-resolved enclosing scopes. */
	targets: WatchTarget[][];
	followUps: number;
	/** Only the first start under a grant is an initial action; subsequent starts consume follow-ups. */
	initialStart?: boolean;
	budgetUsd: number;
	/** Grandfathered watches are valid only for their saved note, in their delivery turn. */
	legacyWatch?: { watchId: string; note: string };
}
export function authorizationLevel(value: unknown): ControlAuthorizationLevel {
	if (!CONTROL_LEVELS.includes(value as ControlAuthorizationLevel)) throw new Error("Invalid authorization level");
	return value as ControlAuthorizationLevel;
}
export function authorizationTarget(value: unknown): WatchTarget {
	if (!value || typeof value !== "object") throw new Error("Invalid authorization target");
	const v = value as WatchTarget;
	if (
		!["chat", "project", "mission", "pr", "chat_prs", "linear", "task"].includes(v.kind) ||
		typeof v.id !== "string" ||
		!v.id.trim() ||
		v.id.length > 500 ||
		/[\x00-\x1f]/.test(v.id)
	)
		throw new Error("Invalid authorization target");
	if (
		v.kind === "task"
			? typeof v.missionId !== "string" || !v.missionId.trim() || v.missionId.length > 200
			: v.missionId !== undefined
	)
		throw new Error("Task authorization targets require a mission ID");
	return { kind: v.kind, id: v.id, ...(v.missionId ? { missionId: v.missionId } : {}) };
}
export function createAuthorization(
	id: string,
	args: Record<string, unknown>,
	userMessage: ControlUserMessageRef,
	now = Date.now(),
): ControlAuthorizationCreate {
	if (typeof args.scope !== "string" || !args.scope.trim() || Buffer.byteLength(args.scope) > 4096)
		throw new Error("Authorization scope must be 1..4096 bytes");
	if (!Array.isArray(args.targets) || !args.targets.length || args.targets.length > 32)
		throw new Error("Authorization requires 1..32 explicit targets");
	const limits = args.limits as { followUps?: unknown; budgetUsd?: unknown } | undefined;
	if (args.limits !== undefined && (!limits || typeof limits !== "object" || Array.isArray(limits)))
		throw new Error("Invalid authorization limits");
	const followUps = limits?.followUps ?? CONTROL_DEFAULT_FOLLOW_UPS;
	const budgetUsd = limits?.budgetUsd ?? CONTROL_DEFAULT_BUDGET_USD;
	if (typeof followUps !== "number" || !Number.isSafeInteger(followUps) || followUps < 0 || followUps > 100)
		throw new Error("followUps must be 0..100");
	if (
		budgetUsd !== undefined &&
		(typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10_000)
	)
		throw new Error("budgetUsd must be positive and at most 10000");
	const expiresAt = args.expiresAt ?? now + CONTROL_DEFAULT_AUTHORIZATION_TTL_MS;
	if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
		throw new Error("Authorization expiry must be in the future");
	return {
		id,
		userMessage,
		scope: args.scope,
		level: authorizationLevel(args.level),
		targets: args.targets.map(authorizationTarget),
		limits: { followUps, ...(budgetUsd === undefined ? {} : { budgetUsd: budgetUsd as number }) },
		createdAt: now,
		expiresAt,
	};
}
export function checkAuthorization(record: ControlAuthorization, use: ControlAuthorizationUse, now = Date.now()): void {
	if (record.revokedAt !== undefined) throw new Error("Authorization revoked");
	if (record.expiresAt !== undefined && record.expiresAt <= now) throw new Error("Authorization expired");
	// Merge is a recorded user intent, never an executable agent capability.
	if (use.level === "merge") throw new Error("Merges require user confirmation in the app");
	if (CONTROL_LEVELS.indexOf(authorizationLevel(use.level)) > CONTROL_LEVELS.indexOf(record.level))
		throw new Error("Action exceeds authorization level");
	if (
		!use.targets.length ||
		use.targets.some(
			(alternatives) =>
				!alternatives.some((target) =>
					record.targets.some(
						(allowed) =>
							allowed.kind === target.kind && allowed.id === target.id && allowed.missionId === target.missionId,
					),
				),
		)
	)
		throw new Error("Action is outside authorization targets");
	if (
		!Number.isSafeInteger(use.followUps) ||
		use.followUps < 0 ||
		!Number.isFinite(use.budgetUsd) ||
		use.budgetUsd < 0
	)
		throw new Error("Invalid authorization reservation");
	if (record.watchId) {
		if (use.legacyWatch?.watchId !== record.watchId || use.legacyWatch.note !== record.scope)
			throw new Error("Legacy watch authorizes only its saved note in its delivery turn");
		return;
	}
	if (record.usage.followUps + use.followUps > record.limits.followUps)
		throw new Error("Authorization follow-up limit exceeded");
	if (record.limits.budgetUsd !== undefined && record.usage.budgetUsd + use.budgetUsd > record.limits.budgetUsd + 1e-9)
		throw new Error("Authorization budget exceeded");
}
