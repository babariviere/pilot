import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WatchService } from "./watch-service.ts";
import type { WatchNotice, WatchObservation } from "./watch-delivery.ts";
import { SessionWatchSource } from "./watch-sessions.ts";
import type { SessionManager } from "./sessions.ts";
import type { SessionSummary } from "@pilot/protocol";
const input = {
	event: "chat.settled" as const,
	target: { kind: "project" as const, id: "p" },
	mode: "persistent" as const,
	note: "Continue without asking",
};
function event(version = "1", at = Date.now()): WatchObservation {
	return {
		source: "c",
		version,
		event: "chat.settled",
		targets: [
			{ kind: "chat", id: "c" },
			{ kind: "project", id: "p" },
		],
		at,
		text: "Untrusted chat title",
		outcome: "done",
	};
}
test("indexed matching, outcome filter, batching, once consumption and self suppression", async () => {
	const s = new WatchService(":memory:");
	const sent: WatchNotice[] = [];
	let busy = false;
	try {
		await s.add(input);
		await s.add({ ...input, mode: "once", target: { kind: "chat", id: "c" } });
		await s.add({ ...input, filter: { outcome: "failed" } });
		s.bindSink({
			sessionId: "control",
			canSend: () => !busy,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		const at = Date.now();
		assert.equal(await s.observe([event("1", at)]), 2);
		assert.equal(await s.observe([event("1", at)]), 0);
		assert.equal((await s.list()).length, 2);
		await s.flush(at + 29999);
		assert.equal(sent.length, 0);
		busy = true;
		await s.flush(at + 31000);
		assert.equal(sent.length, 0);
		busy = false;
		await s.flush(at + 62000);
		await s.flush(at + 92000);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.items.length, 2);
		assert.equal(sent[0]!.items[0]!.note, input.note);
		assert.match(sent[0]!.requestId, /^watch-notice:/);
		assert.equal(await s.observe([{ ...event("2"), originSessionId: "control" }]), 0);
		assert.equal(
			await s.observe([
				{
					...event("3"),
					source: "control",
					targets: [
						{ kind: "chat", id: "control" },
						{ kind: "project", id: "p" },
					],
				},
			]),
			0,
		);
	} finally {
		await s.close();
	}
});
test("frozen retry survives restart and retains later events", async () => {
	const dir = await mkdtemp(join(tmpdir(), "watch-events-"));
	const path = join(dir, "watches.sqlite");
	let s = new WatchService(path);
	let first: WatchNotice | undefined;
	const sent: WatchNotice[] = [];
	try {
		await s.add(input);
		const at = Date.now();
		await s.observe([event("1", at)]);
		s.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				first = n;
				return false;
			},
		});
		await s.flush(at + 30000);
		assert.ok(first);
		await s.observe([event("2", at + 31000)]);
		await s.close();
		s = new WatchService(path);
		s.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		await s.flush(at + 62000);
		assert.deepEqual(sent[0], first);
		await s.flush(at + 93000);
		assert.equal(sent.length, 2);
		assert.notEqual(sent[1]!.requestId, first.requestId);
		await s.flush(at + 120000);
		assert.equal(sent.length, 2);
	} finally {
		await s.close();
		await rm(dir, { recursive: true, force: true });
	}
});
test("session source ignores baseline, streaming, questions and active jobs; emits failed plus settled once", async () => {
	const s = new WatchService(":memory:");
	let change!: (s: SessionSummary) => void;
	const chat = {
		id: "c",
		title: "Chat",
		projectId: "p",
		state: "idle",
		mode: "build",
		cwd: "/tmp",
		sessionPath: "/tmp",
		createdAt: 0,
		updatedAt: 1,
		outcome: "done",
		outcomeAt: 1,
	} as SessionSummary;
	const sessions = {
		list: () => [chat],
		onChange: (f: typeof change) => {
			change = f;
			return () => {};
		},
	} as unknown as SessionManager;
	const source = new SessionWatchSource(s, sessions);
	const sent: WatchNotice[] = [];
	try {
		await s.add(input);
		await s.add({ ...input, event: "chat.failed" });
		s.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		for (let i = 0; i < 1000; i++) change({ ...chat, updatedAt: i });
		await source.idle();
		await s.flush(Date.now() + 60000);
		assert.equal(sent.length, 0);
		change({ ...chat, state: "working", working: true, outcome: undefined });
		change({ ...chat, outcome: "question", outcomeAt: Date.now() });
		await source.idle();
		await s.flush(Date.now() + 60000);
		assert.equal(sent.length, 0);
		const at = Date.now();
		change({
			...chat,
			outcome: "failed",
			outcomeAt: at,
			runningJobs: [{ id: "job", name: "job", state: "running", startedAt: at, outputPath: "/tmp/out" }],
		});
		await source.idle();
		await s.flush(at + 60000);
		assert.equal(sent.length, 0);
		change({ ...chat, outcome: "failed", outcomeAt: at });
		await source.idle();
		await s.flush(at + 60000);
		assert.equal(sent[0]!.items.length, 2);
	} finally {
		await source.stop();
		await s.close();
	}
});
test("rolling 20/hour limit and 30-minute cap share the mission policy", async () => {
	const s = new WatchService(":memory:");
	const sent: WatchNotice[] = [];
	try {
		await s.add(input);
		s.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		const at = Date.now();
		for (let i = 0; i < 21; i++) {
			await s.observe([event(String(i), at + i * 31000)]);
			await s.flush(at + i * 31000 + 30000);
		}
		assert.equal(sent.length, 20);
		await s.flush(at + 3600000 + 30000);
		assert.equal(sent.length, 21);
	} finally {
		await s.close();
	}
});
