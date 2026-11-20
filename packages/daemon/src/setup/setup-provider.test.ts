import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { SetupChallenge } from "@pilot/protocol";
import {
	ANTHROPIC_SETUP_CLIENT,
	ANTHROPIC_SETUP_SCOPES,
	setupProviderLogin,
	supportedSetup,
	validManualAnswer,
	validSetupChallenge,
} from "./setup-provider.ts";

export function manualChallenge(): SetupChallenge {
	return {
		id: randomUUID(),
		type: "manual_code",
		url: `https://claude.ai/oauth/authorize?${new URLSearchParams({
			code: "true",
			client_id: ANTHROPIC_SETUP_CLIENT,
			response_type: "code",
			redirect_uri: "https://platform.claude.com/oauth/code/callback",
			scope: ANTHROPIC_SETUP_SCOPES,
			code_challenge: "c".repeat(43),
			code_challenge_method: "S256",
			state: "s".repeat(43),
		})}`,
	};
}

test("manual challenge validates every pinned parameter, duplicates and complete matching state", () => {
	const challenge = manualChallenge();
	assert.equal(validSetupChallenge("anthropic", challenge), true);
	assert.equal(validManualAnswer(challenge, `synthetic-code#${"s".repeat(43)}`), true);
	for (const answer of ["bare-code", "code#different", "code#", `code#${"s".repeat(43)}#extra`, "x".repeat(5000)])
		assert.equal(validManualAnswer(challenge, answer), false);
	for (const key of ["state", "redirect_uri", "client_id", "code", "code_challenge", "scope"]) {
		const duplicate = new URL(challenge.url);
		duplicate.searchParams.append(key, "evil");
		assert.equal(validSetupChallenge("anthropic", { ...challenge, url: duplicate.href }), false, key);
		const changed = new URL(challenge.url);
		changed.searchParams.set(key, "evil");
		assert.equal(validSetupChallenge("anthropic", { ...challenge, url: changed.href }), false, key);
		changed.searchParams.delete(key);
		assert.equal(validSetupChallenge("anthropic", { ...challenge, url: changed.href }), false, key);
	}
	for (const url of [
		challenge.url.replace("claude.ai", "evil.test"),
		`${challenge.url}&access_token=secret`,
		`${challenge.url}#secret`,
		challenge.url.replace("https:", "http:"),
	])
		assert.equal(validSetupChallenge("anthropic", { ...challenge, url }), false);
	assert.equal(supportedSetup("openai-codex", "manual_code"), false);
	assert.equal(supportedSetup("__proto__", "device_code"), false);
});

test("pinned builtin Anthropic copy-code flow runs without config or callback server and retains state validation", async (t) => {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
		return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 });
	});
	const oauth = builtinProviders().find(({ id }) => id === "anthropic")!.auth.oauth!;
	const challenges: SetupChallenge[] = [];
	const result = await setupProviderLogin({
		provider: "anthropic",
		method: "manual_code",
		signal: new AbortController().signal,
		login: (interaction) => oauth.login(interaction),
		challenge: (value) => challenges.push(value),
		answer: async (value) => `synthetic-code#${new URL(value.url).searchParams.get("state")}`,
	});
	assert.equal(result.access, "synthetic-access");
	assert.equal(challenges.length, 1);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.url, "https://platform.claude.com/v1/oauth/token");
	assert.equal(requests[0]!.body.redirect_uri, "https://platform.claude.com/oauth/code/callback");
	assert.equal(requests[0]!.body.code, "synthetic-code");
	assert.equal(requests[0]!.body.state, requests[0]!.body.code_verifier);
});

test("pinned Codex device flow never selects browser callback and reports only a validated device challenge", async (t) => {
	const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.x`;
	const paths: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = String(input);
		paths.push(url);
		if (url.endsWith("/deviceauth/usercode"))
			return Response.json({ device_auth_id: "private-device-id", user_code: "ABCD-EFGH", interval: 0 });
		if (url.endsWith("/deviceauth/token"))
			return Response.json({ authorization_code: "private-code", code_verifier: "private-verifier" });
		if (url.endsWith("/oauth/token"))
			return Response.json({ access_token: jwt, refresh_token: "private-refresh", expires_in: 3600 });
		throw new Error("Unexpected network request");
	});
	const oauth = builtinProviders().find(({ id }) => id === "openai-codex")!.auth.oauth!;
	const challenges: SetupChallenge[] = [];
	const result = await setupProviderLogin({
		provider: "openai-codex",
		method: "device_code",
		signal: new AbortController().signal,
		login: (interaction) => oauth.login(interaction),
		challenge: (value) => challenges.push(value),
		answer: async () => {
			throw new Error("No manual response expected");
		},
	});
	assert.equal(result.access, jwt);
	assert.equal(challenges[0]!.url, "https://auth.openai.com/codex/device");
	assert.equal(challenges[0]!.userCode, "ABCD-EFGH");
	assert.equal(JSON.stringify(challenges).includes("private-"), false);
	assert.equal(paths.length, 3);
});

test("unknown prompts and mismatched state fail closed and progress messages are never forwarded", async () => {
	let notifications = 0;
	await assert.rejects(
		setupProviderLogin({
			provider: "anthropic",
			method: "manual_code",
			signal: new AbortController().signal,
			login: async (interaction) => {
				interaction.notify({ type: "progress", message: "secret server body" });
				interaction.notify({ type: "auth_url", url: manualChallenge().url });
				await interaction.prompt({ type: "manual_code", message: "secret prompt" });
				throw new Error("Must not exchange");
			},
			challenge: () => notifications++,
			answer: async () => "private-code#wrong-state",
		}),
		(error: Error) => error.message === "Invalid authorization response",
	);
	assert.equal(notifications, 1);
});
