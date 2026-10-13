import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "@pilot/artifacts";
import type { ArtifactReference } from "@pilot/protocol";
import subagentArtifacts from "./subagent-artifact-extension.ts";
import {
	executeSubagentArtifact,
	SubagentArtifactHost,
	ARTIFACT_CALL_EVENT,
	ARTIFACT_RESULT_EVENT,
} from "./subagent-artifacts.ts";

test("child artifact tool reads and publishes to its parent, rejects foreign sources and serializes optimistic updates", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "subagent-artifacts-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ArtifactStore(join(root, "parent"), { sessionId: "parent" });
	const foreign = new ArtifactStore(join(root, "other"), { sessionId: "other" });
	const first = await store.create({ title: "Parent", kind: "html", source: "PARENT SOURCE" });
	const other = await foreign.create({ title: "Other", kind: "html", source: "FOREIGN SOURCE" });
	const publications: Array<{ artifact: ArtifactReference; name?: string }> = [];
	let notifications = 0;
	let fallback = 0;
	const options = {
		store,
		diagnose: false as const,
		onArtifactsChanged: () => notifications++,
		onArtifactPublished: async (artifact: ArtifactReference, name?: string) => {
			publications.push({ artifact, name });
		},
		readReference: async () => {
			fallback++;
			return other;
		},
	};
	let tool!: ToolDefinition;
	const handlers = new Map<string, () => void>();
	const env = { ...process.env };
	t.after(() => {
		process.env = env;
		handlers.get("session_shutdown")?.();
	});
	process.env.PI_CODE_MODE_SUBAGENT = "1";
	process.env.PILOT_ARTIFACT_PARENT_SESSION_ID = "parent";
	const oldSend = process.send;
	t.after(() => {
		process.send = oldSend;
	});
	process.send = ((message: unknown, callback: (error: Error | null) => void) => {
		const packet = message as { callId: string; args: unknown };
		void executeSubagentArtifact("parent", root, options, {
			parentSessionId: "parent",
			name: "designer",
			callId: packet.callId,
			args: packet.args,
		}).then(
			(result) =>
				(process as EventEmitter).emit("message", { type: "artifact.result", callId: packet.callId, result }),
			(error: Error) =>
				(process as EventEmitter).emit("message", {
					type: "artifact.result",
					callId: packet.callId,
					error: error.message,
				}),
		);
		callback(null);
		return true;
	}) as typeof process.send;
	subagentArtifacts({
		registerTool: (registered: ToolDefinition) => {
			tool = registered;
		},
		on: (event: string, handler: () => void) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	assert.ok(tool);
	handlers.get("session_start")!();
	const call = (args: object) => tool.execute("child", args, undefined, undefined, { cwd: root } as never);
	const read = await call({ action: "get", id: first.id, revision: 1 });
	assert.match(JSON.stringify(read.structuredContent), /PARENT SOURCE/);
	assert.ok(!("html" in (read.structuredContent as unknown as { artifact: object }).artifact));
	const list = await call({ action: "list" });
	assert.match(JSON.stringify(list.structuredContent), new RegExp(first.id));
	assert.doesNotMatch(JSON.stringify(list.structuredContent), /PARENT SOURCE|FOREIGN SOURCE/);
	await assert.rejects(call({ action: "get", id: other.id }));
	assert.equal(fallback, 0, "children never inherit the parent's cross-member read capability");
	const created = await call({ action: "create", title: "Child", kind: "html", source: "CHILD SOURCE" });
	const ref = (created.structuredContent as unknown as { artifact: ArtifactReference }).artifact;
	assert.equal(ref.sessionId, "parent");
	assert.equal((await store.get(ref.id)).source, "CHILD SOURCE");
	assert.equal(publications[0]!.name, "designer");
	assert.equal(notifications, 1);
	await assert.rejects(
		call({ action: "update", id: ref.id, title: "Child", kind: "html", source: "NO REVISION" }),
		/expectedRevision/,
	);
	const writes = await Promise.allSettled(
		["ONE", "TWO"].map((source) =>
			call({
				action: "update",
				id: ref.id,
				expectedRevision: 1,
				title: "Child",
				kind: "html",
				source,
			}),
		),
	);
	assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
	assert.equal((await store.get(ref.id)).revision, 2);
	assert.equal(publications.length, 2);
	assert.equal((await foreign.get(other.id)).source, "FOREIGN SOURCE");
	await assert.rejects(
		executeSubagentArtifact("parent", root, options, {
			parentSessionId: "other",
			name: "designer",
			args: { action: "get", id: first.id },
		}),
		/does not match/,
	);
	await assert.rejects(
		call({ action: "create", title: "File", kind: "image", source: "/tmp/private.png" }),
		/inline data URLs/,
	);
	process.send = ((_message: unknown, callback: (error: Error | null) => void) => {
		callback(null);
		return true;
	}) as typeof process.send;
	const disconnected = call({ action: "get", id: first.id });
	(process as EventEmitter).emit("disconnect");
	await assert.rejects(disconnected, /disconnected/);
});

test("parent artifact host bounds in-flight calls and drains them before releasing its listeners", async () => {
	const events = new EventEmitter();
	const handlers = new Map<string, () => Promise<void>>();
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const unavailable = async (): Promise<never> => {
		throw new Error("unexpected operation");
	};
	const host = new SubagentArtifactHost("parent", "/tmp", {
		store: {
			create: unavailable,
			update: unavailable,
			list: unavailable,
			get: async () => {
				await gate;
				return {
					id: "id",
					sessionId: "parent",
					title: "T",
					kind: "html",
					revision: 1,
					createdAt: 1,
					updatedAt: 1,
					source: "SOURCE",
					libraries: [],
					html: "COMPILED",
				};
			},
		},
	});
	host.native({
		events: {
			emit: (event: string, data: unknown) => {
				events.emit(event, data);
			},
			on: (event: string, listener: (data: unknown) => void) => {
				events.on(event, listener);
				return () => {
					events.off(event, listener);
				};
			},
		},
		on: (event: string, handler: () => Promise<void>) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	const replies: Array<{ callId: string; error?: string }> = [];
	events.on(ARTIFACT_RESULT_EVENT, (data) => replies.push(data));
	for (let n = 0; n < 9; n++)
		events.emit(ARTIFACT_CALL_EVENT, {
			callId: String(n),
			parentSessionId: "parent",
			name: "reviewer",
			args: { action: "get", id: "id" },
		});
	assert.match(replies[0]!.error!, /Too many/);
	let closed = false;
	const closing = host.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(events.listenerCount(ARTIFACT_CALL_EVENT), 0);
	finish();
	await closing;
	assert.equal(replies.length, 9);
	await handlers.get("session_shutdown")!();
});

test("child artifact extension is inactive outside an advertised supervised child", () => {
	const previous = process.env.PI_CODE_MODE_SUBAGENT;
	delete process.env.PI_CODE_MODE_SUBAGENT;
	try {
		subagentArtifacts({
			registerTool: () => assert.fail("ordinary Pi must not gain parent access"),
		} as unknown as ExtensionAPI);
	} finally {
		if (previous !== undefined) process.env.PI_CODE_MODE_SUBAGENT = previous;
	}
});
