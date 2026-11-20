/** Native-only host setup. Never contains GitHub tokens or private keys. */
export interface GitHubSetupStatus {
	phase: "idle" | "authorizing" | "key_ready" | "uploading" | "upload_unknown" | "ready" | "interrupted";
	operationId?: string;
	account?: string;
	apiReady: boolean;
	sshReady: boolean;
	/** The SSH identity explicitly checked on this host. */
	sshIdentity?: "existing" | "dedicated";
	publicKey?: string;
	fingerprint?: string;
	keyId?: number;
	challenge?: { url: string; code: string; expiresAt: number };
	problem?: string;
}
export interface GitHubSetupAction {
	id: string;
	action: "authorize" | "prepare_key" | "approve_key" | "verify" | "verify_existing" | "cancel" | "revoke_key";
	/** Explicit approval is bound to the displayed account and exact dedicated key. */
	account?: string;
	fingerprint?: string;
}
