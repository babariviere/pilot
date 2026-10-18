import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type TestContext, test } from "node:test";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SHELL_STATUS_DETAIL, shellDeadline } from "./shell-deadline.ts";
import { ToolActivityTracker, toolActivityExtension } from "./tool-activity.ts";

async function fixture(t: TestContext, defaultTimeoutSeconds = 1) {
	const root = await mkdtemp(join(tmpdir(), "pilot-shell-deadline-"));
	const file = join(root, "activity.jsonl");
	const tracker = new ToolActivityTracker({ file, publish: () => {} });
	const definition = createBashToolDefinition(root, { exposeSessionEnvironment: false }) as ToolDefinition;
	definition.execute = shellDeadline(definition.execute, {
		defaultTimeoutSeconds,
		longRunningMs: 50,
		timeout: (id) => tracker.cancel(id, "timeout"),
	});
	t.after(async () => {
		await tracker.close();
		// Only fixture-owned processes, including assertion-failure cleanup.
		for (const name of ["shell.pid", "child.pid"]) {
			const pid = Number(await readFile(join(root, name), "utf8").catch(() => ""));
			if (pid > 0) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		await rm(root, { recursive: true, force: true });
	});
	let sequence = 0;
	const run = async (
		args: { command: string; timeout?: number },
		signal?: AbortSignal,
		update?: (value: unknown) => void,
	) => {
		const id = `call-${++sequence}`;
		tracker.start(id, "bash", true, signal);
		tracker.running(id);
		try {
			const result = await definition.execute(
				id,
				args,
				signal,
				(value) => {
					if (!(value.details as Record<string, unknown> | undefined)?.[SHELL_STATUS_DETAIL]) tracker.progress(id);
					update?.(value);
				},
				undefined as never,
			);
			tracker.finish(id, result.isError ?? false);
			return result;
		} catch (error) {
			tracker.finish(id, true);
			throw error;
		} finally {
			tracker.finish(id, true); // Duplicate terminal delivery must not produce another terminal record.
		}
	};
	const outcomes = async () => {
		await tracker.flush();
		return (await readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.kind === "finished")
			.map((record) => record.outcome);
	};
	return { root, tracker, run, outcomes };
}

const nonterminating = "echo $$ > shell.pid; (while :; do sleep 60; done) & echo $! > child.pid; printf started; wait";

async function assertGone(root: string) {
	for (const file of ["shell.pid", "child.pid"]) {
		const pid = Number(await readFile(join(root, file), "utf8"));
		assert.ok(pid > 0);
		const until = performance.now() + 3000;
		while (true) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
				break;
			}
			// Linux may retain a killed orphan as a zombie until its container init reaps it.
			if (process.platform === "linux") {
				const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
				if (!stat || /^\d+ \(.*\) Z /.test(stat)) break;
			}
			assert.ok(performance.now() < until, `fixture process ${pid} is still running`);
			await delay(10);
		}
	}
}

test("nonterminating shell reports long-running status, times out once and cleans its process group", {
	timeout: 10_000,
}, async (t) => {
	const f = await fixture(t);
	const updates: unknown[] = [];
	const started = performance.now();
	await assert.rejects(
		f.run({ command: nonterminating }, undefined, (update) => updates.push(update)),
		/Command timed out after 1 seconds/,
	);
	assert.ok(performance.now() - started < 5000);
	assert.match(JSON.stringify(updates), /Command still running.*elapsed; 1s deadline/);
	await assertGone(f.root);
	assert.deepEqual(f.tracker.snapshot().calls, []);
	assert.deepEqual(await f.outcomes(), ["timeout"]);
	assert.equal((await f.run({ command: "printf subsequent" })).isError, undefined);
	assert.deepEqual(await f.outcomes(), ["timeout", "success"]);
});

test("explicit cancellation wins over the later deadline and does not retry", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	await assert.rejects(
		f.run({ command: `${nonterminating}; echo replay >> executions` }, controller.signal, (update) => {
			if (JSON.stringify(update).includes("started")) controller.abort();
		}),
		/Command aborted/,
	);
	await assertGone(f.root);
	await delay(1100);
	assert.deepEqual(await f.outcomes(), ["cancelled"]);
	assert.deepEqual(f.tracker.snapshot().calls, []);
	await assert.rejects(readFile(join(f.root, "executions")), { code: "ENOENT" });
	assert.equal((await f.run({ command: "exit 7" })).isError, true);
	assert.deepEqual(await f.outcomes(), ["cancelled", "failure"]);
});

test("silent valid command honors an explicitly longer deadline, and quick failures keep their exit code", async (t) => {
	const f = await fixture(t, 0.05);
	const result = await f.run({ command: "sleep 0.2", timeout: 2 });
	assert.equal(result.isError, undefined);
	const failed = await f.run({ command: "printf once >> executions; exit 7", timeout: 2 });
	assert.equal(failed.isError, true);
	assert.equal((failed.structuredContent as { exit_code: number }).exit_code, 7);
	assert.equal(await readFile(join(f.root, "executions"), "utf8"), "once");
	assert.deepEqual(await f.outcomes(), ["success", "failure"]);
	await delay(100);
	assert.deepEqual(await f.outcomes(), ["success", "failure"]);
});

test("default deadline is 120 seconds; invalid deadlines and pre-cancelled calls never execute", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let executions = 0;
	const definition = {
		execute: shellDeadline(async (_id, _args, signal) => {
			executions++;
			return new Promise((_resolve, reject) =>
				signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
			);
		}),
	} as ToolDefinition;
	const run = (timeout?: number, signal?: AbortSignal) =>
		definition.execute("id", { command: "unused", timeout }, signal, undefined, undefined as never);
	for (const timeout of [0, -1, NaN, Infinity, 2_147_484]) await assert.rejects(run(timeout), /Invalid shell timeout/);
	await assert.rejects(run(undefined, AbortSignal.abort()));
	assert.equal(executions, 0);
	const pending = assert.rejects(run(), /Command timed out after 120 seconds/);
	t.mock.timers.tick(119_999);
	assert.equal(executions, 1);
	t.mock.timers.tick(1);
	await pending;
	assert.equal(executions, 1);
});

test("elapsed status notices do not manufacture useful progress", async (t) => {
	const f = await fixture(t);
	const handlers = new Map<string, (event: unknown) => unknown>();
	toolActivityExtension(f.tracker)({
		on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
	} as never);
	f.tracker.start("status", "bash", true);
	f.tracker.running("status");
	const before = f.tracker.snapshot().calls[0]!.progressAt;
	await delay(10);
	await handlers.get("tool_execution_update")!({
		toolCallId: "status",
		partialResult: { details: { [SHELL_STATUS_DETAIL]: true } },
	});
	assert.equal(f.tracker.snapshot().calls[0]!.progressAt, before);
	await handlers.get("tool_execution_update")!({
		toolCallId: "status",
		partialResult: { content: [{ type: "text", text: "output" }] },
	});
	assert.ok(f.tracker.snapshot().calls[0]!.progressAt > before);
	f.tracker.finish("status", false);
});

test("completion and failure clear deadline/status timers and detach cancellation listeners", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let timeouts = 0;
	let updates = 0;
	let lateAborts = 0;
	for (const fail of [false, true]) {
		const controller = new AbortController();
		const remove = t.mock.method(controller.signal, "removeEventListener");
		const definition = {
			execute: shellDeadline(
				async (_id, _args, signal) => {
					signal!.addEventListener("abort", () => lateAborts++);
					if (fail) throw new Error("quick failure");
					return { content: [], details: undefined };
				},
				{ timeout: () => timeouts++ },
			),
		} as ToolDefinition;
		const pending = definition.execute(
			"id",
			{ command: "unused" },
			controller.signal,
			() => updates++,
			undefined as never,
		);
		if (fail) await assert.rejects(pending, /quick failure/);
		else await pending;
		assert.equal(remove.mock.callCount(), 1);
		controller.abort();
		t.mock.timers.tick(120_001);
	}
	assert.equal(timeouts, 0);
	assert.equal(updates, 0);
	assert.equal(lateAborts, 0);
});
