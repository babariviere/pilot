import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import { inspectRuntime, OWNER_FILE, type RuntimeBuild } from "./runtime-owner.ts";

const build: RuntimeBuild = {
	schema: 1,
	source: "a".repeat(40),
	version: release.version,
	protocol: 1,
	platform: process.platform,
	arch: process.arch,
	node: process.versions.node,
};

test("isolated daemon stop/start, exact hello, rollback and cold update fence", { timeout: 45_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "day-daemon-handoff-"));
	const home = join(root, "profile");
	await mkdir(join(root, "agent"), { mode: 0o700 });
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	const children: ChildProcess[] = [];
	t.after(async () => {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
		await rm(root, { recursive: true, force: true });
	});
	async function launch(selected = build, seed = "") {
		const child = fork(
			new URL("./testing/day-handoff-daemon.ts", import.meta.url),
			[home, String(port), JSON.stringify(selected), seed],
			{
				execArgv: [],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: { PATH: process.env.PATH, HOME: root, PILOT_AGENT_DIR: join(root, "agent"), XDG_CONFIG_HOME: root },
			},
		);
		children.push(child);
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		const ready = await Promise.race([
			once(child, "message").then(([message]) => message),
			once(child, "exit").then(([code]) => {
				throw new Error(`Disposable daemon exited ${code}: ${stderr}`);
			}),
		]);
		return { child, ready };
	}
	async function close(child: ChildProcess) {
		const exited = once(child, "exit");
		child.send("close");
		await exited;
		assert.equal(child.exitCode, 0, "joined the exact owned daemon, not a PID from disk");
	}
	async function native(action: string, receipt: unknown) {
		const owner = JSON.parse(await readFile(join(home, ".daemon-owner.json"), "utf8"));
		const raw = JSON.stringify({ boot: owner.boot, nonce: randomBytes(32).toString("hex"), action, receipt });
		const mac = (body: string) =>
			createHmac("sha256", Buffer.from(owner.secret, "hex")).update(`update/v1\n${body}`).digest("hex");
		const response = await fetch(`http://127.0.0.1:${port}/__pilot_runtime_update/v1`, {
			method: "POST",
			headers: { "x-pilot-update-proof": mac(raw) },
			body: raw,
		});
		if (response.status !== 200) return { status: response.status, value: null };
		const envelope = (await response.json()) as { body: string; mac: string };
		assert.equal(envelope.mac, mac(envelope.body));
		return { status: 200, value: JSON.parse(envelope.body).receipt };
	}
	const initial = await launch(build, "seed");
	assert.equal(await inspectRuntime(home, port, build, join(home, "fixture-runtime")), "ready");
	const inode = (await stat(join(home, OWNER_FILE))).ino;
	await assert.rejects(launch(), /runtime_profile_owned/, "second daemon cannot acquire the same profile");
	const draft = "  unsent 👩🏽‍💻\n漢字  ";
	await writeFile(join(home, "saved-window"), draft, { mode: 0o600 });
	const identity = {
		hostId: "daemon",
		daemonId: initial.ready.hello.daemonId,
		lineageId: initial.ready.hello.lineageId,
	};
	function operation(kind: string, value: unknown, sequence: number): DurableOperation {
		const payload = canonicalJSON(value);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId,
			sequence,
			origin: identity,
			destination: identity,
			targetId: "global-update",
			kind,
			payload,
			payloadHash: payloadHash(payload),
		};
	}
	const producerId = randomUUID();
	const prepare = operation(
		"global-update-prepare",
		{
			captureHash: payloadHash(draft),
			app: { source: build.source, build: "1000.1" },
			replacement: { runtimeRoot: join(home, "fixture-runtime"), build },
		},
		1,
	);
	const prepared = await native("prepare", { globalUpdate: prepare });
	assert.equal(prepared.status, 200);
	assert.equal(prepared.value.state, "accepted");
	assert.ok(
		prepared.value.result.sessions.some(
			(s: { hostExited: boolean; interrupted: boolean }) => s.hostExited && s.interrupted,
		),
		"broken peer is interrupted with residual uncertainty, not a veto",
	);
	assert.equal(await readFile(join(home, "canceled-job"), "utf8"), "owned-job-exited");
	const stopReply = once(initial.child, "message");
	initial.child.send({ stop: initial.ready.chats[2].id });
	await stopReply;
	await close(initial.child);
	assert.equal(await inspectRuntime(home, port, build), "idle");
	assert.equal((await stat(join(home, OWNER_FILE))).ino, inode);
	// A real failed executable launch has no service graph or lease to replay.
	const failed = fork(join(root, "missing-daemon.ts"), [], { execArgv: [], stdio: "ignore" });
	await once(failed, "exit");
	assert.notEqual(failed.exitCode, 0);
	assert.equal(await inspectRuntime(home, port, build), "idle");
	const wrong = await launch({ ...build, source: "b".repeat(40) });
	await assert.rejects(inspectRuntime(home, port, build), /runtime_incompatible/);
	await close(wrong.child); // only our retained ChildProcess, never an unrelated PID
	const rollback = await launch();
	assert.equal(rollback.ready.starts, 0, "retained global hold precedes cold recovery");
	assert.equal(await inspectRuntime(home, port, build), "ready");
	assert.deepEqual((await native("inspect", { globalUpdate: prepare })).value, prepared.value);
	const releaseOp = operation(
		"global-update-release",
		{ prepareId: prepare.operationId, prepareHash: prepare.payloadHash },
		2,
	);
	const runtime = { boot: rollback.ready.boot, runtimeRoot: join(home, "fixture-runtime"), build };
	// Reject before entering a release journal, so the correct fresh release can proceed.
	assert.equal(
		(await native("release", { globalUpdate: prepare, release: releaseOp, runtime: { ...runtime, boot: "wrong" } }))
			.status,
		409,
	);
	const releaseResult = await native("release", {
		globalUpdate: prepare,
		release: releaseOp,
		runtime,
	});
	assert.equal(releaseResult.status, 200);
	assert.equal(releaseResult.value.state, "accepted");
	assert.deepEqual(
		(await native("inspect", { globalUpdate: releaseOp })).value,
		releaseResult.value,
		"a lost release reply is looked up, never resumed again",
	);
	const statusReply = once(rollback.child, "message");
	rollback.child.send("status");
	const [status] = await statusReply;
	assert.ok(status.opened.includes(initial.ready.chats[0].id), "healthy update-owned chat resumes");
	assert.ok(!status.opened.includes(initial.ready.chats[1].id), "broken uncertain work is never replayed");
	assert.ok(!status.opened.includes(initial.ready.chats[3].id), "canceled job is never replayed");
	// A stopped kernel may reopen only to deliver its durable abort with stopOnOpen.
	const stopped = JSON.parse(await readFile(join(home, "sessions", initial.ready.chats[2].id, "meta.json"), "utf8"));
	assert.equal(stopped.working, false, "later user Stop never resumes canceled execution");
	assert.equal(stopped.lifecycleCheckpoint.phase, "stopped");
	assert.equal(await readFile(join(home, "saved-window"), "utf8"), draft);
	const broken = JSON.parse(await readFile(join(home, "sessions", initial.ready.chats[1].id, "meta.json"), "utf8"));
	assert.equal(broken.updatePaused, true, "broken uncertain work stays held");
	await close(rollback.child);
});
