import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand, KernelSpec } from "@pilot/kernel";
import { ChatSettingsService } from "./chat-settings.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

test("automation settings never configure worker handoff", { timeout: 10_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-handoff-ipc-"));
	const settings = await ChatSettingsService.open(home);
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
	assert.equal(Object.hasOwn(specs[0]!, "autoHandoff"), false);
	assert.equal(
		commands.flat().some((command) => command.type === ("autoHandoff.configure" as string)),
		false,
	);
	await settings.update({ automations: false, expectedRevision: settings.settings().revision });
	assert.equal(
		commands.flat().some((command) => command.type === ("autoHandoff.configure" as string)),
		false,
	);
	finishStartup();
	const unsubscribe = sessions.subscribe(chat.id, () => undefined);
	t.after(unsubscribe);
	await settings.update({ automations: true, expectedRevision: settings.settings().revision });
	assert.equal(
		commands.flat().some((command) => command.type === ("autoHandoff.configure" as string)),
		false,
	);
	assert.equal(specs.length, 1);
	const next = await sessions.spawn({ cwd: home, title: "Second", message: "offline fixture" });
	await new Promise<void>((resolve) => {
		const check = () => (specs.length === 2 ? resolve() : setImmediate(check));
		check();
	});
	assert.equal(Object.hasOwn(specs[1]!, "autoHandoff"), false);
	finishStartup();
	assert.ok(next.id);
});
