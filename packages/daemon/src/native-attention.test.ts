import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, HumanActionCommand, HumanActionRecord } from "@pilot/protocol";
import { attentionDigest } from "./attention-store.ts";
import { nativeAttentionFixture } from "./native-attention.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

const ref = ({ id, revision, digest }: HumanActionRecord) => ({ id, revision, digest });
const error = (r: { ok: boolean; error?: { code: string } }, code: string) => {
	assert.equal(r.ok, false, JSON.stringify(r));
	assert.equal(r.error?.code, code);
};

test("native attention authenticates exact current home/project/origin and receipt reads", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	assert.equal((await f.post({ ...f.envelope(), kind: "read" }, false, "")).status, 403);
	const read = await f.read();
	assert.equal(read.questions.length, 1);
	assert.equal(read.capabilities.help, "unavailable");
	assert.equal(read.capabilities.continuation, "unavailable");
	error(
		await (await f.post({ ...f.envelope(), home: { ...f.host, hostId: "agent" }, kind: "read" })).json(),
		"forbidden",
	);
	error(
		await (
			await f.post({ ...f.envelope(), home: { ...f.host, hostId: "local", lineageId: "other" }, kind: "read" })
		).json(),
		"forbidden",
	);
	error(await (await f.post({ ...f.envelope(), kind: "read", actor: "user" })).json(), "invalid");
	const row = await f.create(),
		command: HumanActionCommand = {
			kind: "complete",
			operationId: randomUUID(),
			expected: ref(row),
			report: "Submitted only",
		};
	const authority = (await f.read()).actions[0]!.authorityDigest;
	error(await f.command(command, authority, true), "unknown");
	f.session = { ...f.session, mode: "ask" };
	error(await f.command(command, authority), "forbidden");
	error(await f.command(command, authority, true), "unknown");
	assert.equal(f.sends, 0);
});

test("progress, Later and opening permission never complete; changed permissions reject shown intent", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	let row = await f.create();
	let read = await f.read();
	const progress = "  exact\n日本 💬  ";
	const save: HumanActionCommand = { kind: "progress", operationId: randomUUID(), expected: ref(row), progress };
	let r = await f.command(save, read.actions[0]!.authorityDigest);
	assert.ok(r.ok, JSON.stringify(r));
	row = r.value;
	assert.equal(row.progress, progress);
	assert.equal(row.completion, null);
	read = await f.read();
	const later: HumanActionCommand = { kind: "defer", operationId: randomUUID(), expected: ref(row), progress };
	r = await f.command(later, read.actions[0]!.authorityDigest);
	assert.ok(r.ok);
	row = r.value;
	assert.equal(row.state, "deferred");
	assert.equal(row.completion, null);
	read = await f.read();
	const resource = {
		...f.envelope(),
		kind: "resource",
		expected: ref(row),
		authorityDigest: read.actions[0]!.authorityDigest,
	};
	const opened = await (await f.post(resource)).json();
	assert.ok(opened.ok);
	assert.equal(opened.value.url, f.content.destination.uri);
	assert.equal(f.store.attention.humanAction(row.id)?.completion, null);
	f.session = { ...f.session, inputGeneration: 1 };
	error(
		await f.command(
			{ kind: "complete", operationId: randomUUID(), expected: ref(row), report: "Submitted" },
			read.actions[0]!.authorityDigest,
		),
		"stale",
	);
	assert.equal(f.sends, 0);
});

test("exact user-report receipt survives restart/lost ACK; resources and prior revision fence completion", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const row = await f.create();
	const authority = (await f.read()).actions[0]!.authorityDigest;
	const cmd: HumanActionCommand = {
		kind: "complete",
		operationId: randomUUID(),
		expected: ref(row),
		report: "Uploaded. Store review is pending.",
	};
	const original = f.store.attention.durable.bind(f.store.attention);
	f.store.attention.durable = async () => {
		await original();
		if (f.store.attention.operation(cmd.operationId)) throw new Error("Lost ACK after durable write");
	};
	const request = f.command(cmd, authority);
	error(await request, "unknown");
	f.store.attention.durable = original;
	const sent = await f.command(cmd, authority, true);
	assert.ok(sent.ok, JSON.stringify(sent));
	await f.restart();
	const receipt = await f.command(cmd, authority, true);
	assert.ok(receipt.ok);
	assert.equal(receipt.value.record.completion.source, "user_report");
	assert.equal(receipt.value.current, true);
	error(await f.command(cmd, authority), "conflict");
	const gate = await f.adapter().completion(f.project.id, ref(row), cmd.operationId);
	assert.ok(gate.ok);
	assert.equal(gate.value.source, "user_report");
	error(
		await f.adapter().completion(f.project.id, { ...ref(row), revision: row.revision + 1 }, cmd.operationId),
		"stale",
	);
	await writeFile(f.file, "replaced package");
	error(await f.adapter().completion(f.project.id, ref(row), cmd.operationId), "stale");
	assert.equal(f.sends, 0);
});

test("replaced file and symlink cannot complete or grant arbitrary local resource access", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const row = await f.create();
	let authority = (await f.read()).actions[0]!.authorityDigest;
	await writeFile(f.file, "new bytes");
	error(
		await f.command({ kind: "complete", operationId: randomUUID(), expected: ref(row), report: "Done" }, authority),
		"stale",
	);
	await writeFile(f.file, "exact package");
	await symlink(f.file, join(f.home, "linked.zip"));
	const cmd: HumanActionCommand = {
		kind: "replace",
		operationId: randomUUID(),
		expected: ref(row),
		content: {
			...f.content,
			files: [
				{
					...f.content.files[0]!,
					uri: new URL("linked.zip", f.content.files[0]!.kind === "file" ? f.content.files[0]!.uri : "").href,
				} as never,
			],
		},
	};
	authority = (await f.read()).actions[0]!.authorityDigest;
	error(await f.command(cmd, authority), "stale");
	assert.equal(f.store.attention.humanAction(row.id)?.state, "pending");
});

test("attention capacity is explicit at 4096 and never evicts exact receipts", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const row = await f.create();
	for (let n = 1; n < 4096; n++)
		f.store.attention.write(
			{ kind: "progress", operationId: `seed-${n}`, expected: ref(row), progress: "" },
			() => row,
		);
	await f.store.durable();
	const authority = (await f.read()).actions[0]!.authorityDigest;
	const r = await f.command(
		{ kind: "progress", operationId: "overflow", expected: ref(row), progress: "kept in native draft" },
		authority,
	);
	error(r, "unavailable");
	assert.match(r.error.message, /4096/);
	assert.ok(f.store.attention.operation("seed-1"));
	assert.equal(f.store.attention.operation("overflow"), undefined);
});

test("qualified help unavailable is truthful; scope changes and old answered history never approve", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const scope = (await f.read()).questions[0]!.scope;
	const req = { ...f.envelope(), kind: "help", request: { requestId: randomUUID(), kind: "simpler", scope } };
	error(await (await f.post(req)).json(), "unavailable");
	f.question = { ...f.question, id: 13 };
	error(await (await f.post(req)).json(), "stale");
	assert.equal(f.sends, 0);
});

test("oversized attention inventory refuses before JSON hydration instead of returning a partial feed", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const row = await f.create();
	for (let n = 0; n < 320; n++) {
		const record = { ...row, id: `large-${n}`, content: { ...row.content, reason: "x".repeat(28000) } };
		f.store.attention.write(
			{ kind: "create", operationId: `large-${n}`, id: record.id, content: record.content },
			() => record,
		);
	}
	await f.store.durable();
	f.store.attention.actions = () => {
		throw new Error("Must reject before hydration");
	};
	const r = await (await f.post({ ...f.envelope(), kind: "read" })).json();
	error(r, "unavailable");
	assert.match(r.error.message, /8 MiB/);
});

test("answer ingress journals once; uncertain/cold recovery only looks up, never resends", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const q = (await f.read()).questions[0]!;
	const payload = JSON.stringify({ projectId: f.project.id, scope: q.scope, message: "Reviewed package" });
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: f.host,
		kind: "attention-answer",
		targetId: f.owner,
		payload,
		payloadHash: payloadHash(payload),
		bindingId: attentionDigest(q.scope),
		bindingGeneration: 1,
	};
	const post = async (receipt = false, token = f.capability) =>
		await fetch(`${f.root}/api/operations${receipt ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": token },
			body: JSON.stringify(op),
		});
	assert.equal((await post(false, "")).status, 403);
	assert.equal((await (await post()).json()).state, "pending");
	assert.equal(f.sends, 1);
	assert.equal((await (await post()).json()).state, "pending");
	assert.equal(f.sends, 1);
	await f.restart();
	assert.equal((await (await post(true)).json()).state, "pending");
	assert.equal(f.sends, 1);
	assert.equal((await (await post()).json()).state, "pending");
	assert.equal(f.sends, 1);
	f.accepted = true;
	const receipt = await (await post()).json();
	assert.equal(receipt.state, "accepted");
	assert.equal(f.sends, 1);
	f.session = { ...f.session, mode: "ask" };
	assert.equal((await post(true)).status, 400); // invalid authority cannot expose an old receipt.
	assert.notEqual((await (await post(true)).json()).state, "accepted");
});
