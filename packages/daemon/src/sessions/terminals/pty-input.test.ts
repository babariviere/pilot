import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundedPtyInput, PTY_INPUT_BYTES, PTY_INPUT_CHUNK, PTY_INPUT_TASKS } from "./pty-input.ts";
import { loadPty } from "./terminals.ts";

function fake() {
	const _writeStream = { _writeQueue: [] as { buffer: Buffer; offset: number }[] };
	return {
		_writeStream,
		write(data: string) {
			_writeStream._writeQueue.push({ buffer: Buffer.from(data), offset: 0 });
		},
	};
}
test("audited writer bounds UTF-8 allocations, tasks and chunks, including partial retained buffers", () => {
	const pty = fake(),
		input = new BoundedPtyInput(pty, "linux", "1.1.0");
	assert.throws(() => input.write("é".repeat(PTY_INPUT_CHUNK)), /chunk/);
	for (let i = 0; i < PTY_INPUT_BYTES / PTY_INPUT_CHUNK; i++) input.write("x".repeat(PTY_INPUT_CHUNK));
	pty._writeStream._writeQueue[0]!.offset = PTY_INPUT_CHUNK - 1;
	assert.throws(() => input.write("x"), /busy/);
	pty._writeStream._writeQueue.splice(0);
	for (let i = 0; i < PTY_INPUT_TASKS; i++) input.write("x");
	assert.throws(() => input.write("x"), /busy/);
	input.close();
	assert.throws(() => input.write("x"), /closed/);
});
test("audited writer fails closed on version/platform/queue identity and malformed native tasks", () => {
	assert.throws(() => new BoundedPtyInput(fake(), "win32", "1.1.0"), /Unsupported/);
	assert.throws(() => new BoundedPtyInput(fake(), "linux", "1.1.1"), /Unsupported/);
	const pty = fake(),
		input = new BoundedPtyInput(pty, "linux", "1.1.0");
	pty._writeStream._writeQueue = [];
	assert.throws(() => input.write("x"), /Unknown/);
	const replaced = fake(),
		pinned = new BoundedPtyInput(replaced, "linux", "1.1.0");
	replaced._writeStream = { _writeQueue: [] };
	assert.throws(() => pinned.write("x"), /Unknown/);
	for (const task of [
		{ buffer: "x", offset: 0 },
		{ buffer: Buffer.from("x"), offset: -1 },
		{ buffer: Buffer.from("x"), offset: 2 },
	]) {
		const bad = fake();
		bad._writeStream._writeQueue.push(task as never);
		assert.throws(() => new BoundedPtyInput(bad, "linux", "1.1.0"), /Unknown/);
	}
});
test("real stalled Unix PTY retains only bounded native input and releases on exit", { timeout: 10_000 }, async (t) => {
	const report = console.error.bind(console);
	t.mock.method(console, "error", (...args: unknown[]) => {
		const code = (args[1] as { code?: string } | undefined)?.code;
		// node-pty reports its final pending write to the intentionally closed fd. Do not hide other errors.
		if (args[0] === "Unhandled pty write error" && (code === "EBADF" || code === "EIO")) return;
		report(...args);
	});
	const pty = loadPty().spawn(
		process.execPath,
		[
			"-e",
			"process.stdin.setRawMode(true); process.stdin.pause(); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
		],
		{
			cwd: process.cwd(),
			cols: 80,
			rows: 24,
			env: process.env as Record<string, string>,
		},
	);
	const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
	const input = new BoundedPtyInput(pty);
	const native = (pty as unknown as { _writeStream: { _writeQueue: { buffer: Buffer }[]; _writeImmediate?: unknown } })
		._writeStream;
	const queue = native._writeQueue;
	try {
		await new Promise<void>((resolve) => {
			let output = "";
			pty.onData((data) => {
				output += data;
				if (output.includes("ready")) resolve();
			});
		});
		let rejected = 0;
		for (let i = 0; i < 1000; i++) {
			try {
				input.write("x".repeat(PTY_INPUT_CHUNK));
			} catch {
				rejected++;
			}
		}
		assert.ok(rejected > 900);
		assert.ok(queue.length <= PTY_INPUT_TASKS);
		assert.ok(queue.reduce((sum, task) => sum + task.buffer.byteLength, 0) <= PTY_INPUT_BYTES);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(queue.length > 0, "the raw-mode child is not consuming native input");
	} finally {
		input.close();
		pty.kill("SIGKILL");
		await exited;
		const deadline = Date.now() + 1000;
		while (queue.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(queue.length, 0, "native retained input is released after process exit");
		assert.equal(native._writeImmediate, undefined);
	}
	assert.throws(() => input.write("after exit"), /closed/);
});
