import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter, type NativeAdapterOptions } from "../../native-adapter.ts";
import { PILOT_CLI_SKILL_PATH } from "./pilot-cli.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pilot-cli-native-"));
	const adapters: NativeAdapter[] = [];
	t.after(async () => {
		for (const adapter of adapters.reverse()) await adapter.close();
		await rm(root, { recursive: true, force: true });
	});
	const agentDir = join(root, "agent");
	const cwd = join(root, "source");
	const bin = join(root, "fixture bin");
	for (const dir of [agentDir, cwd, bin]) await mkdir(dir);
	const personal = join(agentDir, "pilot-cli.md");
	await writeFile(personal, "---\nname: pilot-cli\ndescription: Personal CLI skill\n---\nPersonal instructions.");
	const entry = join(root, "cli.mjs");
	await writeFile(
		entry,
		`const [first] = process.argv.slice(2);
if (first === "--overflow") process.stdout.write("x".repeat(40 * 1024));
else if (first === "--stderr-overflow") process.stderr.write("x".repeat(40 * 1024));
else process.stdout.write(JSON.stringify({
	argv: process.argv.slice(2),
	auth: process.env.PILOT_CLI_PORT === "43210" && process.env.PILOT_CLI_TOKEN === "test-grant",
	ambient: typeof process.env.PILOT_TEST_AMBIENT === "string",
	shellNode: process.env.PILOT_CLI_NODE === process.execPath,
}));`,
	);
	await writeFile(join(bin, "pilot"), `#!/bin/sh\nexec "$PILOT_CLI_NODE" "\${0%/*}/../cli.mjs" "$@"\n`, {
		mode: 0o755,
	});
	const ambient = process.env.PILOT_TEST_AMBIENT;
	process.env.PILOT_TEST_AMBIENT = "not for Ask";
	t.after(() => {
		if (ambient === undefined) delete process.env.PILOT_TEST_AMBIENT;
		else process.env.PILOT_TEST_AMBIENT = ambient;
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-cli-test", models: [{ id: "offline" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const open = async (options: Partial<NativeAdapterOptions> = {}) => {
		const adapter = await NativeAdapter.open({
			cwd,
			agentDir,
			sessionFile: join(root, `fixture-${adapters.length}.jsonl`),
			jobHistoryFresh: true,
			settingsManager: SettingsManager.inMemory({ skills: [personal] }),
			projectTrusted: false,
			askExtensionTools: [],
			sessionOptions: { modelRuntime, model: faux.getModel() },
			...options,
		});
		adapters.push(adapter);
		return adapter;
	};
	return { root, cwd, bin, personal, open, grant: { port: 43210, token: "test-grant", entry, bin } };
}

async function codemode(adapter: NativeAdapter, code: string) {
	const id = `cli-test-${adapter.session.agent.state.messages.length}`;
	const tool = adapter.session.agent.state.tools.find((candidate) => candidate.name === "codemode")!;
	adapter.session.agent.state.messages.push(
		fauxAssistantMessage({ type: "toolCall", id, name: "codemode", arguments: {} }, { stopReason: "toolUse" }),
	);
	return tool.execute(id, { code });
}

test("Build uses the bundled skill and scopes launcher authority to the local shell", {
	skip: process.platform === "win32",
}, async (t) => {
	const f = await fixture(t);
	const adapter = await f.open({ agentCli: f.grant });
	assert.deepEqual(
		adapter.session.resourceLoader
			.getSkills()
			.skills.filter(({ name }) => name === "pilot-cli")
			.map(({ filePath }) => filePath),
		[PILOT_CLI_SKILL_PATH],
	);
	const result = await codemode(
		adapter,
		`
const lookup = await tools.bash({command: "command -v pilot"});
if (lookup.output.trim() !== ${JSON.stringify(join(f.bin, "pilot"))}) throw new Error("Wrong pilot launcher: " + lookup.output);
const launch = await tools.bash({command: "pilot context"});
text(launch.output);
`,
	);
	const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	assert.ok(output.includes('{"argv":["context"],"auth":true,"ambient":true,"shellNode":true}'), output);
	assert.notEqual(process.env.PILOT_CLI_TOKEN, f.grant.token);
	assert.notEqual(process.env.PATH?.split(":")[0], f.bin);
});

test("No grant means no skill or tool, even if a personal skill has the same name", async (t) => {
	const f = await fixture(t);
	const build = await f.open();
	assert.ok(!build.commands().some((command) => command.name === "skill:pilot-cli"));
	const ask = await f.open({ ask: { source: f.cwd } });
	assert.ok(!ask.commands().some((command) => command.name === "skill:pilot-cli"));
	assert.ok(!ask.session.getCallableToolNames().includes("pilot_cli"));
	const read = await codemode(ask, `text(await tools.read({path: ${JSON.stringify(PILOT_CLI_SKILL_PATH)}}));`);
	const output = read.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	assert.match(output, /Ask paths must stay inside the source/);
	const screen = await f.open({ ask: { source: f.cwd }, screen: true, agentCli: f.grant });
	assert.ok(!screen.commands().some((command) => command.name === "skill:pilot-cli"));
	assert.ok(!screen.session.getCallableToolNames().includes("pilot_cli"));
});

test("Ask can read the granted skill and pass literal argv through codemode, but cannot use shell", async (t) => {
	const f = await fixture(t);
	const adapter = await f.open({ ask: { source: f.cwd }, agentCli: f.grant });
	assert.ok(adapter.commands().some((command) => command.name === "skill:pilot-cli"));
	assert.ok(adapter.session.getCallableToolNames().includes("pilot_cli"));
	assert.ok(!adapter.session.getCallableToolNames().some((name) => name === "bash" || name === "write"));
	const literal = "$(printf expanded); #";
	const result = await codemode(
		adapter,
		`
text(await tools.pilot_cli({argv: ["context", ${JSON.stringify(literal)}]}));
text(await tools.read({path: ${JSON.stringify(PILOT_CLI_SKILL_PATH)}, limit: 1}));
`,
	);
	const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	assert.ok(output.includes(literal), output);
	assert.match(output, /"auth":true,"ambient":false,"shellNode":false/);
	assert.match(output, /More lines available; use offset=2/);
});

test("Ask CLI caps both output streams", async (t) => {
	const f = await fixture(t);
	const adapter = await f.open({ ask: { source: f.cwd }, agentCli: f.grant });
	for (const flag of ["--overflow", "--stderr-overflow"]) {
		const result = await codemode(adapter, `text(await tools.pilot_cli({argv: ["${flag}"]}));`);
		const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		assert.match(output, /Pilot CLI exceeded 32 KiB/);
		assert.ok(!output.includes("x".repeat(100)));
	}
});
