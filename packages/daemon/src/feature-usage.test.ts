import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FeatureUsageBatch } from "@pilot/protocol";
import { FeatureUsageStore, parseFeatureUsageBatch } from "./feature-usage.ts";
import { TelemetrySettingsService } from "./telemetry-settings.ts";

const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
const now = Date.parse("2026-10-19T12:00:00Z");
function batch(epoch: string): FeatureUsageBatch {
	return { schemaVersion: 1, epoch, producer: randomUUID(), revision: 1,
		startedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), dropped: 0,
		cells: [{ catalogVersion: 1, feature: "diagnose_chat", stage: "attempt", day: "2026-10-19", count: 3 }] };
}
test("local feature aggregates default off, deduplicate revisions, clear/fence and persist without raw events", async t => {
	const home = await mkdtemp(join(tmpdir(), "feature-usage-"));
	const store = new FeatureUsageStore(home, () => now);
	t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }); });
	await store.load(false);
	assert.equal(store.snapshot(host).status, "disabled");
	assert.deepEqual(store.snapshot(host).cells, []);
	await assert.rejects(store.replace(batch(randomUUID())), /disabled/);
	await store.configure(true);
	assert.equal(store.snapshot(host).reason, "no_producer");
	const input = batch(store.collectionEpoch!);
	await store.replace(input); await store.replace(input);
	await store.replace({ ...input, revision: 0, cells: [] });
	assert.equal(store.snapshot(host).cells[0]?.count, 3);
	assert.equal(store.snapshot(host).status, "partial");
	assert.equal((await stat(store.file)).mode & 0o777, 0o600);
	const reopened = new FeatureUsageStore(home, () => now);
	await reopened.load(true);
	assert.equal(reopened.snapshot(host).cells[0]?.count, 3);
	await reopened.close();
	await store.clear();
	assert.notEqual(store.collectionEpoch, input.epoch);
	await assert.rejects(store.replace(input), /changed/);
	assert.deepEqual(store.snapshot(host).cells, []);
	await store.configure(false);
	await assert.rejects(readFile(store.file), { code: "ENOENT" });
});
test("feature aggregate parser is closed and bounded", () => {
	const input = batch(randomUUID());
	for (const value of [{ ...input, transcript: "secret-canary" },
		{ ...input, cells: [{ ...input.cells[0], raw: "secret-canary" }] },
		{ ...input, cells: [{ ...input.cells[0], count: 70_001 }] },
		{ ...input, cells: Array(337).fill(input.cells[0]) },
		{ ...input, cells: [input.cells[0], input.cells[0]] },
		{ ...input, cells: [{ ...input.cells[0], feature: "arbitrary" }] },
		{ ...input, observedAt: "2099-01-01T00:00:00Z" }]) assert.throws(() => parseFeatureUsageBatch(value, now));
	assert.equal(parseFeatureUsageBatch(input, now).cells[0]?.count, 3);
});
test("retention and producer caps report missing observations, never complete zero", async t => {
	const home = await mkdtemp(join(tmpdir(), "feature-retention-"));
	let clock = now;
	const store = new FeatureUsageStore(home, () => clock);
	t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }); });
	await store.configure(true);
	for (let i = 0; i < 17; i++) await store.replace(batch(store.collectionEpoch!));
	assert.equal(store.snapshot(host).prunedProducers, 1);
	assert.equal(store.snapshot(host).cells[0]?.count, 48);
	clock += 8 * 86_400_000;
	const snapshot = store.snapshot(host);
	assert.equal(snapshot.status, "unavailable");
	assert.equal(snapshot.reason, "no_producer");
	assert.deepEqual(snapshot.cells, []);
	const expired = new FeatureUsageStore(home, () => clock);
	await expired.load(true);
	assert.equal(JSON.parse(await readFile(expired.file, "utf8")).batches.length, 0);
	await expired.close();
});
test("unsafe or oversized aggregate storage reports unavailable without exposing content", async t => {
	const home = await mkdtemp(join(tmpdir(), "feature-unsafe-"));
	const store = new FeatureUsageStore(home, () => now);
	t.after(async () => { await store.close(); await rm(home, { recursive: true, force: true }); });
	const outside = join(home, "outside");
	await writeFile(outside, "secret-canary"); await symlink(outside, store.file);
	await store.load(true);
	assert.equal(store.snapshot(host).reason, "storage_unavailable");
	assert.doesNotMatch(JSON.stringify(store.snapshot(host)), /secret-canary/);
	assert.equal(await readFile(outside, "utf8"), "secret-canary");
});
test("local feature consent is independent of export and old-client writes preserve it", async t => {
	const home = await mkdtemp(join(tmpdir(), "feature-consent-"));
	const service = await TelemetrySettingsService.open(home, { daemonId: host.daemonId, lineageId: host.lineageId,
		daemonVersion: "1.0.0" } as Parameters<typeof TelemetrySettingsService.open>[1]);
	t.after(async () => { await service.featureUsage.close(); await rm(home, { recursive: true, force: true }); });
	assert.equal(service.settings().localFeatureUsage, false);
	await service.update({ localDiagnostics: false, localFeatureUsage: true, remoteOperational: false, productAnalytics: false });
	assert.ok(service.settings().featureUsageEpoch);
	assert.equal(service.settings().remoteOperational, false);
	await service.update({ localDiagnostics: true, remoteOperational: false, productAnalytics: false });
	assert.equal(service.settings().localFeatureUsage, true);
	assert.equal(service.kernelSettings().enabled, false);
	await service.update({ localDiagnostics: true, localFeatureUsage: false, remoteOperational: false, productAnalytics: false });
	assert.equal(service.settings().featureUsageEpoch, undefined);
});
