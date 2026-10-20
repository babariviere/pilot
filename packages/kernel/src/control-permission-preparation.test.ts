import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput, Storage } from "@earendil-works/pi-durable";
import { controlPermissionPreparation } from "./control-permission-preparation.ts";
import { type ControlPermission, controlPermissionBlock, nativeToolPolicy } from "./tool-policy.ts";

type NativeCheck = (event: {
	toolName: string;
	input: Record<string, unknown>;
}) => { block: boolean; reason: string } | undefined;

test("inherited implement permits delivery before recovery or any legacy label update", async () => {
	const permission: ControlPermission = { authorizationId: "build", level: "implement" };
	let first = 1;
	let recovering = true;
	let calls = 0;
	const input = {
		conversationId: "c",
		read: {
			snapshot: async () => ({
				run: { inputs: [first] },
				...(recovering ? { generation: { attempt: 1 } } : {}),
			}),
		},
	} as unknown as PromptInput;
	const storage = {
		submission: async () => ({ status: "placed", entry: 3 }),
		scanEntries: async () => ({ items: [{ kind: "pi.user" }] }),
	} as unknown as Storage;
	let before: NativeCheck = () => undefined;
	nativeToolPolicy(permission)({
		on: (_event: string, handler: NativeCheck) => {
			before = handler;
		},
	} as never);
	const prepare = controlPermissionPreparation(storage, permission, async () => {
		calls++;
		return { authorizationId: "publish", level: "publish" };
	});
	await prepare(input, BACKGROUND_CONTEXT);
	assert.equal(calls, 0);
	recovering = false;
	await prepare(input, BACKGROUND_CONTEXT);
	assert.equal(calls, 0, "same recovered run remains pinned even after its request ends");
	assert.equal(controlPermissionBlock(permission, "bash", { command: "git push" }), undefined);
	assert.equal(before({ toolName: "bash", input: { command: "gh pr create" } }), undefined);
	first++;
	await prepare(input, BACKGROUND_CONTEXT);
	assert.equal(calls, 1);
	assert.deepEqual(permission, { authorizationId: "publish", level: "publish" });
	assert.equal(controlPermissionBlock(permission, "bash", { command: "git push" }), undefined);
	assert.equal(before({ toolName: "bash", input: { command: "gh pr create" } }), undefined);
});

test("ordinary, investigate and already published chats do no new boundary reads", async () => {
	for (const permission of [
		undefined,
		{ authorizationId: "a", level: "investigate" },
		{ authorizationId: "a", level: "publish" },
	] as const) {
		await controlPermissionPreparation({} as Storage, permission, async () => assert.fail("unexpected handshake"))(
			{ read: { snapshot: () => assert.fail("unexpected read") } } as unknown as PromptInput,
			BACKGROUND_CONTEXT,
		);
	}
});
