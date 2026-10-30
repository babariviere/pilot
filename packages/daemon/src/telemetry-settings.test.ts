import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

test("Next privacy epoch persists, disable advances it, and remote consent does not enable collection", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "next-control-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
	const service = await TelemetrySettingsService.open(home, hello);
	const initial = service.settings().nextDiagnostics!.epoch;
	assert.ok(Number.isSafeInteger(initial));
	await service.clearNextDiagnostics();
	const cleared = service.settings().nextDiagnostics!.epoch;
	assert.notEqual(cleared, initial);
	await service.update({ localDiagnostics: false, remoteOperational: false, productAnalytics: false });
	assert.notEqual(service.settings().nextDiagnostics!.epoch, cleared);
	const reopened = await TelemetrySettingsService.open(home, hello);
	assert.deepEqual(reopened.settings().nextDiagnostics, service.settings().nextDiagnostics);
	assert.equal(reopened.settings().localDiagnostics, false);
	await writeFile(join(home, "telemetry.json"), "{invalid");
	const unknown = await TelemetrySettingsService.open(home, hello);
	assert.equal(unknown.settings().nextDiagnostics, undefined, "unreadable settings cannot enable Next integration");
});

test("telemetry settings default off, persist privately and expose only pseudonymous identity", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-telemetry-settings-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
	const service = await TelemetrySettingsService.open(home, hello);
	const initial = service.settings();
	assert.equal(initial.localDiagnostics, true);
	assert.equal(initial.remoteOperational, false);
	assert.equal(initial.productAnalytics, false);
	assert.equal(initial.aiUsageBudget, undefined, "there is no invented monetary default");
	assert.match(initial.hostId, /^[a-z0-9_-]{22}$/);
	assert.equal(JSON.stringify(initial).includes(hello.daemonId), false);
	assert.equal((await stat(join(home, "telemetry.json"))).mode & 0o777, 0o600);

	const updated = await service.update({
		localDiagnostics: false,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "http://127.0.0.1:4318",
		aiUsageBudget: { basis: "catalog_estimate", limitUsdMicros: 2_500_000, window: "retained_chat" },
	});
	assert.equal(updated.endpoint, "http://127.0.0.1:4318/v1/traces");
	const reopened = await TelemetrySettingsService.open(home, hello);
	assert.deepEqual(reopened.settings(), updated);
	assert.equal(reopened.kernelSettings().enabled, true);
	assert.equal(reopened.kernelSettings().localDiagnostics, false);
	assert.equal(reopened.kernelSettings().hostId, initial.hostId);
	assert.equal(JSON.stringify(reopened.kernelSettings()).includes("aiUsageBudget"), false);
	assert.equal(JSON.stringify(reopened.nodeOptions("pilot.daemon")).includes("aiUsageBudget"), false);

	const privateFile = JSON.parse(await readFile(join(home, "telemetry.json"), "utf8"));
	assert.equal(typeof privateFile.hostKey, "string");
	assert.equal(typeof privateFile.analyticsId, "string");
	assert.equal(JSON.stringify(updated).includes(privateFile.hostKey), false);
	if (updated.hostKind === "local") assert.equal(updated.analyticsId, privateFile.analyticsId);
	else assert.equal(JSON.stringify(updated).includes(privateFile.analyticsId), false);
});

test("AI usage budget configuration is optional, bounded, preservable by old clients and explicitly clearable", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-telemetry-budget-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
	const service = await TelemetrySettingsService.open(home, hello);
	const configured = await service.update({
		localDiagnostics: true,
		remoteOperational: false,
		productAnalytics: false,
		aiUsageBudget: { basis: "billed", limitUsdMicros: 1, window: "retained_chat" },
	});
	assert.deepEqual(configured.aiUsageBudget, { basis: "billed", limitUsdMicros: 1, window: "retained_chat" });
	const otherHost = await TelemetrySettingsService.open(join(home, "other-host"), hello);
	assert.equal(otherHost.settings().aiUsageBudget, undefined, "host-local settings do not flow to another Pilot home");

	const preserved = await service.update({
		localDiagnostics: false,
		remoteOperational: false,
		productAnalytics: false,
	});
	assert.deepEqual(
		preserved.aiUsageBudget,
		configured.aiUsageBudget,
		"an older client omission cannot erase the setting",
	);

	for (const aiUsageBudget of [
		{},
		{ basis: "catalog_estimate", limitUsdMicros: 0, window: "retained_chat" },
		{ basis: "catalog_estimate", limitUsdMicros: -1, window: "retained_chat" },
		{ basis: "catalog_estimate", limitUsdMicros: 1.5, window: "retained_chat" },
		{ basis: "provider-specific", limitUsdMicros: 1, window: "retained_chat" },
		{ basis: "billed", limitUsdMicros: 1, window: "calendar_month" },
		{ basis: "billed", limitUsdMicros: 1, window: "retained_chat", provider: "private" },
	]) {
		await assert.rejects(
			service.update({
				localDiagnostics: true,
				remoteOperational: false,
				productAnalytics: false,
				aiUsageBudget,
			}),
			/Invalid AI usage budget/,
		);
	}
	const cleared = await service.update({
		localDiagnostics: true,
		remoteOperational: false,
		productAnalytics: false,
		aiUsageBudget: null,
	});
	assert.equal(cleared.aiUsageBudget, undefined);
	assert.equal(JSON.parse(await readFile(join(home, "telemetry.json"), "utf8")).aiUsageBudget, undefined);
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
