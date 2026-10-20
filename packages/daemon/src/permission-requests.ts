import type { PermissionUpgradeRequest } from "@pilot/protocol";

/** Retained historical metadata from the retired publishing-approval flow. */
export interface PermissionRequestState extends PermissionUpgradeRequest {
	authorizationId: string;
	status: "pending" | "allowed" | "denied" | "expired";
	decidedAt?: number;
	notified?: true;
}
