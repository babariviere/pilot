import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatSettingsService, InvalidChatSettings } from "./chat-settings.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";

async function fixture(t: import("node:test").TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-chat-settings-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return { home, file: join(home, "chat-settings.json"), service: await ChatSettingsService.open(home) };
}

test("chat settings default off, persist privately, survive restart and serialize CAS", async (t) => {
	const { home, file, service } = await fixture(t);
	const initial = service.settings();
	assert.equal(initial.autoHandoff, false);
	assert.equal(initial.schemaVersion, 1);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.deepEqual((await ChatSettingsService.open(home)).settings(), initial);
	const changes: boolean[] = [];
	service.onChange((value) => changes.push(value.autoHandoff));
	const results = await Promise.allSettled([
		service.update({ autoHandoff: true, expectedRevision: initial.revision }),
		service.update({ autoHandoff: false, expectedRevision: initial.revision }),
	]);
	assert.equal(results[0]!.status, "fulfilled");
	assert.equal(results[1]!.status, "rejected");
	assert.ok(results[1]!.status === "rejected" && results[1]!.reason instanceof Conflict);
	assert.deepEqual(changes, [true]);
	const saved = service.settings();
	assert.notEqual(saved.revision, initial.revision);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), saved);
	assert.deepEqual((await ChatSettingsService.open(home)).settings(), saved);
	await service.update({ autoHandoff: false, expectedRevision: saved.revision });
	assert.equal(service.settings().autoHandoff, false);
});

test("chat settings reject non-exact patches without changing state", async (t) => {
	const { service } = await fixture(t);
	const initial = service.settings();
	for (const input of [
		null,
		[],
		true,
		{},
		{ autoHandoff: true },
		{ autoHandoff: "true", expectedRevision: initial.revision },
		{ autoHandoff: true, expectedRevision: 1 },
		{ autoHandoff: true, expectedRevision: "" },
		{ autoHandoff: true, expectedRevision: initial.revision, other: false },
	]) {
		assert.throws(() => service.update(input), InvalidChatSettings);
	}
	assert.deepEqual(service.settings(), initial);
});

test("unconfirmed saves never publish success, even if replacement reached disk", async (t) => {
	const { home, file, service } = await fixture(t);
	const initial = service.settings();
	const failing = await ChatSettingsService.open(home, async (path, value) => {
		await writeFile(path, JSON.stringify(value));
		throw new Error("directory sync failed");
	});
	let changes = 0;
	failing.onChange(() => changes++);
	await assert.rejects(failing.update({ autoHandoff: true, expectedRevision: initial.revision }), ServiceUnavailable);
	assert.equal(changes, 0);
	assert.throws(() => failing.settings(), ServiceUnavailable);
	await assert.rejects(failing.update({ autoHandoff: false, expectedRevision: initial.revision }), ServiceUnavailable);
	assert.equal(JSON.parse(await readFile(file, "utf8")).autoHandoff, true);
	assert.equal((await ChatSettingsService.open(home)).settings().autoHandoff, true);
});

test("corrupt and newer settings stay unavailable and are never overwritten", async (t) => {
	const { home, file } = await fixture(t);
	for (const content of ["{", JSON.stringify({ schemaVersion: 2, autoHandoff: true, revision: "future" })]) {
		await writeFile(file, content);
		const unavailable = await ChatSettingsService.open(home);
		assert.throws(() => unavailable.settings(), ServiceUnavailable);
		await assert.rejects(unavailable.update({ autoHandoff: false, expectedRevision: "future" }), ServiceUnavailable);
		assert.equal(await readFile(file, "utf8"), content);
	}
});

test("unavailable initial persistence does not claim defaults were durably saved", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-chat-settings-unavailable-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const service = await ChatSettingsService.open(home, async () => {
		throw new Error("disk unavailable");
	});
	assert.throws(() => service.settings(), ServiceUnavailable);
	await assert.rejects(service.update({ autoHandoff: true, expectedRevision: "unknown" }), ServiceUnavailable);
	assert.equal((await ChatSettingsService.open(home)).settings().autoHandoff, false);
});
