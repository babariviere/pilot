/** Host-local setup, independent of chats. No tokens, stored secrets or executable configuration. */
export type SetupMethod = "device_code" | "manual_code";
export interface SetupProvider {
	id: string;
	name: string;
	methods: SetupMethod[];
	/** Stored canonical auth only, not a live provider check or ambient/config auth inventory. */
	credential: "missing" | "configured" | "reauthentication_required";
}
export interface SetupIntegration {
	kind: "linear" | "slack";
	state: "connected" | "needs_sign_in" | "failed" | "unknown" | "disabled" | "not_configured";
	/** No generic relay of a browser's localhost callback to another host. */
	login: "unsupported";
	problem: string;
}
/** GET /api/setup. Never probes providers by spending a model request. */
export interface SetupReadiness {
	providers: SetupProvider[];
	integrations: SetupIntegration[];
	independentCredentials: true;
}
/** POST /api/setup/runs. Explicit, never automatically retried after an uncertain response. */
export interface SetupStartRequest {
	provider: string;
	method: SetupMethod;
}
export interface SetupRun {
	id: string;
	provider: string;
	method: SetupMethod;
	state: "starting" | "waiting" | "working" | "done" | "failed" | "cancelled";
	createdAt: number;
	expiresAt: number;
	/** Cancellation/failure may quarantine prior auth. A fresh explicit sign-in resolves it. */
	reauthenticationRequired: boolean;
	problem?: string;
}
/** Private, ephemeral challenge, only on the run's dedicated socket. Never persist or log it. */
export interface SetupChallenge {
	id: string;
	type: SetupMethod;
	url: string;
	userCode?: string;
}
/** /api/setup/runs/:id/terminal/ws. Reattach does not start/retry a helper or replay terminal output. */
export type SetupServerMessage =
	| { type: "setup.state"; run: SetupRun }
	| { type: "setup.challenge"; challenge: SetupChallenge }
	| { type: "setup.output"; data: string }
	| { type: "setup.error"; message: string };
/** Whole challenge answers, not arbitrary keystrokes. Lifetime enqueue is capped, not just frame size. */
export type SetupClientMessage =
	| { type: "setup.answer"; challengeId: string; answer: string }
	| { type: "setup.resize"; cols: number; rows: number };
