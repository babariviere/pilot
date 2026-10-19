import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@pilot/protocol";
import { openSessionStorage } from "../../kernel/src/storage.ts";
import { createAuthorization } from "./control-authorizations.ts";
import { ControlHostStore } from "./control-host-store.ts";
import { ControlHosts } from "./control-hosts.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { WatchService } from "./watch-service.ts";

const host = { hostId: "daemon", daemonId: "test-daemon", lineageId: "test-lineage" } as const;
const snapshot: AgentEvent = {
	type: "snapshot",
	entries: [],
	tools: [],
	nestedTools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
};
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "control-role-"));
	const stores: ControlHostStore[] = [];
	const managers: SessionManager[] = [];
	const watches: WatchService[] = [];
	const starts: string[] = [];
	const inputs: string[] = [];
	const projects = new ProjectStore(root);
	await projects.load();
	t.after(async () => {
		await Promise.all(managers.map((manager) => manager.shutdown()));
		await Promise.all(watches.map((service) => service.close()));
		await Promise.all(stores.map((store) => store.close()));
		await rm(root, { recursive: true, force: true });
	});
	const roles = async (platform: NodeJS.Platform, name = "state") => {
		const store = new ControlHostStore(join(root, "control-hosts", `${name}.sqlite`));
		stores.push(store);
		const hosts = new ControlHosts(host, store);
		assert.equal(hosts.legacyAllowed(), false, "unrecovered policy fails closed");
		await hosts.recoverConversationRole(platform);
		return hosts;
	};
	const manager = async (roles?: ControlHosts, realHistory = false) => {
		const sessions = new SessionManager(root, projects, join(root, "agent"), {
			title: async () => undefined,
			...(!realHistory
				? {
						snapshot: async () => ({ events: [snapshot] }),
						historyRead: async () => ({ entries: [], more: false }),
					}
				: {}),
			worker: (spec, onPacket) => {
				starts.push(spec.sessionId!);
				queueMicrotask(() =>
					onPacket({
						type: "ready",
						model: "test/model",
						working: false,
						usage: {},
					}),
				);
				return {
					state: "idle",
					busy: false,
					ready: Promise.resolve(),
					send: () => {},
					close: async () => {},
					request: async (command) => {
						if (command.type === "input") inputs.push(command.requestId);
					},
				};
			},
		});
		managers.push(sessions);
		if (roles) sessions.setControlRoleGuard(() => roles.legacyAllowed());
		await sessions.load();
		return sessions;
	};
	const watchService = async (frozen = false) => {
		const service = new WatchService(join(root, "watches.sqlite"), frozen);
		watches.push(service);
		await service.ready();
		return service;
	};
	return { root, projects, roles, manager, watchService, starts, inputs };
}

test("conversation role is persisted, lineage pinned, and independent of endpoint names or later platform hints", async (t) => {
	const f = await fixture(t);
	const executor = await f.roles("linux");
	assert.equal(executor.legacyAllowed(), false);
	await executor.store.close();
	const reopened = await f.roles("darwin");
	assert.equal(reopened.legacyAllowed(), false, "restart cannot promote an executor");
	await assert.rejects(
		new ControlHosts({ ...host, lineageId: "other" }, reopened.store).recoverConversationRole("darwin"),
		/another installation/,
	);
	const mac = await f.roles("darwin", "mac");
	assert.equal(mac.legacyAllowed(), true);
	await mac.store.close();
	await assert.rejects(mac.recoverConversationRole("darwin"));
	assert.equal(mac.legacyAllowed(), false, "failed recovery cannot retain a previously open guard");
	assert.equal((await f.roles("linux", "mac")).legacyAllowed(), true, "persisted role is authoritative");
});

test("effective non-home, freeze and archive policy override the Mac compatibility role", async (t) => {
	const f = await fixture(t);
	for (const [name, extra] of Object.entries({
		home: { role: "home" },
		executor: { role: "executor" },
		archive: { role: "archived-control", archive: { sessionId: SessionManager.CONTROL_ID, archivedAt: 1 } },
		freeze: { role: "home", freeze: { operationId: "freeze", expectedRoleEpoch: 1, phase: "requested" } },
	} as const)) {
		const roles = await f.roles("darwin", name);
		await roles.initialize({ schemaVersion: 1, roleEpoch: 1, host, home: host, ...extra });
		assert.equal(roles.legacyAllowed(), name === "home");
	}
	const linux = await f.roles("linux", "legacy-home");
	await linux.initialize({ schemaVersion: 1, roleEpoch: 1, host, home: host, role: "home" });
	assert.equal(linux.legacyAllowed(), false, "old home policy cannot enable a devbox conversation");
});

test("fresh Linux creates no Control; Mac singleton and turns remain unchanged", async (t) => {
	const f = await fixture(t);
	const linux = await f.manager(await f.roles("linux"));
	await assert.rejects(linux.ensureControlChat(), /read-only/);
	assert.equal(linux.getControlChat(), undefined);
	assert.deepEqual(linux.list(), []);
	assert.deepEqual(f.starts, []);
	await linux.shutdown();
	const mac = await f.manager(await f.roles("darwin", "mac"));
	const control = await mac.ensureControlChat();
	assert.equal((await mac.ensureControlChat()).id, control.id);
	await mac.send(control.id, "A local user request");
	assert.deepEqual(f.starts, [control.id]);
});

test("legacy Linux Control is a readable archive, with frozen watches and independent accepted work", async (t) => {
	const f = await fixture(t);
	const seed = await f.manager();
	const control = await seed.ensureControlChat();
	const memory = seed.controlMemory();
	await memory.append({ kind: "note", text: "Retained memory" });
	await memory.auditAppend({
		operationId: "old",
		action: "start",
		phase: "succeeded",
		at: 1,
		caller: control.id,
		args: {},
	});
	await memory.authorizationCreate(
		createAuthorization(
			"old-grant",
			{
				scope: "Old permission",
				level: "investigate",
				targets: [{ kind: "chat", id: "target" }],
			},
			{ conversationId: "1", submissionId: 1, entryId: 1, requestId: "typed" },
		),
	);
	await seed.shutdown();
	const owned = await openSessionStorage(join(f.root, "sessions", control.id, "durable"));
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Keep the saved conversation", timestamp: 1234 }],
			});
		}, context);
	} finally {
		await harness.close(context);
		owned.release();
	}
	const file = join(f.root, "sessions", control.id, "meta.json");
	const meta = JSON.parse(await readFile(file, "utf8"));
	meta.working = true;
	meta.initializing = true;
	meta.pending = [{ type: "input", requestId: "watch-notice:old", content: "Old notice", mode: "followUp" }];
	await writeFile(file, JSON.stringify(meta));
	const preserved = await readFile(file, "utf8");
	const ordinaryId = "11111111-1111-4111-8111-111111111111";
	await mkdir(join(f.root, "sessions", ordinaryId));
	await writeFile(
		join(f.root, "sessions", ordinaryId, "meta.json"),
		JSON.stringify({
			id: ordinaryId,
			cwd: f.root,
			mode: "build",
			title: "Accepted independent work",
			createdAt: 1,
			updatedAt: 1,
			pending: [{ type: "input", requestId: "control:start:accepted", content: "Continue", mode: "followUp" }],
		}),
	);
	const live = await f.watchService();
	const watch = await live.add({
		event: "chat.settled",
		target: { kind: "chat", id: "target" },
		mode: "persistent",
		note: "Old watch",
	});
	await live.followThrough("old-follow-up", "old-grant", ordinaryId);
	const event = {
		source: "target",
		version: "1",
		event: "chat.settled" as const,
		targets: [watch.target],
		at: Date.now(),
		text: "Done",
		outcome: "done" as const,
	};
	await live.observe([event]);
	await live.close();
	const frozen = await f.watchService(true);
	const roles = await f.roles("linux");
	const sessions = await f.manager(roles, true);
	// Even accidental run-binding setup cannot attach frozen legacy follow-through to accepted work.
	sessions.setWatchService(frozen);
	await sessions.send(ordinaryId, "Ordinary work remains usable");
	assert.ok(f.starts.includes(ordinaryId));
	assert.ok(f.inputs.includes("control:start:accepted"));
	assert.equal(f.starts.includes(control.id), false);
	await assert.rejects(sessions.ensureControlChat(), /read-only/);
	for (const mutate of [
		() => sessions.send(control.id, "No"),
		() => sessions.changeModel(control.id, "test/model"),
		() => sessions.stop(control.id),
		() => sessions.controlInputs(control.id, false),
		() => sessions.retryStartup(control.id),
		() => sessions.setPinned(control.id, false),
		() => sessions.rename(control.id, "No"),
		() => sessions.archive(control.id),
		() => sessions.compact(control.id),
		() => sessions.rewind(control.id, "restore", 1),
	])
		await assert.rejects(mutate(), /read-only/);
	assert.equal(sessions.isControlSession(control.id), false);
	assert.equal(sessions.canSendNotice(control.id), false);
	assert.equal(await sessions.sendNotice(control.id, "No wake", "watch-notice:new"), false);
	assert.deepEqual(await sessions.commands(control.id), []);
	assert.throws(() => sessions.setWatches(frozen), /read-only/);
	await new Promise<void>((resolve) => {
		const stop = sessions.subscribe(control.id, (events) => {
			const snapshot = events.find((event) => event.type === "snapshot");
			assert.ok(snapshot?.type === "snapshot");
			assert.equal(JSON.stringify(snapshot.entries).includes("Keep the saved conversation"), true);
			stop();
			resolve();
		});
	});
	const history = await sessions.history(control.id, Number.MAX_SAFE_INTEGER, 10);
	assert.equal(JSON.stringify(history.entries).includes("Keep the saved conversation"), true);
	assert.equal(history.more, false);
	assert.equal((await sessions.controlMemory().messages()).messages[0]?.text, "Retained memory");
	assert.equal((await sessions.controlAudit().page())[0]?.operationId, "old");
	assert.equal((await sessions.controlAuthorizationPage()).authorizations[0]?.id, "old-grant");
	await assert.rejects(
		sessions.controlAudit().perform(control.id, "start", {}, "new", async () => assert.fail("effect")),
		/Only the control chat/,
	);
	assert.equal(await frozen.observe([{ ...event, version: "2" }]), 0);
	assert.deepEqual(await frozen.targets("chat"), []);
	assert.equal((await frozen.page()).watches[0]?.id, watch.id);
	assert.equal(await frozen.followThroughActive("old-follow-up"), true, "preserved evidence is not deleted");
	await assert.rejects(frozen.followThrough("new", "old-grant", ordinaryId), /frozen/);
	let delivered = 0;
	frozen.bindSink({
		sessionId: control.id,
		canSend: () => true,
		deliver: async () => {
			delivered++;
			return true;
		},
	});
	await frozen.flush(Date.now() + 60_000);
	assert.equal(delivered, 0);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.root, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		new ModelCatalog(f.root),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/control-chat`;
	assert.equal((await fetch(base)).status, 200);
	assert.equal((await fetch(base, { method: "POST" })).status, 409);
	for (const path of ["/memory/messages", "/memory/view", "/memory/stats", "/audit", "/authorizations"])
		assert.equal((await fetch(base + path)).status, 200, path);
	assert.equal((await fetch(`${base}/authorizations/old-grant`, { method: "DELETE" })).status, 409);
	assert.equal((await sessions.controlAuthorizationPage()).authorizations[0]?.revokedAt, undefined);
	assert.equal(await readFile(file, "utf8"), preserved, "reads/refusals never rewrite archived metadata");
	assert.equal(f.starts.includes(control.id), false);
});
