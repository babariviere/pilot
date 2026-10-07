import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ArtifactRevision, ArtifactWrite } from "@pilot/protocol";
import { type ArtifactToolOptions, createArtifactTools } from "./artifact-tools.ts";

const write: ArtifactWrite = { title: "Chart", kind: "html", source: "<h1>Editable</h1>", libraries: ["echarts"] };
const revision: ArtifactRevision = {
	...write,
	id: "artifact-1",
	sessionId: "session-1",
	projectId: "project-1",
	revision: 3,
	createdAt: 100,
	updatedAt: 200,
	libraries: ["echarts"],
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
	const tools = createArtifactTools({ store, onArtifactsChanged: () => notifications++, ...overrides });
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

test("artifact tools declare structured output, sequential execution and authoring guidance", () => {
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
	}
	for (const name of ["artifact"]) {
		const description = f.tools.find((tool) => tool.name === name)!.description;
		for (const example of [
			"512 KiB",
			"default-export",
			"echarts.init",
			"mermaid.initialize",
			"motion.animate",
			"d3.select",
			"THREE.Scene",
			"arbitrary npm imports",
			"Tailwind is not available",
			"native bridge",
			"<style> tags",
			"--pilot-background",
			"--pilot-foreground",
			"--pilot-muted",
			"--pilot-muted-foreground",
			"--pilot-border",
			"--pilot-primary",
			"--pilot-radius",
			"your styles may override them",
		])
			assert.ok(description.includes(example), `${name}: ${example}`);
	}
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
	assert.ok(!JSON.stringify(result).includes("Editable"));
});

test("update forwards the full write and expected revision, notifying only after success", async () => {
	const f = fixture();
	await f.call("update", { id: "artifact-1", expectedRevision: 2, ...write });
	assert.deepEqual(f.calls, [{ method: "update", args: ["artifact-1", write, 2] }]);
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
	const f = fixture({
		preview: async () => assert.fail("invalid calls must not render"),
	});
	for (const action of ["get", "update"])
		await assert.rejects(f.call(action, write), new RegExp(`Artifact ${action} requires id`));
	for (const action of ["create", "update", "preview"]) {
		for (const field of ["title", "kind", "source"] as const) {
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
	assert.deepEqual(f.calls, [{ method: "create", args: [write] }]);
});

test("image actions forward embedded sources and do not expose image bytes in publication results", async () => {
	const source =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
	const imageWrite: ArtifactWrite = { title: "Image", kind: "image", source };
	let previews = 0;
	const f = fixture({
		preview: async (write) => {
			assert.deepEqual(write, imageWrite);
			previews++;
			return {
				screenshot: { mimeType: "image/png", data: "cG5n", width: 800, height: 600 },
				consoleMessages: [],
				contentHeight: 600,
			};
		},
	});
	for (const action of ["create", "update"]) {
		const result = await f.call(action, { ...imageWrite, id: "artifact-1", expectedRevision: 3 });
		assert.ok(!JSON.stringify(result).includes(source));
	}
	assert.deepEqual(f.calls, [
		{ method: "create", args: [imageWrite] },
		{ method: "update", args: ["artifact-1", imageWrite, 3] },
	]);
	await f.call("preview", imageWrite);
	assert.equal(previews, 1);
	assert.equal(f.notifications, 2);
	await assert.rejects(f.call("create", { ...imageWrite, libraries: ["react"] }), /do not use libraries/);
	await assert.rejects(f.call("create", { ...imageWrite, source: "https://example.com/image.png" }), /local path/);
	assert.equal(f.notifications, 2);
});

test("preview forwards viewport and abort signal, returns image content and structured screenshot", async () => {
	const signal = new AbortController().signal;
	const screenshot = { mimeType: "image/png" as const, data: "cG5n", width: 640, height: 480 };
	const diagnostics = { consoleMessages: [{ level: "error", text: "Render warning" }], contentHeight: 900 };
	const f = fixture({
		preview: async (received, options) => {
			assert.deepEqual(received, write);
			assert.deepEqual(options, { width: 640, height: 480, signal });
			return { screenshot, ...diagnostics };
		},
	});
	const result = await f.call("preview", { ...write, width: 640, height: 480 }, signal);
	assert.deepEqual(result.content, [
		{ type: "image", mimeType: "image/png", data: "cG5n" },
		{ type: "text", text: JSON.stringify(diagnostics) },
	]);
	assert.deepEqual(result.details, diagnostics);
	assert.deepEqual(result.structuredContent, { screenshot, ...diagnostics });
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

test("write and preview reject source above the UTF-8 byte limit before side effects", async () => {
	const f = fixture({
		preview: async () => {
			assert.fail("oversized source must not render");
		},
	});
	for (const name of ["create", "update", "preview"]) {
		await assert.rejects(f.call(name, { id: "artifact-1", ...write, source: "😀".repeat(131_073) }), /512 KiB UTF-8/);
	}
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
	await f.call("create", { ...write, source: "x".repeat(512 * 1024) });
	assert.equal(f.notifications, 1, "exact byte limit is allowed");
});

test("all artifact tools reject already-aborted calls without store or preview work", async () => {
	const f = fixture({
		preview: async () => {
			assert.fail("aborted preview must not render");
		},
	});
	const controller = new AbortController();
	controller.abort(new Error("Stopped"));
	for (const action of ["create", "update", "get", "list", "preview"])
		await assert.rejects(f.call(action, { id: "artifact-1", ...write }, controller.signal), /Stopped/);
	assert.deepEqual(f.calls, []);
	assert.equal(f.notifications, 0);
});

test("store and missing-browser errors propagate without change notifications", async () => {
	const f = fixture({
		preview: async () => {
			throw new Error("Install Chromium: npx playwright install chromium");
		},
	});
	f.store.get = async () => {
		throw new Error("Artifact not found");
	};
	f.store.create = async () => {
		throw new Error("Unsupported import");
	};
	await assert.rejects(f.call("get", { id: "missing" }), /Artifact not found/);
	await assert.rejects(f.call("create", write), /Unsupported import/);
	await assert.rejects(f.call("preview", write), /npx playwright install chromium/);
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
