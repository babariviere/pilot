/** Fixed PTY entry point. Only structured, allowlisted messages ever reach stdout. */
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { credentialClient } from "@pilot/kernel/credential-client";
import type { SetupChallenge, SetupMethod } from "@pilot/protocol";
import { SETUP_INPUT_BYTES, setupProviderLogin, supportedSetup } from "./setup-provider.ts";

const controller = new AbortController();
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let pending: { id: string; resolve(answer: string): void } | undefined;
let input = "",
	inputBytes = 0;
// Parent accepts answers only after receiving a challenge. Raw mode is set before that message, so
// the PTY line discipline cannot echo authorization codes, even before the first stdin read.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data: string) => {
	inputBytes += Buffer.byteLength(data);
	if (inputBytes > SETUP_INPUT_BYTES) return controller.abort();
	input += data;
	const end = input.indexOf("\n");
	if (end < 0) return;
	try {
		const message = JSON.parse(input.slice(0, end)) as { id?: unknown; answer?: unknown };
		input = "";
		if (!pending || message.id !== pending.id || typeof message.answer !== "string") return controller.abort();
		const next = pending;
		pending = undefined;
		next.resolve(message.answer);
	} catch {
		controller.abort();
	}
});
const answer = (challenge: SetupChallenge, signal: AbortSignal) =>
	new Promise<string>((resolve, reject) => {
		const abort = () => {
			pending = undefined;
			reject(new Error("Cancelled"));
		};
		if (signal.aborted) return abort();
		pending = {
			id: challenge.id,
			resolve: (value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
		};
		signal.addEventListener("abort", abort, { once: true });
	});
process.on("SIGTERM", () => controller.abort());
process.on("SIGHUP", () => controller.abort());
try {
	const [provider, method] = process.argv.slice(2);
	if (!provider || !supportedSetup(provider, method)) throw new Error("Unsupported");
	const client = credentialClient();
	if (!client) throw new Error("Broker required");
	const oauth = builtinProviders().find((entry) => entry.id === provider)?.auth.oauth;
	if (!oauth) throw new Error("Unsupported");
	await client.transaction("pi", provider, "login", async () => {
		const credential = await setupProviderLogin({
			provider,
			method: method as SetupMethod,
			signal: controller.signal,
			login: (interaction) => oauth.login(interaction, { agentName: "Pilot" }),
			challenge: (challenge) => send({ challenge }),
			answer,
		});
		controller.signal.throwIfAborted();
		await client.pi.modify(provider, async () => credential, { signal: controller.signal });
	});
	await client.close();
	send({ done: true });
} catch {
	// SDK/network errors can contain server bodies and credentials. Never stringify them.
	send({ failed: true });
} finally {
	input = "";
	pending = undefined;
	process.stdin.destroy();
}
