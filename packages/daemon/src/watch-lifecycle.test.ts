import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary, WatchInput } from "@pilot/protocol";
import { importLegacyWatchAuthorizations, legacyWatchAuthorization } from "./control-authorizations.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlMemoryDisk } from "./control-memory-disk.ts";
import { watchNoticeContent } from "./control-watches.ts";
import { MissionStore } from "./missions.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";
import type { WatchNotice, WatchRemoval } from "./watch-delivery.ts";
import { WatchLifecycle } from "./watch-lifecycle.ts";
import { WatchService } from "./watch-service.ts";

const input: WatchInput = {
	event: "chat.settled",
	target: { kind: "chat", id: "c" },
	mode: "once",
	note: "Do not run this removed instruction",
};
async function chatWatches(watches: WatchService, id: string) {
	return Promise.all(
		(["once", "persistent"] as const).flatMap((mode) => [
			watches.add({ ...input, mode, target: { kind: "chat", id } }),
			watches.add({ ...input, mode, event: "pr.merged", target: { kind: "chat_prs", id } }),
		]),
	);
}
function collector(watches: WatchService) {
	const notices: WatchNotice[] = [];
	watches.bindSink({
		sessionId: "control",
		canSend: () => true,
		deliver: async (notice) => {
			notices.push(notice);
			return true;
		},
	});
	return notices;
}
function fakeSessions(chats: Map<string, SessionSummary>) {
	return {
		get: (id: string) => chats.get(id),
	};
}

test("archiving a real parked chat removes both watch kinds and modes, audits each, and restore never recreates them", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "watch-archive-"));
	const id = randomUUID();
	await mkdir(join(home, "sessions", id), { recursive: true });
	await writeFile(
		join(home, "sessions", id, "meta.json"),
		JSON.stringify({ id, cwd: home, title: "Parked", createdAt: Date.now(), updatedAt: Date.now() }),
	);
	const projects = new ProjectStore(home);
	await projects.load();
	let starts = 0;
	const sessions = new SessionManager(home, projects, undefined, {
		worker: () => {
			starts++;
			throw new Error("must stay asleep");
		},
	});
	const watches = new WatchService(":memory:");
	let unbind = () => {};
	t.after(async () => {
		unbind();
		await sessions.shutdown();
		await watches.close();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	await sessions.ensureControlChat();
	watches.bindRemovalAudit((removal) => sessions.auditWatchRemoval(removal));
	unbind = sessions.setWatches(watches);
	// No Control worker or notice delivery is needed for cleanup or auditing.
	watches.bindSink(undefined);
	const removed = await chatWatches(watches, id);
	const untouched = await watches.add({ ...input, target: { kind: "project", id: "p" } });
	await importLegacyWatchAuthorizations(() => sessions.controlAuthorizations(), watches);
	await sessions.archive(id);
	assert.deepEqual(
		(await watches.list()).map((w) => w.id),
		[untouched.id],
	);
	assert.equal(starts, 0);
	let audit = await sessions.controlAudit().page();
	assert.equal(audit.length, 8);
	const removals = audit.filter((entry) => entry.action === "unwatch");
	assert.deepEqual(new Set(removals.map((entry) => entry.args.watchId)), new Set(removed.map((w) => w.id)));
	assert.ok(removals.every((entry) => (entry.result as { reason: string }).reason === "removed: chat archived"));
	for (const watch of removed) {
		const grant = await sessions.controlAuthorizations().authorizationGet(`watch:${watch.id}`);
		assert.equal(typeof grant?.revokedAt, "number");
		assert.ok(audit.some((entry) => entry.action === "revokeAuthorization" && entry.authorizationId === grant?.id));
	}
	assert.equal(
		(await sessions.controlAuthorizations().authorizationGet(`watch:${untouched.id}`))?.revokedAt,
		undefined,
	);
	await sessions.restore(id);
	await sessions.archive(id);
	assert.deepEqual(
		(await watches.list()).map((w) => w.id),
		[untouched.id],
	);
	assert.equal((await sessions.controlAudit().page()).length, 8);
	const notices = collector(watches);
	await watches.flush(Date.now() + 60_000);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.items.length, 1, "one notice item for the archive, not one per watch");
	for (const watch of removed) assert.ok(notices[0]!.items[0]!.text.includes(watch.id));
	const content = watchNoticeContent(notices[0]!);
	assert.match(content, /meaningful changes/);
	assert.match(content, /information only/);
	assert.doesNotMatch(content, /Do not run this removed instruction|Instruction:/);
	await sessions.auditWatchRemoval({ watch: removed[0]!, reason: "chat archived", at: Date.now() });
	audit = await sessions.controlAudit().page();
	assert.equal(audit.length, 8, "replaying an audit after a crash is idempotent");
});

test("mission Done retains watches; archive removes both modes, survives immediate unarchive, and leaves other targets alone", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "watch-mission-archive-"));
	const memory = new ControlMemory(home);
	const store = new MissionStore(":memory:");
	const watches = new WatchService(":memory:");
	const source = new WatchLifecycle(watches, fakeSessions(new Map()), store, () => memory);
	t.after(async () => {
		await source.stop();
		await watches.close();
		await memory.stop();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const mission = store.create({ projectId: "p", title: "Mission" });
	const other = store.create({ projectId: "p", title: "Other" });
	const removed = await Promise.all(
		(["once", "persistent"] as const).map((mode) =>
			watches.add({ ...input, event: "mission.done", target: { kind: "mission", id: mission.id }, mode }),
		),
	);
	const kept = await Promise.all([
		watches.add({ ...input, event: "mission.done", target: { kind: "mission", id: other.id } }),
		watches.add({ ...input, target: { kind: "project", id: "p" } }),
		watches.add({
			...input,
			event: "pr.merged",
			target: { kind: "pr", id: "https://github.com/example/repo/pull/1" },
		}),
		watches.add({ ...input, event: "linear.done", target: { kind: "linear", id: "ABC-1" } }),
	]);
	await importLegacyWatchAuthorizations(() => memory, watches);
	const shared = await memory.authorizationCreate({
		id: "shared",
		scope: "Follow this mission",
		level: "publish",
		targets: [{ kind: "mission", id: mission.id }],
		limits: { followUps: 2 },
		createdAt: Date.now(),
	});
	const sharedWatch = await watches.add({
		...input,
		event: "mission.done",
		target: { kind: "mission", id: mission.id },
		authorizationId: shared.id,
	});
	store.update(mission.id, { status: "done" });
	await source.idle();
	await source.reconcile();
	assert.equal((await watches.list()).length, 7);
	for (const watch of removed)
		assert.equal((await memory.authorizationGet(`watch:${watch.id}`))?.revokedAt, undefined);
	const audit: WatchRemoval[] = [];
	watches.bindRemovalAudit(async (removal) => {
		await memory.auditWatchRemoval(removal);
		audit.push(removal);
	});
	store.update(mission.id, { status: "archived" });
	store.update(mission.id, { status: "active" });
	await source.idle();
	assert.deepEqual(new Set((await watches.list()).map((w) => w.id)), new Set(kept.map((w) => w.id)));
	assert.deepEqual(new Set(audit.map((row) => row.watch.id)), new Set([...removed, sharedWatch].map((w) => w.id)));
	assert.ok(audit.every((row) => row.reason === "mission archived"));
	for (const watch of removed)
		assert.equal(typeof (await memory.authorizationGet(`watch:${watch.id}`))?.revokedAt, "number");
	assert.equal(
		(await memory.authorizationGet(shared.id))?.revokedAt,
		undefined,
		"removing a watch must not revoke a shared grant",
	);
	const sent = collector(watches);
	await watches.flush(Date.now() + 60_000);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.items.length, 1);
	assert.match(sent[0]!.items[0]!.text, /mission archived/);
	await source.reconcile();
	assert.deepEqual(new Set((await watches.list()).map((w) => w.id)), new Set(kept.map((w) => w.id)));
});

test("restart reconciles archived and deleted chats and missions, including a cleanup interrupted before audit delivery", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "watch-reconcile-"));
	const path = join(dir, "watches.sqlite");
	let memory = new ControlMemory(dir);
	const store = new MissionStore(":memory:");
	const archived = store.create({ projectId: "p", title: "Archived" });
	const done = store.create({ projectId: "p", title: "Done" });
	store.update(archived.id, { status: "archived" });
	store.update(done.id, { status: "done" });
	let watches = new WatchService(path);
	let source: WatchLifecycle | undefined;
	t.after(async () => {
		await source?.stop();
		await watches.close();
		await memory.stop();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});
	const chats = new Map<string, SessionSummary>([
		["archived", { id: "archived", archivedAt: 123 } as SessionSummary],
		["active", { id: "active" } as SessionSummary],
	]);
	const removed = [...(await chatWatches(watches, "archived")), ...(await chatWatches(watches, "deleted"))];
	removed.push(await watches.add({ ...input, event: "mission.done", target: { kind: "mission", id: archived.id } }));
	removed.push(
		await watches.add({ ...input, event: "mission.done", target: { kind: "mission", id: "deleted-mission" } }),
	);
	const kept = [
		...(await chatWatches(watches, "active")),
		await watches.add({
			...input,
			event: "mission.done",
			target: { kind: "mission", id: done.id },
			mode: "persistent",
		}),
	];
	await importLegacyWatchAuthorizations(() => memory, watches);
	// Simulate crashing after one atomic cleanup, before its audit is copied to Control.
	assert.equal(await watches.removeTarget("chat", "archived", "chat archived"), 4);
	await watches.close();
	await memory.stop();
	watches = new WatchService(path);
	memory = new ControlMemory(dir);
	const audit: WatchRemoval[] = [];
	watches.bindRemovalAudit(async (row) => {
		await memory.auditWatchRemoval(row);
		audit.push(row);
	});
	source = new WatchLifecycle(watches, fakeSessions(chats), store, () => memory);
	await source.reconcile();
	assert.deepEqual(new Set((await watches.list()).map((w) => w.id)), new Set(kept.map((w) => w.id)));
	assert.deepEqual(new Set(audit.map((row) => row.watch.id)), new Set(removed.map((w) => w.id)));
	assert.equal(audit.filter((row) => row.reason === "chat deleted").length, 4);
	for (const watch of removed)
		assert.equal(typeof (await memory.authorizationGet(`watch:${watch.id}`))?.revokedAt, "number");
	for (const watch of kept) assert.equal((await memory.authorizationGet(`watch:${watch.id}`))?.revokedAt, undefined);
	const notices = collector(watches);
	await watches.flush(Date.now() + 60_000);
	assert.equal(notices[0]!.items.length, 4, "one informational item per removed target");
	assert.ok(notices[0]!.items.every((item) => item.event === "watch.removed"));
	await source.stop();
	await watches.close();
	watches = new WatchService(path);
	watches.bindRemovalAudit(async (row) => {
		await memory.auditWatchRemoval(row);
		audit.push(row);
	});
	source = new WatchLifecycle(watches, fakeSessions(chats), store, () => memory);
	await source.reconcile();
	const repeated = collector(watches);
	await watches.flush(Date.now() + 120_000);
	assert.equal(repeated.length, 0);
	assert.equal(audit.length, removed.length);
});

test("startup revokes pre-upgrade orphan grants, including an acknowledged removal followed by restore, but preserves fired authority", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "watch-orphan-grants-"));
	const memory = new ControlMemory(home);
	const watches = new WatchService(":memory:");
	const store = new MissionStore(":memory:");
	const chats = new Map<string, SessionSummary>([
		["restored", { id: "restored" } as SessionSummary],
		["archived", { id: "archived", archivedAt: 1 } as SessionSummary],
		["active", { id: "active" } as SessionSummary],
	]);
	const source = new WatchLifecycle(watches, fakeSessions(chats), store, () => memory);
	t.after(async () => {
		await source.stop();
		await watches.close();
		await memory.stop();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const restored = await watches.add({ ...input, target: { kind: "chat", id: "restored" } });
	const archived = await watches.add({ ...input, target: { kind: "chat_prs", id: "archived" }, event: "pr.merged" });
	const deletedMission = await watches.add({
		...input,
		event: "mission.done",
		target: { kind: "mission", id: "deleted" },
	});
	const fired = await watches.add({ ...input, target: { kind: "chat", id: "active" } });
	await importLegacyWatchAuthorizations(() => memory, watches);
	// Fill the first authorization page, so watch grants must be reconciled on a later page.
	await memory.authorizationImport(
		Array.from({ length: 100 }, (_, i) => ({
			id: `auth-${i}`,
			scope: "Other user scope",
			level: "publish" as const,
			targets: [{ kind: "chat" as const, id: "archived" }],
			limits: { followUps: 2 },
			createdAt: 1,
		})),
	);
	// Old cleanup acknowledged its removal audit, without revoking the grant.
	watches.bindRemovalAudit(async ({ watch, reason, at }) => {
		await memory.auditAppend({
			operationId: `watch-removed:${watch.id}`,
			action: "unwatch",
			phase: "succeeded",
			at,
			caller: "daemon",
			args: { watchId: watch.id },
			result: { removed: true, reason: `removed: ${reason}` },
		});
	});
	await watches.removeTarget("chat", "restored", "chat archived");
	await watches.remove(archived.id);
	await watches.remove(deletedMission.id);
	// A fired once-watch has no live row either, but still authorizes its frozen delivery.
	const notices = collector(watches);
	await watches.observe([
		{
			source: "active",
			version: "1",
			event: "chat.settled",
			targets: [fired.target],
			at: Date.now(),
			text: "finished",
		},
	]);
	await watches.flush(Date.now() + 60_000);
	const delivery = notices.find((notice) => notice.items.some((item) => item.watchId === fired.id))!;
	assert.ok(await watches.authority(fired.id, delivery.requestId));
	assert.equal((await watches.list()).length, 0);
	await source.reconcile();
	for (const watch of [restored, archived, deletedMission]) {
		assert.equal(typeof (await memory.authorizationGet(`watch:${watch.id}`))?.revokedAt, "number");
		assert.ok(await memory.auditOperation(`watch-authorization-revoked:${watch.id}`));
	}
	assert.equal((await memory.authorizationGet(`watch:${fired.id}`))?.revokedAt, undefined);
	assert.equal(
		(await memory.authorizationGet("auth-0"))?.revokedAt,
		undefined,
		"ordinary grants are not watch grants",
	);
	const audit = await memory.auditPage();
	await source.reconcile();
	assert.deepEqual(await memory.auditPage(), audit, "repeated reconciliation is idempotent");
});

test("watch revocation and removal audits roll back together and replay only once", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "watch-removal-atomic-"));
	const memory = new ControlMemoryDisk(home);
	t.after(async () => {
		memory.close();
		await rm(home, { recursive: true, force: true });
	});
	const watch = { ...input, id: randomUUID(), createdAt: 1 };
	memory.authorizations.create(legacyWatchAuthorization(watch));
	const removal = { watch, reason: "chat archived" as const, at: 123 };
	assert.throws(
		() => memory.auditWatchRemoval({ ...removal, watch: { ...watch, note: "x".repeat(64_000) } }),
		/64 KB/,
	);
	assert.equal(memory.authorizations.get(`watch:${watch.id}`)?.revokedAt, undefined);
	assert.deepEqual(memory.auditPage(), []);
	assert.equal(memory.auditWatchRemoval(removal), true);
	assert.equal(memory.authorizations.get(`watch:${watch.id}`)?.revokedAt, 123);
	assert.equal(memory.auditPage().length, 2);
	assert.equal(memory.auditWatchRemoval(removal), false);
	assert.equal(memory.auditPage().length, 2);
});
