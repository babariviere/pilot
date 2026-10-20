import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type TestContext, test } from "node:test";
import {
	REFRESH_EVIDENCE_AGE_MS,
	REFRESH_EVIDENCE_BYTES,
	RefreshEvidenceStore,
	validRefreshValue,
} from "./refresh-evidence.ts";

const host = { hostId: "daemon", daemonId: "fixture", lineageId: "lineage" };
const source = (now: number) => ({
	lastAttemptAt: now,
	lastStartedAt: now,
	lastCompletedAt: now,
	outcome: "success",
	stages: [{ stage: "commit", outcome: "success", count: 0 }],
});
async function directory(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "refresh-evidence-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	return join(root, "evidence");
}

test("restart retains success/failure/inflight as historical only, with exact host/config fences and private files", async (t) => {
	const root = await directory(t);
	let now = 100_000;
	const first = new RefreshEvidenceStore({ directory: root, host, enabled: true, now: () => now });
	await first.load();
	const ref = first.ref("source", "private-project:linear", "config-generation");
	const running = first.ref("job", "private-job", "config-generation");
	first.schedule(() => [
		{ ref, type: "source", value: source(now) },
		{
			ref: running,
			type: "job",
			value: {
				job: "linked_linear_sync",
				kind: "linear",
				startedAt: now,
				queued: true,
				nextDueAt: now + 5000,
				readCalls: 1,
				writeCalls: 0,
			},
		},
	]);
	await first.close();
	assert.equal(first.read(ref), undefined);
	const bytes = await readFile(join(root, "refresh-health.json"), "utf8");
	assert.doesNotMatch(bytes, /private-project|private-job|config-generation|fixture|lineage/);
	assert.ok(Buffer.byteLength(bytes) <= REFRESH_EVIDENCE_BYTES);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	assert.equal((await stat(join(root, "refresh-health.json"))).mode & 0o777, 0o600);
	now++;
	const reopened = new RefreshEvidenceStore({ directory: root, host, enabled: true, now: () => now });
	await reopened.load();
	t.after(() => reopened.close());
	assert.equal(reopened.read(ref)?.state, "historical_observation");
	assert.equal(reopened.read(running)?.state, "interrupted_unknown");
	assert.equal(reopened.read(running)?.observation.queued, undefined);
	assert.equal(reopened.read(running)?.observation.nextDueAt, undefined);
	assert.equal(reopened.read(first.ref("source", "private-project:linear", "new-generation")), undefined);
	const other = new RefreshEvidenceStore({
		directory: root,
		host: { ...host, lineageId: "other" },
		enabled: true,
		now: () => now,
	});
	await other.load();
	assert.equal(other.read(ref), undefined);
	await other.close();
	now += REFRESH_EVIDENCE_AGE_MS + 1;
	assert.equal(reopened.read(ref), undefined);
});

test("clear/disable fences an in-flight atomic commit and never resurrects collected state", async (t) => {
	for (const disable of [false, true]) {
		const root = await directory(t);
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const store = new RefreshEvidenceStore({
			directory: root,
			host,
			enabled: true,
			now: () => 1000,
			beforeCommit: async () => {
				enter();
				await held;
			},
		});
		await store.load();
		const ref = store.ref("source", "id", "config");
		store.schedule(() => [{ ref, type: "source", value: source(1000) }]);
		const pending = store.flush();
		await entered;
		if (disable) store.setEnabled(false);
		const clear = store.clear();
		release();
		await pending;
		await clear;
		await store.close();
		await assert.rejects(readFile(join(root, "refresh-health.json")), { code: "ENOENT" });
		const reopened = new RefreshEvidenceStore({ directory: root, host, enabled: true });
		await reopened.load();
		assert.equal(reopened.read(ref), undefined);
		await reopened.close();
	}
});

test("strict schema, count/byte/age bounds, coalescing and interrupted-file/corruption safety", async (t) => {
	const root = await directory(t),
		now = Date.now();
	assert.equal(validRefreshValue("source", { ...source(now), error: "private" }), false);
	assert.equal(
		validRefreshValue("job", { job: "manual_lookup", kind: "linear", stage: "private", readCalls: 0, writeCalls: 0 }),
		false,
	);
	const store = new RefreshEvidenceStore({ directory: root, host, enabled: true, now: () => now });
	await store.load();
	let collections = 0;
	const collect = () => {
		collections++;
		return Array.from({ length: 200 }, (_, i) => ({
			ref: store.ref("source", String(i), "key"),
			type: "source" as const,
			value: {
				...source(now),
				stages: [
					"discovery",
					"classification",
					"commit",
					"waiting_replies",
					"reaction_reads",
					"parent_headers",
				].map((stage) => ({
					stage,
					lastStartedAt: now,
					lastCompletedAt: now,
					lastSucceededAt: now,
					outcome: "success",
					count: 1000,
					requested: 1000,
					readAttempts: 1000,
					cacheHits: 1000,
				})),
			},
		}));
	};
	const start = performance.now();
	for (let i = 0; i < 10_000; i++) store.schedule(collect);
	t.diagnostic(`10,000 save notifications: ${(performance.now() - start).toFixed(2)} ms, no inline snapshot/IO`);
	assert.equal(collections, 0);
	const cpu = process.threadCpuUsage();
	await store.flush();
	const used = process.threadCpuUsage(cpu);
	t.diagnostic(
		`coalesced bounded save main-thread CPU: ${((used.user + used.system) / 1000).toFixed(2)} ms (async file IO)`,
	);
	assert.equal(collections, 1);
	assert.ok(store.coverage().dropped >= 72);
	const file = join(root, "refresh-health.json");
	assert.ok((await stat(file)).size <= REFRESH_EVIDENCE_BYTES);
	await store.close();
	await writeFile(join(root, ".refresh-health.tmp"), "private-partial", { mode: 0o600 });
	const good = new RefreshEvidenceStore({ directory: root, host, enabled: true, now: () => now });
	await good.load();
	assert.ok(good.read(store.ref("source", "0", "key")));
	await good.close();
	await writeFile(file, "{partial", { mode: 0o600 });
	const corrupt = new RefreshEvidenceStore({ directory: root, host, enabled: true });
	await corrupt.load();
	assert.ok(corrupt.coverage().error);
	await corrupt.clear();
	await corrupt.close();
	await writeFile(file, JSON.stringify({ schemaVersion: 2 }), { mode: 0o600 });
	const newer = new RefreshEvidenceStore({ directory: root, host, enabled: true });
	await newer.load();
	assert.equal(newer.coverage().error, "version");
	newer.schedule(collect);
	await newer.flush();
	assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, 2);
	await newer.clear();
	await newer.close();
});

test("unsafe roots/files, permissions and storage errors remain evidence failures, not workflow errors", async (t) => {
	const root = await directory(t);
	await mkdir(root, { mode: 0o700 });
	const outside = join(root, "outside");
	await writeFile(outside, "untouched", { mode: 0o600 });
	await symlink(outside, join(root, "refresh-health.json"));
	const store = new RefreshEvidenceStore({ directory: root, host, enabled: true });
	await store.load();
	const ref = store.ref("source", "id", "config");
	store.schedule(() => [{ ref, type: "source", value: source(Date.now()) }]);
	await store.flush();
	assert.equal(store.coverage().error, "write_failed");
	assert.equal(await readFile(outside, "utf8"), "untouched");
	await store.close();
	await rm(join(root, "refresh-health.json"));
	await chmod(root, 0o755);
	const permissions = new RefreshEvidenceStore({ directory: root, host, enabled: true });
	await permissions.load();
	assert.ok(permissions.coverage().error);
	await permissions.close();
});
