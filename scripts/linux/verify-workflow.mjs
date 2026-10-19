/** Packaged daemon/kernel through owned SSH forwards, disposable CI user only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUpdateFixtureTerminal } from "./update-terminal.mjs";
import { api, child, freePort, hash, operation, png, quote, setupSource, until } from "./workflow-fixture.mjs";

if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux")
	throw new Error("Disposable Linux CI fixture only");
const [home, runtime, archive, ...sshArgs] = process.argv.slice(2);
const destination = sshArgs.pop();
if (!home || !runtime || !sshArgs.length) throw new Error("Usage: verify-workflow.mjs home runtime ssh-args...");
const work = await mkdtemp(join(tmpdir(), "pilot-workflow-"));
const ssh = (command, input) => child("ssh", [...sshArgs, destination, command], input);
let local, terminal;
const forwards = new Set();
async function forward() {
	const socket = join(work, randomUUID()),
		port = await freePort();
	await child("ssh", [...sshArgs, "-M", "-S", socket, "-fN", "-o", "ControlPersist=no", destination]);
	const close = async () => {
		forwards.delete(close);
		await child("ssh", [...sshArgs, "-S", socket, "-O", "exit", destination]).catch(() => {});
	};
	forwards.add(close);
	// The owned master explicitly acknowledges this forward before any handshake request.
	await child("ssh", [
		...sshArgs,
		"-S",
		socket,
		"-O",
		"forward",
		"-o",
		"ExitOnForwardFailure=yes",
		"-L",
		`127.0.0.1:${port}:127.0.0.1:4319`,
		destination,
	]);
	return { base: `http://127.0.0.1:${port}`, close };
}
try {
	const configured = JSON.parse(
		await ssh(`cd ${quote(runtime)} && ./node/bin/node --input-type=module -`, setupSource(home)),
	);
	const first = await forward();
	const hello = await api(first.base, "hello");
	assert.equal(hello.capabilities.independentExecution, true);
	assert.equal(hello.capabilities.swiftUIArtifacts, false);
	const readiness = await api(first.base, "setup");
	assert.ok(readiness);
	const directory = await api(first.base, "repositories/directories?rootId=home&path=workflow-repo");
	assert.ok(directory.entries.some((entry) => entry.name === ".git") || directory.path.includes("workflow-repo"));
	const project = await api(first.base, "repositories/projects", {
		method: "POST",
		body: { selection: { rootId: "home", path: "workflow-repo" }, name: "Remote fixture" },
	});
	assert.equal(project.path, configured.repo);
	const image = Buffer.from(png, "base64");
	const metadata = {
		uploadId: randomUUID(),
		sha256: hash(image),
		bytes: image.length,
		origin: { hostId: "fixture", daemonId: "fixture", lineageId: "fixture" },
	};
	const attachment = await api(first.base, `attachments/${metadata.uploadId}`, {
		method: "PUT",
		body: image,
		headers: {
			"content-type": "image/png",
			"content-length": String(image.length),
			"x-pilot-attachment": Buffer.from(JSON.stringify(metadata)).toString("base64"),
		},
	});
	const op = operation(
		hello,
		{
			request: {
				cwd: configured.repo,
				title: "Remote packaged workflow",
				message: "Run the bounded offline fixture",
				model: "faux/faux-1",
			},
			attachments: [attachment],
		},
		{ kind: "chat-create-attached" },
	);
	const receipt = await api(first.base, "operations", { method: "POST", body: op });
	assert.equal(receipt.state, "accepted");
	const sessionId = receipt.result.sessionId;
	assert.equal(sessionId, op.targetId);
	await until(
		async () => (await ssh(`test -f ${quote(configured.repo + "/started")} && printf yes || true`)) === "yes",
		"remote native tool barrier",
	);
	terminal = await openUpdateFixtureTerminal(first.base, sessionId);
	const terminalId = terminal.terminalId;
	// Detach, not terminal.close. Remote shell and worker must remain alive.
	terminal.socket.close();
	terminal = undefined;
	await first.close();
	await ssh(`printf release > ${quote(configured.repo + "/release")}`);
	await until(
		async () => (await ssh(`test -f ${quote(configured.repo + "/completed")} && printf yes || true`)) === "yes",
		"tool completes without any app forward",
	);
	const reconnected = await forward();
	assert.equal((await api(reconnected.base, "hello")).daemonId, hello.daemonId);
	await until(async () => {
		const session = await api(reconnected.base, `sessions/${sessionId}`);
		assert.notEqual(session.state, "failed", "Packaged faux run failed");
		return session.state === "idle";
	}, "durable remote completion");
	terminal = await openUpdateFixtureTerminal(reconnected.base, sessionId);
	assert.equal(terminal.terminalId, terminalId);
	await terminal.closeShell();
	terminal = undefined;
	const recovered = await api(reconnected.base, "operations/receipt", { method: "POST", body: op });
	assert.deepEqual(recovered, receipt);
	assert.deepEqual(await api(reconnected.base, "operations", { method: "POST", body: op }), receipt);
	assert.equal((await api(reconnected.base, "sessions")).filter((value) => value.id === sessionId).length, 1);
	await assert.rejects(
		api(reconnected.base, "operations", {
			method: "POST",
			body: { ...op, destination: { ...op.destination, lineageId: "untrusted-clone" } },
		}),
		/HTTP 400/,
	);
	assert.equal((await api(reconnected.base, "sessions")).filter((value) => value.id === sessionId).length, 1);
	const file = await api(reconnected.base, `sessions/${sessionId}/files?path=tracked.txt`);
	assert.match(JSON.stringify(file), /remote-workflow-ok/);
	const changes = await api(reconnected.base, `sessions/${sessionId}/changes`);
	assert.match(changes.diff, /remote-workflow-ok/);
	const artifacts = await api(reconnected.base, `sessions/${sessionId}/artifacts`);
	assert.deepEqual(artifacts.map((item) => item.kind).sort(), ["html", "image", "react"]);
	for (const artifact of artifacts) {
		const revision = await api(reconnected.base, `sessions/${sessionId}/artifacts/${artifact.id}?revision=1`);
		assert.equal(revision.revision, 1);
		assert.equal(revision.sessionId, sessionId);
		if (revision.kind === "image") assert.match(revision.source, /^data:image\/png;base64,/);
		else assert.match(revision.source, /remote-(html|react)-ok/);
	}
	// A second packaged endpoint uses its own data/config, even while the remote forward is alive.
	const localPort = await freePort(),
		localHome = join(work, "local"),
		agent = join(work, "agent");
	await mkdir(agent);
	await child("tar", ["-xzf", archive, "-C", work], undefined, { timeoutMs: 60_000 });
	const localRuntime = join(work, "runtime");
	local = spawn(join(localRuntime, "node/bin/node"), [join(localRuntime, "packages/daemon/src/main.ts")], {
		stdio: ["ignore", "ignore", "ignore"],
		env: {
			HOME: work,
			PATH: "/usr/bin:/bin",
			SHELL: "/bin/sh",
			PI_OFFLINE: "1",
			PILOT_HOME: localHome,
			PILOT_PORT: String(localPort),
			PILOT_AGENT_DIR: agent,
			PI_CODING_AGENT_DIR: agent,
		},
	});
	const localBase = `http://127.0.0.1:${localPort}`;
	await until(async () => {
		try {
			return !!(await api(localBase, "hello"));
		} catch {
			assert.equal(local.exitCode, null);
			return false;
		}
	}, "independent local endpoint");
	assert.notEqual((await api(localBase, "hello")).daemonId, hello.daemonId);
	const localSessions = await api(localBase, "sessions");
	// Fresh Linux endpoints have no Control conversation and must not import remote chats.
	assert.deepEqual(localSessions, []);
	await reconnected.close();
	assert.deepEqual(await api(localBase, "sessions"), localSessions);
	console.log(
		JSON.stringify({
			packagedWorkflow: "passed",
			resources: [
				"repository",
				"kernel",
				"terminal",
				"files",
				"changes",
				"attachment",
				"html",
				"react",
				"image",
				"receipt",
			],
			reconnect: true,
			localIndependent: true,
		}),
	);
} finally {
	await ssh(`touch ${quote(home + "/workflow-repo/release")}`).catch(() => {});
	await terminal?.closeShell().catch(() => {});
	for (const close of forwards) await close();
	if (local && local.exitCode === null) {
		const exited = once(local, "exit");
		local.kill("SIGTERM");
		const timer = setTimeout(() => local.kill("SIGKILL"), 10_000);
		try {
			await exited;
		} finally {
			clearTimeout(timer);
		}
	}
	await rm(work, { recursive: true, force: true });
}
