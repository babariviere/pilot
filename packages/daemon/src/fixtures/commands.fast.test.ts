import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

test("fixture commands reply in order and quit while the parent keeps stdin open", { timeout: 10_000 }, async (t) => {
	const child = spawn(process.execPath, [
		"--input-type=module",
		"--eval",
		`import { serveCommands } from ${JSON.stringify(new URL("./commands.ts", import.meta.url).href)};
		let count = 0;
		await serveCommands(async ({ value }) => ({ count: ++count, value: await Promise.resolve(value) }));`,
	]);
	t.after(() => {
		child.stdin.destroy();
		child.kill();
	});
	child.stdin.on("error", () => {}); // A failed child may close its side before the write arrives.
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	const closed = once(child, "close");
	child.stdin.write('{"action":"read","value":"first"}\n{"action":"read","value":"second"}\n{"action":"quit"}\n');
	assert.deepEqual(await closed, [0, null], stderr);
	assert.equal(stdout, '{"count":1,"value":"first"}\n{"count":2,"value":"second"}\n');
});
