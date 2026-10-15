/** Real headless entry + kernel, isolated credentials and a faux provider. No remote host/account needed. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DaemonHello, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";

async function until(check: () => Promise<boolean>, detail: () => string): Promise<void> {
	const deadline = performance.now() + 25_000;
	while (!(await check())) {
		if (performance.now() >= deadline) throw new Error(`Headless smoke timeout: ${detail()}`);
		await delay(25);
	}
}

test("headless daemon runs native tools after clients disconnect and keeps identity/state on restart", {
	timeout: 60_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-headless-"));
	const stops: Array<() => Promise<void>> = [];
	t.after(async () => {
		try {
			// Release a shell even when an assertion fails before disconnect/completion.
			await writeFile(join(root, "work", "release"), "cleanup").catch(() => {});
			for (const stop of stops.reverse()) await stop();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const home = join(root, "data");
	const agent = join(root, "agent");
	const cwd = join(root, "work");
	await Promise.all([mkdir(agent), mkdir(cwd)]);
	const provider = join(agent, "offline.ts");
	const release = join(cwd, "release");
	const started = join(cwd, "started");
	const completed = join(cwd, "completed");
	const command = `printf started > started; while [ ! -f release ]; do sleep 0.05; done; printf headless-tool-ok > completed`;
	await writeFile(
		provider,
		`
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default pi => {
 const faux = fauxProvider();
 faux.setResponses([
  fauxAssistantMessage({type:'toolCall',id:'headless-tool',name:'codemode',arguments:{code:${JSON.stringify(`return await tools.bash({command:${JSON.stringify(command)}});`)}}}, {stopReason:'toolUse'}),
  fauxAssistantMessage('Headless execution complete')
 ]);
 pi.registerProvider(faux.provider);
};`,
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			extensions: [provider],
			defaultProvider: "faux",
			defaultModel: "faux-1",
			defaultTools: ["+codemode"],
			codemode: { mode: "only" },
		}),
	);
	const offline = join(root, "offline.mjs");
	await writeFile(
		offline,
		`globalThis.fetch = async (url, options) => {
			// Simulate reachability for the host-owned admission gate, never contact the network.
			if (url === 'https://www.gstatic.com/generate_204' && options?.method === 'HEAD')
				return new Response(null, { status: 204 });
			throw new Error('Headless smoke must stay offline');
		};\n`,
	);
	// Reserve only long enough to choose a port. A collision fails startup rather than using another daemon.
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const port = (reservation.address() as AddressInfo).port;
	await new Promise<void>((resolve) => reservation.close(() => resolve()));
	const base = `http://127.0.0.1:${port}/api`;
	async function start() {
		let log = "";
		const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				HOME: root,
				PATH: "/usr/bin:/bin",
				SHELL: "/bin/sh",
				PI_OFFLINE: "1",
				PILOT_HOME: home,
				PILOT_PORT: String(port),
				PILOT_AGENT_DIR: agent,
				PI_CODING_AGENT_DIR: agent,
				PILOT_POWER_HELPER: join(root, "absent-power"),
				PILOT_SYSTEM_EVENTS_HELPER_APP: join(root, "absent-events"),
				NODE_OPTIONS: `--import=${offline}`,
			},
		});
		child.stdout.on("data", (data) => {
			log = (log + data).slice(-32_768);
		});
		child.stderr.on("data", (data) => {
			log = (log + data).slice(-32_768);
		});
		const exited = once(child, "exit");
		let stopped = false;
		async function stop() {
			if (stopped) return;
			stopped = true;
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
			try {
				assert.deepEqual(await exited, [0, null], log);
			} finally {
				clearTimeout(timeout);
			}
		}
		stops.push(stop);
		await until(
			async () => {
				if (child.exitCode !== null || child.signalCode !== null) throw new Error(log);
				return log.includes(`listening on http://127.0.0.1:${port}`);
			},
			() => log,
		);
		return { stop, log: () => log };
	}
	const first = await start();
	const helloResponse = await fetch(`${base}/hello`);
	assert.equal(helloResponse.status, 200);
	const hello = (await helloResponse.json()) as DaemonHello;
	assert.equal(hello.capabilities.independentExecution, true);
	assert.equal(hello.capabilities.powerManagement, false);
	if (process.platform === "linux") {
		assert.equal(hello.capabilities.coordinatorIsolation, false);
		assert.equal(hello.capabilities.swiftUIArtifacts, false);
	}
	const power = await fetch(`${base}/power`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ keepAwake: true, closedLid: true }),
	});
	assert.equal(power.status, 503);
	await power.arrayBuffer();
	const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws`);
	t.after(() => ws.terminate());
	await once(ws, "open");
	const spawned = await fetch(`${base}/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			cwd,
			title: "Offline smoke",
			message: "Run the offline smoke fixture",
			model: "faux/faux-1",
		}),
	});
	assert.equal(spawned.status, 201, await spawned.clone().text());
	const session = (await spawned.json()) as SessionSummary;
	await until(
		() =>
			access(started).then(
				() => true,
				() => false,
			),
		first.log,
	);
	ws.close();
	await once(ws, "close");
	// No client remains connected when the shell and model complete.
	await writeFile(release, "continue");
	await until(
		() =>
			access(completed).then(
				() => true,
				() => false,
			),
		first.log,
	);
	assert.equal(await readFile(completed, "utf8"), "headless-tool-ok");
	await until(async () => {
		const response = await fetch(`${base}/sessions/${session.id}`);
		const current = (await response.json()) as SessionSummary;
		if (current.state === "failed") throw new Error(JSON.stringify(current));
		return current.state === "idle" && !current.working;
	}, first.log);
	await first.stop();
	const second = await start();
	const restarted = (await (await fetch(`${base}/hello`)).json()) as DaemonHello;
	assert.equal(restarted.daemonId, hello.daemonId);
	assert.equal(restarted.daemonVersion, hello.daemonVersion);
	const sessions = (await (await fetch(`${base}/sessions`)).json()) as SessionSummary[];
	assert.ok(sessions.some((saved) => saved.id === session.id && saved.title === "Offline smoke"));
	assert.ok(!first.log().includes("Energy helper unavailable"));
	await second.stop();
});
