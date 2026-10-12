// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { SessionCommand, SessionState } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { CommandRejected, SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

type Command = Extract<KernelCommand, { requestId: string }>;

const listed: SessionCommand[] = [
	{ name: "review", source: "prompt", description: "Review the diff", argumentHint: "<focus>" },
	{ name: "skill:commit", source: "skill", description: "Create a commit" },
];

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	readonly commands: Command[] = [];
	rejectBusy = false;
	send(): void {}
	async request(command: Command): Promise<void> {
		this.commands.push(command);
		if (this.rejectBusy) throw new CommandRejected("Conversation is busy", "busy");
	}
	async close(): Promise<void> {}
}

async function fixture(t: TestContext, meta: Record<string, unknown> = {}) {
	const home = await mkdtemp(join(tmpdir(), "pilot-session-commands-"));
	const id = randomUUID();
	const dir = join(home, "sessions", id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify({ id, cwd: home, title: "Chat", createdAt: 100, updatedAt: 200, ...meta }),
	);
	const projects = new ProjectStore(home);
	const workers: FakeWorker[] = [];
	const sessions = new SessionManager(home, projects, undefined, {
		worker: (_spec, onPacket: (packet: KernelPacket) => void) => {
			const worker = new FakeWorker();
			workers.push(worker);
			queueMicrotask(() =>
				onPacket({ type: "ready", model: "test/model", working: false, usage: {}, commands: listed }),
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
	return { home, id, projects, sessions, workers };
}

test("commands open a parked session once, then serve the cached list without reopening it", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.sessions.commands(f.id), listed);
	assert.equal(f.workers.length, 1);
	// Parking keeps the list; a later request must not start another kernel.
	f.sessions["workers"].delete(f.id);
	assert.deepEqual(await f.sessions.commands(f.id), listed);
	assert.equal(f.workers.length, 1);
});

test("archived sessions list no commands and never start a kernel", async (t) => {
	const f = await fixture(t, { archivedAt: 300 });
	assert.deepEqual(await f.sessions.commands(f.id), []);
	await assert.rejects(f.sessions.compact(f.id), Conflict);
	assert.equal(f.workers.length, 0);
});

test("compact forwards trimmed instructions, omits blank ones, and maps busy to a conflict", async (t) => {
	const f = await fixture(t);
	await f.sessions.compact(f.id, "  keep the failing test names  ");
	await f.sessions.compact(f.id, "   ");
	const [first, second] = f.workers[0]!.commands;
	assert.deepEqual(first?.type === "compact" && first.instructions, "keep the failing test names");
	assert.equal(second?.type, "compact");
	assert.equal(second && "instructions" in second, false);
	f.workers[0]!.rejectBusy = true;
	await assert.rejects(f.sessions.compact(f.id), Conflict);
});

test("HTTP routes list commands and validate compaction instructions", async (t) => {
	const f = await fixture(t);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${f.id}`;
	const list = await fetch(`${base}/commands`);
	assert.equal(list.status, 200);
	assert.deepEqual(await list.json(), { commands: listed });
	const post = (body: unknown) =>
		fetch(`${base}/compact`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	assert.equal((await post({ instructions: 42 })).status, 400);
	const accepted = await post({ instructions: "focus on the API" });
	assert.equal(accepted.status, 202);
	assert.deepEqual(await accepted.json(), { ok: true });
	assert.equal((await post({})).status, 202);
	assert.equal(f.workers[0]!.commands.filter((command) => command.type === "compact").length, 2);
});
