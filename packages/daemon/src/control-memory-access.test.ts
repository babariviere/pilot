import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createControlMemoryTools } from "../../kernel/src/control-memory-tools.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlMemoryAccess } from "./control-memory-access.ts";

test("only control declares zoom/date, and caller authorization is live on every read", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-zoom-")),
		memory = new ControlMemory(home);
	t.after(async () => {
		await memory.stop();
		await rm(home, { recursive: true, force: true });
	});
	let control = true;
	const access = new ControlMemoryAccess(memory, (id) => id === "control" && control);
	const call = async () => null;
	assert.deepEqual(createControlMemoryTools(false, call), []);
	const tools = createControlMemoryTools(true, call);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["zoom", "date"],
	);
	assert.ok(tools.every((tool) => tool.description.length < 120));
	await memory.append({ kind: "user", text: "first", at: 1234 });
	await memory.append({ kind: "assistant", text: "second" });
	assert.deepEqual(await access.call("control", "zoom", { id: 0, n: 2 }), {
		untrusted: true,
		lines: [
			{ id: 0, n: 1, text: "user: first" },
			{ id: 1, n: 1, text: "assistant: second" },
		],
	});
	assert.deepEqual(await access.call("control", "date", { id: 0 }), { id: 0, at: new Date(1234).toISOString() });
	await assert.rejects(access.call("other", "zoom", { id: 0, n: 1 }), /Only the control/);
	control = false;
	await assert.rejects(access.call("control", "date", { id: 0 }), /Only the control/);
	control = true;
	for (const args of [
		{ id: 1, n: 2 },
		{ id: 0, n: 3 },
		{ id: -1, n: 1 },
		{ id: 2, n: 1 },
		{ id: 0, n: 2, offset: 0 },
	])
		await assert.rejects(access.call("control", "zoom", args));
	const input = { data: "🙂".repeat(15_000) };
	const [message] = await memory.append({ kind: "tool", text: "", name: "sample", input });
	let text = "",
		offset = 0;
	for (;;) {
		const page = (await access.call("control", "zoom", { id: message!.id, n: 1, offset })) as {
			untrusted: boolean;
			message: { text: string; input?: unknown };
			format: string;
			next?: number;
		};
		assert.equal(page.untrusted, true);
		assert.equal(page.format, "json");
		assert.equal(page.message.input, undefined);
		assert.ok(page.message.text.length <= 12_000);
		assert.doesNotMatch(page.message.text, /�/);
		text += page.message.text;
		if (page.next === undefined) break;
		offset = page.next;
	}
	assert.deepEqual(JSON.parse(text), { name: "sample", input, text: "" });
});
