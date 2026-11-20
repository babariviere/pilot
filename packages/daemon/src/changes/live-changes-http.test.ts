import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RepositoryChanges } from "./changes.ts";
import { nativeIntakeFixture } from "../day/intake/native-intake.fixture.ts";
import { deferred } from "../testing/session-workspace.ts";

test("native live changes read only the expected private workspace and recheck it before replying", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const id = randomUUID();
	const session = await f.sessions.spawnDurable(
		{ projectId: f.project.id, mode: "build", model: "fake/model", message: "Synthetic work only" },
		id,
		randomUUID(),
	);
	const cwd = join(f.home, "private copy & test");
	await mkdir(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git("init", "-q");
	const filename = join(cwd, "note.txt");
	await writeFile(filename, "before\n");
	git("add", "note.txt");
	git("-c", "user.name=Pilot test", "-c", "user.email=pilot@example.invalid", "commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	const index = await readFile(join(cwd, ".git", "index"));
	await writeFile(filename, "after\n");
	let meta = { ...session, cwd, workspace: "clone" as const };
	Object.defineProperty(f.sessions, "get", {
		value: (requested: string) => (requested === session.id ? meta : undefined),
	});
	const changeBase = t.mock.method(f.sessions, "changeBase", (requested: string) => {
		assert.equal(requested, session.id);
		return { cwd: meta.cwd, base };
	});
	const headers = { "x-pilot-github-capability": f.capability };
	const endpoint = `${f.root}/api/sessions/${session.id}/changes/live`;
	const path = (projectId = f.project.id, expectedCwd = cwd) =>
		`${endpoint}?${new URLSearchParams({ expectedProjectId: projectId, expectedCwd })}`;
	for (const r of await Promise.all([
		fetch(path(), { headers: { "x-pilot-github-capability": "bad" } }),
		fetch(path(f.other.id), { headers }),
		fetch(path(f.project.id, f.home), { headers }),
		fetch(`${path()}&expectedCwd=${encodeURIComponent(cwd)}`, { headers }),
		fetch(endpoint, { headers }),
		fetch(path(), { headers, method: "POST", body: "{}" }),
	])) {
		assert.notEqual(r.status, 200);
		await r.arrayBuffer();
	}
	assert.equal(changeBase.mock.callCount(), 0);

	const ok = await fetch(path(), { headers });
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("cache-control"), "no-store");
	const patch = await ok.json();
	assert.equal(patch.sessionId, session.id);
	assert.equal(patch.projectId, f.project.id);
	assert.equal(patch.cwd, cwd);
	assert.match(patch.diff, /-before\n\+after/);
	assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);
	assert.equal(git("rev-parse", "HEAD"), base);

	const entered = deferred();
	const resume = deferred();
	t.mock.method(RepositoryChanges.prototype, "changes", async () => {
		entered.resolve();
		await resume.promise;
		return { base, files: [], diff: "", truncated: false };
	});
	const response = fetch(path(), { headers });
	try {
		await Promise.race([
			entered.promise,
			response.then((r) => assert.fail(`read refused before the diff: ${r.status}`)),
		]);
		meta = { ...meta, cwd: join(f.home, "replacement") };
	} finally {
		resume.resolve();
	}
	const stale = await response;
	assert.equal(stale.status, 409);
	assert.equal((await stale.json()).diff, undefined);
});
