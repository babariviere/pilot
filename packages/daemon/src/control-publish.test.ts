import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ControlPermission, KernelCommand, KernelPacket } from "@pilot/kernel";
import type { ControlAuthorization } from "@pilot/protocol";
import { controlPermissionBlock } from "../../kernel/src/tool-policy.ts";
import { ControlPilot } from "./control-pilot.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { WatchService } from "./watch-service.ts";

const caller = SessionManager.CONTROL_ID;
const userMessage = { conversationId: "1", submissionId: 10, entryId: 20, requestId: "typed-user" };

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "control-publish-"));
	const home = join(root, "home");
	const source = join(root, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const watches = new WatchService(join(home, "watches.sqlite"));
	const managers: SessionManager[] = [];
	const admitted = new Set<string>();
	const awaitingAdmission = new Map<string, () => void>();
	const workers: Array<{ spec: Extract<KernelCommand, { type: "start" }>["spec"]; worker: SessionWorker }> = [];
	const open = async () => {
		const sessions = new SessionManager(home, projects, undefined, {
			title: async () => undefined,
			worker: (spec, onPacket, onExit) => {
				const worker: SessionWorker = {
					ready: Promise.resolve(),
					state: "idle",
					busy: false,
					send: () => {},
					request: async (command) => {
						if (command.type === "input") {
							const packet: KernelPacket = {
								type: "accepted",
								requestId: command.requestId,
								delivery: "delivered",
							};
							onPacket(packet);
							worker.state = "working";
							onPacket({ type: "working", working: true });
							admitted.add(spec.sessionId);
							awaitingAdmission.get(spec.sessionId)?.();
						}
					},
					close: async () => {
						onExit(worker, 0);
					},
				};
				workers.push({ spec, worker });
				return worker;
			},
		});
		managers.push(sessions);
		await sessions.load();
		await sessions.ensureControlChat();
		const service = new ControlPilot({
			isControl: (id) => sessions.isControlSession(id),
			sessions,
			controlPermission: sessions.controlPermission.bind(sessions),
			authorizations: () => sessions.controlAuthorizations(),
			turnOrigin: async () => ({ requestId: userMessage.requestId, userMessage }),
			projects: () => [],
			missions: () => [],
			linear: () => [],
			watches,
			mutations: {
				audit: () => sessions.controlAudit(),
				startProject: (request, permission) =>
					sessions.controlStart(
						() => sessions.spawn({ cwd: source, message: request.message, mode: request.mode }),
						permission,
					),
				startTask: async () => {
					throw new Error("unused");
				},
				send: sessions.sendReported.bind(sessions),
				upgradePermission: sessions.upgradeControlPermission.bind(sessions),
			},
		});
		return { sessions, service };
	};
	const first = await open();
	let operation = 0;
	const authorize = (targets: unknown[], level = "publish") =>
		first.service.call(
			caller,
			"authorize",
			{
				scope: "Publish this change only",
				level,
				targets,
			},
			`grant-${++operation}`,
		) as Promise<ControlAuthorization>;
	const start = async (level: "investigate" | "implement" = "implement") => {
		const grant = await authorize([{ kind: "project", id: "p" }], level);
		const result = (await first.service.call(
			caller,
			"start",
			{
				projectId: "p",
				message: "work locally",
				model: "test/model",
				mode: level === "implement" ? "build" : "ask",
				authorizationId: grant.id,
			},
			`start-${++operation}`,
		)) as { id: string };
		if (!admitted.has(result.id))
			await new Promise<void>((resolve) => {
				awaitingAdmission.set(result.id, resolve);
			});
		return { id: result.id, grant };
	};
	const upgrade = (id: string, authorizationId: string, operationId = `upgrade-${++operation}`, extra = {}) =>
		first.service.call(
			caller,
			"upgrade_permission",
			{ sessionId: id, authorizationId, level: "publish", ...extra },
			operationId,
		);
	const stored = async (id: string) =>
		JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8")) as {
			controlPermission?: ControlPermission;
			pendingControlPermission?: ControlPermission;
		};
	t.after(async () => {
		for (const manager of managers) await manager.shutdown();
		await watches.close();
		await rm(root, { recursive: true, force: true });
	});
	return { ...first, home, open, workers, authorize, start, upgrade, stored };
}

test("explicit upgrade is audited, durable, idempotent and leaves a busy run implement-only", async (t) => {
	const f = await fixture(t);
	const { id, grant: build } = await f.start();
	const workerPermission = f.workers.at(-1)!.spec.pilot!.controlPermission!;
	const publish = await f.authorize([{ kind: "chat", id }]);
	const args = { sessionId: id, message: "publish", level: "publish", authorizationId: publish.id };
	const sent = await f.service.call(caller, "send", args, "send-before-upgrade");
	assert.match(JSON.stringify(sent), /permission unchanged/);
	assert.deepEqual(f.sessions.controlPermission(id), { authorizationId: build.id, level: "implement" });
	for (const command of ["git push", "gh pr create --fill"])
		assert.ok(controlPermissionBlock(workerPermission, "bash", { command }));
	const result = await f.upgrade(id, publish.id, "upgrade");
	assert.deepEqual(await f.upgrade(id, publish.id, "upgrade"), result);
	assert.deepEqual(await f.upgrade(id, publish.id, "upgrade-retry"), result);
	assert.equal(f.workers.at(-1)!.worker.state, "working");
	assert.equal(workerPermission.level, "implement", "active worker's spawn authority is untouched");
	assert.deepEqual((await f.stored(id)).pendingControlPermission, { authorizationId: publish.id, level: "publish" });
	assert.equal((await f.stored(id)).controlPermission?.level, "implement");
	const entries = (await f.sessions.controlAudit().page()).filter((entry) => entry.action === "upgrade_permission");
	assert.deepEqual(
		entries.map((entry) => entry.phase),
		["succeeded", "requested", "succeeded", "requested"],
	);
	assert.ok(entries.every((entry) => entry.authorizationId === publish.id));
	await f.sessions.shutdown();
	const recovered = await f.open();
	assert.equal(recovered.sessions.controlPermission(id)?.level, "implement", "recovery of an old run cannot publish");
	assert.deepEqual((await f.stored(id)).pendingControlPermission, { authorizationId: publish.id, level: "publish" });
	const applied = await recovered.sessions.prepareControlPermission(id);
	assert.deepEqual(applied, { authorizationId: publish.id, level: "publish" });
	assert.equal((await f.stored(id)).pendingControlPermission, undefined);
	for (const command of ["git push", "gh pr create --fill"])
		assert.equal(controlPermissionBlock(applied, "bash", { command }), undefined);
	await recovered.sessions.shutdown();
	const again = await f.open();
	assert.deepEqual(again.sessions.controlPermission(id), applied, "effective permission survives another restart");
	assert.deepEqual(
		await again.service.call(
			caller,
			"upgrade_permission",
			{
				sessionId: id,
				authorizationId: publish.id,
				level: "publish",
			},
			"upgrade",
		),
		result,
		"audited retry survives restart",
	);
});

test("upgrade denies wrong, enclosing, legacy, revoked, expired and non-publish grants", async (t) => {
	const f = await fixture(t);
	const { id } = await f.start();
	for (const targets of [
		[{ kind: "chat", id: "wrong" }],
		[{ kind: "project", id: "p" }],
		[{ kind: "mission", id: "m" }],
		[{ kind: "chat_prs", id }],
	]) {
		const grant = await f.authorize(targets);
		await assert.rejects(f.upgrade(id, grant.id), /exact chat/);
	}
	for (const level of ["investigate", "implement", "merge"]) {
		const grant = await f.authorize([{ kind: "chat", id }], level);
		await assert.rejects(f.upgrade(id, grant.id), /level|publish authorization/);
	}
	const revoked = await f.authorize([{ kind: "chat", id }]);
	await f.sessions.controlAuthorizations().authorizationRevoke(revoked.id);
	await assert.rejects(f.upgrade(id, revoked.id), /revoked/);
	const expired = await f.sessions.controlAuthorizations().authorizationCreate({
		id: "expired",
		scope: "old approval",
		userMessage,
		level: "publish",
		targets: [{ kind: "chat", id }],
		createdAt: 0,
		expiresAt: 1,
		limits: { followUps: 0 },
	});
	await assert.rejects(f.upgrade(id, expired.id), /expired/);
	await f.sessions.controlAuthorizations().authorizationCreate({
		id: "no-user",
		scope: "not a user request",
		level: "publish",
		targets: [{ kind: "chat", id }],
		createdAt: Date.now(),
		limits: { followUps: 0 },
	});
	await assert.rejects(f.upgrade(id, "no-user"), /user-request/);
	await assert.rejects(f.upgrade(id, "watch:legacy"), /Legacy watch/);
	assert.equal((await f.stored(id)).pendingControlPermission, undefined);
	assert.equal(f.sessions.controlPermission(id)?.level, "implement");
});

test("upgrade denies investigate, Control, ordinary chats, remote/other hosts and merge levels", async (t) => {
	const f = await fixture(t);
	const ask = await f.start("investigate");
	const ordinary = await f.sessions.spawn({ cwd: f.home, mode: "build", message: "local" });
	for (const id of [ask.id, caller, ordinary.id]) {
		const grant = await f.authorize([{ kind: "chat", id }]);
		await assert.rejects(f.upgrade(id, grant.id), /investigate|Control chat|implement to publish/);
	}
	const { id } = await f.start();
	const grant = await f.authorize([{ kind: "chat", id }]);
	for (const host of ["remote", { hostId: "daemon", daemonId: "other", lineageId: "other" }])
		await assert.rejects(f.upgrade(id, grant.id, undefined, { host }), /same-host/);
	await assert.rejects(f.upgrade(`remote:${id}`, grant.id), /Unknown local/);
	for (const level of ["merge", "implement", "investigate", undefined])
		await assert.rejects(f.upgrade(id, grant.id, undefined, { level }), /Only implement to publish/);
	await assert.rejects(
		f.service.call(
			"member",
			"upgrade_permission",
			{
				sessionId: id,
				authorizationId: grant.id,
				level: "publish",
			},
			"not-control",
		),
		/Only the control/,
	);
	assert.equal((await f.stored(id)).pendingControlPermission, undefined);
});

test("a pending upgrade cannot activate after its grant is revoked or expires", async (t) => {
	for (const reason of ["revoked", "expired"] as const) {
		const f = await fixture(t);
		const { id } = await f.start();
		const grant = await f.authorize([{ kind: "chat", id }]);
		await f.upgrade(id, grant.id);
		if (reason === "revoked") await f.sessions.controlAuthorizations().authorizationRevoke(grant.id);
		else t.mock.method(Date, "now", () => grant.expiresAt! + 1);
		assert.equal((await f.sessions.prepareControlPermission(id))?.level, "implement");
		assert.equal((await f.stored(id)).pendingControlPermission, undefined);
		t.mock.restoreAll();
	}
});

test("retry recovers a committed upgrade after losing its final audit acknowledgement", async (t) => {
	const f = await fixture(t);
	const { id } = await f.start();
	const grant = await f.authorize([{ kind: "chat", id }]);
	const memory = f.sessions.controlAuthorizations();
	const append = memory.auditAppend.bind(memory);
	const interrupted = t.mock.method(memory, "auditAppend", async (entry: Parameters<typeof memory.auditAppend>[0]) => {
		if (entry.action === "upgrade_permission" && entry.phase === "succeeded") throw new Error("lost audit ack");
		return append(entry);
	});
	await assert.rejects(f.upgrade(id, grant.id, "lost-ack"), /lost audit ack/);
	interrupted.mock.restore();
	assert.equal((await f.stored(id)).pendingControlPermission?.authorizationId, grant.id);
	await f.sessions.shutdown();
	const reopened = await f.open();
	await reopened.service.call(
		caller,
		"upgrade_permission",
		{
			sessionId: id,
			authorizationId: grant.id,
			level: "publish",
		},
		"lost-ack",
	);
	assert.equal((await reopened.sessions.controlAudit().page())[0]?.phase, "succeeded");
	assert.equal(
		(await reopened.sessions.controlAuthorizations().authorizationGet(grant.id))?.usage.followUps,
		0,
		"upgrade retries consume no follow-ups",
	);
});
