import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAskTools } from "./ask-tools.ts";
import { createCoordinatorSourceTools } from "./coordinator-source-tools.ts";
import { createExplorationTools } from "./exploration-tools.ts";
import { createReferenceSourcesTool, type ReferenceSource, withReferenceSources } from "./reference-sources.ts";

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-reference-sources-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const dependency = join(root, "mod", "github.com", "!acme", "schema@v0.32.0");
	const linked = join(root, "views", "lib", "source");
	const unlinked = join(root, "views", "other", "source");
	for (const dir of [project, dependency, linked, unlinked]) await mkdir(dir, { recursive: true });
	await writeFile(join(project, "main.go"), "package main\n");
	await writeFile(join(dependency, "event.go"), "package schema\n// needle in dependency\n");
	await writeFile(join(dependency, "..", "secret.txt"), "outside the pinned module");
	await writeFile(join(linked, "lib.ts"), "export const needle = 1;\n");
	await writeFile(join(unlinked, "other.ts"), "export const hidden = 1;\n");
	const references: ReferenceSource[] = [
		{ kind: "linked", name: "lib", path: linked },
		{ kind: "dependency", name: "github.com/Acme/schema", version: "v0.32.0", path: dependency },
		{ kind: "dependency", name: "golang.org/x/text", version: "v0.1.0", indirect: true, path: join(root, "x") },
	];
	return { root, project, dependency, linked, unlinked, references };
}

function caller(tools: ToolDefinition[], cwd: string) {
	return async (name: string, args: Record<string, unknown>) => {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool, name);
		const result = await tool.execute("test", args, undefined, undefined, { cwd } as ExtensionToolContext);
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	};
}

test("Ask reads inside a pinned dependency or linked project and refuses everything else", async (t) => {
	const f = await fixture(t);
	let reads = 0;
	const call = caller(
		withReferenceSources(await createAskTools({ source: f.project }), f.project, async () => {
			reads++;
			return f.references;
		}),
		f.project,
	);
	assert.match(await call("read", { path: "main.go" }), /package main/);
	assert.equal(reads, 0, "project paths never ask the host");
	assert.match(await call("read", { path: join(f.dependency, "event.go") }), /needle in dependency/);
	assert.match(await call("grep", { path: f.dependency, pattern: "needle" }), /event.go:2/);
	assert.match(await call("ls", { path: f.linked }), /lib.ts/);
	assert.match(await call("read", { path: join(f.linked, "lib.ts") }), /needle/);
	await assert.rejects(call("read", { path: join(f.unlinked, "other.ts") }), /inside the source/);
	await assert.rejects(call("read", { path: join(f.dependency, "..", "secret.txt") }), /inside the source/);
	await assert.rejects(call("read", { path: `${f.dependency}/../schema@v0.32.0/event.go` }), /traversal/);
	await assert.rejects(call("read", { path: join(f.dependency, "..", "..", "..", "..", "secret.txt") }));
});

test("Build code exploration follows the same reference roots", async (t) => {
	const f = await fixture(t);
	const call = caller(
		withReferenceSources(createExplorationTools({ source: f.project }), f.project, async () => f.references),
		f.project,
	);
	const found = JSON.parse(await call("code_search", { path: f.linked, query: "needle" }));
	assert.ok(JSON.stringify(found).includes("lib.ts"));
	await assert.rejects(call("code_search", { path: f.unlinked, query: "hidden" }));
});

test("coordinator source tools admit reference roots from the host scope only", async (t) => {
	const f = await fixture(t);
	const scratch = join(f.root, "scratch");
	await mkdir(scratch);
	let references: ReferenceSource[] | undefined = f.references;
	const tools = await createCoordinatorSourceTools(
		async () => ({ main: f.project, members: [], scratch, skills: [], ...(references ? { references } : {}) }),
		scratch,
		() => {},
	);
	const call = caller(tools, scratch);
	assert.match(await call("read", { path: join(f.dependency, "event.go") }), /needle in dependency/);
	assert.match(await call("read", { path: join(f.linked, "lib.ts") }), /needle/);
	await assert.rejects(call("read", { path: join(f.unlinked, "other.ts") }), /outside current main/);
	references = undefined;
	await assert.rejects(call("read", { path: join(f.dependency, "event.go") }), /outside current main/);
});

test("the listing shows direct dependencies and linked projects, and indirect ones by name", async (t) => {
	const f = await fixture(t);
	const call = caller([createReferenceSourcesTool(async () => f.references)], f.project);
	const listing = await call("reference_sources", {});
	assert.match(listing, /lib \(linked project\) → /);
	assert.match(listing, /github.com\/Acme\/schema@v0.32.0 → .*schema@v0.32.0/);
	assert.doesNotMatch(listing, /golang.org/);
	assert.match(listing, /1 indirect dependencies/);
	assert.match(await call("reference_sources", { name: "TEXT" }), /golang.org\/x\/text@v0.1.0/);
});
