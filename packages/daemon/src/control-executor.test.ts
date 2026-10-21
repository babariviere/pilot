import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { controlPermissionBlock } from "../../kernel/src/tool-policy.ts";
import { ControlHostError } from "./control-host-policy.ts";
import { ControlHosts } from "./control-hosts.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { executorFixture, executorHost, home } from "./testing/control-executor.ts";

test("remote implement delegation and legacy publish sends share Build delivery without raising read-only roles", async (t) => {
	const f = await executorFixture(t);
	const op = f.operation("control.start", {
		target: { kind: "project", projectId: "project" },
		message: "Implement this fix, push the task branch and open a PR.",
		model: "fake/model",
		levelCeiling: "implement",
	});
	assert.equal((await f.journal.execute(op, (o) => f.handler.handle(o))).state, "accepted");
	assert.equal(f.calls.at(-1)?.level, "implement");
	assert.equal(
		controlPermissionBlock({ authorizationId: "grant", level: "implement" }, "bash", {
			command: "gh pr create --fill",
		}),
		undefined,
	);
	f.backend.resolveChat = (id) => ({
		id,
		scopes: [[{ kind: "project", id: "project" }]],
		permission: { authorizationId: "grant", level: "implement" },
	});
	const send = f.operation(
		"control.send",
		{ sessionId: "chat", message: "Open the PR.", levelCeiling: "publish" },
		"chat",
	);
	assert.equal((await f.journal.execute(send, (o) => f.handler.handle(o))).state, "accepted");
	assert.equal(f.calls.at(-1)?.level, "implement");
	const readOnly = f.operation(
		"control.send",
		{ sessionId: "chat", message: "Implement", levelCeiling: "investigate" },
		"chat",
	);
	assert.equal((await f.journal.execute(readOnly, (o) => f.handler.handle(o))).state, "rejected");
});

test("six authorized kinds and every run action retain receipts, target and permission through restart", async (t) => {
	const f = await executorFixture(t);
	const start = f.operation("control.start", {
		target: { kind: "project", projectId: "project" },
		message: "Inspect",
		model: "fake/model",
	});
	const ops = [
		start,
		f.operation("control.send", { sessionId: "chat", message: "Continue" }, "chat"),
		...["stop", "pause", "resume", "redirect"].map((action) =>
			f.operation(
				"control.run",
				{ sessionId: "chat", action, ...(action === "redirect" ? { message: "Change focus" } : {}) },
				"chat",
			),
		),
	];
	const watch = f.operation(
		"control.watch",
		{
			watch: {
				event: "chat.settled",
				target: { kind: "chat", id: "chat", host: executorHost },
				mode: "once",
				note: "Report",
				authorizationId: "grant",
			},
		},
		"watch",
	);
	ops.push(watch);
	for (const op of ops) assert.equal((await f.journal.execute(op, (o) => f.handler.handle(o))).state, "accepted");
	assert.equal(f.calls.find((c) => c.kind === "start")?.level, "investigate");
	const unwatch = f.operation("control.unwatch", { watchId: "watch" }, "watch");
	const revoke = f.operation("control.revoke", { revokedAt: Date.now() }, "grant");
	for (const op of [unwatch, revoke])
		assert.equal((await f.journal.execute(op, (o) => f.handler.handle(o))).state, "accepted");
	const count = f.calls.length;
	await f.reopen();
	const journal = new OperationJournal(join(f.root, "operations"), executorHost);
	for (const op of [...ops, unwatch, revoke])
		assert.equal((await journal.execute(op, (o) => f.handler.handle(o))).state, "accepted");
	assert.equal(f.calls.length, count);
});
test("parallel replay is one domain admission, including crash after result before generic receipt", async (t) => {
	const f = await executorFixture(t);
	const op = f.operation("control.start", {
		target: { kind: "project", projectId: "project" },
		message: "Inspect",
		model: "fake/model",
	});
	const receipts = await Promise.all(
		Array.from({ length: 16 }, () => f.journal.execute(op, (o) => f.handler.handle(o))),
	);
	assert.ok(receipts.every((r) => r.state === "accepted"));
	assert.equal(f.calls.length, 1);
	const other = f.operation("control.send", { sessionId: "chat", message: "Next" }, "chat");
	await f.journal.reserve(other);
	await f.handler.handle(other);
	await f.reopen();
	await f.journal.execute(other, (o) => f.handler.handle(o));
	assert.equal(f.calls.filter((c) => c.kind === "send").length, 1);
});
test("foreign home, lineage, generation, role, expiry, host scope and task delegation reject explicitly", async (t) => {
	const f = await executorFixture(t);
	const original = () =>
		f.operation("control.start", {
			target: { kind: "project", projectId: "project" },
			message: "Inspect",
			model: "fake/model",
		});
	const altered = (change: (p: Record<string, any>) => void) => {
		const op = original();
		const p = JSON.parse(op.payload);
		change(p);
		op.payload = JSON.stringify(p);
		op.payloadHash = payloadHash(op.payload);
		return op;
	};
	const ops = [
		{ ...original(), origin: { ...home, daemonId: "foreign" } },
		{ ...original(), origin: { ...home, lineageId: "restored" } },
		{ ...original(), bindingGeneration: 2 },
		altered((p) => (p.roleFence.home = 2)),
		altered((p) => (p.authorization.expiresAt = 1)),
		altered((p) => delete p.authorization.hosts),
		altered((p) => (p.authorization.hosts = [])),
		altered((p) => (p.authorization.targets[0].host = home)),
		altered((p) => (p.target = { kind: "task", missionId: "mission", taskId: "task" })),
	];
	for (const op of ops) {
		const r = await f.journal.execute(op, (o) => f.handler.handle(o));
		assert.equal(r.state, "rejected");
		assert.ok((r.result as { code: string }).code);
	}
	assert.equal(f.calls.length, 0);
});
test("revocation during asynchronous preparation fences allocation, expired safety operations still remove exact authority", async (t) => {
	const f = await executorFixture(t);
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((r) => (entered = r));
	const barrier = new Promise<void>((r) => (release = r));
	f.backend.prepareStart = async () => {
		entered();
		await barrier;
	};
	const op = f.operation("control.start", {
		target: { kind: "project", projectId: "project" },
		message: "Inspect",
		model: "fake/model",
	});
	const pending = f.journal.execute(op, (o) => f.handler.handle(o));
	await ready;
	const revoke = f.operation("control.revoke", { revokedAt: Date.now() }, "grant");
	const payload = JSON.parse(revoke.payload);
	payload.authorization.expiresAt = 1;
	revoke.payload = JSON.stringify(payload);
	revoke.payloadHash = payloadHash(revoke.payload);
	assert.equal((await f.journal.execute(revoke, (o) => f.handler.handle(o))).state, "accepted");
	release();
	assert.equal((await pending).state, "rejected");
	assert.equal(f.calls.length, 0);
});
test("input to unrestricted or wider execution is refused, never silently promoted", async (t) => {
	const f = await executorFixture(t);
	f.backend.resolveChat = (id) => ({ id, scopes: [[{ kind: "project", id: "project" }]] });
	const op = f.operation("control.send", { sessionId: "chat", message: "Next" }, "chat");
	assert.equal((await f.journal.execute(op, (o) => f.handler.handle(o))).state, "rejected");
});
test("native enrollment requires pinned signatures and exact consent, replay precedes CAS and staging preserves legacy role", async (t) => {
	const f = await executorFixture(t, true);
	const state = await f.hosts.enroll(f.enrollment.bindingId, f.request, "native");
	assert.equal(state.mutation?.disposition, "replayed");
	assert.equal(state.configuration.roleEpoch, 1);
	assert.equal(state.configuration.role, "home");
	assert.equal(f.hosts.legacyAllowed(), false);
	assert.deepEqual(state.configuration.stagedRole?.home, home);
	await assert.rejects(
		f.hosts.enroll(f.enrollment.bindingId, { ...f.request, approvalRequestId: randomUUID() }, "native"),
		ControlHostError,
	);
	await assert.rejects(
		new ControlHosts(executorHost, f.store).enroll(f.enrollment.bindingId, f.request, "native"),
		/Protected native/,
	);
	const bytes = "{}",
		path = "/api/control-hosts/control-pair";
	const proof = JSON.stringify({
		appKeyId: "native",
		host: executorHost,
		requestId: randomUUID(),
		issuedAt: Date.now(),
		method: "GET",
		path,
		bodyHash: payloadHash(bytes),
	});
	const headers = {
		proof: Buffer.from(proof).toString("base64"),
		signature: sign(null, Buffer.from(`native-management-v1\n${proof}`), f.key.privateKey).toString("base64"),
	};
	assert.equal(await f.hosts.authenticate(headers, "GET", path, bytes), "native");
	await assert.rejects(f.hosts.authenticate(headers, "GET", path, " {}"));
});
