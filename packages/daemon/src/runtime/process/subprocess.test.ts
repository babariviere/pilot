import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { execFileOffThread, ProcessFailed, SubprocessPool } from "./subprocess.ts";

test("runs off-thread and returns stdout, stderr and exit status", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const ok = await pool.run("sh", ["-c", "printf out; printf err >&2"], { maxBytes: 1024, overflow: "fail" });
	assert.equal(ok.code, 0);
	assert.equal(ok.stdout.toString(), "out");
	assert.ok(Buffer.isBuffer(ok.stdout));
	assert.equal(ok.stderr, "err");
	const failed = await pool.run("sh", ["-c", "exit 3"], { maxBytes: 1024, overflow: "fail" });
	assert.equal(failed.code, 3);
});

test("execFileOffThread rejects like execFile, with exit code and stdout", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	assert.equal(await execFileOffThread("sh", ["-c", "echo hi"], { maxBytes: 1024 }, pool), "hi\n");
	await assert.rejects(
		execFileOffThread("sh", ["-c", "printf partial; exit 1"], { maxBytes: 1024 }, pool),
		(error) => {
			assert.ok(error instanceof ProcessFailed);
			assert.equal(error.code, 1);
			assert.equal(error.stdout, "partial");
			return true;
		},
	);
	await assert.rejects(
		execFileOffThread("pilot-command-that-does-not-exist", [], { maxBytes: 1024 }, pool),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});

test("streams bounded NUL-delimited stdin and tolerates an early reader exit", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const input = "a\0tabs\tand\nnewlines\0";
	const result = await pool.run("cat", [], { stdin: input, maxBytes: 1024, overflow: "fail" });
	assert.equal(result.code, 0);
	assert.equal(result.stdout.toString(), input);
	const early = await pool.run("true", [], { stdin: "x".repeat(1024 * 1024), maxBytes: 1, overflow: "fail" });
	assert.equal(early.code, 0);
	await assert.rejects(
		pool.run("cat", [], { stdin: "x".repeat(32 * 1024 * 1024 + 1), maxBytes: 1, overflow: "fail" }),
		/exceeds 32 MiB/,
	);
});

test("exec failures omit argv payloads, bound log text and retain structured diagnostics", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const secret = "fixture-private-argument";
	await assert.rejects(
		execFileOffThread("sh", ["-c", 'printf "diagnostic\\n" >&2; exit 7', secret], { maxBytes: 1024 }, pool),
		(error) => {
			assert.ok(error instanceof ProcessFailed);
			assert.equal(error.message, "Command failed: sh (exit 7): diagnostic");
			assert.equal(error.stderr, "diagnostic\n");
			assert.equal(error.timedOut, false);
			assert.doesNotMatch(String(error), new RegExp(secret));
			return true;
		},
	);
	await assert.rejects(
		execFileOffThread(
			"sh",
			["-c", "exec sleep 30", `query=multi\nline ${secret}`],
			{ maxBytes: 1024, timeoutMs: 50, killSignal: "SIGKILL" },
			pool,
		),
		(error) => {
			assert.ok(error instanceof ProcessFailed);
			assert.equal(error.message, "Command timed out: sh (50ms timeout)");
			assert.equal(error.timedOut, true);
			assert.equal(error.killed, true);
			return true;
		},
	);
	await assert.rejects(
		execFileOffThread("sh", ["-c", "yes diagnostic | head -c 4096 >&2; exit 1"], { maxBytes: 1024 }, pool),
		(error) => {
			assert.ok(error instanceof ProcessFailed);
			assert.ok(error.message.length < 600);
			assert.equal(error.stderr.length, 4096);
			assert.ok(!error.message.includes("\n"));
			return true;
		},
	);
});

test("bounds output: truncate keeps a prefix, fail reports overflow", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const script = "yes x | head -c 100000";
	const truncated = await pool.run("sh", ["-c", script], { maxBytes: 10, overflow: "truncate" });
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.stdout.length, 10);
	const overflowed = await pool.run("sh", ["-c", script], { maxBytes: 10, overflow: "fail" });
	assert.equal(overflowed.overflowed, true);
});

test("timeouts and aborts stop the child, including its process group", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const started = Date.now();
	const timedOut = await pool.run("sh", ["-c", "sleep 30 & wait"], {
		maxBytes: 1024,
		overflow: "fail",
		timeoutMs: 100,
		detached: true,
	});
	assert.equal(timedOut.timedOut, true);
	assert.ok(Date.now() - started < 10_000);
	const controller = new AbortController();
	const running = pool.run("sleep", ["30"], { maxBytes: 1024, overflow: "fail", signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	assert.equal((await running).aborted, true);
	await assert.rejects(pool.run("true", [], { maxBytes: 1, overflow: "fail", signal: AbortSignal.abort() }));
});

test("bounds threads, runs concurrently, and reclaims idle threads", async (t) => {
	const pool = new SubprocessPool({ maxThreads: 2, idleMs: 1_000 });
	t.after(() => pool.close());
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const sockets = new Set<Socket>();
	let allConnected!: () => void;
	const connected = new Promise<void>((resolve) => {
		allConnected = resolve;
	});
	const server = createServer((socket) => {
		sockets.add(socket);
		if (sockets.size === 6) allConnected();
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const results = Promise.all(
		Array.from({ length: 6 }, () =>
			pool.run(process.execPath, ["-e", `require("node:net").connect(${address.port}, "127.0.0.1").resume()`], {
				maxBytes: 1,
				overflow: "fail",
			}),
		),
	);
	// Teardown can reject the pool before the connection barrier on a test failure.
	void results.catch(() => undefined);
	// None can exit until all six have started, including children sharing a worker thread.
	await connected;
	assert.equal(sockets.size, 6);
	assert.equal(pool.size, 2);
	t.mock.timers.tick(1_500);
	assert.equal(pool.size, 2, "active threads cannot be reclaimed");
	for (const socket of sockets) socket.end();
	assert.ok((await results).every((result) => result.code === 0));
	t.mock.timers.tick(999);
	assert.equal(pool.size, 2);
	t.mock.timers.tick(1);
	assert.equal(pool.size, 0);
});

test("children inherit the daemon's current environment, not the thread's startup copy", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	await pool.run("true", [], { maxBytes: 1, overflow: "fail" });
	process.env.PILOT_SUBPROCESS_TEST = "changed";
	t.after(() => delete process.env.PILOT_SUBPROCESS_TEST);
	const result = await pool.run("sh", ["-c", 'printf %s "$PILOT_SUBPROCESS_TEST"'], {
		maxBytes: 64,
		overflow: "fail",
	});
	assert.equal(result.stdout.toString(), "changed");
});
