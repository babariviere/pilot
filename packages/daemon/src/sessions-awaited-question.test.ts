import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { SessionState } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

async function until(check: () => boolean) {
	const end = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < end);
		await delay(2);
	}
}

test("a question the live run awaits is live attention only while that run works", { timeout: 10_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sessions-awaited-question-"));
	const commands: KernelCommand[] = [];
	let publish!: (packet: KernelPacket) => void;
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker(_spec, packet, exit) {
			publish = packet;
			const worker = {
				state: "idle" as SessionState,
				busy: false,
				ready: Promise.resolve(),
				send(command: KernelCommand) {
					commands.push(command);
				},
				async request(command: Extract<KernelCommand, { requestId: string }>) {
					commands.push(command);
					if (command.type === "input") {
						this.state = "working";
						this.busy = true;
						packet({ type: "working", working: true });
					}
				},
				async close() {
					exit(this, 0);
				},
			};
			queueMicrotask(() => packet({ type: "ready", working: false, model: "faux/faux-1", usage: {} }));
			return worker;
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, title: "Asking chat", message: "work" });
	await until(() => commands.some((command) => command.type === "input"));
	const before = sessions.get(chat.id)!;
	assert.equal(before.attentionReason, undefined);

	publish({ type: "question.awaited", question: "Which layout?\nThreads or flat" });
	const asking = sessions.get(chat.id)!;
	assert.deepEqual(asking.attentionReason, { kind: "asks", detail: "Which layout?" });
	assert.equal(typeof asking.attentionAt, "number");
	// Presentation only: the run, its state and the outcome stay untouched.
	assert.equal(asking.state, before.state);
	assert.equal(asking.working, true);
	assert.equal(asking.outcome, undefined);

	// Answered, stopped or cancelled: the kernel clears it.
	publish({ type: "question.awaited" });
	assert.equal(sessions.get(chat.id)?.attentionReason, undefined);

	// A run that ended never keeps a stale question.
	publish({ type: "question.awaited", question: "Again?" });
	publish({ type: "working", working: false, completion: { outcome: "done", outcomeAt: Date.now() } });
	assert.equal(sessions.get(chat.id)?.attentionReason, undefined);
});
