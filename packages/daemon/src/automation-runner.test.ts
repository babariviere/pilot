import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ActionRequest, ActionRunner, actionEnvironment, actionOutput } from "./automation-runner.ts";
import { type ProcessResult, SubprocessPool } from "./subprocess.ts";

const empty: ProcessResult = {
	code: 0,
	signal: null,
	stdout: Buffer.from("done"),
	stderr: "",
	truncated: false,
	overflowed: false,
	timedOut: false,
	aborted: false,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("mission action revalidation catches a fence set during durable preparation", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-action-fence-")),
		pool = new SubprocessPool();
	const runner = new ActionRunner(pool);
	t.after(async () => {
		await runner.close();
		await pool.close();
		await rm(home, { recursive: true, force: true });
	});
	let held = false,
		effects = 0;
	t.mock.method(pool, "run", async () => {
		effects++;
		return empty;
	});
	const result = await runner.runAction({
		actionId: "synthetic",
		projectId: "p",
		sessionId: "s",
		cwd: home,
		run: { argv: ["synthetic"] },
		record: async (state) => {
			if (state === "running") held = true;
		},
		revalidate: () => {
			if (held) throw new Error("mission paused");
		},
	});
	assert.equal(effects, 0);
	assert.equal(result.outcome, "failed");
});

test("tail mode combines streams, retains the tail and does not terminate a noisy command", async (t) => {
	const pool = new SubprocessPool();
	t.after(() => pool.close());
	const result = await pool.run(
		process.execPath,
		["-e", 'process.stdout.write("x".repeat(100000)); setTimeout(() => process.stderr.write("END"), 20)'],
		{ maxBytes: 64, overflow: "tail", combinedOutput: true },
	);
	assert.equal(result.code, 0);
	assert.equal(result.stdout.length, 64);
	assert.ok(result.stdout.toString().endsWith("END"));
	assert.equal(result.truncated, true);
	assert.equal(result.stderr, "");
});

test("runner executes argv, shell and reviewed copies with bounds and sanitized environment", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-actions-"));
	const pool = new SubprocessPool();
	const runner = new ActionRunner(pool);
	t.after(async () => {
		await runner.close();
		await pool.close();
		await rm(home, { recursive: true, force: true });
	});
	const states: string[] = [];
	const base: ActionRequest = {
		actionId: "one",
		projectId: "p",
		cwd: home,
		run: {
			argv: [
				process.execPath,
				"-e",
				'console.log(process.env.CI,process.env.API_KEY,process.env.PILOT_AUTOMATION); console.error("tail")',
			],
		},
		env: { CI: "1", API_KEY: "secret" },
		record: async (state) => {
			states.push(state);
		},
	};
	const result = await runner.runAction(base);
	assert.equal(result.outcome, "ok");
	assert.match(result.outputTail, /1 undefined one/);
	assert.match(result.outputTail, /tail/);
	assert.deepEqual(states, ["waiting", "running", "ok"]);
	assert.equal(
		(await runner.runAction({ ...base, actionId: "two", run: { shell: "printf failure; exit 7" } })).exitCode,
		7,
	);
	assert.equal(
		(await runner.runAction({ ...base, actionId: "three", run: { scriptCopy: "/bin/echo", args: ["reviewed"] } }))
			.outputTail,
		"reviewed\n",
	);
	assert.equal(
		(await runner.runAction({ ...base, actionId: "missing", run: { argv: ["pilot-no-such-command"] } })).outcome,
		"failed",
	);
	assert.equal(
		(await runner.runAction({ ...base, actionId: "timeout", timeoutMs: 30, run: { shell: "sleep 30 & wait" } }))
			.outcome,
		"timed_out",
	);
	assert.equal((await runner.runAction({ ...base, actionId: "outside", relativeCwd: ".." })).outcome, "failed");
	await mkdir(join(home, "inside"));
	await symlink(tmpdir(), join(home, "escape"));
	assert.equal((await runner.runAction({ ...base, actionId: "symlink", relativeCwd: "escape" })).outcome, "failed");
});

test("sanitizes base and additions, redacts terminal-obfuscated credentials", () => {
	assert.deepEqual(
		actionEnvironment(
			{ CI: "1", API_KEY: "secret", PILOT_ACCESS: "secret", NODE_OPTIONS: "bad" },
			{ HOME: "/home/test", PATH: "/bin", SSH_AUTH_SOCK: "/secret", GH_TOKEN: "secret", PI_CREDENTIAL: "secret" },
		),
		{ HOME: "/home/test", PATH: "/bin", CI: "1" },
	);
	assert.equal(actionOutput("\x1b[31mAPI_\u200bKEY=secret\x1b[0m"), "[REDACTED credential-bearing record]");
});

test("FIFO per chat, three per host, bounded queue, freeze and update pause", async (t) => {
	const pool = new SubprocessPool();
	const flights: ReturnType<typeof deferred<ProcessResult>>[] = [];
	const started: string[] = [];
	const arrivals = Array.from({ length: 4 }, () => deferred<void>());
	t.mock.method(pool, "run", async (_file: string, args: string[]) => {
		started.push(args[0]!);
		const flight = deferred<ProcessResult>();
		flights.push(flight);
		arrivals[started.length - 1]?.resolve();
		return flight.promise;
	});
	const runner = new ActionRunner(pool);
	t.after(async () => {
		for (const flight of flights) flight.resolve(empty);
		await runner.close();
		await pool.close();
	});
	const request = (id: string, sessionId: string): ActionRequest => ({
		actionId: id,
		projectId: "p",
		sessionId,
		cwd: tmpdir(),
		run: { argv: ["fake", id] },
		record: async () => {},
	});
	const release = runner.freezeAdmissions();
	const first = runner.runAction(request("1", "a"));
	const second = runner.runAction(request("2", "a"));
	const third = runner.runAction(request("3", "b"));
	const fourth = runner.runAction(request("4", "c"));
	assert.equal(started.length, 0);
	assert.equal(runner.isWorking("a"), true);
	runner.setUpdatePaused(true);
	release();
	await Promise.resolve();
	assert.equal(started.length, 0);
	runner.setUpdatePaused(false);
	await Promise.all(arrivals.slice(0, 3).map((a) => a.promise));
	assert.deepEqual(new Set(started), new Set(["1", "3", "4"]));
	assert.equal(runner.blockers().length, 3);
	flights[started.indexOf("1")]!.resolve(empty);
	await arrivals[3]!.promise;
	assert.equal(started[3], "2");
	for (const flight of flights) flight.resolve(empty);
	await Promise.all([first, second, third, fourth]);
	const frozen = runner.freezeAdmissions();
	const waiting = Array.from({ length: 64 }, (_, i) => runner.runAction(request(`queued-${i}`, "q")));
	const skipped = await runner.runAction(request("overflow", "q"));
	assert.equal(skipped.outcome, "skipped");
	assert.equal(skipped.reason, "too many automations waiting");
	await runner.cancelSession("q");
	assert.ok((await Promise.all(waiting)).every((result) => result.outcome === "cancelled"));
	frozen();
});

test("explicit lifecycle interrupts commands, joins exit and records queued work without replay", async (t) => {
	const pool = new SubprocessPool();
	const entered = deferred<void>();
	const exit = deferred<ProcessResult>();
	let spawns = 0;
	t.mock.method(pool, "run", async () => {
		spawns++;
		entered.resolve();
		return exit.promise;
	});
	const runner = new ActionRunner(pool);
	t.after(async () => {
		exit.resolve(empty);
		await runner.close();
		await pool.close();
	});
	const states: string[] = [];
	const request: ActionRequest = {
		actionId: "running",
		sessionId: "a",
		projectId: "p",
		cwd: tmpdir(),
		run: { argv: ["fake"] },
		record: async (state) => {
			states.push(state);
		},
	};
	const first = runner.runAction(request);
	await entered.promise;
	const second = runner.runAction({ ...request, actionId: "waiting" });
	runner.setUpdatePaused(true);
	let joined = false;
	const checkpoint = runner.checkpointLifecycle().then(() => {
		joined = true;
	});
	await Promise.resolve();
	assert.equal(joined, false, "an abort signal is not process exit");
	exit.resolve(empty);
	await checkpoint;
	assert.equal((await first).outcome, "interrupted");
	assert.equal((await second).outcome, "interrupted");
	assert.equal(spawns, 1);
	assert.equal(runner.blockers().length, 0);
	assert.equal(states.filter((state) => state === "interrupted").length, 2);
	runner.setUpdatePaused(false);
	assert.equal((await runner.runAction({ ...request, actionId: "fresh" })).outcome, "ok");
	assert.equal(spawns, 2, "only a new explicit intent starts another command");
});

test("sleep records interruption before process exit, keeps queued work and resumes on wake", async (t) => {
	const pool = new SubprocessPool();
	const entered = deferred<void>();
	const exit = deferred<ProcessResult>();
	let spawns = 0;
	t.mock.method(pool, "run", async () => {
		spawns++;
		entered.resolve();
		return exit.promise;
	});
	const runner = new ActionRunner(pool);
	t.after(async () => {
		exit.resolve(empty);
		await runner.close();
		await pool.close();
	});
	const states: string[] = [];
	const request: ActionRequest = {
		actionId: "running",
		sessionId: "a",
		projectId: "p",
		cwd: tmpdir(),
		run: { argv: ["fake"] },
		record: async (state) => {
			states.push(state);
		},
	};
	const first = runner.runAction(request);
	const second = runner.runAction({ ...request, actionId: "queued", record: async () => {} });
	await entered.promise;
	await runner.pauseForSleep();
	assert.equal(states.at(-1), "interrupted");
	assert.equal(runner.blockers().length, 1, "process still owns its slot");
	exit.resolve(empty);
	assert.equal((await first).outcome, "interrupted");
	assert.equal(spawns, 1);
	runner.resumeAfterSleep();
	assert.equal((await second).outcome, "ok");
	assert.equal(spawns, 2);
});

test("an aborted queued action never spawns and a failed running save never executes", async (t) => {
	const pool = new SubprocessPool();
	const spawn = t.mock.method(pool, "run", async () => empty);
	const runner = new ActionRunner(pool);
	t.after(async () => {
		await runner.close();
		await pool.close();
	});
	const signal = AbortSignal.abort();
	const request: ActionRequest = {
		actionId: "abort",
		projectId: "p",
		cwd: tmpdir(),
		signal,
		run: { argv: ["fake"] },
		record: async () => {},
	};
	assert.equal((await runner.runAction(request)).outcome, "cancelled");
	const failed = await runner.runAction({
		...request,
		actionId: "save-failed",
		signal: undefined,
		record: async (state) => {
			if (state === "running") throw new Error("disk failed");
		},
	});
	assert.equal(failed.outcome, "failed");
	assert.equal(spawn.mock.callCount(), 0);
});
