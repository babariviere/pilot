import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import release from "../../../package.json" with { type: "json" };
import { launchRuntime } from "./runtime-launch.ts";
import { inspectRuntime, type RuntimeBuild } from "./runtime-owner.ts";

const build: RuntimeBuild = {
	schema: 1,
	source: "a".repeat(40),
	version: release.version,
	protocol: 1,
	platform: process.platform,
	arch: process.arch,
	node: process.versions.node,
};
async function fixture(t: { after(fn: () => Promise<void>): void }, mode = "ready") {
	const root = await mkdtemp(join(tmpdir(), "pilot-launch-faux-")),
		home = join(root, "profile");
	const socket = createServer();
	await new Promise<void>((ok) => socket.listen(0, "127.0.0.1", ok));
	const port = (socket.address() as { port: number }).port;
	await new Promise<void>((ok) => socket.close(() => ok()));
	const entry = join(root, "faux.mjs");
	await writeFile(
		entry,
		`
import { ownRuntime } from ${JSON.stringify(new URL("./runtime-owner.ts", import.meta.url).href)};
import { activateRuntime } from ${JSON.stringify(new URL("./runtime-bootstrap.ts", import.meta.url).href)};
import { daemonHello } from ${JSON.stringify(new URL("./hello.ts", import.meta.url).href)};
import { loadConfig } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
import { writeFile } from 'node:fs/promises';
const home=process.env.PILOT_HOME, port=Number(process.env.PILOT_PORT);
const owner=await ownRuntime(home,port,true,${JSON.stringify(build)});
const config=loadConfig();
await writeFile(home+'/policy',JSON.stringify({scope:config.modelScopeReadOnly===true,mcp:config.mcpSetupReadOnly===true,retentionOff:config.workspaceRetentionMs===Number.POSITIVE_INFINITY,park:config.idleParkMs}),{mode:0o600});
if(process.env.MODE==='silent') { await new Promise(()=>setInterval(()=>{},1000)); }
await activateRuntime(owner);
await writeFile(home+'/activated','explicit startup commit',{mode:0o600});
if(process.env.MODE==='crash')process.exit(2);
if(process.env.MODE==='finite') { setTimeout(async()=>{await owner.close();await writeFile(home+'/faux-exited','natural fixture exit');process.exit(0);},3000); await new Promise(()=>{}); }
if(process.env.MODE==='starting') { await new Promise(()=>setInterval(()=>{},1000)); }
owner.install((req,res)=>res.end('faux only'));
owner.ready(await daemonHello(home,{independentExecution:true,coordinatorIsolation:false,powerManagement:false,systemSleepEvents:false,swiftUIArtifacts:false}));
// These diagnostics must not be retained by the launcher or its caller.
process.stdout.write('private faux log'.repeat(100000));
process.stderr.write('private faux error'.repeat(100000));
`,
	);
	const children: ChildProcess[] = [];
	t.after(async () => {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) {
				if (child.stdin) {
					child.stdin.end();
					await new Promise<void>((ok) => {
						const timer = setTimeout(ok, 2000);
						child.once("exit", () => {
							clearTimeout(timer);
							ok();
						});
					});
					if (child.exitCode !== null || child.signalCode !== null) continue;
				}
				const exited = new Promise<void>((ok) => child.once("exit", () => ok()));
				child.kill("SIGKILL");
				await exited;
			}
		await rm(root, { recursive: true, force: true });
	});
	return {
		home,
		port,
		build,
		entry,
		env: { MODE: mode, HOME: root },
		onSpawn: (child: ChildProcess) => {
			children.push(child);
		},
		children,
	};
}
test("configured child retains scope/MCP read-only and no-retention/idle policy", async (t) => {
	const f = await fixture(t);
	await launchRuntime({
		...f,
		env: {
			...f.env,
			PILOT_MODEL_SCOPE_READ_ONLY: "1",
			PILOT_MCP_SETUP_READ_ONLY: "1",
			PILOT_WORKSPACE_RETENTION_DAYS: "0",
			PILOT_IDLE_PARK_MS: "1234",
		},
	});
	assert.deepEqual(JSON.parse(await readFile(join(f.home, "policy"), "utf8")), {
		scope: true,
		mcp: true,
		retentionOff: true,
		park: 1234,
	});
});
async function until(check: () => Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("bounded faux launcher wait");
		await new Promise((ok) => setTimeout(ok, 10));
	}
}
async function servingFixture(f: Awaited<ReturnType<typeof fixture>>) {
	const entry = join(f.env.HOME, "launcher.mjs");
	await writeFile(
		entry,
		`import { serveLauncher } from ${JSON.stringify(new URL("./runtime-launch.ts", import.meta.url).href)}; await serveLauncher({home:${JSON.stringify(f.home)},port:${f.port},build:${JSON.stringify(build)},entry:${JSON.stringify(f.entry)},env:process.env});`,
	);
	const helper = spawn(process.execPath, [entry], { env: f.env, stdio: ["pipe", "pipe", "ignore"] });
	f.children.push(helper);
	let output = "";
	helper.stdout.on("data", (chunk) => {
		output = (output + chunk).slice(0, 4097);
	});
	const exited = new Promise<number | null>((ok) => helper.once("exit", ok));
	return {
		helper,
		exited,
		reply: () => {
			assert.ok(Buffer.byteLength(output) <= 4096);
			return JSON.parse(output);
		},
	};
}
test("actual launcher EOF reports preactivation nested-child reap before helper exit", async (t) => {
	const f = await fixture(t, "silent"),
		serving = await servingFixture(f);
	await until(async () => {
		try {
			return (await inspectRuntime(f.home, f.port, build)) === "starting";
		} catch {
			return false;
		}
	});
	serving.helper.stdin.end();
	assert.equal(await serving.exited, 1);
	assert.equal(serving.reply().cleanup, "preactivation-reaped");
	assert.equal(await inspectRuntime(f.home, f.port, build), "idle");
	await assert.rejects(readFile(join(f.home, "activated")), { code: "ENOENT" });
});
test("actual launcher EOF reports possible activation and preserves the nested daemon", async (t) => {
	const f = await fixture(t, "finite"),
		serving = await servingFixture(f);
	await until(async () =>
		readFile(join(f.home, "activated")).then(
			() => true,
			() => false,
		),
	);
	serving.helper.stdin.end();
	assert.equal(await serving.exited, 1);
	assert.equal(serving.reply().cleanup, "activation-possible");
	assert.equal(await inspectRuntime(f.home, f.port, build), "starting");
	await until(async () =>
		readFile(join(f.home, "faux-exited")).then(
			() => true,
			() => false,
		),
	);
	assert.equal(await inspectRuntime(f.home, f.port, build), "idle");
});
test("cold faux startup and exact existing-owner reuse need no PATH, repo cwd or duplicate process", async (t) => {
	const f = await fixture(t);
	assert.equal(await launchRuntime(f), "started");
	assert.equal(f.children.length, 1);
	assert.equal(await inspectRuntime(f.home, f.port, build), "ready");
	assert.equal(await launchRuntime({ ...f, entry: "/missing/must-not-spawn" }), "reused");
	assert.equal(f.children.length, 1);
	assert.equal(await readFile(join(f.home, "activated"), "utf8"), "explicit startup commit");
});
test("existing incompatible owner never spawns, signals or changes retained work", async (t) => {
	const f = await fixture(t);
	await launchRuntime(f);
	await writeFile(join(f.home, "retained-work"), "unchanged");
	await assert.rejects(launchRuntime({ ...f, build: { ...build, source: "b".repeat(40) } }), /runtime_incompatible/);
	assert.equal(f.children.length, 1);
	assert.equal(f.children[0]!.signalCode, null);
	assert.equal(await readFile(join(f.home, "retained-work"), "utf8"), "unchanged");
});
test("ownership timeout reaps only the exact preactivation child and releases its lease", async (t) => {
	const f = await fixture(t, "silent");
	await assert.rejects(launchRuntime({ ...f, timeout: 500 }), /runtime_ownership_timeout/);
	assert.equal(f.children[0]!.signalCode, "SIGKILL");
	assert.equal(await inspectRuntime(f.home, f.port, build), "idle");
	await assert.rejects(readFile(join(f.home, "activated")), { code: "ENOENT" });
});
test("postactivation readiness timeout preserves the owned daemon rather than killing restored work", async (t) => {
	const f = await fixture(t, "starting");
	await assert.rejects(launchRuntime({ ...f, timeout: 500 }), /runtime_startup_unconfirmed/);
	assert.equal(f.children[0]!.signalCode, null);
	assert.equal(await inspectRuntime(f.home, f.port, build), "starting");
	assert.equal(await readFile(join(f.home, "activated"), "utf8"), "explicit startup commit");
	await assert.rejects(launchRuntime({ ...f, timeout: 100 }), /runtime_owner_still_starting/);
	assert.equal(f.children.length, 1);
});
test("activation crash is a failure, not a ready result or stale-PID cleanup request", async (t) => {
	const f = await fixture(t, "crash");
	await assert.rejects(launchRuntime(f));
	assert.equal(await inspectRuntime(f.home, f.port, build), "idle");
});
test("preactivation cancellation cannot activate work; pre-canceled calls spawn nothing", async (t) => {
	const f = await fixture(t, "silent"),
		controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 250);
	try {
		await assert.rejects(launchRuntime({ ...f, signal: controller.signal }), /runtime_startup_canceled/);
	} finally {
		clearTimeout(timer);
	}
	assert.equal(f.children[0]!.signalCode, "SIGKILL");
	await assert.rejects(readFile(join(f.home, "activated")), { code: "ENOENT" });
	await assert.rejects(launchRuntime({ ...f, signal: controller.signal }), /runtime_startup_canceled/);
	assert.equal(f.children.length, 1);
});
test("missing entry returns a bounded launch failure without loading the real daemon", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		launchRuntime({ ...f, entry: fileURLToPath(new URL("./does-not-exist.ts", import.meta.url)) }),
		/runtime_launch_failed/,
	);
	assert.equal(f.children.length, 1);
});
test("postactivation cancellation preserves the live owned daemon and does not spawn a replacement", async (t) => {
	const f = await fixture(t, "starting"),
		controller = new AbortController();
	const running = launchRuntime({ ...f, signal: controller.signal });
	const deadline = Date.now() + 2000;
	while (true) {
		try {
			await readFile(join(f.home, "activated"));
			break;
		} catch {
			if (Date.now() >= deadline) throw new Error("faux activation deadline");
			await new Promise((ok) => setTimeout(ok, 10));
		}
	}
	controller.abort();
	await assert.rejects(running, /runtime_startup_canceled/);
	assert.equal(f.children[0]!.signalCode, null);
	assert.equal(await inspectRuntime(f.home, f.port, build), "starting");
	assert.equal(f.children.length, 1);
});
test("a second real process cannot acquire the held lease, even on a different port", async (t) => {
	const f = await fixture(t);
	await launchRuntime(f);
	const child = spawn(process.execPath, [f.entry], {
		env: { ...f.env, PILOT_HOME: f.home, PILOT_PORT: String(f.port + 1) },
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	f.children.push(child);
	let requestedActivation = false;
	child.on("message", () => {
		requestedActivation = true;
	});
	const code = await new Promise<number | null>((ok) => child.once("exit", ok));
	assert.equal(code, 1);
	assert.equal(requestedActivation, false);
	assert.equal(await inspectRuntime(f.home, f.port, build), "ready");
});
test("parent IPC disconnect before activation closes the exact child without importing work", async (t) => {
	const f = await fixture(t);
	const child = spawn(process.execPath, [f.entry], {
		env: { ...f.env, PILOT_HOME: f.home, PILOT_PORT: String(f.port) },
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	f.children.push(child);
	await new Promise<void>((ok) =>
		child.once("message", () => {
			child.disconnect();
			ok();
		}),
	);
	await new Promise<void>((ok) => child.once("exit", () => ok()));
	await assert.rejects(readFile(join(f.home, "activated")), { code: "ENOENT" });
	assert.equal(await inspectRuntime(f.home, f.port, build), "idle");
});
