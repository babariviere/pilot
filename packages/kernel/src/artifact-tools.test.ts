import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord/json";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ArtifactNotFound, ArtifactStore, captureNshSource, ensureArtifactScratch } from "@pilot/artifacts";
import type { ArtifactRevision, ArtifactWrite } from "@pilot/protocol";
import { ARTIFACT_SKILL_PATH } from "./artifact-skill.ts";
import { type ArtifactToolOptions, createArtifactTools } from "./artifact-tools.ts";

const write: ArtifactWrite = {
	title: "Chart",
	kind: "image",
	source:
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
};
const revision: ArtifactRevision = {
	...write,
	id: "artifact-1",
	sessionId: "session-1",
	projectId: "project-1",
	revision: 3,
	createdAt: 100,
	updatedAt: 200,
	libraries: [],
	html: "COMPILED_HTML_MUST_NOT_REACH_MODEL".repeat(1000),
};

function fixture(overrides: Partial<ArtifactToolOptions> = {}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	let notifications = 0;
	const store: ArtifactToolOptions["store"] = {
		async create(...args) {
			calls.push({ method: "create", args });
			return revision;
		},
		async update(...args) {
			calls.push({ method: "update", args });
			return revision;
		},
		async get(...args) {
			calls.push({ method: "get", args });
			return revision;
		},
		async list(...args) {
			calls.push({ method: "list", args });
			return [revision];
		},
	};
	const tools = createArtifactTools({
		store,
		onArtifactsChanged: () => notifications++,
		...overrides,
	});
	return {
		tools,
		calls,
		store,
		get notifications() {
			return notifications;
		},
		call(action: string, args: object, signal?: AbortSignal) {
			const tool = tools.find((candidate) => candidate.name === "artifact");
			assert.ok(tool);
			return execute(tool, { action, ...args }, signal);
		},
	};
}

function execute(tool: ToolDefinition, args: unknown, signal?: AbortSignal) {
	return tool.execute("call-1", args, signal, undefined, { cwd: process.cwd() } as ExtensionToolContext);
}

test("retired kinds are absent from write schemas and forged writes fail before callbacks", async () => {
	const f = fixture();
	const tool = f.tools[0]!;
	const schema = tool.parameters as { properties: { kind: { enum: string[] }; action: { enum: string[] } } };
	assert.deepEqual(schema.properties.kind.enum, ["image"]);
	assert.deepEqual(schema.properties.action.enum, ["create", "update", "get", "list"]);
	for (const kind of ["html", "react", "swiftui", "visual", "shader"]) {
		for (const action of ["create", "update", "preview"]) {
			const args = { action, id: revision.id, title: "Legacy", kind, source: "while(true){}" };
			assert.throws(
				() => validateToolArguments(tool, { type: "toolCall", id: "old", name: "artifact", arguments: args }),
				/Validation failed/,
			);
			await assert.rejects(execute(tool, args), /is read-only\. Publish kind nsh or image instead/);
		}
		const stored = {
			...revision,
			kind: kind as ArtifactRevision["kind"],
			source: `Exact ${kind} source`,
			libraries: ["react" as const],
			libraryVersions: { react: "old" },
		};
		f.store.get = async () => stored;
		const result = await f.call("get", { id: revision.id, revision: 1 });
		const { html: _html, ...read } = stored;
		assert.deepEqual(result.structuredContent, { artifact: read });
	}
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

for (const ask of [false, true]) {
	test(`get falls back to read-only references, never update or list (ask=${ask})`, async () => {
		const reads: unknown[][] = [];
		const f = fixture({
			ask,
			readReference: async (...args) => {
				reads.push(args);
				return { ...revision, sessionId: "author" };
			},
		});
		await f.call("get", { id: revision.id });
		assert.deepEqual(reads, [], "owned artifacts retain local read semantics");
		f.store.get = async () => {
			throw new ArtifactNotFound("Unknown artifact");
		};
		const result = await f.call("get", { id: revision.id, revision: 2 });
		assert.deepEqual(reads, [[revision.id, 2]]);
		assert.equal(
			(result.structuredContent as unknown as { artifact: ArtifactRevision }).artifact.sessionId,
			"author",
		);
		assert.doesNotMatch(JSON.stringify(result), /COMPILED_HTML/);
		assert.equal(f.notifications, 0);
		f.store.update = async () => {
			throw new ArtifactNotFound("Unknown artifact");
		};
		await assert.rejects(f.call("update", { id: revision.id, ...write }), ArtifactNotFound);
		await f.call("list", {});
		assert.equal(reads.length, 1, "update and list cannot access foreign stores");
	});
}

test("reference reads propagate authorization failures and do not mask damaged local stores", async () => {
	let reads = 0;
	const f = fixture({
		readReference: async () => {
			reads++;
			throw new Error("Artifact reference is not authorized");
		},
	});
	f.store.get = async () => {
		throw new ArtifactNotFound("Unknown artifact");
	};
	await assert.rejects(f.call("get", { id: "foreign" }), /not authorized/);
	assert.equal(reads, 1);
	f.store.get = async () => {
		throw new SyntaxError("Damaged store");
	};
	await assert.rejects(f.call("get", { id: revision.id }), /Damaged store/);
	assert.equal(reads, 1);
});

test("artifact tools declare structured output, sequential execution and a compact namespaced skill pointer", () => {
	const f = fixture();
	assert.deepEqual(
		f.tools.map((tool) => tool.name),
		["artifact"],
	);
	for (const tool of f.tools) {
		assert.ok(tool.outputSchema, tool.name);
		assert.equal(tool.executionMode, "sequential");
		assert.notEqual(tool.exposure, "model-only");
		assert.equal(tool.annotations?.openWorldHint, false);
		assert.notEqual(tool.annotations?.readOnlyHint, true, "the combined tool can publish");
		assert.equal(tool.namespace?.name, "artifacts");
		assert.match(tool.namespace!.description!, /tools\.artifact/);
		assert.match(tool.namespace!.description!, /pilot-artifacts skill/);
		assert.ok(tool.namespace!.instructions!.includes(ARTIFACT_SKILL_PATH));
		assert.match(tool.description, /pilot-artifacts skill before creating or updating artifacts/);
		assert.ok(tool.description.length < 1600, `description bloated to ${tool.description.length} characters`);
		assert.match(tool.description, /512 KiB|16 MiB/);
		assert.match(tool.description, /expectedRevision/);
		assert.doesNotMatch(
			tool.description,
			/echarts\.init|mermaid\.initialize|motion\.animate|@StateObject|String\(fn\)|mainImage/,
		);
	}
});

test("Ask denies every image file path before store or renderer callbacks, including forged calls", async () => {
	const f = fixture({ ask: true });
	for (const source of [
		"/etc/passwd",
		"../secret.png",
		"picture.png",
		"file:///etc/passwd",
		"https://example.test/image.png",
		"/tmp/generated.png",
	]) {
		for (const action of ["create", "update"])
			await assert.rejects(
				f.call(action, { id: revision.id, title: "Escaped", kind: "image", source }),
				/require inline data URLs/,
			);
	}
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

test("Ask inspects stored SwiftUI source without entering rendering or publication paths", async () => {
	const stored: ArtifactRevision = {
		...revision,
		kind: "swiftui",
		source: 'struct ArtifactView: View { var body: some View { Text("Stored") } }',
		libraries: [],
	};
	const f = fixture({ ask: true });
	f.store.get = async () => stored;
	f.store.list = async () => [stored];
	f.store.create = async () => assert.fail("SwiftUI inspection must not publish");
	f.store.update = async () => assert.fail("SwiftUI inspection must not publish");
	assert.deepEqual((await f.call("get", { id: stored.id })).structuredContent, {
		artifact: {
			id: stored.id,
			sessionId: stored.sessionId,
			projectId: stored.projectId,
			title: stored.title,
			kind: "swiftui",
			revision: stored.revision,
			createdAt: stored.createdAt,
			updatedAt: stored.updatedAt,
			source: stored.source,
			libraries: [],
		},
	});
	assert.ok(JSON.stringify((await f.call("list", {})).structuredContent).includes('"kind":"swiftui"'));
	assert.ok(!JSON.stringify(await f.call("get", { id: stored.id })).includes("COMPILED_HTML"));
	const output = f.tools[0]!.outputSchema as {
		anyOf: Array<{ properties: { artifact?: { properties: { kind: { enum: string[] } } } } }>;
	};
	assert.ok(output.anyOf.some((entry) => entry.properties.artifact?.properties.kind?.enum.includes("swiftui")));
	assert.equal(f.notifications, 0);
});

test("create awaits committed publication before notification and returns only a pinned reference", async () => {
	let finish!: (value: ArtifactRevision) => void;
	const committed = new Promise<ArtifactRevision>((resolve) => {
		finish = resolve;
	});
	const f = fixture();
	f.store.create = async () => committed;
	const pending = f.call("create", write);
	assert.equal(f.notifications, 0);
	finish(revision);
	const result = await pending;
	assert.equal(f.notifications, 1);
	const expected = { artifact: { id: "artifact-1", sessionId: "session-1", title: "Chart", revision: 3 } };
	assert.deepEqual(result.details, expected);
	assert.deepEqual(result.structuredContent, expected);
	assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected) }]);
	assert.ok(!JSON.stringify(result).includes("COMPILED_HTML"));
	assert.ok(!JSON.stringify(result).includes(write.source));
});

test("update forwards the full write and expected revision, notifying only after success", async () => {
	const f = fixture();
	await f.call("update", { id: "artifact-1", expectedRevision: 2, ...write });
	assert.deepEqual(f.calls, [{ method: "update", args: ["artifact-1", write, 2, undefined] }]);
	assert.equal(f.notifications, 1);
	f.store.update = async () => {
		throw new Error("Revision conflict");
	};
	await assert.rejects(f.call("update", { id: "artifact-1", expectedRevision: 2, ...write }), /Revision conflict/);
	assert.equal(f.notifications, 1);
});

test("get returns editable metadata and historical revision, list returns summaries only", async () => {
	const f = fixture();
	const result = await f.call("get", { id: "artifact-1", revision: 2 });
	const { html: _html, ...editable } = revision;
	assert.deepEqual(result.structuredContent, { artifact: editable });
	await f.call("get", { id: "artifact-1" });
	assert.deepEqual(f.calls.slice(0, 2), [
		{ method: "get", args: ["artifact-1", 2] },
		{ method: "get", args: ["artifact-1", undefined] },
	]);
	const listed = await f.call("list", {});
	const { source: _source, libraries: _libraries, ...summary } = editable;
	assert.deepEqual(listed.structuredContent, { artifacts: [summary] });
	assert.ok(!JSON.stringify([result, listed]).includes("COMPILED_HTML"));
	assert.equal(f.notifications, 0);
});

test("actions reject missing required fields and unknown actions before side effects", async () => {
	const f = fixture();
	for (const action of ["get", "update"])
		await assert.rejects(f.call(action, write), new RegExp(`Artifact ${action} requires id`));
	for (const action of ["create", "update"]) {
		for (const field of ["title", "kind"] as const) {
			const incomplete: Partial<ArtifactWrite> = { ...write };
			delete incomplete[field];
			await assert.rejects(
				f.call(action, { id: "artifact-1", ...incomplete }),
				new RegExp(`Artifact ${action} requires title, kind and source`),
			);
		}
	}
	await assert.rejects(f.call("unknown", {}), /Unknown artifact action/);
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

test("artifact schema requires a valid action and retains field constraints", () => {
	const [tool] = fixture().tools;
	assert.ok(tool);
	const invalidArguments: Record<string, JsonValue>[] = [
		{},
		{ action: "unknown" },
		{ action: "create", ...write, title: "" },
		{ action: "create", ...write, kind: "text" },
		{ action: "update", ...write, id: "artifact-1", expectedRevision: 0 },
		{ action: "get", id: "artifact-1", revision: 0 },
		{ action: "preview", ...write, width: 239 },
		{ action: "preview", ...write, height: 1601 },
	];
	for (const args of invalidArguments) {
		assert.throws(
			() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: "artifact", arguments: args }),
			/Validation failed/,
		);
	}
});

test("create forwards only document fields, without action or unrelated controls", async () => {
	const f = fixture();
	await f.call("create", { ...write, id: "ignored", revision: 1, expectedRevision: 1, width: 800 });
	assert.deepEqual(f.calls, [{ method: "create", args: [write, undefined] }]);
});

test("unavailable preview is neither advertised nor callable, while publishing still works", async () => {
	const f = fixture();
	const [tool] = f.tools;
	assert.ok(tool);
	assert.doesNotMatch(tool.description, /- preview:|Chromium|install chromium/);
	assert.doesNotMatch(tool.promptSnippet!, /preview/);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /preview|width|height/);
	assert.doesNotMatch(JSON.stringify(tool.outputSchema), /screenshot|consoleMessages|contentHeight/);
	assert.throws(
		() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "unavailable",
				name: "artifact",
				arguments: { action: "preview", ...write },
			}),
		/Validation failed/,
	);
	await assert.rejects(f.call("preview", write), /unavailable; publish without preview/);
	assert.deepEqual(f.calls, []);
	await f.call("create", write);
	await f.call("update", { id: "artifact-1", ...write });
	assert.equal(f.notifications, 2);
});

test("image actions forward embedded sources and do not expose image bytes in publication results", async () => {
	const source =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
	const imageWrite: ArtifactWrite = { title: "Image", kind: "image", source };
	const f = fixture();
	for (const action of ["create", "update"]) {
		const result = await f.call(action, { ...imageWrite, id: "artifact-1", expectedRevision: 3 });
		assert.ok(!JSON.stringify(result).includes(source));
	}
	assert.deepEqual(f.calls, [
		{ method: "create", args: [imageWrite, undefined] },
		{ method: "update", args: ["artifact-1", imageWrite, 3, undefined] },
	]);
	assert.equal(f.notifications, 2);
	await assert.rejects(f.call("create", { ...imageWrite, libraries: ["react"] }), /do not use libraries/);
	await assert.rejects(f.call("create", { ...imageWrite, source: "https://example.com/image.png" }), /local path/);
	assert.equal(f.notifications, 2);
});

test("NSH writes reject captured source above the UTF-8 byte limit before side effects", async () => {
	let source = "😀".repeat(131_073);
	const f = fixture({
		nshSessionDirectory: "/host/session",
		captureNsh: async () => ({ source, entry: "view.tsx" }),
	});
	const nsh = { title: "Big", kind: "nsh", sourcePath: "view.tsx", expectedRevision: 3 };
	for (const name of ["create", "update"])
		await assert.rejects(f.call(name, { id: "artifact-1", ...nsh }), /512 KiB UTF-8/);
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
	source = "x".repeat(512 * 1024);
	await f.call("create", nsh);
	assert.equal(f.notifications, 1, "exact byte limit is allowed");
});

test("all artifact tools reject already-aborted calls without store or preview work", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort(new Error("Stopped"));
	for (const action of ["create", "update", "get", "list", "preview"])
		await assert.rejects(f.call(action, { id: "artifact-1", ...write }, controller.signal), /Stopped/);
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

test("publication waits for asynchronous durable admission before returning and notifying", async () => {
	let admit!: () => void;
	let received: unknown;
	const admitted = new Promise<void>((resolve) => {
		admit = resolve;
	});
	const f = fixture({
		onArtifactPublished: async (artifact) => {
			received = artifact;
			await admitted;
		},
	});
	const pending = f.call("create", write);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(received, { id: "artifact-1", sessionId: "session-1", title: "Chart", revision: 3 });
	assert.equal(f.notifications, 0);
	admit();
	await pending;
	assert.equal(f.notifications, 1);
});

test("image publications pass their header size for display only; the model result is unchanged", async () => {
	const published: unknown[][] = [];
	const f = fixture({
		nshSessionDirectory: "/host/session",
		captureNsh: async () => ({ source: "export default () => null;", entry: "view.tsx" }),
		onArtifactPublished: async (...args) => {
			published.push(args);
		},
	});
	const image = {
		...revision,
		kind: "image" as const,
		source:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==",
		libraries: [],
	};
	f.store.create = async () => image;
	const result = await f.call("create", { title: "Image", kind: "image", source: image.source });
	f.store.update = async () => ({ ...revision, kind: "nsh", source: "export default () => null;" });
	await f.call("update", {
		id: revision.id,
		expectedRevision: 3,
		title: "Chart",
		kind: "nsh",
		sourcePath: "view.tsx",
	});
	const artifact = { id: "artifact-1", sessionId: "session-1", title: "Chart", revision: 3 };
	assert.deepEqual(published, [
		[artifact, { mimeType: "image/png", width: 3, height: 2 }],
		[artifact, undefined],
	]);
	assert.deepEqual(result.structuredContent, { artifact });
});

test("committed publication keeps its metadata fallback when display admission fails", async (t) => {
	const warnings = t.mock.method(console, "warn", () => {});
	const f = fixture({
		onArtifactPublished: async () => {
			throw new Error("Display admission failed");
		},
	});
	const result = await f.call("create", write);
	assert.deepEqual(result.details, result.structuredContent);
	assert.equal(f.notifications, 1, "the committed store still needs a list refresh");
	assert.equal(warnings.mock.callCount(), 1);
});

test("visual and shader writes are refused, while saved revisions stay readable as saved", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-old-visual-artifact-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ArtifactStore(root, { sessionId: "old-session" });
	// The store still saves these kinds, as older Pilot versions did through the tool.
	const source = "function visual({ ui, data }) {\n  return () => ui.column(data.map((row) => ui.text(row.name)));\n}";
	const data = [{ name: "Builds" }];
	const visual = await store.create({ title: "Stats", kind: "visual", source, data });
	const shader = await store.create({
		title: "Glow",
		kind: "shader",
		source: "void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }",
	});
	const f = fixture({ store, nshSessionDirectory: root, captureNsh: async () => assert.fail("never captured") });
	const [tool] = f.tools;
	const schema = tool!.parameters as { properties: { kind: { enum: string[] } } };
	assert.deepEqual(schema.properties.kind.enum, ["image", "nsh"]);
	assert.match(tool!.description, /New artifacts use kind nsh or image/);
	for (const old of [visual, shader])
		for (const action of ["create", "update"])
			await assert.rejects(
				f.call(action, { id: old.id, expectedRevision: 1, title: "Again", kind: old.kind, source: old.source }),
				new RegExp(`Artifact kind "${old.kind}" is read-only\\. Publish kind nsh or image instead`),
			);
	assert.equal(f.notifications, 0);
	assert.deepEqual(await store.get(visual.id), visual);
	assert.deepEqual(await store.get(shader.id), shader);
	const read = await f.call("get", { id: visual.id });
	assert.deepEqual((read.structuredContent as { artifact: unknown }).artifact, {
		...(await store.list()).find((summary) => summary.id === visual.id),
		source,
		libraries: [],
		libraryVersions: {},
		data,
		visual: { api: 1, engine: "quickjs-ng 0.17.0" },
	});
	const shaderRead = (await f.call("get", { id: shader.id })).structuredContent as {
		artifact: { kind: string; source: string };
	};
	assert.equal(shaderRead.artifact.kind, "shader");
	assert.equal(shaderRead.artifact.source, shader.source);
	const listed = (await f.call("list", {})).structuredContent as { artifacts: Array<{ kind: string }> };
	assert.deepEqual(listed.artifacts.map((summary) => summary.kind).sort(), ["shader", "visual"]);
});

test("updates without expectedRevision succeed with a warning", async () => {
	const f = fixture();
	const result = await f.call("update", { id: "artifact-1", ...write });
	const warnings = (result.structuredContent as { warnings?: string[] }).warnings ?? [];
	assert.match(warnings[0] ?? "", /without expectedRevision.*\(3\)/);
	const pinned = await f.call("update", { id: "artifact-1", expectedRevision: 2, ...write });
	assert.ok(!("warnings" in (pinned.structuredContent as object)));
});

test("Ask offers NSH and writes source only to this session's scratch/artifacts", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nsh-ask-tool-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const scratch = join(root, "scratch", "artifacts");
	const project = join(root, "project");
	await mkdir(scratch, { recursive: true });
	await mkdir(project);
	await writeFile(join(project, "secret.tsx"), "project file");
	await symlink(join(project, "secret.tsx"), join(scratch, "linked.tsx"));
	const store = new ArtifactStore(root, { sessionId: "ask-owner" });
	const captured: string[] = [];
	const f = fixture({
		store,
		ask: true,
		nshSessionDirectory: root,
		// Stands in for the host capture: it reads the exact file the tool wrote.
		captureNsh: async (path) => {
			captured.push(path);
			return { source: await readFile(join(scratch, path), "utf8"), entry: path };
		},
	});
	const [tool] = f.tools;
	const schema = tool!.parameters as { properties: { kind: { enum: string[] } } };
	assert.deepEqual(schema.properties.kind.enum, ["image", "nsh"]);
	assert.match(tool!.description, /the tool writes that one file in .*scratch\/artifacts.*Ask writes nothing else/);
	const source = "export default () => null;\n";
	const result = await f.call("create", { title: "Plan", kind: "nsh", sourcePath: "plan.tsx", source });
	const { artifact } = result.structuredContent as { artifact: { id: string } };
	assert.equal(await readFile(join(scratch, "plan.tsx"), "utf8"), source);
	assert.equal((await store.get(artifact.id)).source, source);
	assert.equal((await store.get(artifact.id)).nsh?.entry, "plan.tsx");
	const next = "export default () => 1;\n";
	await f.call("update", {
		id: artifact.id,
		expectedRevision: 1,
		title: "Plan",
		kind: "nsh",
		sourcePath: "plan.tsx",
		source: next,
	});
	assert.equal(await readFile(join(scratch, "plan.tsx"), "utf8"), next);
	for (const sourcePath of [
		"../escape.tsx",
		"sub/plan.tsx",
		".hidden.tsx",
		"plan.ts",
		join(project, "plan.tsx"),
		join(root, "scratch", "plan.tsx"),
	])
		await assert.rejects(
			f.call("create", { title: "Escape", kind: "nsh", sourcePath, source }),
			/sourcePath must name one file in session scratch\/artifacts/,
			sourcePath,
		);
	await assert.rejects(f.call("create", { title: "Linked", kind: "nsh", sourcePath: "linked.tsx", source }), /ELOOP/);
	await assert.rejects(
		f.call("create", { title: "No source", kind: "nsh", sourcePath: "plan.tsx" }),
		/require source/,
	);
	await assert.rejects(
		f.call("update", { id: artifact.id, title: "Plan", kind: "nsh", sourcePath: "plan.tsx", source: "changed" }),
		/expectedRevision/,
	);
	assert.equal(await readFile(join(scratch, "plan.tsx"), "utf8"), next, "a refused update writes nothing");
	assert.equal(await readFile(join(project, "secret.tsx"), "utf8"), "project file");
	assert.deepEqual((await readdir(project)).sort(), ["secret.tsx"]);
	assert.deepEqual((await readdir(scratch)).sort(), ["linked.tsx", "plan.tsx"]);
	assert.deepEqual(captured, ["plan.tsx", "plan.tsx"]);
	// Build keeps file capture: the agent writes the file itself, the tool never takes inline source.
	await assert.rejects(
		fixture({ store, nshSessionDirectory: root, captureNsh: async () => assert.fail("never captured") }).call(
			"create",
			{ title: "Inline", kind: "nsh", sourcePath: "plan.tsx", source },
		),
		/sourcePath only, not source/,
	);
});

test("Ask NSH refuses a scratch folder that resolves elsewhere", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nsh-ask-swapped-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const elsewhere = join(root, "elsewhere");
	await mkdir(elsewhere);
	await mkdir(join(root, "session", "scratch"), { recursive: true });
	await symlink(elsewhere, join(root, "session", "scratch", "artifacts"));
	const f = fixture({ ask: true, nshSessionDirectory: join(root, "session"), captureNsh: async () => assert.fail() });
	await assert.rejects(
		f.call("create", { title: "Plan", kind: "nsh", sourcePath: "plan.tsx", source: "export default () => null;" }),
		/must be a plain folder/,
	);
	assert.deepEqual(await readdir(elsewhere), []);
	assert.deepEqual(f.calls, []);
});

test("NSH tool refuses compile errors before creating or updating any revision", async () => {
	let published = 0;
	const f = fixture({
		nshSessionDirectory: "/host/session",
		captureNsh: async () => {
			throw new Error("Artifact.tsx:1:28: Expected closing tag. Nothing was published.");
		},
		onArtifactPublished: async () => {
			published++;
		},
	});
	for (const action of ["create", "update"]) {
		await assert.rejects(
			f.call(action, { id: "existing", expectedRevision: 1, title: "Invalid", kind: "nsh", sourcePath: "view.tsx" }),
			/Artifact.tsx:1:28: Expected closing tag/,
		);
	}
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
	assert.equal(published, 0);
});

test("NSH tool waits for compilation of the exact captured bytes before publication", async () => {
	let enter = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let compile = () => {};
	const compiled = new Promise<void>((resolve) => {
		compile = resolve;
	});
	const source = '\uFEFFexport default () => "é😀";\r\n';
	const controller = new AbortController();
	const f = fixture({
		nshSessionDirectory: "/host/session",
		captureNsh: async (path, signal) => {
			assert.equal(path, "view.tsx");
			assert.equal(signal, controller.signal);
			enter();
			await compiled;
			return { source, entry: "view.tsx" };
		},
	});
	const pending = f.call("create", { title: "Preview", kind: "nsh", sourcePath: "view.tsx" }, controller.signal);
	await entered;
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
	compile();
	const result = await pending;
	assert.deepEqual(f.calls, [
		{ method: "create", args: [{ title: "Preview", kind: "nsh", source, entry: "view.tsx" }, controller.signal] },
	]);
	assert.match((result.structuredContent as { warnings: string[] }).warnings.join(), /compiled and saved/);
	assert.equal(f.notifications, 1);
});

test("NSH canceled compilation cannot publish even if the compiler returns success", async () => {
	const controller = new AbortController();
	const f = fixture({
		nshSessionDirectory: "/host/session",
		captureNsh: async () => {
			controller.abort();
			return { source: "export default () => null;", entry: "view.tsx" };
		},
	});
	await assert.rejects(
		f.call("create", { title: "Preview", kind: "nsh", sourcePath: "view.tsx" }, controller.signal),
		{ name: "AbortError" },
	);
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

test("NSH failed update compilation keeps the saved revision and history unchanged", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nsh-tool-compile-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ArtifactStore(root, { sessionId: "owner" });
	const first = await store.create({
		title: "Saved",
		kind: "nsh",
		source: "export default () => null;",
		entry: "view.tsx",
	});
	const f = fixture({
		store,
		nshSessionDirectory: root,
		captureNsh: async () => {
			throw new Error("Artifact.tsx:1:28: Invalid TSX");
		},
	});
	await assert.rejects(
		f.call("update", { id: first.id, expectedRevision: 1, title: "Invalid", kind: "nsh", sourcePath: "view.tsx" }),
		/Invalid TSX/,
	);
	assert.deepEqual(await store.get(first.id), first);
	assert.equal((await store.list()).length, 1);
	assert.equal(f.notifications, 0);
});

test("NSH tool captures only session scratch and keeps exact pins without executing source", {
	skip: !process.env.NSH_ARTIFACT_TEST_HOST ? "Run the focused Day artifact-source wrapper" : false,
}, async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nsh-tool-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const host = process.env.NSH_ARTIFACT_TEST_HOST;
	const directory = await ensureArtifactScratch(root, host);
	const source = "throw Error('never executed at publication'); export default () => null;\r\n";
	await writeFile(join(directory, "view.tsx"), source);
	const store = new ArtifactStore(root, { sessionId: "owner" });
	const f = fixture({
		store,
		nshSessionDirectory: root,
		captureNsh: (path, signal) => captureNshSource(root, path, signal, host),
	});
	const result = await f.call("create", { title: "Preview", kind: "nsh", sourcePath: "view.tsx" });
	const data = result.structuredContent as { artifact: { id: string; revision: number }; warnings: string[] };
	assert.equal(data.artifact.revision, 1);
	assert.match(data.warnings.join(), /Preview availability depends on your app/);
	assert.equal((await store.get(data.artifact.id)).source, source);
	await assert.rejects(
		f.call("update", { id: data.artifact.id, title: "Next", kind: "nsh", sourcePath: "view.tsx" }),
		/expectedRevision/,
	);
	await assert.rejects(f.call("create", { title: "No", kind: "nsh", source: "inline" }), /sourcePath only/);
	await assert.rejects(f.call("create", { title: "No", kind: "nsh", sourcePath: "../outside.tsx" }), /sourcePath/);
	await assert.rejects(
		fixture({ store, nshSessionDirectory: root, ask: true }).call("create", {
			title: "No",
			kind: "nsh",
			sourcePath: "view.tsx",
		}),
		/Ask NSH artifacts require source/,
	);
	assert.equal((await store.list()).length, 1);
	const read = await f.call("get", { id: data.artifact.id, revision: 1 });
	assert.equal(
		(read.structuredContent as { artifact: { nsh: { rendering: string } } }).artifact.nsh.rendering,
		undefined,
	);
	for (const invalid of ["export default () => <Text>;", "import {host} from 'nsh'; export default () => host;"]) {
		await writeFile(join(directory, "view.tsx"), invalid);
		for (const action of ["create", "update"]) {
			await assert.rejects(
				f.call(action, {
					id: data.artifact.id,
					expectedRevision: 1,
					title: "Invalid",
					kind: "nsh",
					sourcePath: "view.tsx",
				}),
				/Artifact.tsx/,
			);
		}
		assert.equal((await store.get(data.artifact.id)).source, source);
		assert.equal((await store.get(data.artifact.id)).revision, 1);
		assert.equal((await store.list()).length, 1);
	}
});
