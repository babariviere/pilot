import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerMessage } from "@pilot/protocol";
import { WebSocket } from "ws";
import { ModelCatalog } from "./models.ts";
import { PowerService } from "./power.ts";
import type { PowerCommand, PowerSample } from "./power-helper.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("power GET only copies cached policy/status, without starting or refreshing the helper", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-power-read-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	let starts = 0;
	let emit!: (sample: PowerSample) => void;
	let lost!: () => void;
	const commands: PowerCommand[] = [];
	const sample: PowerSample = {
		backend: "kde",
		qualification: "unqualified",
		inhibitionActive: false,
		networkKnown: false,
		available: true,
		authorized: false,
		connectedToPower: false,
		wifiConnected: false,
		online: false,
		lidClosed: null,
		sleeping: false,
		fullWake: false,
		wakeToken: "0:0",
		sleepGeneration: 0,
		closedLidActive: false,
	};
	const power = new PowerService(home, sessions, async (accept, fail) => {
		starts++;
		emit = accept;
		lost = fail;
		accept(sample);
		return {
			async request(command) {
				commands.push(command);
			},
			async close() {},
		};
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		power,
	);
	t.after(async () => {
		await power.stop();
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const get = async () => {
		const response = await fetch(`${origin}/api/power`);
		assert.equal(response.status, 200);
		return response.json();
	};
	const unavailable = {
		settings: { keepAwake: true, closedLid: false },
		available: false,
		authorized: false,
		keepingAwake: false,
		closedLidActive: false,
		paused: false,
		connectedToPower: false,
		wifiConnected: false,
	};
	assert.deepEqual(await get(), unavailable);
	assert.equal(starts, 0, "GET must not initialize a helper");
	assert.deepEqual(commands, []);
	await power.start(); // Injected pipe fixture only, never a native helper.
	await power.settled();
	const beforeRead = [...commands];
	assert.deepEqual(await get(), {
		...unavailable,
		available: true,
		error: "Linux/KDE power behavior is not hardware-qualified.",
	});
	assert.deepEqual(commands, beforeRead, "GET cannot refresh sensors or apply policy");
	// A helper sample changes the cache; GET alone does not. The public report
	// drops backend/qualification/networkKnown and has no observation timestamp.
	emit({ ...sample, connectedToPower: true });
	await power.settled();
	const report = await get();
	assert.deepEqual(report, { ...power.status() });
	assert.deepEqual(await get(), report);
	assert.deepEqual(commands, beforeRead);
	assert.equal(starts, 1);
	assert.equal(power.status().settings.keepAwake, true);
	assert.equal(power.status().keepingAwake, false, "enabled policy is not active inhibition");
	lost();
	await power.settled();
	assert.deepEqual(await get(), {
		...unavailable,
		error: "Linux energy helper unavailable. Requires an active KDE Wayland session, current PowerDevil and logind delay permission.",
	});
	assert.equal(starts, 1, "GET cannot reconnect a lost helper");
	assert.deepEqual(commands, beforeRead);
	await assert.rejects(readFile(join(home, "power-settings.json")), { code: "ENOENT" });
});

test("Energy API persists setup, pushes initial/changed state, and keeps HTTP origin/method guards", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-power-api-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	let authorizations = 0;
	const power = new PowerService(home, sessions, async (sample) => {
		const state = {
			available: true,
			authorized: false,
			connectedToPower: true,
			wifiConnected: true,
			online: true,
			lidClosed: false,
			sleeping: false,
			fullWake: true,
			wakeToken: "100:1",
			sleepGeneration: 0,
			closedLidActive: false,
		};
		sample(state);
		return {
			async request(command) {
				if (command.action === "authorize") {
					authorizations++;
					state.authorized = true;
					sample({ ...state });
				}
			},
			async close() {},
		};
	});
	await power.start();
	await power.settled();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		power,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const ws = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws`);
	const nextPower = (matches: (message: Extract<ServerMessage, { type: "power" }>) => boolean = () => true) =>
		new Promise<Extract<ServerMessage, { type: "power" }>>((resolve) => {
			const listener = (data: Buffer) => {
				const message = JSON.parse(data.toString()) as ServerMessage;
				if (message.type === "power" && matches(message)) {
					ws.off("message", listener);
					resolve(message);
				}
			};
			ws.on("message", listener);
		});
	t.after(async () => {
		ws.terminate();
		await power.stop();
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	const initial = nextPower();
	await once(ws, "open");
	assert.deepEqual((await initial).power, power.status());
	const response = await fetch(`${origin}/api/power`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), power.status());
	assert.equal(authorizations, 0, "reads and websocket connections cannot prompt for administrator permission");
	const changed = nextPower((message) => message.power.settings.closedLid);
	const configured = await fetch(`${origin}/api/power`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ keepAwake: true, closedLid: true }),
	});
	assert.equal(configured.status, 200);
	await configured.arrayBuffer();
	assert.equal((await changed).power.settings.closedLid, true);
	assert.equal(authorizations, 1);
	for (const [path, method, body, status, headers] of [
		["/api/power", "POST", undefined, 405, {}],
		["/api/power/extra", "GET", undefined, 404, {}],
		["/api/power", "PATCH", JSON.stringify({ keepAwake: "yes", closedLid: false }), 400, {}],
		[
			"/api/power",
			"PATCH",
			JSON.stringify({ keepAwake: true, closedLid: true }),
			403,
			{ origin: "https://example.com" },
		],
	] as const) {
		const rejected = await fetch(`${origin}${path}`, {
			method,
			body,
			headers: { "content-type": "application/json", ...headers },
		});
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	assert.equal(authorizations, 1);
});
