import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput, Storage } from "@earendil-works/pi-durable";
import { turnPreparation } from "./turn-preparation.ts";

function fixture(kind = "pi.user", overflow = false) {
	let first = 1;
	const input = {
		conversationId: "c",
		read: { snapshot: async () => ({ run: { inputs: [first, 2] } }) },
	} as unknown as PromptInput;
	const storage = {
		submission: async () => ({ status: "placed", entry: 3 }),
		scanEntries: async () => ({ items: [{ kind }], ...(overflow ? { next: {} } : {}) }),
	} as unknown as Storage;
	return {
		input,
		storage,
		next: () => {
			first++;
		},
	};
}

test("first prompt waits for refresh, tool rounds and steers do not refresh, next queued turn does", async () => {
	const f = fixture();
	let calls = 0;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const prepare = turnPreparation(f.storage, async () => {
		calls++;
		await blocked;
	});
	let ready = false;
	const first = prepare(f.input, BACKGROUND_CONTEXT).then(() => {
		ready = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
	assert.equal(ready, false);
	release();
	await first;
	await prepare(f.input, BACKGROUND_CONTEXT);
	assert.equal(calls, 1, "same run, including newly steered input");
	f.next();
	await prepare(f.input, BACKGROUND_CONTEXT);
	assert.equal(calls, 2, "new queued turn");
});

test("recovery and large histories never update during an existing turn", async () => {
	for (const f of [fixture("pi.assistant"), fixture("pi.tool-result"), fixture("pi.user", true)]) {
		let calls = 0;
		await turnPreparation(f.storage, async () => {
			calls++;
		})(f.input, BACKGROUND_CONTEXT);
		assert.equal(calls, 0);
	}
	const recovering = fixture();
	recovering.input.read.snapshot = (async () => ({ run: { inputs: [1] }, generation: { attempt: 2 } })) as never;
	let calls = 0;
	await turnPreparation(recovering.storage, async () => {
		calls++;
	})(recovering.input, BACKGROUND_CONTEXT);
	assert.equal(calls, 0, "a recovered request/backoff before its first answer is not a new turn");
});

test("large streaming turns retain one marker and scan at most 16 entries once; ordinary chats do no reads", async () => {
	const f = fixture();
	let scans = 0;
	let snapshots = 0;
	let enabled = false;
	const snapshot = f.input.read.snapshot;
	f.input.read.snapshot = (async (...args: unknown[]) => {
		snapshots++;
		return (snapshot as Function)(...args);
	}) as typeof snapshot;
	const scan = f.storage.scanEntries;
	f.storage.scanEntries = async (...args) => {
		scans++;
		assert.equal(args[1], 16);
		return scan(...args);
	};
	const prepare = turnPreparation(
		f.storage,
		async () => {},
		() => enabled,
	);
	await prepare(f.input, BACKGROUND_CONTEXT);
	assert.equal(snapshots, 0);
	enabled = true;
	for (let i = 0; i < 10_000; i++) await prepare(f.input, BACKGROUND_CONTEXT);
	assert.equal(scans, 1);
	assert.equal(snapshots, 10_000, "one small committed document, not transcript hydration");
});
