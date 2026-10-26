import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../store.ts";
import { checkVisual, VisualCheckError } from "./index.ts";
import { MermaidError, validateMermaid } from "./mermaid.ts";

test("native and publication admission share explicit supported/invalid/unsupported/limit corpus", async () => {
	const corpus = JSON.parse(
		await readFile(new URL("../../../protocol/fixtures/mermaid/syntax.json", import.meta.url), "utf8"),
	) as Array<{ name: string; source: string; kind: string }>;
	for (const value of corpus) {
		if (value.kind === "supported") assert.doesNotThrow(() => validateMermaid(value.source), value.name);
		else
			assert.throws(
				() => validateMermaid(value.source),
				(e: unknown) => e instanceof MermaidError && e.kind === value.kind,
				value.name,
			);
	}
});
test("source, nodes, edges, depth, slots and coordinates remain bounded", () => {
	const full = Array.from({ length: 47 }, (_, i) => `N${Math.floor(i / 2)} --> N${i + 1}`).join("\n");
	assert.doesNotThrow(() => validateMermaid(`graph TD\n${full}`));
	const limit = (source: string) =>
		assert.throws(
			() => validateMermaid(source),
			(e: unknown) => e instanceof MermaidError && e.kind === "limit",
		);
	limit("x".repeat(20 * 1024 + 1));
	limit(`graph TD\n${"%% comment\n".repeat(193)}`);
	limit(`graph TD\n${Array.from({ length: 49 }, (_, i) => `N${i}`).join("\n")}`);
	limit(`graph TD\n${Array.from({ length: 25 }, (_, i) => `N${i}`).join(" --> ")}`);
	limit(`graph TD\n${Array.from({ length: 48 }, (_, i) => `N${i}`).join("\n")}`);
	limit(
		`graph TD\n${Array.from({ length: 15 }, (_, i) => Array.from({ length: 14 - i }, (_, j) => `N${i} --> N${i + j + 1}`).join("\n")).join("\n")}`,
	);
	assert.throws(
		() => validateMermaid(`graph TD\nA${"%".repeat(20 * 1024 - 16)}`),
		(e: unknown) => e instanceof MermaidError && e.kind === "invalid",
	);
});

test("invalid and unvalidated grammar reject check/create/update before immutable publication", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mermaid-admission-"));
	const source = (mermaid: string) => `({ui})=>()=>ui.mermaid(${JSON.stringify(mermaid)})`;
	try {
		const store = new ArtifactStore(dir, { sessionId: "synthetic" });
		for (const [diagram, message] of [
			["graph TD\nA -->", /Invalid Mermaid/],
			["sequenceDiagram\nA->>B: hello", /Unsupported Mermaid/],
			["graph TD\nA --> A", /Unsupported Mermaid/],
		] as const) {
			await assert.rejects(
				checkVisual({ source: source(diagram), data: "null", id: "synthetic" }),
				(e) => e instanceof VisualCheckError && message.test(e.message),
			);
			await assert.rejects(store.create({ title: "Bad", kind: "visual", source: source(diagram) }), message);
			assert.deepEqual(await store.list(), []);
			assert.deepEqual(await readdir(dir), [], "rejected create must not create an artifact directory");
		}
		const first = await store.create({ title: "Good", kind: "visual", source: source("graph TD\nA --> B") });
		await assert.rejects(
			store.update(first.id, { title: "Bad revision", kind: "visual", source: source("graph TD\nA -->") }, 1),
			/Invalid Mermaid/,
		);
		const reopened = new ArtifactStore(dir, { sessionId: "synthetic" });
		assert.deepEqual(await reopened.get(first.id), first);
		await assert.rejects(reopened.get(first.id, 2), /Unknown artifact revision/);
		assert.equal((await reopened.list())[0].revision, 1);
		// A private fixture revision saved before strict admission stays readable.
		const retained = { ...first, source: source("sequenceDiagram\nA->>B: legacy") };
		await writeFile(join(dir, "artifacts", first.id, "1.json"), JSON.stringify(retained));
		assert.deepEqual(await new ArtifactStore(dir, { sessionId: "synthetic" }).get(first.id, 1), retained);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("check rejects Mermaid revealed by native controls, with interaction context", async () => {
	for (const [diagram, message] of [
		["graph TD\nA -->", /Invalid Mermaid/],
		["graph TD\nsubgraph G\nA --> B\nend", /Unsupported Mermaid/],
	] as const) {
		const source = `({ui,state})=>{const s=state({bad:false});return()=>ui.column([ui.toggle({label:"Reveal",value:s.bad,onChange:v=>s.bad=v}),ui.mermaid(s.bad?${JSON.stringify(diagram)}:"graph TD\\nA --> B",{key:"diagram"})])}`;
		await assert.rejects(
			checkVisual({ source, data: "null", id: "synthetic" }),
			(e) => e instanceof VisualCheckError && message.test(e.message) && /after toggle "bad" = true/.test(e.message),
		);
	}
	assert.throws(
		() => validateMermaid('graph TD\nA["\ud800"]'),
		(e: unknown) => e instanceof MermaidError && e.kind === "invalid",
	);
});
