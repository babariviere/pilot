import type { PermissionUpgradeRequest } from "@pilot/protocol";

export interface PermissionRequestState extends PermissionUpgradeRequest {
	authorizationId: string;
	status: "pending" | "allowed" | "denied" | "expired";
	decidedAt?: number;
	notified?: true;
}

/** Like database access: stale/reused decisions and plain messages never grant permission. */
export function decidePermissionRequest(
	request: PermissionRequestState | undefined,
	chatId: string,
	requestId: string,
	allow: boolean,
	now = Date.now(),
): PermissionRequestState {
	if (request?.status !== "pending" || request.id !== requestId || request.chatId !== chatId)
		throw new Error("This permission request is no longer pending for this chat");
	return { ...request, status: request.expiresAt <= now ? "expired" : allow ? "allowed" : "denied", decidedAt: now };
}

export function publicPermissionRequest(request: PermissionRequestState): PermissionUpgradeRequest {
	const { id, chatId, chatTitle, level, scope, requestedBy, createdAt, expiresAt } = request;
	return { id, chatId, chatTitle, level, scope, requestedBy, createdAt, expiresAt };
}
