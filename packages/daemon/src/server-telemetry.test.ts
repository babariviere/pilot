import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonHello, TelemetrySettings } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TelemetrySettingsService } from "./telemetry-settings.ts";
import { TerminalManager } from "./terminals.ts";

test("telemetry API keeps controls host-scoped, validates mutations and clears without starting sessions", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-telemetry-api-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const hello: DaemonHello = {
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		daemonVersion: "1.45.1",
		daemonId: "daemon",
		lineageId: "lineage",
		platform: process.platform,
		arch: process.arch,
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: process.platform === "darwin",
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	const telemetry = await TelemetrySettingsService.open(home, hello);
	sessions.configureTelemetry(telemetry.kernelSettings());
	telemetry.onChange(() => sessions.configureTelemetry(telemetry.kernelSettings()));
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
		undefined,
		undefined,
		hello,
		undefined,
		undefined,
		undefined,
		undefined,
		telemetry,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});

	const initial = await fetch(`${origin}/api/telemetry`);
	assert.equal(initial.status, 200);
	assert.equal(((await initial.json()) as TelemetrySettings).remoteOperational, false);
	const configured = await fetch(`${origin}/api/telemetry`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			localDiagnostics: false,
			remoteOperational: true,
			productAnalytics: false,
			endpoint: "http://127.0.0.1:4318",
		}),
	});
	assert.equal(configured.status, 200);
	assert.equal(((await configured.json()) as TelemetrySettings).endpoint, "http://127.0.0.1:4318/v1/traces");
	const unsafe = await fetch(`${origin}/api/telemetry`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			localDiagnostics: true,
			remoteOperational: true,
			productAnalytics: false,
			endpoint: "http://collector.example/v1/traces",
		}),
	});
	assert.equal(unsafe.status, 400);
	await unsafe.arrayBuffer();
	const cleared = await fetch(`${origin}/api/diagnostics`, { method: "DELETE" });
	assert.equal(cleared.status, 200);
	assert.deepEqual(await cleared.json(), { cleared: true });
	assert.equal(sessions.list().length, 0);
});
