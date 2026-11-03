import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompletionRuntime } from "./background-usage.ts";
import { McpStatusService } from "./mcp-status.ts";
import { ModelCatalog } from "./models.ts";
import { NoticeDispatcher } from "./notice-dispatcher.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { RuntimeResources } from "./runtime-admission.ts";
import { RuntimeBackground } from "./runtime-background.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";

test("maintenance freezes synchronously, retains admitted lifetime, resumes once", async () => {
	let pause = 0,
		resume = 0,
		finish!: () => void;
	const gate = new RuntimeBackground(
		"synthetic",
		() => {
			resume++;
		},
		() => {
			pause++;
		},
	);
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let cleanup = false;
	const active = gate.run("child", async () => {
		await settled;
		cleanup = true;
	});
	const resources = new RuntimeResources([gate]);
	const a = resources.freezeAdmissions(),
		b = gate.freezeAdmissions();
	assert.equal(gate.frozen, true);
	assert.equal(pause, 1);
	assert.equal((await resources.blockers()).length, 1);
	await assert.rejects(
		gate.run("new", () => {}),
		/maintenance/,
	);
	a();
	a();
	assert.equal(resume, 0);
	finish();
	await active;
	assert.equal(cleanup, true);
	assert.deepEqual(await resources.blockers(), []);
	b();
	b();
	assert.equal(resume, 1);
	assert.equal(gate.frozen, false);
	await gate.run("next", () => {});
});

test("rejected work and throwing observers release only their own admission", async () => {
	const gate = new RuntimeBackground("synthetic");
	gate.onChange(() => {
		throw new Error("observer");
	});
	const end = gate.begin("retained");
	await assert.rejects(
		gate.run("failed", () => {
			throw new Error("failure");
		}),
		/failure/,
	);
	assert.equal(gate.blockers().length, 1);
	end();
	end();
	assert.deepEqual(gate.blockers(), []);
});

test("maintenance resume is reversible; capacity and pause errors fail closed", () => {
	const gate = new RuntimeBackground("synthetic");
	const ends = Array.from({ length: 128 }, () => gate.begin());
	assert.throws(() => gate.begin(), /busy/);
	for (const end of ends) end();
	const failing = new RuntimeBackground("broken", undefined, () => {
		throw new Error("pause failure");
	});
	assert.throws(() => failing.freezeAdmissions(), /pause failure/);
	assert.equal(failing.frozen, true);
	assert.throws(() => failing.begin(), /maintenance/);
});

test("MCP status drains admitted probes, blocks re-entry, and resumes reversibly", async () => {
	const finishes: Array<(value: { servers: []; configProblems: number; complete: boolean }) => void> = [];
	const service = new McpStatusService({ probe: () => new Promise((resolve) => finishes.push(resolve)) });
	service.start();
	assert.equal(finishes.length, 1);
	const release = service.runtime.freezeAdmissions();
	service.check();
	assert.equal(finishes.length, 1);
	assert.equal(service.runtime.blockers().length, 1);
	finishes[0]!({ servers: [], configProblems: 0, complete: true });
	await service["settled"];
	assert.deepEqual(service.runtime.blockers(), []);
	assert.equal(finishes.length, 1);
	release();
	assert.equal(finishes.length, 2);
	finishes[1]!({ servers: [], configProblems: 0, complete: true });
	await service["settled"];
	await service.close();
});

test("reentrant freeze inside an MCP probe retains its admitted child lifetime", async () => {
	let finish!: (value: { servers: []; configProblems: number; complete: boolean }) => void;
	let release!: () => void;
	const service = new McpStatusService({
		probe: () => {
			release = service.runtime.freezeAdmissions();
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	service.start();
	assert.equal(service.runtime.frozen, true);
	assert.equal(service.runtime.blockers().length, 1, "probe is admitted before any reentrant code executes");
	finish({ servers: [], configProblems: 0, complete: true });
	await service["settled"];
	assert.deepEqual(service.runtime.blockers(), []);
	await service.close();
	release();
});

test("notice delivery retains admitted lifetime and freeze preserves later durable work", async () => {
	let finish!: () => void;
	let started!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let deliveries = 0;
	const dispatcher = new NoticeDispatcher({
		deadlines: () => [{ key: "notice", at: 0 }],
		eligible: () => true,
		deliver: async () => {
			deliveries++;
			started();
			await pending;
		},
	});
	dispatcher.start();
	const work = dispatcher.flush(1);
	await entered;
	const release = dispatcher.runtime.freezeAdmissions();
	await dispatcher.flush(1);
	assert.equal(deliveries, 1);
	assert.ok(dispatcher.runtime.blockers().length > 0);
	finish();
	await work;
	assert.deepEqual(dispatcher.runtime.blockers(), []);
	release();
	await dispatcher.flush(1);
	assert.equal(deliveries, 2);
	await dispatcher.stop();
});

test("source MCP freeze rejects calls and sign-ins without constructing children", async () => {
	const client = new PiSourceMcpClient("/synthetic/unused");
	const release = client.runtime.freezeAdmissions();
	await assert.rejects(client.call("linear", "me", { query: "me" }, new AbortController().signal), /maintenance/);
	await assert.rejects(
		client.signInServer("synthetic", { again: false, signal: new AbortController().signal }),
		/maintenance/,
	);
	assert.deepEqual(client.runtime.blockers(), []);
	release();
	await client.close();
});

test("memory freeze joins admitted disk RPC and reversibly rejects new work", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-memory-maintenance-"));
	const memory = new ProjectMemoryService(home);
	try {
		const admitted = memory.load("project");
		const release = memory.runtime.freezeAdmissions();
		assert.ok(memory.runtime.blockers().length > 0);
		await assert.rejects(memory.note("project", "blocked", "session"), /maintenance/);
		await admitted;
		assert.deepEqual(memory.runtime.blockers(), []);
		release();
		await memory.note("project", "resumed", "session");
	} finally {
		await memory.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test("title completion keeps provider lifetime visible after caller cancellation", async () => {
	const models = new ModelCatalog("/synthetic/unused");
	let finish!: () => void;
	let calls = 0;
	const underlying = new Promise<never>((_resolve, reject) => {
		finish = () => reject(new Error("provider settled"));
	});
	const provider = {
		completeSimple: () => {
			calls++;
			return underlying;
		},
	} as unknown as CompletionRuntime;
	const guarded = models["background"](provider, "title");
	const controller = new AbortController();
	const title = guarded.completeSimple({} as never, {} as never, { signal: controller.signal });
	const release = models.maintenance.freezeAdmissions();
	controller.abort();
	assert.equal(models.maintenance.blockers().length, 1, "ignored cancellation is not provider-exit proof");
	await assert.rejects(guarded.completeSimple({} as never, {} as never), /maintenance/);
	assert.equal(calls, 1, "no provider invocation after maintenance freeze");
	finish();
	await assert.rejects(title, /provider settled/);
	assert.deepEqual(models.maintenance.blockers(), []);
	release();
});
