import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelSpec } from "@pilot/kernel";
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

test("offline is a quiet projection; clearing it cannot admit work past sleep, updates or Stop", {
	timeout: 10_000,
}, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sessions-offline-"));
	const commands: KernelCommand[] = [],
		specs: KernelSpec[] = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker(spec, packet, exit) {
			specs.push(spec);
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
					} else if (command.type === "abort") {
						this.state = "idle";
						this.busy = false;
						packet({
							type: "working",
							working: false,
							completion: { outcome: "stopped", outcomeAt: Date.now() },
						});
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
	sessions.setConnectivity(false);
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, title: "Offline chat", message: "work" });
	await until(() => commands.some((command) => command.type === "input"));
	assert.equal(specs[0]?.connectivityPolicy, join(home, "connectivity.json"));
	assert.equal(sessions.get(chat.id)?.offlinePaused, true);
	assert.equal(sessions.get(chat.id)?.working, false);
	assert.equal(sessions.get(chat.id)?.outcome, undefined);
	const count = commands.length;
	sessions.setConnectivity(true);
	assert.equal(sessions.get(chat.id)?.working, true);
	assert.equal(commands.length, count, "connectivity never resubmits input or sends a resume command");
	sessions.setConnectivity(false);
	await sessions.pauseForSleep();
	const starts = specs.length;
	sessions.setConnectivity(true);
	assert.equal(specs.length, starts);
	assert.equal(sessions.get(chat.id)?.sleepPaused, true);
	sessions.pauseForUpdate();
	await sessions.resumeAfterSleep();
	assert.equal(specs.length, starts, "online plus wake cannot bypass the update lease");
	// A later sleep still permits durable cancellation without opening a parked worker.
	await sessions.pauseForSleep();
	await sessions.stop(chat.id);
	sessions.setConnectivity(false);
	sessions.setConnectivity(true);
	assert.equal(specs.length, starts, "Stop does not reopen work when connectivity changes");
});
