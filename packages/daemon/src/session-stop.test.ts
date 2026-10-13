// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { SessionState } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";

type Command = Extract<KernelCommand, { requestId: string }>;

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	readonly commands: Command[] = [];
	reply?: (command: Command) => Promise<KernelPacket | undefined> | KernelPacket | undefined;
	private readonly onPacket: (packet: KernelPacket) => void;
	constructor(onPacket: (packet: KernelPacket) => void) {
		this.onPacket = onPacket;
	}
	send(): void {}
	async request(command: Command): Promise<void> {
		this.commands.push(command);
		const reply = await this.reply?.(command);
		if (reply) this.onPacket(reply);
	}
	async close(): Promise<void> {}
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-session-stop-"));
	const id = randomUUID();
	const dir = join(home, "sessions", id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify({ id, cwd: home, title: "Chat", createdAt: 1, updatedAt: 2 }),
	);
	const workers: FakeWorker[] = [];
	let reply: FakeWorker["reply"];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		worker: (_spec, onPacket) => {
			const worker = new FakeWorker(onPacket);
			worker.reply = (command) => reply?.(command);
			workers.push(worker);
			queueMicrotask(() => onPacket({ type: "ready", model: "provider/model", working: false, usage: {} }));
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
		id,
		sessions,
		workers,
		setReply: (next: FakeWorker["reply"]) => {
			reply = next;
		},
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("stop returns the user's withdrawn queued messages as a composer draft", async (t) => {
	const f = await fixture(t);
	await f.sessions.send(f.id, "start", "followUp");
	assert.deepEqual(await f.sessions.stop(f.id), { ok: true }, "nothing queued, nothing to restore");
	f.setReply((command) =>
		command.type === "abort"
			? {
					type: "aborted",
					requestId: command.requestId,
					withdrawn: [{ requestId: "a", content: "Steer this" }, { content: "Then this" }],
				}
			: undefined,
	);
	assert.deepEqual(await f.sessions.stop(f.id), { ok: true, draft: "Steer this\n\nThen this" });
	assert.equal(f.sessions["stopResults"].size, 0);
});

test("stop restores undelivered input once, leaving input in flight to the kernel", async (t) => {
	const f = await fixture(t);
	await f.sessions.send(f.id, "start", "followUp");
	const gate = deferred();
	let inFlight: string | undefined;
	f.setReply(async (command) => {
		if (command.type === "input" && command.content === "in flight") {
			inFlight = command.requestId;
			await gate.promise;
		}
		// The kernel received the in-flight message before the abort, and withdrew it.
		return command.type === "abort"
			? { type: "aborted", requestId: command.requestId, withdrawn: [{ requestId: inFlight, content: "in flight" }] }
			: undefined;
	});
	const first = f.sessions.send(f.id, "in flight", "followUp");
	while (!inFlight) await new Promise((resolve) => setTimeout(resolve, 1));
	const second = f.sessions.send(f.id, "not sent yet", "steer");
	const automatic = f.sessions.send(f.id, "coordinator", "followUp", "mission:send:1");
	await new Promise((resolve) => setTimeout(resolve, 5));
	const stopping = f.sessions.stop(f.id);
	gate.resolve();
	assert.deepEqual(await stopping, { ok: true, draft: "in flight\n\nnot sent yet" });
	await Promise.allSettled([first, second, automatic]);
	const sent = f.workers.flatMap((worker) => worker.commands).filter((command) => command.type === "input");
	assert.deepEqual(
		sent.map((command) => (command.type === "input" ? command.content : "")),
		["start", "in flight"],
		"withdrawn input is never delivered",
	);
	assert.equal(f.sessions["delivering"].size, 0);
});
