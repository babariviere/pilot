// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

async function fixture(t: TestContext, working?: boolean) {
	const home = await mkdtemp(join(tmpdir(), "pilot-sessions-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const id = randomUUID();
	const file = join(home, "sessions", id, "meta.json");
	const updatedAt = Date.now() - 86_400_000;
	await mkdir(join(home, "sessions", id), { recursive: true });
	await writeFile(file, JSON.stringify({ id, title: "Old chat", cwd: home, createdAt: updatedAt, updatedAt }));
	const manager = new SessionManager(home, new ProjectStore(home));
	await manager.load();
	t.after(() => manager.shutdown());
	// Exercise packet handling without starting a real kernel or loading user credentials.
	const meta = manager["require"](id);
	meta.working = working;
	const worker = { child: { exitCode: null }, state: "idle" } as unknown as Parameters<SessionManager["onPacket"]>[1];
	const changes: SessionSummary[] = [];
	manager.onChange((summary) => changes.push(summary));
	return {
		manager,
		meta,
		worker,
		changes,
		updatedAt,
		async persisted() {
			await manager["saving"].get(id);
			return JSON.parse(await readFile(file, "utf8"));
		},
	};
}

test("opening an old chat preserves its activity timestamp, including legacy metadata", async (t) => {
	for (const working of [undefined, false, true]) {
		const f = await fixture(t, working);
		f.manager["onPacket"](f.meta, f.worker, {
			type: "ready",
			model: "offline/model",
			working: false,
			usage: {},
		});
		assert.equal(f.changes.at(-1)?.updatedAt, f.updatedAt);
		const persisted = await f.persisted();
		assert.equal(persisted.updatedAt, f.updatedAt);
		assert.equal(persisted.model, "offline/model");
		assert.equal(persisted.working, false);
	}
});

test("real working transitions advance activity but duplicate state and usage updates do not", async (t) => {
	const f = await fixture(t, false);
	t.mock.method(Date, "now", () => f.updatedAt + 1_000);
	f.manager["onPacket"](f.meta, f.worker, { type: "working", working: true });
	assert.equal((await f.persisted()).updatedAt, f.updatedAt + 1_000);
	t.mock.method(Date, "now", () => f.updatedAt + 2_000);
	f.manager["onPacket"](f.meta, f.worker, { type: "working", working: true });
	f.manager["onPacket"](f.meta, f.worker, { type: "usage", usage: {} });
	assert.equal(f.changes.at(-1)?.updatedAt, f.updatedAt + 1_000);
	f.manager["onPacket"](f.meta, f.worker, { type: "working", working: false });
	assert.equal((await f.persisted()).updatedAt, f.updatedAt + 2_000);
});

test("ready hydration preserves completion and activity, while new settled work advances both", async (t) => {
	const f = await fixture(t, false);
	const completion = { outcome: "needs_input" as const, outcomeAt: f.updatedAt + 500, outcomeReason: "Review this" };
	f.manager["onPacket"](f.meta, f.worker, {
		type: "ready",
		model: "offline/model",
		working: false,
		usage: {},
		completion,
	});
	assert.equal((await f.persisted()).updatedAt, f.updatedAt);
	assert.equal(f.meta.outcomeAt, completion.outcomeAt);
	t.mock.method(Date, "now", () => f.updatedAt + 1_000);
	f.manager["onPacket"](f.meta, f.worker, { type: "working", working: false, completion });
	assert.equal((await f.persisted()).updatedAt, f.updatedAt);
	const next = { outcome: "done" as const, outcomeAt: f.updatedAt + 800 };
	f.manager["onPacket"](f.meta, f.worker, { type: "working", working: false, completion: next });
	assert.equal((await f.persisted()).updatedAt, f.updatedAt + 1_000);
	assert.equal(f.meta.outcome, "done");
	assert.equal(f.meta.outcomeAt, next.outcomeAt);
});
