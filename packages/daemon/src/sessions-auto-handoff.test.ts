import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand, KernelSpec } from "@pilot/kernel";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

test("handoff settings reach new, initializing and live workers without reopening", { timeout: 10_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-handoff-ipc-"));
	const specs: KernelSpec[] = [];
	const commands: KernelCommand[][] = [];
	let finishStartup!: () => void;
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker(spec, packet, exit) {
			specs.push(spec);
			const sent: KernelCommand[] = [];
			commands.push(sent);
			let ready!: () => void;
			const worker = {
				state: "starting" as const,
				busy: false,
				ready: new Promise<void>((resolve) => {
					ready = resolve;
				}),
				send(command: KernelCommand) {
					sent.push(command);
				},
				async request(command: Extract<KernelCommand, { requestId: string }>) {
					sent.push(command);
				},
				async close() {
					exit(this, 0);
				},
			};
			finishStartup = () => {
				packet({ type: "ready", working: false, model: "faux/faux-1", usage: {} });
				ready();
			};
			// Exercise a setting change in the factory's synchronous prefix, before publication.
			sessions.configureAutoHandoff(true);
			return worker;
		},
	});
	t.after(async () => {
		finishStartup?.();
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, title: "Handoff config", message: "offline fixture" });
	// Worker launch is asynchronous; wait using the startup callback, not a model provider.
	await new Promise<void>((resolve) => {
		const check = () => (specs.length ? resolve() : setImmediate(check));
		check();
	});
	assert.equal(specs[0]?.autoHandoff, false);
	assert.deepEqual(commands[0]?.[0], { type: "autoHandoff.configure", enabled: true });
	sessions.configureAutoHandoff(false);
	assert.deepEqual(commands[0]?.at(-1), { type: "autoHandoff.configure", enabled: false });
	finishStartup();
	const unsubscribe = sessions.subscribe(chat.id, () => undefined);
	t.after(unsubscribe);
	sessions.configureAutoHandoff(true);
	assert.deepEqual(commands[0]?.at(-1), { type: "autoHandoff.configure", enabled: true });
	assert.equal(specs.length, 1);
	const next = await sessions.spawn({ cwd: home, title: "Second", message: "offline fixture" });
	await new Promise<void>((resolve) => {
		const check = () => (specs.length === 2 ? resolve() : setImmediate(check));
		check();
	});
	assert.equal(specs[1]?.autoHandoff, true);
	finishStartup();
	assert.ok(next.id);
});
