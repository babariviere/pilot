import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

test("durable revocation notifies runtime listeners even when aggregate deletion fails", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "privacy-cleanup-failure-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const service = await TelemetrySettingsService.open(home, hello);
	let runtimeEnabled = false;
	service.onChange((settings) => {
		runtimeEnabled = settings.remoteOperational;
	});
	await service.update({
		localDiagnostics: true,
		localFeatureUsage: true,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "https://collector.example/v1/traces",
	});
	assert.equal(runtimeEnabled, true);
	await rm(join(home, "feature-usage.json"), { force: true });
	await mkdir(join(home, "feature-usage.json"));
	const saved = await service.update({
		localDiagnostics: false,
		localFeatureUsage: false,
		remoteOperational: false,
		productAnalytics: false,
	});
	assert.equal(saved.remoteOperational, false);
	assert.equal(runtimeEnabled, false);
	assert.equal(service.nodeOptions("pilot.daemon").enabled, false);
	assert.equal(service.kernelSettings().enabled, false);
	assert.equal((await TelemetrySettingsService.open(home, hello)).settings().remoteOperational, false);
});

test("failed consent persistence stops live reductions without publishing enables", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "privacy-persist-failure-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const service = await TelemetrySettingsService.open(home, hello);
	await service.update({
		localDiagnostics: true,
		localFeatureUsage: true,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "https://collector.example/v1/traces",
	});
	let effective = service.settings();
	service.onChange((s) => {
		effective = s;
	});
	await rename(join(home, "telemetry.json"), join(home, "before.json"));
	await mkdir(join(home, "telemetry.json"));
	const saving = service.update({
		localDiagnostics: false,
		localFeatureUsage: false,
		remoteOperational: false,
		productAnalytics: false,
	});
	assert.equal(effective.remoteOperational, false, "disable is published before the first fallible await");
	assert.equal(effective.localDiagnostics, false);
	assert.equal(effective.productAnalytics, false);
	assert.equal(effective.localFeatureUsage, false);
	await assert.rejects(saving);
	assert.equal(service.settings().remoteOperational, false);
	assert.equal(effective.remoteOperational, false);
	await rm(join(home, "telemetry.json"), { recursive: true });
	await rename(join(home, "before.json"), join(home, "telemetry.json"));
	assert.equal(
		(await TelemetrySettingsService.open(home, hello)).settings().remoteOperational,
		true,
		"failed persistence never claims a durable revocation",
	);
	await rename(join(home, "telemetry.json"), join(home, "before.json"));
	await mkdir(join(home, "telemetry.json"));
	await assert.rejects(
		service.update({
			localDiagnostics: true,
			localFeatureUsage: true,
			remoteOperational: true,
			productAnalytics: true,
			endpoint: "https://other.example/v1/traces",
		}),
	);
	assert.equal(effective.remoteOperational, false, "an enable is not published before durable persistence");
});

test("an older asynchronous update cannot publish a newer failed enable", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "privacy-old-update-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const service = await TelemetrySettingsService.open(home, hello);
	let entered = () => {},
		release = () => {};
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const gate = new Promise<void>((r) => {
		release = r;
	});
	t.mock.method(service.featureUsage, "configure", async () => {
		entered();
		await gate;
	});
	let runtimeEnabled = false;
	service.onChange((s) => {
		runtimeEnabled = s.remoteOperational;
	});
	const older = service.update({
		localDiagnostics: false,
		localFeatureUsage: true,
		remoteOperational: false,
		productAnalytics: false,
	});
	await started;
	await rename(join(home, "telemetry.json"), join(home, "before.json"));
	await mkdir(join(home, "telemetry.json"));
	await assert.rejects(
		service.update({
			localDiagnostics: false,
			localFeatureUsage: true,
			remoteOperational: true,
			productAnalytics: false,
			endpoint: "https://collector.example/v1/traces",
		}),
	);
	release();
	await older;
	assert.equal(runtimeEnabled, false, "old continuation cannot grant the newer unpersisted settings");
});

test("mixed reductions never expose pending enables through public or runtime readers", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "privacy-mixed-readers-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const service = await TelemetrySettingsService.open(home, hello);
	const oldEndpoint = "https://previous.example/v1/traces";
	await service.update({
		localDiagnostics: true,
		localFeatureUsage: false,
		remoteOperational: false,
		productAnalytics: false,
		endpoint: oldEndpoint,
	});
	const observed: unknown[] = [];
	const probe = () => ({
		publicRemote: service.settings().remoteOperational,
		nodeRemote: service.nodeOptions("pilot.daemon").enabled,
		kernelRemote: service.kernelSettings().enabled,
		publicEndpoint: service.settings().endpoint,
		nodeEndpoint: service.nodeOptions("pilot.daemon").endpoint,
		kernelEndpoint: service.kernelSettings().endpoint,
		local: service.kernelSettings().localDiagnostics,
		analytics: service.settings().productAnalytics,
	});
	service.onChange((s) => observed.push({ listenerRemote: s.remoteOperational, ...probe() }));
	await rename(join(home, "telemetry.json"), join(home, "before.json"));
	await mkdir(join(home, "telemetry.json"));
	const saving = service.update({
		localDiagnostics: false,
		localFeatureUsage: false,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "https://pending.example/v1/traces",
	});
	const restricted = {
		publicRemote: false,
		nodeRemote: false,
		kernelRemote: false,
		publicEndpoint: oldEndpoint,
		nodeEndpoint: oldEndpoint,
		kernelEndpoint: oldEndpoint,
		local: false,
		analytics: false,
	};
	assert.deepEqual(probe(), restricted, "all readers stay restrictive before persistence");
	assert.deepEqual(
		observed,
		[{ listenerRemote: false, ...restricted }],
		"daemon listeners cannot observe a pending grant through another reader",
	);
	await assert.rejects(saving);
	assert.deepEqual(probe(), restricted, "failed persistence cannot expose pending enables or collector changes");
	await rm(join(home, "telemetry.json"), { recursive: true });
	await rename(join(home, "before.json"), join(home, "telemetry.json"));
	await service.clearNextDiagnostics();
	assert.deepEqual(probe(), restricted, "Clear cannot commit a prior failed enable or collector");
	const durable = (await TelemetrySettingsService.open(home, hello)).settings();
	assert.equal(durable.remoteOperational, false);
	assert.equal(durable.endpoint, oldEndpoint);
	const enabling = service.update({
		localDiagnostics: false,
		localFeatureUsage: false,
		remoteOperational: true,
		productAnalytics: true,
		endpoint: "https://confirmed.example/v1/traces",
	});
	assert.deepEqual(probe(), restricted, "a fresh enable remains hidden until durable");
	await enabling;
	assert.equal(service.settings().remoteOperational, true);
	assert.equal(service.nodeOptions("pilot.daemon").enabled, true);
	assert.equal(service.kernelSettings().enabled, true);
	assert.equal(service.settings().endpoint, "https://confirmed.example/v1/traces");
});

test("an already enabled exporter keeps its committed collector during failed endpoint change", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "privacy-collector-readers-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const service = await TelemetrySettingsService.open(home, hello);
	const endpoint = "https://previous.example/v1/traces";
	await service.update({
		localDiagnostics: true,
		localFeatureUsage: false,
		remoteOperational: true,
		productAnalytics: false,
		endpoint,
	});
	let checked = false;
	service.onChange((s) => {
		assert.equal(s.endpoint, endpoint);
		assert.equal(service.settings().endpoint, endpoint);
		assert.equal(service.nodeOptions("pilot.daemon").endpoint, endpoint);
		assert.equal(service.kernelSettings().endpoint, endpoint);
		checked = true;
	});
	await rename(join(home, "telemetry.json"), join(home, "before.json"));
	await mkdir(join(home, "telemetry.json"));
	await assert.rejects(
		service.update({
			localDiagnostics: false,
			localFeatureUsage: false,
			remoteOperational: true,
			productAnalytics: false,
			endpoint: "https://pending.example/v1/traces",
		}),
	);
	assert.equal(checked, true);
	assert.equal(service.settings().endpoint, endpoint);
	assert.equal(service.nodeOptions("pilot.daemon").endpoint, endpoint);
	assert.equal(service.kernelSettings().endpoint, endpoint);
});

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
