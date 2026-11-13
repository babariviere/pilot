import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	createKnowledgeTool,
	createProjectPreferencesTool,
	type KnowledgeAction,
	type ProjectContextAction,
} from "./knowledge-tools.ts";

test("knowledge tool forwards stable operation IDs only for writes", async () => {
	const calls: [KnowledgeAction | ProjectContextAction, Record<string, JsonValue>, string | undefined][] = [];
	const tool = createKnowledgeTool(async (action, args, operationId) => {
		calls.push([action, args, operationId]);
		return { ok: true };
	});
	const run = (params: Record<string, unknown>, id = "call-1") =>
		tool.execute(id, params as never, undefined, undefined, undefined as never);
	await run({ action: "list", kind: "component" });
	await run({ action: "create", kind: "investigation", title: "T", synopsis: "S", body: "B" }, "call-2");
	await run({ action: "append", id: "e", expectedRevision: 1, operationId: "retry-1" }, "call-3");
	assert.deepEqual(calls, [
		["list", { kind: "component" }, undefined],
		["create", { kind: "investigation", title: "T", synopsis: "S", body: "B" }, "call-2"],
		["append", { id: "e", expectedRevision: 1, operationId: "retry-1" }, "retry-1"],
	]);
	assert.match(tool.description, /never marks an entry checked/);
});

test("project preferences tool uses explicit operation identity and lookup, never a retry fallback", async () => {
	const calls: unknown[] = [];
	const tool = createProjectPreferencesTool(async (action, args, operationId) => {
		calls.push([action, args, operationId]);
		return { state: "unknown" };
	});
	const run = (params: Record<string, unknown>) =>
		tool.execute("not-an-operation", params as never, undefined, undefined, undefined as never);
	await run({ action: "get" });
	await run({ action: "write", operationId: "explicit", expectedRevision: 0, entries: [], reason: "User removal" });
	await run({ action: "lookup", operationId: "explicit" });
	assert.deepEqual(calls, [
		["preferences.get", {}, undefined],
		[
			"preferences.write",
			{ operationId: "explicit", expectedRevision: 0, entries: [], reason: "User removal" },
			undefined,
		],
		["preferences.lookup", { operationId: "explicit" }, undefined],
	]);
	assert.match(tool.description, /never resend/);
	assert.match(tool.description, /never global defaults/);
});
