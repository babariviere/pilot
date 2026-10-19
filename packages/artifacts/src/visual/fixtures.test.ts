/** Keeps the shared API 1 fixtures (schema and conformance cases) in step with the runtime and schema. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { Compile } from "typebox/compile";
import { CASES, type ConformanceFile, ERRORS, runCase, runErrorCase } from "./conformance.ts";
import { VISUAL_LIMITS, VisualTreeSchema, visualTreeJsonSchema } from "./schema.ts";
import { VisualSession, visualRuntime } from "./session.ts";

const directory = new URL("../../../protocol/fixtures/visual/", import.meta.url);
/** Set to regenerate the committed files after an intended change, then run pnpm fmt. */
const update = process.env.PILOT_UPDATE_VISUAL_FIXTURES === "1";

async function compare(name: string, value: unknown): Promise<void> {
	const url = new URL(name, directory);
	if (update) await writeFile(url, `${JSON.stringify(value, null, "\t")}\n`);
	assert.deepEqual(
		JSON.parse(await readFile(url, "utf8")),
		JSON.parse(JSON.stringify(value)),
		`${name} is stale. Rerun with PILOT_UPDATE_VISUAL_FIXTURES=1 and review the diff`,
	);
}

async function session(seed: string, now: number): Promise<VisualSession> {
	return VisualSession.open({ wasm: await loadQuickJSWasm(), runtime: await visualRuntime(), seed, now });
}

test("the published JSON Schema matches schema.ts", async () => {
	await compare("api-1.schema.json", visualTreeJsonSchema());
});

test("conformance cases match the runtime", async () => {
	const file: ConformanceFile = {
		api: 1,
		engine: "",
		cases: [],
		errors: [],
	};
	for (const value of CASES) {
		const vm = await session(value.id, value.now);
		try {
			file.engine = vm.engine;
			file.cases.push(runCase(vm, value));
		} finally {
			vm.dispose();
		}
	}
	for (const value of ERRORS) {
		const vm = await session("", 0);
		try {
			file.errors.push({ ...value, error: runErrorCase(vm, value) });
		} finally {
			vm.dispose();
		}
	}
	await compare("conformance.json", file);
});

test("every conformance tree is valid API 1 and covers every node type", async () => {
	const file = JSON.parse(await readFile(new URL("conformance.json", directory), "utf8")) as ConformanceFile;
	const check = Compile(VisualTreeSchema);
	const types = new Set<string>();
	const visit = (node: { type: string; children?: unknown[] }) => {
		types.add(node.type);
		for (const child of node.children ?? []) visit(child as typeof node);
	};
	for (const value of file.cases)
		for (const step of value.steps) {
			assert.ok(check.Check(step.tree), value.name);
			visit(step.tree.root);
		}
	const schema = visualTreeJsonSchema() as {
		$defs: { Node: { anyOf: Array<{ properties: { type: { const: string } } }> } };
	};
	assert.deepEqual([...types].sort(), schema.$defs.Node.anyOf.map((node) => node.properties.type.const).sort());
});

test("the runtime enforces the same limits as schema.ts", async () => {
	const runtime = await visualRuntime();
	const declared = runtime.match(/const LIMITS = Object\.freeze\(\{([^}]*)\}\)/)?.[1] ?? "";
	for (const name of ["nodes", "textChars", "stateChars", "logLines", "logLineChars"] as const) {
		const value = declared.match(new RegExp(`\\b${name}: ([^,\\n]+)`))?.[1];
		assert.equal(value && Function(`return (${value})`)(), VISUAL_LIMITS[name], name);
	}
});
