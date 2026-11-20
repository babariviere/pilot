/** Isolated real native settings ingress/storage. Fake catalogue only; no provider or credentials. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveCommands } from "./commands.ts";
import { mock } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { ModelCatalog } from "../models.ts";
import { nativePlanningFixture } from "../native-mission-planning.fixture.ts";
import { requiredAuthRegistration } from "../testing/required-auth.ts";

await installCredentialBrokerHooks();
const choices = ["claude-opus-5-5", "small"].map((id) => ({
	id,
	provider: "fixture",
	name: id,
	api: "openai-completions",
	baseUrl: "https://not-used.invalid",
	input: ["text"],
	reasoning: true,
	contextWindow: 32000,
	maxTokens: 1024,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
}));
mock.method(
	ModelRuntime,
	"create",
	async () =>
		({
			...requiredAuthRegistration,
			getAvailable: async () => choices,
			getAvailableSnapshot: () => choices,
			getModel: (provider: string, id: string) => choices.find((m) => m.provider === provider && m.id === id),
			getModelsOfType: () => choices,
			hasConfiguredAuth: () => true,
			completeSimple: () => assert.fail("No provider calls in this fixture"),
		}) as unknown as ModelRuntime,
);
const f = await nativePlanningFixture();
const ledger = join(f.home, "commands.jsonl"),
	settings = join(f.home, "settings.json");
await writeFile(settings, '{"defaultProvider":"fixture","defaultModel":"small","extensions":["keep"]}');
let writes = 0,
	lost = false;
const save = ModelCatalog.prototype.saveDefaults;
mock.method(
	ModelCatalog.prototype,
	"saveDefaults",
	async function (this: ModelCatalog, ...args: Parameters<typeof save>) {
		const records = (await readFile(ledger, "utf8"))
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		assert(
			records.some((r) => r.operation?.kind === "model-controls"),
			"native journal exists before settings write",
		);
		writes++;
		await save.apply(this, args);
		if (lost) {
			lost = false;
			throw new Error("Simulated lost domain acknowledgement");
		}
	},
);
console.log(
	JSON.stringify({
		source: {
			profile: f.home,
			port: Number(new URL(f.root).port),
			home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
		ledger,
	}),
);
await serveCommands(async (c) => {
	if (c.action === "lost") lost = true;
	if (c.action === "external")
		await writeFile(
			settings,
			'{"defaultProvider":"fixture","defaultModel":"small","defaultThinkingLevel":"off","extensions":["keep"]}',
		);
	return {
		writes,
		sessions: f.sessions.list().length,
		settings: JSON.parse(await readFile(settings, "utf8")),
	};
});
await f.close();
