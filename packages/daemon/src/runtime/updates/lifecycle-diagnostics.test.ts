import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	LIFECYCLE_FILE,
	LifecycleDiagnostics,
	type LifecycleObservation,
	lifecycleLine,
	MAX_LIFECYCLE_EVENT_BYTES,
} from "./lifecycle-diagnostics.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const baseline: LifecycleObservation = {
	state: "parked",
	working: false,
	sleepPaused: false,
	offlinePaused: false,
	quotaPaused: false,
	updatePaused: false,
	recoveryPending: false,
	recoveryStopped: false,
	startupFailed: false,
};

async function fixture(options: ConstructorParameters<typeof LifecycleDiagnostics>[1] = {}) {
	const home = await mkdtemp(join(tmpdir(), "pilot-lifecycle-"));
	await mkdir(join(home, "sessions", sessionId), { recursive: true });
	return { home, log: new LifecycleDiagnostics(home, { release: "1.2.3", ...options }) };
}

async function events(home: string) {
	const file = join(home, "sessions", sessionId, LIFECYCLE_FILE);
	const previous = await readFile(`${file}.1`, "utf8").catch(() => "");
	const current = await readFile(file, "utf8");
	return `${previous}${current}`
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

test("lifecycle serializer is a strict bounded allowlist", () => {
	const line = lifecycleLine({
		v: 1,
		id: "abc-1",
		at: "2026-10-17T08:00:00.000Z",
		source: "daemon",
		release: "1.2.3",
		hostKind: "local",
		kind: "pause.changed",
		reason: "sleep",
		state: "paused",
		traceId: "0".repeat(32),
		count: 2,
		secret: "must not serialize",
	} as never);
	assert.ok(line);
	assert.ok(Buffer.byteLength(line) <= MAX_LIFECYCLE_EVENT_BYTES);
	assert.equal(JSON.parse(line).secret, undefined);
	assert.equal(
		lifecycleLine({
			v: 1,
			id: "abc",
			at: "now",
			source: "daemon",
			release: "private build",
			hostKind: "local",
			kind: "pause.changed",
			reason: "sleep",
			state: "paused",
		}),
		undefined,
	);
});

test("records startup, pause, quota and recovery transitions without content", async (t) => {
	let now = Date.parse("2026-10-17T08:00:00.000Z");
	const f = await fixture({ now: () => new Date(now++) });
	t.after(async () => {
		await f.log.close();
		await rm(f.home, { recursive: true, force: true });
	});
	f.log.observe(sessionId, baseline);
	f.log.observe(sessionId, { ...baseline, state: "starting" });
	f.log.observe(sessionId, { ...baseline, state: "working", working: true });
	f.log.observe(sessionId, { ...baseline, sleepPaused: true });
	f.log.observe(sessionId, { ...baseline, state: "working", working: true, quotaPaused: true });
	f.log.observe(sessionId, { ...baseline, state: "failed", recoveryPending: true });
	f.log.observe(sessionId, { ...baseline, state: "idle" });
	await f.log.flush();
	const rows = await events(f.home);
	assert.deepEqual(
		rows.map(({ kind, reason, state }) => [kind, reason, state]),
		[
			["worker.start.requested", "startup", "starting"],
			["worker.started", "startup", "working"],
			["execution.started", "work", "working"],
			["worker.parked", "sleep", "parked"],
			["execution.completed", "sleep", "completed"],
			["pause.changed", "sleep", "paused"],
			["execution.started", "work", "working"],
			["pause.changed", "sleep", "resumed"],
			["quota.changed", "quota", "paused"],
			["worker.recovery.started", "process_exit", "failed"],
			["quota.changed", "quota", "resumed"],
			["worker.recovery.completed", "recovery_backoff", "completed"],
		],
	);
	assert.ok(rows.every((row) => row.release === "1.2.3" && row.source === "daemon"));
	assert.doesNotMatch(JSON.stringify(rows), /prompt|message|error|path|model/i);
});

test("rotates private files, reports overload and isolates a symlink failure", async (t) => {
	const f = await fixture({ maxBytes: MAX_LIFECYCLE_EVENT_BYTES, maxPendingPerSession: 1 });
	t.after(async () => {
		await f.log.close();
		await rm(f.home, { recursive: true, force: true });
	});
	f.log.observe(sessionId, baseline);
	for (let index = 0; index < 20; index++) {
		f.log.observe(sessionId, { ...baseline, sleepPaused: index % 2 === 0 });
	}
	await f.log.flush();
	f.log.observe(sessionId, { ...baseline, updatePaused: true });
	await f.log.flush();
	assert.ok((await events(f.home)).some((row) => row.droppedBefore > 0));
	for (let index = 0; index < 8; index++) {
		f.log.observe(sessionId, { ...baseline, sleepPaused: index % 2 === 0 });
		await f.log.flush();
	}
	const file = join(f.home, "sessions", sessionId, LIFECYCLE_FILE);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.ok((await stat(`${file}.1`)).size > 0);

	const other = "00000000-0000-4000-8000-000000000002";
	await mkdir(join(f.home, "sessions", other), { recursive: true });
	await symlink(join(f.home, "outside"), join(f.home, "sessions", other, LIFECYCLE_FILE));
	f.log.observe(other, { ...baseline, state: "starting" });
	f.log.observe(sessionId, { ...baseline, updatePaused: true });
	await f.log.flush();
	assert.ok((await events(f.home)).some((row) => row.reason === "update"));
});

test("local consent stops collection and resumes from a fresh baseline", async (t) => {
	const f = await fixture();
	t.after(async () => {
		await f.log.close();
		await rm(f.home, { recursive: true, force: true });
	});
	f.log.setEnabled(false);
	f.log.observe(sessionId, { ...baseline, state: "starting" });
	await f.log.flush();
	await assert.rejects(readFile(join(f.home, "sessions", sessionId, LIFECYCLE_FILE)), { code: "ENOENT" });
	f.log.setEnabled(true);
	f.log.observe(sessionId, baseline);
	f.log.observe(sessionId, { ...baseline, sleepPaused: true });
	await f.log.flush();
	assert.deepEqual(
		(await events(f.home)).map((event) => event.reason),
		["sleep"],
	);
});
