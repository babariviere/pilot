// Presentation mirror only. Rust chooses the host/project, journals effects and owns eligibility.
import { signal } from "nsh";
import type { FundingOwner, FundingView } from "../../../../packages/protocol/src/funding/funding";
import type { WorkProfile } from "../../../../packages/protocol/src/projects/work-profiles";
import { AutoCheck } from "../../sources/autoCheck";
import { call } from "../../sources/bridge";

export type ModelChoice = {
	id: string;
	provider: string;
	name: string;
	thinkingLevels?: string[];
	defaultThinking?: string;
	modelChangeThinking?: string;
	taskDefaultThinking?: string;
};
export type ModelList = {
	models: ModelChoice[];
	defaultModel?: string;
	resolvedDefaultModel?: string;
	priceCeiling?: { limit: number | null; source: string };
};
export type ModelDefaults = {
	defaultProvider: string | null;
	defaultModel: string | null;
	defaultThinkingLevel: string | null;
	pilotTaskPriceLimit: number | null;
};
export type SignInRun = { id: string; provider: string; state: string; reauthenticationRequired: boolean };
export type ModelSettings = {
	funding?: FundingView;
	backgroundSubscription?: {
		windows: { provider: "anthropic" | "openai"; label: string; usedPercent: number }[];
		force?: ("anthropic" | "openai")[];
	};
	fundedWork?: {
		id: string;
		title: string;
		owner: FundingOwner;
		subscription: { forced?: boolean; windows: { label: string; usedPercent: number }[] } | null;
	}[];
	version: number;
	binding: string;
	defaults: ModelDefaults;
	/** Work profiles, with Pilot's starting set until the user saves a list. */
	profiles: WorkProfile[];
	project: { id: string; name: string; model: string | null } | null;
	scope: {
		enabledModels: string[] | null;
		candidates: { id: string; name: string; provider: string }[];
		projectOverride?: string[] | null;
		resolution: { pattern: string; matches: string[]; unresolved?: string }[];
	};
	available: ModelList;
	task: ModelList;
	providers: { id: string; name: string; methods: string[]; credential: string }[];
	runs: SignInRun[];
	failed?: { id: string; title: string; model: string | null }[];
	failedCount?: number;
};
export type ModelRecovery = {
	sessionId: string;
	source: { source: "startup" | "outcome"; token: string };
	choices: ModelList;
	saved: { model: string; thinking?: string } | null;
};
export type SignInView = {
	run: SignInRun;
	challenge: { id: string; type: string; url: string; userCode?: string } | null;
};
export type ModelAction =
	| "scope"
	| "defaults"
	| "work-profiles"
	| "project-model"
	| "failed-model"
	| "sign-in"
	| "cancel"
	| "logout"
	| "funding-settings"
	| "funding-limits"
	| "fund-work"
	| "continue-anyway"
	| "background-continue";
export interface ModelControls {
	settings: () => ModelSettings | null;
	busy: () => boolean;
	message: () => string;
	unknown: () => { operationId: string }[];
	read(): Promise<void>;
	write(action: ModelAction, value: unknown, binding?: string): Promise<boolean>;
	check(id: string): Promise<void>;
	/** Stops the automatic lookups. */
	close?(): void;
	recovery(sessionId: string): Promise<ModelRecovery | null>;
	signIn(
		run: string,
		action: "read" | "open" | "answer",
		challengeId?: string,
		answer?: string,
	): Promise<SignInView | null>;
}

/** One per window, kept while Settings is closed. No code or challenge is saved in window capture. */
export function connectedModelControls(window: string): ModelControls {
	const settings = signal<ModelSettings | null>(null);
	const busy = signal(false);
	const message = signal("");
	const unknown = signal<{ operationId: string }[]>([]);
	// Unknown actions are looked up by their receipt automatically; Check is the fallback.
	const auto = new AutoCheck(check, () => {});
	function receive(r: { snapshot: ModelSettings | null; value: Record<string, unknown> }) {
		if (r.snapshot) settings.set(r.snapshot);
		unknown.set((r.value.operations ?? []) as { operationId: string }[]);
		auto.watch(unknown().map((o) => o.operationId));
	}
	async function read() {
		if (busy()) return;
		busy.set(true);
		try {
			const r = await call<ModelSettings>(window, "day.models.read", {});
			if (r.ok) {
				receive(r);
				message.set("");
			} else message.set("AI settings could not be read. Read again before changing them.");
		} finally {
			busy.set(false);
		}
	}
	async function write(action: ModelAction, value: unknown, binding?: string) {
		const s = settings();
		if (!s || busy() || (unknown().length > 0 && action !== "cancel" && action !== "logout")) return false;
		busy.set(true);
		try {
			const r = await call<ModelSettings | null>(window, "day.models.write", {
				binding: binding ?? s.binding,
				action,
				value,
			});
			if (!r.ok) {
				message.set(
					r.refusal === "stale"
						? "These settings changed. Read again; your edits stay here."
						: "This action could not be confirmed. Read again and check its receipt. It will not be sent again.",
				);
				return false;
			}
			receive(r);
			const outcome = r.value.outcome as { state?: string } | undefined;
			const accepted = outcome?.state === "accepted";
			message.set(
				accepted
					? "Saved."
					: outcome?.state === "rejected"
						? "Nothing changed. Read again before trying a new change."
						: "This action is Unknown. Check only reads its receipt; it does not resend.",
			);
			return accepted;
		} finally {
			busy.set(false);
		}
	}
	async function check(operationId: string) {
		if (busy()) return;
		busy.set(true);
		try {
			const r = await call<ModelSettings | null>(window, "day.models.check", { operationId });
			if (r.ok) {
				receive(r);
				message.set(
					unknown().length
						? "The action is still Unknown. Nothing was sent again."
						: "The receipt was found. Read the current choices below.",
				);
			} else message.set("The receipt could not be read. Nothing was sent again.");
		} finally {
			busy.set(false);
		}
	}
	async function signIn(runId: string, action: "read" | "open" | "answer", challengeId?: string, answer?: string) {
		if (busy()) return null;
		busy.set(true);
		try {
			const r = await call<SignInView | null>(window, "day.models.signIn", {
				runId,
				action,
				...(challengeId ? { challengeId } : {}),
				...(answer ? { answer } : {}),
			});
			if (!r.ok) {
				message.set("Sign-in could not be confirmed. Check sign-in; do not send the answer again.");
				return null;
			}
			return r.snapshot;
		} finally {
			busy.set(false);
		}
	}
	async function recovery(sessionId: string) {
		if (busy()) return null;
		busy.set(true);
		try {
			const r = await call<ModelRecovery>(window, "day.models.recovery", { sessionId });
			if (r.ok) return r.snapshot;
			message.set("Failed work or its eligible models changed. Read again.");
			return null;
		} finally {
			busy.set(false);
		}
	}
	return { settings, busy, message, unknown, read, write, check, signIn, recovery, close: () => auto.close() };
}
