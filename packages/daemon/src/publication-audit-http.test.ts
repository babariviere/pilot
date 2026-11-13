import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { GitHubAction } from "@pilot/protocol";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";

test("native publication audit read is passive, exact-project and capability-bound", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability };
	const worker = await f.sessions.spawnDurable(
		{ projectId: f.project.id, mode: "build", model: "fake/model", message: "Synthetic work only" },
		randomUUID(),
		randomUUID(),
	);
	const path = (project: string, extra = "") =>
		`${f.root}/api/sessions/${worker.id}/publication-audit?expectedProjectId=${project}${extra}`;
	// The saved audit as the chat stored it, including an unresolved attempt.
	const actions: GitHubAction[] = [
		{
			id: "call-1/0:0:attempt",
			kind: "push",
			branch: "main",
			summary: "jj git push",
			description: "pushed main",
			at: 1,
			exitCode: null,
			publication: {
				attemptId: "call-1/0:0:attempt",
				stage: "attempted",
				evidence: "command-dispatch",
				local: { status: "unknown" },
			},
		},
	];
	let reads = 0;
	Object.defineProperty(f.sessions, "publicationAudit", {
		value: async (id: string) => {
			assert.equal(id, worker.id);
			reads++;
			return actions;
		},
	});
	const ok = await fetch(path(f.project.id), { headers });
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("cache-control"), "no-store");
	assert.deepEqual(await ok.json(), { version: 1, sessionId: worker.id, projectId: f.project.id, actions });
	for (const r of await Promise.all([
		fetch(path(f.project.id), { headers: { "x-pilot-github-capability": "bad" } }),
		fetch(path(f.other.id), { headers }),
		fetch(path(f.project.id, `&expectedProjectId=${f.project.id}`), { headers }),
		fetch(path(f.project.id, "&after=1"), { headers }),
		fetch(`${f.root}/api/sessions/${worker.id}/publication-audit`, { headers }),
		fetch(path(f.project.id), { headers, method: "POST", body: "{}" }),
	])) {
		assert.notEqual(r.status, 200);
		await r.arrayBuffer();
	}
	assert.equal(reads, 1);
});
