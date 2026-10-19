/** A host-local request. Only a native app decision for this exact request can approve it. */
export interface PermissionUpgradeRequest {
	id: string;
	chatId: string;
	chatTitle: string;
	level: "publish";
	scope: string;
	requestedBy: string;
	createdAt: number;
	expiresAt: number;
}
export interface PermissionUpgradeDecision {
	id: string;
	allow: boolean;
}
