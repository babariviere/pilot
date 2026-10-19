import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand } from "@pilot/kernel";
import type { DaemonHello } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";
import { RuntimeMaintenance } from "./runtime-maintenance.ts";
import { type RuntimeUpdateJournal, readUpdate, updatePath, writeUpdate } from "./runtime-update-journal.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, "condition did not settle");
		await delay(5);
	}
}
async function fixture(t: TestContext) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-maintenance-")));
	const hello = { daemonId: randomUUID(), lineageId: randomUUID() } as DaemonHello;
	const journal: RuntimeUpdateJournal = {
		schema: 1,
		id: randomUUID(),
		version: "1.40.0",
		revision: 1,
		phase: "draining",
		blockers: [],
		daemonId: hello.daemonId,
		lineageId: hello.lineageId!,
		archive: "digest",
		manifest: "signed",
		signature: "signature",
		publicKey: "pinned",
		from: "/old",
		to: "/new",
		oldUnit: "old",
		newUnit: "new",
	};
	await writeUpdate(home, journal);
	const commands: KernelCommand[] = [],
		opened: string[] = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker: (spec, report) => {
			opened.push(spec.sessionId);
			return {
				ready: Promise.resolve(),
				state: "idle",
				busy: false,
				jobs: async () => [],
				hasChildren: async () => false,
				send: (command) => {
					commands.push(command);
					if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
				},
				request: async () => {},
				close: async () => {},
			};
		},
	});
	const identity = { bootId: randomUUID(), pid: 12, start: "22" };
	const maintenance = new RuntimeMaintenance(home, hello, sessions, async () => identity);
	const transfers = new RuntimeAdmission();
	await maintenance.load();
	maintenance.bind(new RuntimeResources([sessions, transfers]));
	t.after(async () => {
		maintenance.close();
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	return { home, hello, journal, sessions, maintenance, transfers, opened, commands, identity };
}

test("startup loads metadata while maintenance fences recovery, then resumes the original saved input", async (t) => {
	const f = await fixture(t),
		id = randomUUID();
	await mkdir(join(f.home, "sessions", id), { recursive: true });
	await writeFile(
		join(f.home, "sessions", id, "meta.json"),
		JSON.stringify({
			id,
			cwd: f.home,
			title: "Saved chat",
			createdAt: 1,
			updatedAt: 1,
			working: false,
			updatePaused: true,
			createOperationId: "original-operation",
		}),
	);
	await f.sessions.load(true);
	assert.deepEqual(f.opened, []);
	assert.equal(f.maintenance.frozen, true);
	await assert.rejects(f.sessions.spawn({ cwd: f.home, message: "not admitted" }), /update|paused/);
	assert.throws(() => f.transfers.begin({ kind: "download", id: "new" }), /frozen/);
	await writeUpdate(f.home, { ...f.journal, phase: "completed", revision: 2 });
	await until(() => f.opened.includes(id));
	assert.equal(
		f.commands.some((command) => command.type === "input" || command.type === "abort"),
		false,
	);
	assert.equal(f.sessions.get(id)?.id, id);
});

test("legacy expiry cannot reopen transaction-owned tools; waiting releases holds so children can finish", async (t) => {
	const f = await fixture(t);
	await f.sessions.load(true);
	const internal = f.sessions as unknown as { resumeAfterUpdate(): void };
	internal.resumeAfterUpdate();
	assert.equal(f.maintenance.frozen, true);
	assert.throws(() => f.transfers.begin({ kind: "transfer", id: "new" }), /frozen/);
	await writeUpdate(f.home, {
		...f.journal,
		phase: "waiting",
		revision: 2,
		blockers: [{ kind: "child-process", id: "child" }],
	});
	await until(() => !f.maintenance.frozen);
	const end = f.transfers.begin({ kind: "transfer", id: "allowed" });
	end();
});

test("a transfer admitted before freezing blocks proof through final cleanup", async (t) => {
	const f = await fixture(t);
	await f.sessions.load(true);
	await writeUpdate(f.home, { ...f.journal, phase: "waiting", revision: 2 });
	await until(() => !f.maintenance.frozen);
	const finish = f.transfers.begin({ kind: "download", id: "active" });
	await writeUpdate(f.home, { ...f.journal, phase: "draining", revision: 3 });
	// A watcher refresh that read the waiting journal before this write would release inspect's fence when it
	// finishes, and inspect would correctly reject its proof. Let the watcher observe draining first.
	await until(() => f.maintenance.frozen);
	await (f.maintenance as unknown as { refreshing?: Promise<void> }).refreshing;
	const proof = await f.maintenance.inspect(f.journal.id);
	assert.equal(proof.ready, false);
	assert.ok(proof.blockers.some((blocker) => blocker.kind === "download"));
	finish();
	assert.equal((await f.maintenance.inspect(f.journal.id)).ready, true);
});

test("commit rejects stale PID/start identity and cancellation is only a durable request", async (t) => {
	const f = await fixture(t);
	await f.sessions.load(true);
	await writeUpdate(f.home, { ...f.journal, phase: "ready", revision: 2, process: { ...f.identity, start: "old" } });
	await assert.rejects(f.maintenance.inspect(f.journal.id, true), /process changed/);
	assert.deepEqual(await f.maintenance.cancel(f.journal.id), { id: f.journal.id, requested: true });
	assert.equal((await readUpdate(f.home))?.phase, "ready");
	await writeUpdate(f.home, { ...f.journal, phase: "stopping", revision: 3 });
	await assert.rejects(f.maintenance.cancel(f.journal.id), /no longer/);
});

async function unfrozenInspectionFixture(t: TestContext) {
	const f = await fixture(t);
	await f.sessions.load(true);
	await writeUpdate(f.home, { ...f.journal, phase: "waiting", revision: 2 });
	await until(() => !f.maintenance.frozen);
	// Isolate inspection's own error handling. Otherwise the watcher can independently
	// acquire a hold and hide a fail-open inspection path behind an already-frozen owner.
	const internal = f.maintenance as unknown as { watcher: { close(): void }; refreshing?: Promise<void> };
	internal.watcher.close();
	// Closing fs.watch does not cancel a refresh already reading the waiting journal.
	// Drain it before mutating the file, or its stale read can release inspect's new fence.
	await internal.refreshing;
	assert.equal(f.maintenance.frozen, false);
	return f;
}

test("inspection errors retain their new fence for malformed and unsafe-permission journals", async (t) => {
	for (const failure of ["corrupt", "permissions", "unreadable"] as const) {
		await t.test(failure, { skip: failure === "unreadable" && process.getuid?.() === 0 }, async (t) => {
			const f = await unfrozenInspectionFixture(t);
			if (failure === "corrupt") await writeFile(updatePath(f.home), "{broken");
			else await chmod(updatePath(f.home), failure === "unreadable" ? 0o000 : 0o644);
			try {
				await assert.rejects(f.maintenance.inspect(f.journal.id));
				assert.equal(f.maintenance.frozen, true);
				assert.throws(() => f.transfers.begin({ kind: "download", id: "refused" }), /frozen/);
				await assert.rejects(f.sessions.spawn({ cwd: f.home, message: "refused" }), /update|paused/);
			} finally {
				await chmod(updatePath(f.home), 0o600);
			}
		});
	}
});

test("journal corruption, permission loss and disappearance during inspection cannot resume tools", async (t) => {
	for (const failure of ["corrupt", "permissions", "missing"] as const) {
		await t.test(failure, async (t) => {
			const f = await unfrozenInspectionFixture(t);
			await writeUpdate(f.home, { ...f.journal, phase: "draining", revision: 3 });
			f.maintenance.bind(
				new RuntimeResources([
					f.sessions,
					f.transfers,
					{
						freezeAdmissions: () => () => {},
						blockers: async () => {
							if (failure === "corrupt") await writeFile(updatePath(f.home), "{broken");
							else if (failure === "permissions") await chmod(updatePath(f.home), 0o644);
							else await unlink(updatePath(f.home));
							return [];
						},
					},
				]),
			);
			const resume = t.mock.method(f.sessions, "resumeMaintenance");
			await assert.rejects(f.maintenance.inspect(f.journal.id));
			assert.equal(f.maintenance.frozen, true);
			assert.equal(resume.mock.callCount(), 0);
			assert.throws(() => f.transfers.begin({ kind: "transfer", id: "refused" }), /frozen/);
		});
	}
});

test("a genuinely absent intent releases a rejected request's temporary fence", async (t) => {
	const f = await unfrozenInspectionFixture(t);
	await unlink(updatePath(f.home));
	await assert.rejects(f.maintenance.inspect(f.journal.id), /intent does not match/);
	assert.equal(f.maintenance.frozen, false);
	const release = f.transfers.begin({ kind: "download", id: "permitted" });
	release();
});

test("the journal watcher also retains a known maintenance owner when its intent disappears", async (t) => {
	const f = await fixture(t);
	await f.sessions.load(true);
	const resume = t.mock.method(f.sessions, "resumeMaintenance");
	await unlink(updatePath(f.home));
	await (f.maintenance as unknown as { refresh(): Promise<void> }).refresh();
	assert.equal(f.maintenance.frozen, true);
	assert.equal(resume.mock.callCount(), 0);
});

test("actual HTTP download admission remains a blocker after disconnect until asynchronous work settles", async (t) => {
	const f = await fixture(t);
	await f.sessions.load(true);
	await writeUpdate(f.home, { ...f.journal, phase: "waiting", revision: 2 });
	await until(() => !f.maintenance.frozen);
	let entered = false,
		finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	t.mock.method(f.sessions, "resolveArtifact", async () => {
		entered = true;
		await pending;
		throw new Error("fixture done");
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		new ProjectStore(f.home),
		new ModelCatalog(f.home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		f.maintenance,
	);
	t.after(async () => {
		finish();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const download = request(`${base}/api/artifacts/fixture`, { method: "GET" });
	download.on("error", () => {});
	download.end();
	await until(() => entered);
	download.destroy();
	await writeUpdate(f.home, { ...f.journal, phase: "draining", revision: 3 });
	// A refresh still reading waiting can release inspect's new fence. Let the watcher
	// observe draining and settle before asking for a proof, as in the transfer fixture.
	await until(() => f.maintenance.frozen);
	await (f.maintenance as unknown as { refreshing?: Promise<void> }).refreshing;
	let proof = await f.maintenance.inspect(f.journal.id);
	assert.ok(proof.blockers.some((blocker) => blocker.kind === "download"));
	const refused = await fetch(`${base}/api/artifacts/not-admitted`);
	assert.equal(refused.status, 503);
	await refused.arrayBuffer();
	finish();
	await until(async () => {
		proof = await f.maintenance.inspect(f.journal.id);
		return proof.ready;
	});
});
