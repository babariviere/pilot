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
import { createDaemonServer } from "./server.ts";
import { CommandRejected, SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

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
	const sessions = new SessionManager(home, projects, undefined, {
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
	});
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
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
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
