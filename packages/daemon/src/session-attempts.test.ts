// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket, KernelUsage } from "@pilot/kernel";
import type { RewindResponse, SessionAttempt, SessionState, SessionSummary } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { CommandRejected, SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "./testing/daemon-server.ts";
import { offlineSessionOptions } from "./testing/offline-session-options.ts";

type Command = Extract<KernelCommand, { requestId: string }>;
const attempts: SessionAttempt[] = [
	{ id: "1" },
	{ id: "7", reason: "retry", createdAt: 5, preview: "second", active: true },
];

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	usage: KernelUsage = { context: { tokens: 5, contextWindow: 100, percent: 5 } };
	readonly commands: Command[] = [];
	readonly sent: KernelCommand[] = [];
	closed = false;
	reply?: (command: Command) => KernelPacket | Error | undefined;
	private readonly onPacket: (packet: KernelPacket) => void;
	constructor(onPacket: (packet: KernelPacket) => void) {
		this.onPacket = onPacket;
	}
	send(command: KernelCommand): void {
		this.sent.push(command);
	}
	emit(packet: KernelPacket): void {
		this.onPacket(packet);
	}
	async request(command: Command): Promise<void> {
		this.commands.push(command);
		const reply = this.reply?.(command);
		if (reply instanceof Error) throw reply;
		if (reply) this.onPacket(reply);
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

async function fixture(t: TestContext, patch: Record<string, unknown> = {}) {
	const home = await mkdtemp(join(tmpdir(), "pilot-session-attempts-"));
	const id = randomUUID();
	const dir = join(home, "sessions", id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify({
			id,
			cwd: home,
			title: "Chat",
			createdAt: 100,
			updatedAt: 200,
			outcome: "failed",
			outcomeAt: 300,
			outcomeReason: "Invalid request",
			...patch,
		}),
	);
	const projects = new ProjectStore(home);
	const workers: FakeWorker[] = [];
	let reply: FakeWorker["reply"] = (command) =>
		command.type === "rewind"
			? {
					type: "rewound",
					requestId: command.requestId,
					switched: true,
					content: "second",
					attempts,
				}
			: command.type === "activateAttempt"
				? { type: "rewound", requestId: command.requestId, switched: false }
				: undefined;
	const createSessions = () =>
		new SessionManager(
			home,
			projects,
			undefined,
			{
				worker: (_spec, onPacket) => {
					const worker = new FakeWorker(onPacket);
					worker.reply = (command) => reply?.(command);
					workers.push(worker);
					const generation = workers.length;
					queueMicrotask(() =>
						onPacket({
							type: "ready",
							model: "provider/model",
							working: false,
							usage: worker.usage,
							...(generation > 1 ? { attempts } : {}),
						}),
					);
					return worker;
				},
			},
			{},
			offlineSessionOptions(),
		);
	const sessions = createSessions();
	await sessions.load();
	t.after(async () => {
		await sessions.shutdown();
		await Promise.allSettled(sessions["saving"].values());
		await rm(home, { recursive: true, force: true });
	});
	return {
		home,
		dir,
		id,
		projects,
		sessions,
		workers,
		async restart() {
			await sessions.shutdown();
			const restarted = createSessions();
			await restarted.load();
			t.after(() => restarted.shutdown());
			return restarted;
		},
		setReply: (next: FakeWorker["reply"]) => {
			reply = next;
		},
	};
}

test("retry stops the kernel, reopens the new attempt for every viewer, clears the failure and resends", async (t) => {
	const f = await fixture(t);
	const events: unknown[] = [];
	const unsubscribe = f.sessions.subscribe(f.id, (batch) => events.push(...batch));
	t.after(unsubscribe);
	const response = await f.sessions.rewind(f.id, "retry", 42);
	assert.equal(response.draft, undefined);
	assert.deepEqual(f.workers[0]!.commands[0], {
		type: "rewind",
		requestId: f.workers[0]!.commands[0]!.requestId,
		action: "retry",
		entryId: 42,
	});
	assert.equal(f.workers[0]!.closed, true, "the retired kernel is replaced");
	assert.equal(f.workers.length, 2);
	assert.ok(
		f.workers[1]!.sent.some((command) => command.type === "watch" && !command.activityOnly),
		"existing viewers reattach to the replacement",
	);
	const input = f.workers[1]!.commands.find((command) => command.type === "input");
	assert.equal(input?.type === "input" ? input.content : undefined, "second");
	const summary = f.sessions.get(f.id)!;
	assert.deepEqual(summary.attempts, attempts);
	assert.equal(summary.outcome, undefined, "the failure belonged to the attempt that was left");
	assert.equal(summary.error, undefined);
	const stored = JSON.parse(await readFile(join(f.dir, "meta.json"), "utf8"));
	assert.deepEqual(stored.attempts, attempts);
	assert.equal(stored.outcome, undefined);
	assert.equal(stored.lastOutcomeAt, 300);
	assert.equal(stored.inputGeneration, 1, "attempt changes fence previously captured native sends");
	await f.sessions.sendDurable(f.id, "old capture", "steer", randomUUID(), { inputGeneration: 0 });
	const captured = f.workers[1]!.commands.at(-1)!;
	assert.equal(captured.type, "input");
	assert.ok(captured.type === "input" && captured.dedupeOnly, "stale capture can only inspect an existing receipt");
});

test("edit returns the draft without sending, and an unchanged attempt keeps its kernel", async (t) => {
	const f = await fixture(t);
	f.setReply((command) =>
		command.type === "rewind"
			? { type: "rewound", requestId: command.requestId, switched: true, content: "first", attempts }
			: command.type === "activateAttempt"
				? { type: "rewound", requestId: command.requestId, switched: false, attempts }
				: undefined,
	);
	const edited = await f.sessions.rewind(f.id, "edit", 3);
	assert.equal(edited.draft, "first");
	assert.equal(edited.session.attempts?.length, 2);
	assert.equal(
		f.workers.flatMap((worker) => worker.commands).some((command) => command.type === "input"),
		false,
		"edit leaves sending to the user",
	);
	const kernels = f.workers.length;
	const same = await f.sessions.activateAttempt(f.id, "7");
	assert.equal(f.workers.length, kernels, "activating the current attempt does not restart the kernel");
	assert.equal(f.workers.at(-1)!.closed, false);
	assert.deepEqual(same.attempts, attempts);
	await assert.rejects(f.sessions.activateAttempt(f.id, "0"), /Invalid attempt ID/);
	await assert.rejects(f.sessions.rewind(f.id, "undo" as never, 3), /action must be/);
	await assert.rejects(f.sessions.rewind(f.id, "edit", -1), /Invalid entry ID/);
});

test("busy kernels, archived chats, and concurrent changes reject without restarting", async (t) => {
	const f = await fixture(t);
	f.setReply((command) =>
		command.type === "rewind" ? new CommandRejected("Conversation is busy", "busy") : undefined,
	);
	await assert.rejects(f.sessions.rewind(f.id, "retry", 4), Conflict);
	assert.equal(f.workers.length, 1);
	assert.equal(f.workers[0]!.closed, false);
	assert.equal(f.sessions.get(f.id)!.outcome, "failed", "a rejected rewind changes nothing");
	f.setReply((command) =>
		command.type === "rewind" ? new Error("The message is not part of this conversation") : undefined,
	);
	await assert.rejects(f.sessions.rewind(f.id, "edit", 4), /not part of this conversation/);
	f.sessions["changingModels"].set(f.id, Promise.resolve());
	await assert.rejects(f.sessions.rewind(f.id, "retry", 4), Conflict);
	await assert.rejects(
		f.sessions.send(f.id, "during", "followUp"),
		Conflict,
		"sends cannot reach the attempt being left",
	);
	f.sessions["changingModels"].delete(f.id);
	f.sessions["metas"].get(f.id)!.archivedAt = 500;
	await assert.rejects(f.sessions.rewind(f.id, "retry", 4), Conflict);
});

test("HTTP rewind and attempt activation validate input and return the session", async (t) => {
	const f = await fixture(t);
	const server = createDaemonServer({
		config: { home: f.home, host: "127.0.0.1", port: 0 },
		sessions: f.sessions,
		projects: f.projects,
		models: new ModelCatalog("/unused"),
		terminals: new TerminalManager(),
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${f.id}`;
	const post = (path: string, body?: unknown) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	assert.equal((await post("/rewind", { action: "undo", entryId: 1 })).status, 400);
	assert.equal((await post("/rewind", { action: "edit", entryId: "1" })).status, 400);
	assert.equal((await post("/attempts/abc/activate")).status, 400);
	const response = await post("/rewind", { action: "edit", entryId: 9 });
	assert.equal(response.status, 200);
	const body = (await response.json()) as RewindResponse;
	assert.equal(body.session.id, f.id);
	assert.equal(body.draft, "second");
	const activated = await post("/attempts/1/activate");
	assert.equal(activated.status, 200);
	assert.equal(((await activated.json()) as SessionSummary).id, f.id);
});

test("Slack replies never cold-start a parked session", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", "slack-reply:item:1", () => {}), false);
	assert.equal(f.workers.length, 0);
	assert.equal(f.sessions.get(f.id)!.error, undefined);
});

test("Slack replies require the exact live idle worker and preserve Stop and input holds", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
	const worker = f.workers[0]!;
	assert.ok(worker);
	const baseline = worker.commands.length;
	const meta = f.sessions["metas"].get(f.id)!;
	for (const hold of [
		"cancelled",
		"recoveryStopped",
		"inputsPaused",
		"updatePaused",
		"sleepPaused",
		"delegationFenced",
	] as const) {
		meta[hold] = true;
		assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", `slack-reply:item:${hold}`, () => {}), false, hold);
		assert.equal(meta[hold], true, "automatic input does not clear a hold");
		delete meta[hold];
	}
	assert.equal(worker.commands.length, baseline);
	const beforeActivity = meta.lastUserMessageAt;
	assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", "slack-reply:item:allowed", () => {}), true);
	assert.equal(
		worker.commands.filter((command) => command.type === "input").at(-1)?.requestId,
		"slack-reply:item:allowed",
	);
	assert.equal(meta.lastUserMessageAt, beforeActivity, "Slack replies are not user activity");
});

test("Slack reply admission rechecks the item after persistence and before dispatch", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
	const worker = f.workers[0]!;
	const baseline = worker.commands.length;
	let changed = false;
	t.mock.method(f.sessions, "captureRunBoundary" as never, async () => {
		changed = true;
	});
	assert.equal(
		await f.sessions.resumeSlackReply(f.id, "Stale reply", "slack-reply:item:stale", () => {
			if (changed) throw new Error("User changed the report");
		}),
		false,
	);
	assert.equal(worker.commands.length, baseline);
	assert.equal(f.sessions.get(f.id)!.error, undefined);
	assert.equal(f.sessions["metas"].get(f.id)!.pending?.length ?? 0, 0);
});

test("Slack replies keep a pending database decision on hold", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
	const worker = f.workers[0]!;
	const before = worker.commands.length;
	const meta = f.sessions["metas"].get(f.id)!;
	const request = { id: "database-question", env: "production", mode: "read" as const };
	meta.databases = { request };
	assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", "slack-reply:item:database", () => {}), false);
	assert.equal(worker.commands.length, before);
	assert.equal(meta.databases.request, request, "only the user's database decision answers this request");
});

test("Slack reply rejects a hold or worker replacement during run-boundary I/O", async (t) => {
	for (const action of ["hold", "replace", "database"] as const) {
		const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
		await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
		const worker = f.workers[0]!;
		const baseline = worker.commands.length;
		t.mock.method(f.sessions, "captureRunBoundary" as never, async () => {
			if (action === "hold") f.sessions["metas"].get(f.id)!.inputsPaused = true;
			else if (action === "database")
				f.sessions["metas"].get(f.id)!.databases = {
					request: { id: "database-question", env: "production", mode: "read" },
				};
			else f.sessions["workers"].delete(f.id);
		});
		assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", `slack-reply:item:${action}`, () => {}), false);
		assert.equal(worker.commands.length, baseline);
		assert.equal(f.workers.length, 1, "no replacement or cold start");
		assert.equal(f.sessions.get(f.id)!.error, undefined);
	}
});

test("Slack reply never reports delivery when a held drain did not dispatch", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
	const worker = f.workers[0]!;
	const baseline = worker.commands.length;
	t.mock.method(f.sessions, "start" as never, async () => new Map());
	assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", "slack-reply:item:deferred", () => {}), false);
	assert.equal(worker.commands.length, baseline);
	assert.equal(f.sessions["metas"].get(f.id)!.pending?.length ?? 0, 0);
});

test("a lost Slack reply acknowledgement holds uncertain admission without automatic replay", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
	const worker = f.workers[0]!;
	f.setReply((command) => (command.type === "input" ? new Error("Input acknowledgement lost") : undefined));
	const requestId = "slack-reply:item:uncertain";
	await assert.rejects(
		f.sessions.resumeSlackReply(f.id, "Reply", requestId, () => {}),
		/acknowledgement lost/,
	);
	const requests = worker.commands.length;
	assert.equal(await f.sessions.resumeSlackReply(f.id, "Reply", requestId, () => {}), false);
	assert.equal(worker.commands.length, requests, "uncertain admission is not replayed automatically");
	assert.equal(f.sessions["metas"].get(f.id)!.pending?.length ?? 0, 0);
	assert.match(f.sessions.get(f.id)!.error!, /acknowledgement lost/);
});

test("unknown Slack admission survives readiness and restart, including newer reply IDs", async (t) => {
	const f = await fixture(t, { outcome: undefined, outcomeAt: undefined });
	await f.sessions.send(f.id, "User approved work", "followUp", randomUUID());
	const worker = f.workers[0]!;
	f.setReply((command) => (command.type === "input" ? new Error("Input acknowledgement lost") : undefined));
	await assert.rejects(
		f.sessions.resumeSlackReply(f.id, "Reply", "slack-reply:item:lost", () => {}),
		/acknowledgement lost/,
	);
	worker.emit({ type: "ready", model: "provider/model", working: false, usage: worker.usage });
	assert.equal(f.sessions.get(f.id)!.error, undefined, "ordinary inputError is cleared on readiness");
	await Promise.allSettled(f.sessions["saving"].values());
	assert.equal(
		JSON.parse(await readFile(join(f.dir, "meta.json"), "utf8")).slackReplyAdmission,
		"slack-reply:item:lost",
	);
	f.setReply(undefined);
	const before = worker.commands.length;
	assert.equal(await f.sessions.resumeSlackReply(f.id, "New reply", "slack-reply:item:new", () => {}), false);
	assert.equal(worker.commands.length, before);
	await Promise.allSettled(f.sessions["saving"].values());
	const restarted = await f.restart();
	assert.equal(f.workers.length, 1, "reloading does not cold-start Slack work");
	await restarted["ensureWorker"](f.id);
	await Promise.resolve();
	assert.equal(restarted.get(f.id)!.error, undefined);
	assert.equal(restarted.canSendNotice(f.id, "slack-reply:item:newer"), true, "ordinary readiness is not the hold");
	const live = f.workers.at(-1)!;
	const restartedBefore = live.commands.length;
	assert.equal(await restarted.resumeSlackReply(f.id, "Another reply", "slack-reply:item:newer", () => {}), false);
	assert.equal(live.commands.length, restartedBefore);
	await restarted.send(f.id, "I checked the uncertain result. Continue.", "followUp", randomUUID());
	assert.equal(await restarted.resumeSlackReply(f.id, "Fresh reply", "slack-reply:item:resolved", () => {}), true);
});
