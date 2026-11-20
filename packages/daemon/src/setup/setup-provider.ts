/** Audited Pi 1.1.0 headless login adapter. No generic OAuth callback forwarding or config writes. */
import { randomUUID } from "node:crypto";
import type { AuthInteraction, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { SetupChallenge, SetupMethod } from "@pilot/protocol";

export const SETUP_METHODS: Readonly<Record<string, readonly SetupMethod[]>> = {
	"openai-codex": ["device_code"],
	anthropic: ["manual_code"],
};
export const SETUP_INPUT_BYTES = 16 * 1024;
export const SETUP_OUTPUT_BYTES = 64 * 1024;
// Fixed parameters of the pinned Pi 1.1.0 Anthropic copy-code implementation. `code=true` is
// explicitly sent by that path, unlike the browser callback path. Upgrade only with audit/tests.
export const ANTHROPIC_SETUP_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_SETUP_SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export function supportedSetup(provider: string, method: unknown): method is SetupMethod {
	return Object.hasOwn(SETUP_METHODS, provider) && SETUP_METHODS[provider]!.includes(method as SetupMethod);
}

/** Validate again in the parent before a private challenge can reach any client. */
export function validSetupChallenge(provider: string, value: unknown): value is SetupChallenge {
	if (!value || typeof value !== "object") return false;
	const c = value as SetupChallenge;
	if (typeof c.id !== "string" || !/^[a-f0-9-]{36}$/.test(c.id) || typeof c.url !== "string" || c.url.length > 4096)
		return false;
	try {
		const url = new URL(c.url);
		if (url.username || url.password || url.hash || url.protocol !== "https:") return false;
		if (provider === "openai-codex")
			return (
				c.type === "device_code" &&
				url.href === "https://auth.openai.com/codex/device" &&
				typeof c.userCode === "string" &&
				/^[A-Za-z0-9-]{1,32}$/.test(c.userCode)
			);
		if (provider !== "anthropic" || c.type !== "manual_code" || c.userCode !== undefined) return false;
		const keys = [...url.searchParams.keys()];
		if (keys.length !== 8 || new Set(keys).size !== keys.length) return false;
		return (
			url.origin === "https://claude.ai" &&
			url.pathname === "/oauth/authorize" &&
			url.searchParams.get("redirect_uri") === "https://platform.claude.com/oauth/code/callback" &&
			url.searchParams.get("response_type") === "code" &&
			url.searchParams.get("code_challenge_method") === "S256" &&
			url.searchParams.get("client_id") === ANTHROPIC_SETUP_CLIENT &&
			url.searchParams.get("scope") === ANTHROPIC_SETUP_SCOPES &&
			url.searchParams.get("code") === "true" &&
			/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") &&
			/^[A-Za-z0-9_-]{32,128}$/.test(url.searchParams.get("state") ?? "") &&
			[...url.searchParams.keys()].every((key) =>
				[
					"code",
					"client_id",
					"response_type",
					"redirect_uri",
					"scope",
					"code_challenge",
					"code_challenge_method",
					"state",
				].includes(key),
			)
		);
	} catch {
		return false;
	}
}

/** Require state even though the SDK also accepts bare codes. Never put the rejected input in an error. */
export function validManualAnswer(challenge: SetupChallenge, answer: string): boolean {
	if (challenge.type !== "manual_code" || Buffer.byteLength(answer) > 4096) return false;
	const parts = answer.trim().split("#");
	return (
		parts.length === 2 &&
		/^[A-Za-z0-9_-]{1,2048}$/.test(parts[0]!) &&
		parts[1] === new URL(challenge.url).searchParams.get("state")
	);
}

export async function setupProviderLogin(options: {
	provider: string;
	method: SetupMethod;
	signal: AbortSignal;
	login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;
	challenge(challenge: SetupChallenge): void;
	answer(challenge: SetupChallenge, signal: AbortSignal): Promise<string>;
}): Promise<OAuthCredential> {
	if (!supportedSetup(options.provider, options.method)) throw new Error("Unsupported headless login");
	let challenge: SetupChallenge | undefined;
	let prompted = false;
	let selected = false;
	const interaction: AuthInteraction = {
		signal: options.signal,
		prompt: async (prompt) => {
			options.signal.throwIfAborted();
			if (prompt.type === "select" && !selected) {
				selected = true;
				const id = options.method === "device_code" ? "device_code" : "copy_code";
				if (prompt.options.some((entry) => entry.id === id)) return id;
			}
			if (prompt.type !== "manual_code" || !challenge || prompted) throw new Error("Unsupported headless prompt");
			prompted = true;
			const answer = await options.answer(
				challenge,
				AbortSignal.any([options.signal, ...(prompt.signal ? [prompt.signal] : [])]),
			);
			if (!validManualAnswer(challenge, answer)) throw new Error("Invalid authorization response");
			return answer.trim();
		},
		notify: (event) => {
			options.signal.throwIfAborted();
			if (event.type === "info" || event.type === "progress") return; // Never forward provider text.
			if (challenge) throw new Error("Unexpected extra challenge");
			const next: SetupChallenge =
				event.type === "auth_url"
					? { id: randomUUID(), type: "manual_code", url: event.url }
					: { id: randomUUID(), type: "device_code", url: event.verificationUri, userCode: event.userCode };
			if (next.type !== options.method || !validSetupChallenge(options.provider, next))
				throw new Error("Unsupported authorization challenge");
			challenge = next;
			options.challenge(next);
		},
	};
	const credential = await options.login({ ...interaction, signal: options.signal });
	options.signal.throwIfAborted();
	return credential;
}
