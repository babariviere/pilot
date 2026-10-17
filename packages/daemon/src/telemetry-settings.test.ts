import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonHello } from "@pilot/protocol";
import { TelemetrySettingsService } from "./telemetry-settings.ts";

const hello: DaemonHello = {
	protocolVersion: 1,
	minimumClientProtocolVersion: 1,
	daemonVersion: "1.45.1",
	daemonId: "daemon-private-id",
	lineageId: "lineage-private-id",
	platform: "darwin",
	arch: "arm64",
	capabilities: {
		powerManagement: true,
		systemSleepEvents: true,
		swiftUIArtifacts: true,
		coordinatorIsolation: true,
		independentExecution: true,
	},
};

test("telemetry settings default off, persist privately and expose only pseudonymous identity", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-telemetry-settings-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
	const service = await TelemetrySettingsService.open(home, hello);
	const initial = service.settings();
	assert.equal(initial.localDiagnostics, true);
	assert.equal(initial.remoteOperational, false);
	assert.equal(initial.productAnalytics, false);
	assert.match(initial.hostId, /^[a-z0-9_-]{22}$/);
	assert.equal(JSON.stringify(initial).includes(hello.daemonId), false);
	assert.equal((await stat(join(home, "telemetry.json"))).mode & 0o777, 0o600);

	const updated = await service.update({
		localDiagnostics: false,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "http://127.0.0.1:4318",
	});
	assert.equal(updated.endpoint, "http://127.0.0.1:4318/v1/traces");
	const reopened = await TelemetrySettingsService.open(home, hello);
	assert.deepEqual(reopened.settings(), updated);
	assert.equal(reopened.kernelSettings().enabled, true);
	assert.equal(reopened.kernelSettings().localDiagnostics, false);
	assert.equal(reopened.kernelSettings().hostId, initial.hostId);

	const privateFile = JSON.parse(await readFile(join(home, "telemetry.json"), "utf8"));
	assert.equal(typeof privateFile.hostKey, "string");
	assert.equal(typeof privateFile.analyticsId, "string");
	assert.equal(JSON.stringify(updated).includes(privateFile.hostKey), false);
	if (updated.hostKind === "local") assert.equal(updated.analyticsId, privateFile.analyticsId);
	else assert.equal(JSON.stringify(updated).includes(privateFile.analyticsId), false);
});

test("telemetry settings reject unsafe endpoints and rotate analytics identity on revocation", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-telemetry-settings-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
	const service = await TelemetrySettingsService.open(home, hello);
	for (const endpoint of [
		"http://collector.example/v1/traces",
		"https://token@collector.example/v1/traces",
		"https://collector.example/v1/traces?token=secret",
	]) {
		await assert.rejects(
			service.update({
				localDiagnostics: true,
				remoteOperational: true,
				productAnalytics: false,
				endpoint,
			}),
		);
	}
	await assert.rejects(service.update({ localDiagnostics: true, remoteOperational: true, productAnalytics: false }));

	await service.update({
		localDiagnostics: true,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "https://collector.example/v1/traces",
	});
	const before = JSON.parse(await readFile(join(home, "telemetry.json"), "utf8")).analyticsId;
	await service.update({
		localDiagnostics: true,
		remoteOperational: false,
		productAnalytics: false,
		endpoint: "https://collector.example/v1/traces",
	});
	const after = JSON.parse(await readFile(join(home, "telemetry.json"), "utf8")).analyticsId;
	assert.notEqual(after, before);
});
