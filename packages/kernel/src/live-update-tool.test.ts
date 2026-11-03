import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createLiveUpdateTools } from "./live-update-tool.ts";
import type { KernelSpec } from "./protocol.ts";

const spec: KernelSpec = {
	sessionId: "chat",
	projectId: "pilot",
	storageDir: "/tmp/faux-storage",
	cwd: "/tmp/faux-pilot",
	liveUpdateProposals: true,
};
const args = {
	directory: "/tmp/faux-built-release",
	source: "a".repeat(40),
	build: "1.109.2",
	summary: "Fix rendering",
};

test("pilot_update only proposes via callback with stable operation identity", async () => {
	const calls: unknown[] = [];
	const [tool] = createLiveUpdateTools(spec, async (...request) => {
		calls.push(request);
		return { status: "proposed", approvalRequired: true };
	});
	assert.ok(tool);
	assert.equal(tool.name, "pilot_update");
	for (const [id, params] of [
		["call-1", args],
		["call-2", { ...args, operationId: "retry-1" }],
	] as const) {
		const result = await tool.execute(id, params, undefined, undefined, {} as never);
		assert.deepEqual(result.details, { status: "proposed", approvalRequired: true });
		assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), result.details);
	}
	assert.deepEqual(calls, [
		[args, "call-1"],
		[args, "retry-1"],
	]);
});

test("pilot_update admission preserves read-only, specialist and shared-context guards", () => {
	const call = async () => null;
	for (const denied of [
		{ ...spec, liveUpdateProposals: undefined },
		{ ...spec, liveUpdateProposals: false },
		{ ...spec, projectId: undefined },
		{ ...spec, pilot: { ask: { source: "/tmp/source" } } },
		{ ...spec, pilot: { executionPermission: { level: "investigate", authorizationId: "grant" } } },
		{ ...spec, role: "diagnostics" },
		{ ...spec, pilot: { coordinatorView: { path: "/tmp/source", scratch: "/tmp/scratch", protectedPaths: [] } } },
		...[{ sharedContext: true }, { role: "explorer" }, { role: "reviewer" }].map((mission) => ({ ...spec, mission })),
	] as KernelSpec[])
		assert.deepEqual(createLiveUpdateTools(denied, call), []);
	assert.deepEqual(createLiveUpdateTools(spec), []);
	assert.equal(createLiveUpdateTools(spec, call).length, 1);
});

test("pilot_update schema rejects malformed release metadata and execution actions", () => {
	const [tool] = createLiveUpdateTools(spec, async () => assert.fail("schema validation must not dispatch"));
	assert.ok(tool);
	const validate = (arguments_: Record<string, JsonValue>) =>
		validateToolArguments(tool, {
			type: "toolCall",
			id: "test",
			name: "pilot_update",
			arguments: arguments_,
		});
	validate(args);
	for (const invalid of [
		{},
		{ ...args, directory: "relative/path" },
		{ ...args, directory: "https://example.com/release" },
		{ ...args, directory: "/tmp/\u0000release" },
		{ ...args, source: "A".repeat(40) },
		{ ...args, source: "a".repeat(39) },
		{ ...args, build: "1.beta" },
		{ ...args, build: "1..2" },
		{ ...args, summary: "" },
		{ ...args, operationId: "" },
		...["accept", "cancel", "restart"].map((action) => ({ ...args, action })),
	])
		assert.throws(() => validate(invalid));
});

test("pilot_update forwards daemon failure without claiming an update", async () => {
	const [tool] = createLiveUpdateTools(spec, async () => {
		throw new Error("not admitted");
	});
	await assert.rejects(tool!.execute("call", args, undefined, undefined, {} as never), /not admitted/);
});
