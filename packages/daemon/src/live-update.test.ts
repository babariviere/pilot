import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { KernelCommand } from "@pilot/kernel";
import {
	type LiveUpdateHooks,
	type LiveUpdateIdentity,
	LiveUpdateService,
	type LiveUpdateTarget,
} from "./live-update.ts";
import { durableJSON } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";

const source = "a".repeat(40),
	oldSource = "b".repeat(40);
const target: LiveUpdateTarget = {
	guiBuild: "12.3",
	source,
	build: { schema: 1, source, version: "1.109.0", protocol: 1, platform: "darwin", arch: "arm64", node: "24.21.0" },
	runtimeRoot: "/immutable/new/runtime",
};
const initial: LiveUpdateIdentity = {
	...target,
	boot: "initial",
	source: oldSource,
	build: { ...target.build, source: oldSource },
	runtimeRoot: "/immutable/old/runtime",
};
const receipt: LiveUpdateIdentity = { ...target, boot: "gui-restarted" };
const args = { directory: "/synthetic/pilot", source, build: "12.3", summary: "Synthetic update" };
async function fixture(t: test.TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-live-update-"));
	const cleanups: Array<() => Promise<void>> = [];
	let ready = true,
		pauses = 0,
		resumed = 0,
		freezes = 0;
	let eligible = true,
		failResume = false,
		failRelease = false;
	const admission = new RuntimeAdmission();
	const resources = new RuntimeResources([admission]);
	const projects = {
		async origin() {
			return { identity: eligible ? '["github.com","babariviere/pilot"]' : null };
		},
	};
	const services: LiveUpdateService[] = [];
	function create(runtime = initial, save?: LiveUpdateHooks["save"]) {
		const s = new LiveUpdateService(
			home,
			projects,
			() => {
				freezes++;
				return () => {
					if (failRelease) throw new Error("release failed");
				};
			},
			async () => {
				resumed++;
				if (failResume) throw new Error("resume failed");
			},
			{
				runtime,
				save,
				pauseForUpdate() {
					pauses++;
					return { ready };
				},
			},
		);
		s.attach(resources);
		services.push(s);
		return s;
	}
	t.after(async () => {
		for (const s of services) await s.close();
		// One ordered teardown, independent of node:test after-hook registration order.
		// Dependent services/managers/workers must settle before their storage is removed.
		for (const cleanup of cleanups.toReversed()) await cleanup();
		await rm(home, { recursive: true, force: true });
	});
	const service = create();
	await service.load();
	const proposed = () => service.propose("session", "project", "update", args);
	return {
		home,
		service,
		create,
		proposed,
		admission,
		setReady(v: boolean) {
			ready = v;
		},
		setEligible(v: boolean) {
			eligible = v;
		},
		setFailResume(v: boolean) {
			failResume = v;
		},
		setFailRelease(v: boolean) {
			failRelease = v;
		},
		counts: () => ({ pauses, resumed, freezes }),
		record: async () => JSON.parse(await readFile(join(home, "live-update.json"), "utf8")),
		beforeRemove(cleanup: () => Promise<void>) {
			cleanups.push(cleanup);
		},
	};
}

test("proposal origin, strict content and dedupe", async (t) => {
	const f = await fixture(t);
	f.setEligible(false);
	await assert.rejects(f.proposed(), /Pilot source project/);
	f.setEligible(true);
	await assert.rejects(f.service.propose("s", "p", "id", { ...args, extra: true }), /Invalid/);
	const a = await f.proposed();
	assert.deepEqual(await f.proposed(), a);
	await assert.rejects(f.service.propose("session", "project", "update", { ...args, summary: "different" }), /reused/);
	await assert.rejects(f.service.propose("s", "p", "other", args), /Another/);
	a.summary = "mutated";
	assert.equal(f.service.snapshot()?.summary, args.summary);
	assert.equal(f.counts().pauses, 0);
});

test("terminal operation IDs remain deduplicated after replacement and restart", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	await f.service.cancel("update");
	await f.service.propose("session", "project", "second", args);
	await f.service.cancel("second");
	await assert.rejects(f.proposed(), /superseded/);
	const restarted = f.create();
	await restarted.load();
	await assert.rejects(restarted.propose("session", "project", "update", args), /superseded/);
	assert.equal(restarted.snapshot()?.id, "second");
	await durableJSON(join(f.home, "live-update.json"), {
		...(await f.record()),
		history: ["update", ...Array.from({ length: 1023 }, (_, index) => `retained-${index}`)],
	});
	const full = f.create();
	await full.load();
	await assert.rejects(full.propose("session", "project", "over-capacity", args), /capacity/);
	await assert.rejects(full.propose("session", "project", "update", args), /superseded/);
});

test("real session worker resumes only after terminal persistence, never after write failure", async (t) => {
	const f = await fixture(t);
	const thread = new Worker(
		"const {parentPort}=require('node:worker_threads'); parentPort.on('message', m => {if(m.type==='update.resume') parentPort.postMessage('resumed');});",
		{ eval: true },
	);
	f.beforeRemove(async () => {
		await thread.terminate();
	});
	const writes: string[] = [];
	const commands: KernelCommand[] = [];
	const sessions = new SessionManager(f.home, new ProjectStore(f.home), undefined, {
		title: async () => undefined,
		worker: (_spec, report) => {
			const worker: SessionWorker = {
				ready: Promise.resolve(),
				state: "idle",
				busy: false,
				send(command) {
					commands.push(command);
					if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
					if (command.type === "update.resume") {
						assert.equal(writes.at(-1), "cancelled", "terminal checkpoint precedes tool resumption");
						thread.postMessage(command);
					}
				},
				request: async () => {},
				close: async () => {},
				jobs: async () => [],
				hasChildren: async () => false,
			};
			return worker;
		},
	});
	f.beforeRemove(() => sessions.shutdown());
	let failTerminal = true;
	const create = () => {
		const service = new LiveUpdateService(
			f.home,
			{
				async origin() {
					return { identity: '["github.com","babariviere/pilot"]' };
				},
			},
			() => sessions.freezeAdmissions(),
			() => sessions.resumeMaintenance(),
			{
				runtime: initial,
				pauseForUpdate: () => sessions.pauseForUpdate(),
				save: async (file, next) => {
					if (next.phase === "cancelled" && failTerminal) throw new Error("terminal write failure");
					await durableJSON(file, next);
					writes.push(next.phase);
				},
			},
		);
		service.attach(new RuntimeResources([sessions]));
		f.beforeRemove(() => service.close());
		return service;
	};
	const service = create();
	await service.load();
	await sessions.load();
	await sessions.spawn({ cwd: f.home, message: "synthetic work" });
	await Promise.all(sessions["starting"].values());
	await service.propose("session", "project", "update", args);
	await service.accept("update");
	const deadline = performance.now() + 3000;
	while (!(await service.progress("update")).ready) {
		assert.ok(performance.now() < deadline);
		await delay(1);
	}
	await assert.rejects(service.cancel("update"), /write failure/);
	assert.equal(
		commands.some((command) => command.type === "update.resume"),
		false,
	);
	assert.equal(service.frozen, true);
	// Failed ownership remains frozen in this process. Recovery is a new process in production;
	// this fixture releases only that old service's local holds before constructing its replacement.
	service["release"]();
	await service.close();
	failTerminal = false;
	const recovered = create();
	await recovered.load();
	const resumed = once(thread, "message");
	await recovered.progress("update");
	assert.deepEqual(await resumed, ["resumed"]);
	assert.equal(recovered.frozen, false);
	assert.equal((await f.record()).phase, "cancelled");
	assert.equal((await f.record()).resumePending, undefined, "ordinary future startups are not GUI-gated");
	await recovered.close();
});

test("proposal authorization is rechecked after asynchronous origin lookup", async (t) => {
	const f = await fixture(t);
	let authorized = true;
	let lookups = 0;
	let checks = 0;
	const service = new LiveUpdateService(
		f.home,
		{
			async origin() {
				lookups++;
				authorized = false;
				return { identity: '["github.com","babariviere/pilot"]' };
			},
		},
		() => () => {},
		async () => {},
		{ runtime: initial, pauseForUpdate: () => ({ ready: true }) },
	);
	service.attach(new RuntimeResources([]));
	await service.load();
	await assert.rejects(
		service.propose("session", "project", "update", args, () => {
			checks++;
			if (!authorized) throw new Error("worker ownership changed");
		}),
		/ownership changed/,
	);
	assert.equal(checks, 2);
	assert.equal(lookups, 1);
	assert.equal(service.snapshot(), null);
	await service.close();
});

test("durable freeze, GUI receipt and exact new daemon identity", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	await f.service.accept("update");
	assert.equal(f.service.snapshot()?.phase, "draining");
	assert.equal(f.counts().pauses, 0);
	assert.throws(() => f.admission.begin({ kind: "job", id: "new" }), /frozen/);
	f.setReady(false);
	assert.equal((await f.service.progress("update")).ready, false);
	await assert.rejects(f.service.armGui("update", target), /block/);
	f.setReady(true);
	await assert.rejects(f.service.armGui("update", { ...target, guiBuild: "99" }), /Invalid/);
	await f.service.armGui("update", target);
	await assert.rejects(f.service.armGui("update", target), /changed/);
	await assert.rejects(f.service.cancel("update"), /changed/);
	await assert.rejects(f.service.guiReady("update", { ...receipt, runtimeRoot: "/wrong" }), /mismatch/);
	await assert.rejects(f.service.guiReady("update", { ...receipt, guiBuild: undefined }), /mismatch/);
	await assert.rejects(f.service.guiReady("update", { ...receipt, guiBuild: "99" }), /mismatch/);
	await assert.rejects(
		f.service.guiReady("update", { ...receipt, build: { ...target.build, node: "24.22.0" } }),
		/mismatch/,
	);
	await f.service.guiReady("update", receipt);
	await f.service.armDaemon("update");
	await assert.rejects(f.service.armDaemon("update"), /changed/);
	await assert.rejects(f.service.complete("update"), /identity/);
	for (const runtime of [
		{ ...target, boot: initial.boot },
		{ ...target, boot: "new", build: { ...target.build, node: "24.22.0" } },
		{ ...target, boot: "new", runtimeRoot: "/wrong" },
	]) {
		const s = f.create(runtime);
		await s.load();
		await assert.rejects(s.complete("update"), /identity/);
	}
	const updated = f.create({ ...target, boot: "new" });
	await updated.load();
	assert.equal(updated.frozen, true);
	assert.equal((await updated.complete("update")).phase, "completed");
	assert.equal(f.counts().resumed, 1);
	assert.equal((await f.record()).phase, "completed");
	const pausesBeforeOrdinaryReboots = f.counts().pauses;
	for (const runtime of [
		{ ...initial, boot: "unrelated-future-boot" },
		{
			...initial,
			boot: "second-future-boot",
			source: "c".repeat(40),
			build: { ...initial.build, source: "c".repeat(40), node: "24.22.0" },
			runtimeRoot: "/later/ordinary/runtime",
		},
	]) {
		const laterOrdinaryUpgrade = f.create(runtime);
		await laterOrdinaryUpgrade.load();
		assert.equal(laterOrdinaryUpgrade.frozen, false, "terminal authorization does not pin future daemon runtimes");
	}
	assert.equal(f.counts().pauses, pausesBeforeOrdinaryReboots, "ordinary reboots do not replay update lifecycle");
});

test("full resource blockers never terminate jobs, PTYs or unknown processes", async (t) => {
	for (const kind of ["job", "terminal", "unknown-process", "transfer", "setup"]) {
		const f = await fixture(t);
		const end = f.admission.begin({ kind, id: "active" });
		await f.proposed();
		await f.service.accept("update");
		const p = await f.service.progress("update");
		assert.deepEqual(p.blockers, [{ kind, id: "active" }]);
		assert.equal(p.ready, false);
		await assert.rejects(f.service.armGui("update", target), /block/);
		end();
		assert.equal((await f.service.progress("update")).ready, true);
	}
});

test("crash checkpoints reload frozen, concurrent load shares promise", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	await f.service.accept("update");
	for (const phase of ["draining", "gui-installing", "gui-ready", "daemon-installing"]) {
		const s = f.create();
		const before = f.counts().pauses;
		const p = s.load();
		assert.equal(s.frozen, true);
		assert.equal(p, s.load());
		await p;
		assert.equal(s.snapshot()?.phase, phase);
		assert.equal(s.frozen, true);
		assert.equal(f.counts().pauses, before);
		if (phase === "draining") await s.armGui("update", target);
		if (phase === "gui-installing") await s.guiReady("update", receipt);
		if (phase === "gui-ready") await s.armDaemon("update");
	}
});

test("accept holds freeze across persistence and never pauses on save failure", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	const s = f.create(initial, async (_file, next) => {
		assert.equal(next.phase, "draining");
		assert.throws(() => f.admission.begin({ kind: "job", id: "race" }), /frozen/);
		throw new Error("disk failure");
	});
	await s.load();
	await assert.rejects(s.accept("update"), /disk failure/);
	assert.equal(s.frozen, true);
	assert.equal(f.counts().pauses, 0);
	await assert.rejects(s.cancel("update"), /unavailable/);
});

test("listener exceptions cannot fail saves; lost acknowledgement cannot retry intent", async (t) => {
	const f = await fixture(t);
	f.service.onChange(() => {
		throw new Error("observer");
	});
	await f.proposed();
	await f.service.accept("update");
	const s = f.create(initial, async (file, next) => {
		await durableJSON(file, next);
		throw new Error("lost acknowledgement");
	});
	await s.load();
	await assert.rejects(s.armGui("update", target), /acknowledgement/);
	await assert.rejects(s.armGui("update", target), /unavailable/);
	const reopened = f.create();
	await reopened.load();
	assert.equal(reopened.snapshot()?.phase, "gui-installing");
	await assert.rejects(reopened.armGui("update", target), /changed/);
	await assert.rejects(reopened.cancel("update"), /changed/);
});

test("release and resume failures freeze locally; durable authorization permits ordinary restart", async (t) => {
	for (const failure of ["resume", "release"]) {
		const f = await fixture(t);
		await f.proposed();
		await f.service.accept("update");
		if (failure === "resume") f.setFailResume(true);
		else f.setFailRelease(true);
		await assert.rejects(f.service.cancel("update"), /failed/);
		assert.equal(f.service.frozen, true);
		assert.equal((await f.record()).phase, "cancelled");
		assert.throws(() => f.admission.begin({ kind: "job", id: "blocked" }), /frozen/);
		f.setFailResume(false);
		f.setFailRelease(false);
		const recovered = f.create();
		await recovered.load();
		assert.equal(recovered.frozen, false);
		const terminal = f.create();
		await terminal.load();
		assert.equal(terminal.frozen, false);
	}
});

test("terminal save failure refreezes while retaining resuming checkpoint", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	await f.service.accept("update");
	const s = f.create(initial, async (file, next) => {
		if (next.phase === "cancelled") throw new Error("terminal disk failure");
		await durableJSON(file, next);
	});
	await s.load();
	await assert.rejects(s.cancel("update"), /disk failure/);
	assert.equal(s.frozen, true);
	assert.equal((await f.record()).phase, "resuming");
	assert.equal(f.counts().resumed, 0, "persistence failure must not resume any worker");
});

test("private bounded nofollow record load fails closed and never retries", async (t) => {
	for (const kind of ["json", "oversize", "public", "symlink", "hardlink", "phase", "tuple"]) {
		const f = await fixture(t);
		await f.proposed();
		const path = join(f.home, "live-update.json");
		if (kind === "json") await writeFile(path, "{");
		if (kind === "oversize") await writeFile(path, " ".repeat(256 * 1024 + 1));
		if (kind === "public") await chmod(path, 0o644);
		if (kind === "symlink") {
			await rm(path);
			await symlink("/absent", path);
		}
		if (kind === "hardlink") await link(path, join(f.home, "copy"));
		if (kind === "phase") await durableJSON(path, { ...(await f.record()), phase: "paused" });
		if (kind === "tuple")
			await durableJSON(path, {
				...(await f.record()),
				phase: "daemon-installing",
				initialBoot: "old",
				target,
				guiReceipt: { ...receipt, build: { ...target.build, node: "bad" } },
			});
		const s = f.create();
		const p = s.load();
		await assert.rejects(p);
		assert.equal(s.frozen, true);
		assert.equal(s.load(), p);
		await assert.rejects(s.propose("s", "p", "id", args), /unavailable/);
	}
});

test("resources attach once before loading; missing attachment fails closed", async (t) => {
	const f = await fixture(t);
	assert.throws(() => f.service.attach(new RuntimeResources([])), /once/);
	const s = new LiveUpdateService(
		f.home,
		{
			async origin() {
				return { identity: null };
			},
		},
		() => () => {},
		async () => {},
		{ runtime: initial, pauseForUpdate: () => ({ ready: true }) },
	);
	await assert.rejects(s.load(), /attached/);
	assert.equal(s.frozen, true);
});

test("unbundled startup loads retained freeze without inventing runtime identity", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	const create = () => {
		const s = new LiveUpdateService(
			f.home,
			{
				async origin() {
					return { identity: '["github.com","babariviere/pilot"]' };
				},
			},
			() => () => {},
			async () => {},
			{ pauseForUpdate: () => ({ ready: true }) },
		);
		s.attach(new RuntimeResources([]));
		return s;
	};
	const unbundled = create();
	await unbundled.load();
	await assert.rejects(unbundled.accept("update"), /identity is unavailable/);
	await f.service.accept("update");
	const recovered = create();
	await recovered.load();
	assert.equal(recovered.frozen, true);
	assert.equal(recovered.snapshot()?.phase, "draining");
	await recovered.cancel("update");
	assert.equal(recovered.frozen, false);
	await unbundled.close();
	await recovered.close();
});

test("GUI intent awaits every contributor and unknown errors block", async (t) => {
	const f = await fixture(t);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(release);
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let unknown = false;
	const resources = new RuntimeResources([
		new RuntimeAdmission(),
		{
			freezeAdmissions: () => () => {},
			async blockers() {
				entered();
				await gate;
				if (unknown) throw new Error("unconfirmed");
				return [];
			},
		},
	]);
	const service = new LiveUpdateService(
		f.home,
		{
			async origin() {
				return { identity: '["github.com","babariviere/pilot"]' };
			},
		},
		() => () => {},
		async () => {},
		{ runtime: initial, pauseForUpdate: () => ({ ready: true }) },
	);
	service.attach(resources);
	await service.load();
	await service.propose("session", "project", "update", args);
	await service.accept("update");
	const arm = service.armGui("update", target);
	await started;
	assert.equal((await f.record()).phase, "draining");
	unknown = true;
	release();
	await assert.rejects(arm, /block/);
	assert.equal(service.snapshot()?.phase, "draining");
	await service.close();
});

test("completed resuming recovery cannot release a mismatched runtime", async (t) => {
	const f = await fixture(t);
	await f.proposed();
	await f.service.accept("update");
	await f.service.armGui("update", target);
	await f.service.guiReady("update", receipt);
	await f.service.armDaemon("update");
	const updated = f.create({ ...target, boot: "new" }, async (file, next) => {
		if (next.phase === "completed") throw new Error("terminal failure");
		await durableJSON(file, next);
	});
	await updated.load();
	await assert.rejects(updated.complete("update"), /terminal failure/);
	assert.equal((await f.record()).phase, "resuming");
	const mismatch = f.create();
	await mismatch.load();
	const before = f.counts().resumed;
	await assert.rejects(mismatch.progress("update"), /identity/);
	assert.equal(mismatch.frozen, true);
	assert.equal(f.counts().resumed, before);
	const recovered = f.create({ ...target, boot: "another-new" });
	await recovered.load();
	assert.equal((await recovered.progress("update")).update.phase, "completed");
});
