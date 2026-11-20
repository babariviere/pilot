import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { KernelPacket } from "@pilot/kernel";
import { DaemonOperations, operations } from "./event-loop-watchdog.ts";
import { CommandRejected, Worker as KernelWorker, WorkerUnavailable } from "./kernel-worker.ts";
import { emptySnapshot as snapshot, FakeKernelProcess } from "./testing/fake-kernel-worker.ts";

function supervisedWorker(t: TestContext, commandTimeoutMs = 1_000) {
	const child = new FakeKernelProcess();
	const packets: KernelPacket[] = [];
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const worker = new KernelWorker(
		{ sessionId: "supervision", cwd: "/unused", storageDir: "/unused" },
		(packet) => packets.push(packet),
		() => {},
		undefined,
		{ child: child as unknown as ChildProcess, startupTimeoutMs: 1_000, commandTimeoutMs },
	);
	t.after(() => child.emit("exit", 0, null));
	const ready = () => {
		child.emit("message", { type: "ready", model: "test/model", working: false, usage: {} });
		const watch = child.sent.findLast((command) => command.type === "watch");
		assert.ok(watch?.type === "watch");
		child.emit("message", { type: "events", watchId: watch.watchId, events: [snapshot] });
	};
	return { child, worker, ready, packets };
}

test("todo counts arrive on readiness and committed mutations without starting extra work", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	await worker.ready;
	child.emit("message", { type: "ready", model: "test/model", working: false, usage: {}, openTodoCount: 7 });
	assert.equal(worker.openTodoCount, 7);
	const sent = child.sent.length;
	child.emit("message", { type: "todos.changed", openCount: 6 });
	assert.equal(worker.openTodoCount, 6);
	assert.equal(child.sent.length, sent);
	assert.equal(worker.state, "idle");
});

test("worker acquisition and IPC serialization timings do not capture command content", (t) => {
	const tracker = new DaemonOperations();
	t.mock.method(operations, "time", <T>(label: string | (() => string), run: () => T) => tracker.time(label, run, 0));
	const { worker, ready } = supervisedWorker(t);
	ready();
	worker.send({ type: "input", requestId: "private-request", content: "private-command-content", mode: "followUp" });
	const labels = tracker.snapshot().slowByKind.map((entry) => entry.label);
	assert.ok(labels.includes("worker.acquire"));
	assert.ok(labels.includes("worker.send"));
	assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /private-request|private-command-content|unused/);
});

test("unexpected disconnect still fails an idle worker", async (t) => {
	const { child, worker, ready, packets } = supervisedWorker(t);
	ready();
	child.connected = false;
	child.emit("disconnect");
	assert.equal(worker.state, "failed");
	assert.equal(worker.transportUnavailable, true);
	assert.deepEqual(packets.at(-1), { type: "error", message: "Kernel IPC disconnected" });
	assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("the disconnect after a kernel startup failure keeps the kernel's reason", async (t) => {
	const { child, worker, packets } = supervisedWorker(t);
	const reason = "Kernel failed to start: Required upstream interview skill unavailable or shadowed: /x/SKILL.md";
	child.emit("message", { type: "error", message: reason });
	child.connected = false;
	child.emit("disconnect");
	await assert.rejects(worker.ready, new RegExp(reason));
	assert.equal(worker.state, "failed");
	assert.equal(worker.error, reason);
	assert.equal(worker.transportUnavailable, true);
	assert.deepEqual(packets.filter((packet) => packet.type === "error").at(-1), { type: "error", message: reason });
	assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("intentional close ignores disconnect but waits for confirmed exit", async (t) => {
	const { child, worker, ready, packets } = supervisedWorker(t);
	ready();
	const send = child.send.bind(child);
	child.send = (command, callback) => {
		if (command.type === "shutdown") {
			child.connected = false;
			child.emit("disconnect");
			callback?.(new Error("IPC channel closed"));
			return true;
		}
		return send(command, callback);
	};
	let closed = false;
	const closing = worker.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(worker.state, "idle");
	assert.equal(worker.error, undefined);
	assert.equal(worker.transportUnavailable, false);
	assert.ok(packets.every((packet) => packet.type !== "error"));
	assert.deepEqual(child.killed, []);
	t.mock.timers.tick(8_000);
	await closing;
	assert.deepEqual(child.killed, ["SIGKILL"], "close retains its shutdown deadline");
});

test("startup tolerates starvation while the IPC channel and process remain alive", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	t.mock.timers.tick(120_000);
	assert.deepEqual(child.killed, []);
	assert.equal(worker.state, "starting");
	assert.equal(worker.busy, true);
	assert.equal(worker.transportUnavailable, false);
	ready();
	await worker.ready;
	t.mock.timers.tick(120_000);
	assert.equal(worker.state, "idle");
	assert.deepEqual(child.killed, []);
});

test("command acknowledgements tolerate starvation without clearing uncertain admissions", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	await worker.ready;
	const input = worker.request({ type: "input", requestId: "stable-id", content: "work", mode: "followUp" });
	const abort = worker.request({ type: "abort", requestId: "abort-id" });
	t.mock.timers.tick(120_000);
	assert.deepEqual(child.killed, []);
	assert.equal(worker["pending"].size, 2);
	assert.equal(worker.busy, true, "a slow acknowledgement must still block idle-only work");
	child.emit("message", { type: "accepted", requestId: "stable-id" });
	child.emit("message", { type: "aborted", requestId: "abort-id" });
	await Promise.all([input, abort]);
	assert.equal(worker["pending"].size, 0);
});

test("a dead channel rejects readiness and every uncertain command", async (t) => {
	const { child, worker } = supervisedWorker(t);
	const input = worker.request({ type: "input", requestId: "stable-id", content: "work", mode: "followUp" });
	const rejected = Promise.all([
		assert.rejects(worker.ready, WorkerUnavailable),
		assert.rejects(input, WorkerUnavailable),
	]);
	child.connected = false; // Also covered by the periodic check if a disconnect event was missed.
	t.mock.timers.tick(1_000);
	await rejected;
	assert.deepEqual(child.killed, ["SIGTERM"]);
	assert.equal(worker.state, "failed");
	assert.equal(worker["pending"].size, 0);
	assert.equal(worker["killTimer"], undefined);
	child.emit("message", { type: "ready", model: "late/model", working: false, usage: {} });
	assert.equal(worker.state, "failed");
});

test("process exit without a disconnect rejects startup as recoverable transport loss", async (t) => {
	const { child, worker } = supervisedWorker(t);
	const rejected = assert.rejects(worker.ready, WorkerUnavailable);
	child.emit("exit", 1, null);
	await rejected;
	await assert.rejects(worker.request({ type: "abort", requestId: "after-exit" }), WorkerUnavailable);
	t.mock.timers.tick(120_000);
	assert.deepEqual(child.killed, [], "an exited process does not need a kill deadline");
});

test("inspection deadline protects the worker without killing it or clearing unrelated admissions", async (t) => {
	const { child, worker, ready } = supervisedWorker(t, 60_000);
	ready();
	await worker.ready;
	const input = worker.request({ type: "input", requestId: "unrelated", content: "work", mode: "followUp" });
	const children = worker.hasChildren();
	t.mock.timers.tick(10_000);
	assert.equal(await children, true);
	assert.deepEqual(child.killed, []);
	assert.equal(worker["pending"].has("unrelated"), true);
	assert.equal(worker["pending"].size, 1);
	child.emit("message", { type: "accepted", requestId: "unrelated" });
	await input;
	assert.equal(worker["pending"].size, 0);
});

test("jobs reads coalesce, correlate replies and release snapshots without activity updates", async (t) => {
	const { child, worker, ready, packets } = supervisedWorker(t);
	ready();
	await worker.ready;
	const before = packets.length;
	const first = worker.jobs();
	assert.equal(worker.jobs(), first);
	const command = child.sent.find((item) => item.type === "inspectJobs")!;
	assert.ok(command.type === "inspectJobs");
	const jobs = [{ id: "one", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }];
	child.emit("message", { type: "jobs", requestId: "unrelated", jobs: [] });
	assert.equal(worker["pending"].has(command.requestId), true);
	child.emit("message", { type: "jobs", requestId: command.requestId, jobs });
	assert.deepEqual(await first, jobs);
	assert.equal(worker["jobResults"].size, 0);
	assert.equal(packets.length, before, "read results never broadcast session updates");
	const second = worker.jobs();
	const next = child.sent.filter((item) => item.type === "inspectJobs").at(-1)!;
	assert.notEqual(next.requestId, command.requestId);
	child.emit("message", { type: "jobs", requestId: next.requestId, jobs: [] });
	assert.deepEqual(await second, []);
});

test("jobs failures and deadlines do not fail or stop the worker, including late errors", async (t) => {
	const { child, worker, ready } = supervisedWorker(t, 60_000);
	ready();
	await worker.ready;
	const read = worker.jobs();
	const command = child.sent.find((item) => item.type === "inspectJobs")!;
	assert.ok(command.type === "inspectJobs");
	const rejected = assert.rejects(read, /timed out/);
	t.mock.timers.tick(10_000);
	await rejected;
	child.emit("message", { type: "error", requestId: command.requestId, message: "Late read error" });
	assert.equal(worker.error, undefined);
	assert.equal(worker.state, "idle");
	assert.deepEqual(child.killed, []);
	const retry = worker.jobs();
	const next = child.sent.filter((item) => item.type === "inspectJobs").at(-1)!;
	const failed = assert.rejects(retry, /Registry unavailable/);
	child.emit("message", { type: "error", requestId: next.requestId, message: "Registry unavailable" });
	await failed;
	assert.equal(worker.error, undefined);
	assert.equal(worker["jobResults"].size, 0);
});

test("job stop commands correlate replies and never fail the worker", async (t) => {
	const { child, worker, ready } = supervisedWorker(t, 60_000);
	ready();
	await worker.ready;
	const stop = worker.stopJob("tests");
	const command = child.sent.find((item) => item.type === "stopJob")!;
	assert.ok(command.type === "stopJob");
	assert.equal(command.jobId, "tests");
	child.emit("message", { type: "accepted", requestId: command.requestId });
	await stop;
	const missing = assert.rejects(worker.stopJob("gone"), /No running job gone/);
	const next = child.sent.filter((item) => item.type === "stopJob").at(-1)!;
	child.emit("message", { type: "error", requestId: next.requestId, message: "No running job gone" });
	await missing;
	const slow = assert.rejects(worker.stopJob("slow"), /timed out/);
	t.mock.timers.tick(10_000);
	await slow;
	assert.equal(worker.error, undefined, "a job command never becomes the session's error");
	assert.equal(worker.state, "idle");
	assert.deepEqual(child.killed, []);
});

test("transport retirement sends SIGTERM first, escalates once after eight seconds, and waits for confirmed exit", async (t) => {
	const { child, worker } = supervisedWorker(t);
	child.kill = (signal) => {
		child.killed.push(signal);
		return true;
	};
	const rejected = assert.rejects(worker.ready, WorkerUnavailable);
	child.connected = false;
	child.emit("disconnect");
	await rejected;
	assert.deepEqual(child.killed, ["SIGTERM"]);
	let closed = false;
	const closing = worker.close().then(() => {
		closed = true;
	});
	t.mock.timers.tick(7_999);
	assert.deepEqual(child.killed, ["SIGTERM"]);
	t.mock.timers.tick(1);
	assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
	await Promise.resolve();
	assert.equal(closed, false, "sending SIGKILL is not proof that the writer lease has been released");
	child.emit("exit", null, "SIGKILL");
	await closing;
	assert.equal(worker["killTimer"], undefined);
	t.mock.timers.tick(10_000);
	assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"], "retirement has only one shared fallback timer");
});

test("acknowledged commands cancel their deadline and idle-child inspection does not reset activity", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	const inspection = worker.hasChildren();
	const command = child.sent.at(-1)!;
	assert.equal(command.type, "inspectChildren");
	assert.ok("requestId" in command);
	child.emit("message", { type: "children", requestId: command.requestId, hasChildren: false });
	assert.equal(await inspection, false);
	t.mock.timers.tick(5_000);
	assert.deepEqual(child.killed, []);
	assert.equal(worker.busy, false);
});

test("automatic idle-guard rejection does not leave a visible worker error", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	const input = worker.request({
		type: "input",
		requestId: "automatic",
		content: "Check the PR",
		mode: "followUp",
		onlyIfIdle: true,
	});
	const rejected = assert.rejects(input, CommandRejected);
	child.emit("message", { type: "error", requestId: "automatic", message: "Conversation is busy", code: "busy" });
	await rejected;
	assert.equal(worker.error, undefined);
	assert.equal(worker.state, "idle");
	assert.equal(worker.busy, false);
	// Ordinary rejected user commands still expose their error.
	const user = worker.request({ type: "input", requestId: "user", content: "User work", mode: "followUp" });
	const userRejected = assert.rejects(user, CommandRejected);
	child.emit("message", { type: "error", requestId: "user", message: "User input failed", code: "busy" });
	await userRejected;
	assert.equal(worker.error, "User input failed");
});
