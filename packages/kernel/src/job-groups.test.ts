import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { groupAbsent, OwnedJobGroups } from "./job-groups.ts";
import { JobHistory } from "./job-history.ts";

async function until(condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await condition())) {
		assert.ok(Date.now() < end, "exact owned process fixture deadline");
		await delay(10);
	}
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "job-groups-test-"));
	const directory = join(root, "groups");
	const groups = await OwnedJobGroups.open("test-owner", directory);
	let wrap!: (value: unknown) => void;
	groups.native({
		events: {
			on: (_name: string, handler: typeof wrap) => {
				wrap = handler;
			},
		},
	} as ExtensionAPI);
	const clients: { child: ChildProcess; closed: Promise<void> }[] = [];
	const releases: (() => void)[] = [];
	t.after(async () => {
		for (const release of releases) release();
		try {
			await groups.close().catch(() => {});
			await Promise.all(clients.map(({ closed }) => closed));
			// Only groups learned from this exact live fixture, never saved/reopened IDs.
			for (const value of groups.evidence()) if (value.pgid) await until(() => groupAbsent(value.pgid!));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const launch = async (command: string, afterSpawn?: () => Promise<void>) => {
		const id = randomUUID();
		return groups.execute(id, async () => {
			const request: { command: string; result?: Promise<string> } = { command };
			wrap(request);
			const launcher = await request.result!;
			const child = spawn("bash", ["-c", launcher], { cwd: root, detached: true, stdio: "ignore" });
			const closed = new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", () => resolve());
			});
			clients.push({ child, closed });
			await afterSpawn?.();
			return { structuredContent: { id } };
		});
	};
	return { root, directory, groups, launch, clients, releases };
}

test("real natural shell exit keeps exact group ownership until resistant orphan drain", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const ready = join(f.root, "ready");
	const heartbeat = join(f.root, "heartbeat");
	const script = join(f.root, "resistant.cjs");
	await writeFile(
		script,
		`const fs=require('node:fs'); process.on('SIGTERM',()=>{});
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'),10);
setTimeout(()=>process.exit(),12000);`,
	);
	await f.launch(
		`${JSON.stringify(process.execPath)} ${JSON.stringify(script)} & until test -f ${JSON.stringify(ready)}; do sleep 0.01; done`,
	);
	await f.clients[0]!.closed; // Original provider leader has already exited.
	const value = f.groups.evidence()[0]!;
	assert.equal(value.scope, "process-group");
	assert.equal(value.shellExit, 0);
	assert.ok(value.pgid);
	assert.equal(groupAbsent(value.pgid), false);
	const before = await readFile(heartbeat, "utf8").catch(() => "");
	await until(async () => (await readFile(heartbeat, "utf8").catch(() => "")).length > before.length);
	await f.groups.drain();
	assert.equal(groupAbsent(value.pgid), true);
	assert.equal(f.groups.evidence()[0]!.state, "group-empty");
	const saved = JSON.parse(await readFile(join(f.directory, `${value.admission}.json`), "utf8"));
	assert.deepEqual(saved, f.groups.evidence()[0]);
	assert.equal("subtreeSafe" in saved, false);
	const reopened = await OwnedJobGroups.open("test-owner", f.directory);
	await reopened.drain(); // Read-only receipt recovery, no numeric PID signalling.
	assert.deepEqual(reopened.evidence(), [saved]);
});

test("pre-stopped provider leader cannot cancel its resistant group's escalation", { timeout: 20_000 }, async (t) => {
	const f = await fixture(t);
	const ready = join(f.root, "ready");
	await f.launch(
		`${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(),12000);`)} & wait`,
	);
	await until(async () => (await readFile(ready, "utf8").catch(() => "")) === "ready");
	const pgid = f.groups.evidence()[0]!.pgid!;
	f.clients[0]!.child.kill("SIGTERM"); // Exact still-live ChildProcess, not a retained PID.
	await f.clients[0]!.closed;
	await f.groups.drain();
	assert.equal(groupAbsent(pgid), true);
	assert.equal(f.groups.evidence()[0]!.state, "group-empty");
});

test("drain fences new starts and joins an entered admission gate before group release", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	let entered!: () => void;
	let release!: () => void;
	const admitted = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.releases.push(release);
	const effect = join(f.root, "effect");
	const starting = f.launch(`printf unsafe > ${JSON.stringify(effect)}`, async () => {
		entered();
		await gate;
	});
	await admitted;
	let settled = false;
	const draining = f.groups.drain().finally(() => {
		settled = true;
	});
	await assert.rejects(f.launch("true"), /unavailable/);
	assert.equal(settled, false);
	release();
	await starting;
	await draining;
	await assert.rejects(readFile(effect), { code: "ENOENT" });
	assert.equal(f.groups.evidence()[0]!.state, "group-empty");
});

test("unproven reopened admissions and malformed ownership never regain kill authority", async (t) => {
	const f = await fixture(t);
	await f.groups.execute("unsupported-provider", async () => ({ structuredContent: { id: "legacy" } }));
	const reopened = await OwnedJobGroups.open("test-owner", f.directory);
	await assert.rejects(reopened.drain(), /ownership is unknown/);
	await writeFile(join(f.directory, `${randomUUID()}.json`), '{"schema":1,"scope":"subtree-safe"}');
	const malformed = await OwnedJobGroups.open("test-owner", f.directory);
	await assert.rejects(
		malformed.execute("blocked", async () => assert.fail("must not enter")),
		/unavailable/,
	);
	await assert.rejects(malformed.drain(), /ownership is unknown/);
});

test("lost provider result drains its gated group without inventing job ownership", { timeout: 20_000 }, async (t) => {
	const f = await fixture(t);
	const effect = join(f.root, "effect");
	await assert.rejects(
		f.launch(`printf unsafe > ${JSON.stringify(effect)}`, async () => {
			throw new Error("lost provider result");
		}),
		/lost provider result/,
	);
	await assert.rejects(f.groups.drain(), /result identity is unknown/);
	await assert.rejects(readFile(effect), { code: "ENOENT" });
	const value = f.groups.evidence()[0]!;
	assert.equal(value.state, "unknown");
	assert.equal(value.jobId, undefined);
	assert.equal(groupAbsent(value.pgid!), true);
	const reopened = await OwnedJobGroups.open("test-owner", f.directory);
	await assert.rejects(reopened.drain(), /ownership is unknown/);
});

test("failed admission evidence blocks provider entry", async (t) => {
	const f = await fixture(t);
	await rm(f.directory, { recursive: true });
	await writeFile(f.directory, "not a directory");
	let entered = false;
	await assert.rejects(
		f.groups.execute("failed-write", async () => {
			entered = true;
			return { structuredContent: { id: "must-not-enter" } };
		}),
	);
	assert.equal(entered, false);
	assert.equal(f.groups.evidence()[0]!.state, "intent");
});

test("failed drain persistence still joins live-anchor fallback without an exit receipt", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const ready = join(f.root, "ready");
	await f.launch(
		`exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(),15000);`)}`,
	);
	await until(async () => (await readFile(ready, "utf8").catch(() => "")) === "ready");
	const pgid = f.groups.evidence()[0]!.pgid!;
	await rm(f.directory, { recursive: true });
	await writeFile(f.directory, "storage failed");
	await assert.rejects(f.groups.drain());
	await assert.rejects(f.groups.close());
	assert.equal(groupAbsent(pgid), true);
	assert.notEqual(f.groups.evidence()[0]!.state, "group-empty");
});

test("interrupted kernel self-cleans its live group but cannot recover an exit receipt", {
	timeout: 25_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "job-group-interrupted-"));
	const directory = join(root, "groups");
	const ready = join(root, "ready");
	const source = `
import {spawn} from 'node:child_process';
import {OwnedJobGroups} from ${JSON.stringify(new URL("./job-groups.ts", import.meta.url).href)};
import {JobHistory} from ${JSON.stringify(new URL("./job-history.ts", import.meta.url).href)};
const groups=await OwnedJobGroups.open('interrupted-owner',${JSON.stringify(directory)});
const history=await JobHistory.open(${JSON.stringify(join(root, "history"))},true); await history.admit();
let wrap; groups.native({events:{on:(_name,handler)=>{wrap=handler;}}});
process.on('message',()=>process.exit(0));
process.on('disconnect',()=>process.exit(0));
await groups.execute('interrupted-start',async()=>{
 const request={command:${JSON.stringify(`exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},100);setTimeout(()=>process.exit(),15000);`)}`)}};
 wrap(request); const command=await request.result;
 const client=spawn('bash',['-c',command],{cwd:${JSON.stringify(root)},detached:true,stdio:'ignore'});
 process.send({client:client.pid}); return {structuredContent:{id:'interrupted-job'}};
});`;
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const runner = spawn(process.execPath, ["--input-type=module", "-e", source], {
		env,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let output = "";
	runner.stderr!.on("data", (chunk) => {
		output += chunk;
	});
	let client: number | undefined;
	runner.on("message", (message) => {
		client = (message as { client: number }).client;
	});
	const closed = new Promise<void>((resolve, reject) => {
		runner.once("error", reject);
		runner.once("close", (code) => (code === 0 ? resolve() : reject(new Error(output))));
	});
	let pgid: number | undefined;
	t.after(async () => {
		if (runner.connected) runner.send({ exit: true });
		await closed;
		if (pgid) await until(() => groupAbsent(pgid!));
		if (client) await until(() => groupAbsent(client!));
		await rm(root, { recursive: true, force: true });
	});
	await until(async () => (await readFile(ready, "utf8").catch(() => "")) === "ready");
	const [name] = await readdir(directory);
	const before = JSON.parse(await readFile(join(directory, name!), "utf8"));
	pgid = before.pgid;
	assert.equal(before.state, "owned");
	runner.send({ exit: true }); // Simulated kernel loss, not graceful checkpoint.
	await closed;
	await until(() => groupAbsent(pgid!));
	const reopened = await OwnedJobGroups.open("interrupted-owner", directory);
	await assert.rejects(reopened.drain(), /ownership is unknown/);
	assert.equal(reopened.evidence()[0]!.state, "owned", "absence now is not a historical exit receipt");
	const history = await JobHistory.open(join(root, "history"));
	assert.throws(() => history.assertClear(), /descendant exit/);
});

test("group absence refuses invalid and permission-denied identities", (t) => {
	for (const pgid of [0, -1, 1, NaN, 1.1]) assert.throws(() => groupAbsent(pgid), /Invalid/);
	const signals: unknown[] = [];
	t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
		signals.push([pid, signal]);
		throw Object.assign(new Error("denied"), { code: "EPERM" });
	});
	assert.equal(groupAbsent(123456), false);
	assert.deepEqual(signals, [[-123456, 0]], "only a null inspection signal, never a stale group kill");
});
