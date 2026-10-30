import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter } from "./native-adapter.ts";
import { nativeToolPolicy } from "./tool-policy.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-exploration-sdk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, "widget.tsx"),
		"export const Widget = () => <button>local</button>;\nexport function renderWidget() { return Widget(); }\n",
	);
	return root;
}

for (const mode of ["ask", "build-investigate"] as const) {
	test(`first-party tools are registered and callable through Pi/codemode in ${mode}`, {
		timeout: 20_000,
	}, async (t) => {
		const root = await fixture(t);
		t.mock.method(globalThis, "fetch", () => assert.fail("exploration SDK fixture must stay offline"));
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const faux = fauxProvider();
		modelRuntime.registerNativeProvider(faux.provider);
		const adapter = await NativeAdapter.open({
			cwd: root,
			agentDir: join(root, "agent"),
			projectTrusted: false,
			...(mode === "ask" ? { ask: { source: root }, askExtensionTools: [] } : {}),
			bundledExtensions: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
			sessionOptions: { modelRuntime, model: faux.getModel() },
			hostExtensions: [nativeToolPolicy({ authorizationId: "fixture", level: "investigate" })],
			loaderOptions: {
				cwd: root,
				agentDir: join(root, "agent"),
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				extensionFactories: [createCodemodeExtension({ models: false, mode: "on" })],
			},
		});
		t.after(() => adapter.close());
		for (const name of ["code_call_paths", "code_impact", "code_search", "code_symbols"])
			assert.ok(adapter.session.getCallableToolNames().includes(name), name);
		const codemode = adapter.session.agent.state.tools.find((tool) => tool.name === "codemode")!;
		adapter.session.agent.state.messages.push(
			fauxAssistantMessage(
				{ type: "toolCall", id: "source-script", name: "codemode", arguments: {} },
				{ stopReason: "toolUse" },
			),
		);
		const result = await codemode.execute(
			"source-script",
			{
				code: `
const found = await searchTools("code_symbols");
text(found.map(t => t.name));
const symbols = await tools.code_symbols({query:"Widget",exact:true,path:"widget.tsx"});
text({name:symbols.results[0].name,coverage:symbols.results[0].coverage});
const calls = await tools.code_call_paths({symbol:{path:"widget.tsx",line:symbols.results[0].span.start.line,column:symbols.results[0].span.start.column,contentHash:symbols.results[0].contentHash},direction:"callees"});
text({mode:calls.mode,root:calls.root.name,edges:calls.results.length});
const impact = await tools.code_impact({symbols:[{path:"widget.tsx",line:1,column:14}],expectedRevision:calls.revision.id});
text({impactCaller:impact.results[0].frame.name,witness:impact.results[0].witness[0].to.name});
const search = await tools.code_search({query:"Widget",path:"widget.tsx"});
text(search.results[0].citation);
try { await tools.code_search({query:"Widget",path:"../outside"}); text("ESCAPED"); }
catch { text("ROOT_DENIED"); }
`,
			},
			undefined,
		);
		assert.ok(!result.isError, JSON.stringify(result));
		assert.match(JSON.stringify(result), /Widget.*parsed/);
		assert.match(JSON.stringify(result), /widget.tsx:1:14/);
		assert.match(JSON.stringify(result), /source-inferred-not-runtime/);
		assert.match(JSON.stringify(result), /impactCaller.*renderWidget/);
		assert.match(JSON.stringify(result), /ROOT_DENIED/);
		assert.doesNotMatch(JSON.stringify(result), /ESCAPED/);
		if (mode === "ask") {
			assert.ok(!adapter.session.getCallableToolNames().includes("bash"));
			assert.deepEqual(
				adapter.extension.tools?.map((tool) => tool.name),
				["codemode"],
			);
		}
	});
}

test("relocated parser/worker payload needs no source writes, project setup or runtime install", {
	timeout: 20_000,
}, async (t) => {
	const root = await fixture(t);
	const stage = join(root, "relocated");
	await mkdir(join(stage, "node_modules/@babel"), { recursive: true });
	await writeFile(join(stage, "package.json"), '{"type":"module"}');
	for (const name of [
		"exploration-runner.ts",
		"exploration-worker.ts",
		"exploration-scan.ts",
		"exploration-parser.ts",
		"exploration-page.ts",
		"call-graph.ts",
		"impact-scan.ts",
		"call-path-scan.ts",
		"call-path-syntax.ts",
		"source-reader.ts",
	])
		await cp(new URL(name, import.meta.url), join(stage, name));
	// Assert inside the actual worker, not only in its parent process.
	const worker = join(stage, "exploration-worker.ts");
	await writeFile(
		worker,
		'if (!process.permission || process.permission.has("fs.write")) throw new Error("worker lost read-only permission");\n' +
			(await readFile(worker, "utf8")),
	);
	await cp(
		fileURLToPath(new URL("../", import.meta.resolve("@babel/parser"))),
		join(stage, "node_modules/@babel/parser"),
		{ recursive: true },
	);
	await writeFile(
		join(stage, "smoke.mjs"),
		`
import assert from 'node:assert/strict';
import { runExploration } from './exploration-runner.ts';
globalThis.fetch = () => { throw new Error('offline only'); };
const page = await runExploration({source:${JSON.stringify(root)}}, {tool:'code_symbols',path:'widget.tsx',query:'Widget',exact:true});
assert.equal(page.results[0].name, 'Widget');
assert.equal(page.results[0].coverage, 'parsed');
const calls = await runExploration({source:${JSON.stringify(root)}}, {tool:'code_call_paths',symbol:{path:'widget.tsx',line:1,column:14},direction:'callees'});
assert.equal(calls.mode, 'source-inferred-not-runtime');
assert.equal(calls.root.name, 'Widget');
const impact = await runExploration({source:${JSON.stringify(root)}}, {tool:'code_impact',symbols:[{path:'widget.tsx',line:1,column:14}],expectedRevision:calls.revision.id});
assert.equal(impact.results[0].frame.name, 'renderWidget');
assert.equal(impact.results[0].witness[0].to.name, 'Widget');
console.log('relocated-parser-ok');
`,
	);
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"--permission",
			"--allow-worker",
			"--allow-fs-read=*",
			"--input-type=module",
			"-e",
			`await import(${JSON.stringify(join(stage, "smoke.mjs"))})`,
		],
		{ timeout: 15_000, env: { ...process.env, NODE_OPTIONS: undefined } },
	);
	assert.match(stdout, /relocated-parser-ok/);
});
