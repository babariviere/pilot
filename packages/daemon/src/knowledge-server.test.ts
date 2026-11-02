import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import type { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { KnowledgeService } from "./project-knowledge.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

test("knowledge HTTP reads are passive and writes act for the user with CAS", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-knowledge-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, workspace: "direct" });
	const sessions = {
		setWorkspaceProcessGuard() {},
		list: () => [] as SessionSummary[],
		get: () => undefined,
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		artifact: async () => {
			throw new Error("not used");
		},
	} as unknown as SessionManager;
	const store = new MissionStore(join(home, "missions.sqlite"));
	const knowledge = new KnowledgeService(store, projects, sessions);
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		{ service: {} as MissionService, store, knowledge },
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(base + path, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};
	const mission = store.create({ projectId: project.id, title: "Mission" });
	const write = {
		operationId: "create-1",
		expectedRevision: 0,
		kind: "component",
		title: "Code exploration",
		synopsis: "First-party search tools.",
		body: "## Purpose\nSearch.\n\n## Interfaces\ncode_search.\n\n## Gaps\nNo index.",
		sources: [{ type: "repository", path: "docs/code-exploration.md" }],
	};
	const created = await call("POST", `/api/projects/${project.id}/knowledge`, write);
	assert.equal(created.status, 201);
	const id = (created.body.entry as { id: string }).id;
	assert.deepEqual((await call("POST", `/api/projects/${project.id}/knowledge`, write)).body.replayed, true);
	assert.equal(
		(await call("POST", `/api/projects/${project.id}/knowledge`, { ...write, title: "Other" })).status,
		409,
	);
	assert.equal(
		(await call("POST", `/api/projects/${project.id}/knowledge`, { ...write, operationId: "x", body: "short" }))
			.status,
		400,
	);
	assert.equal((await call("GET", "/api/projects/missing/knowledge")).status, 404);

	const detail = await call("GET", `/api/projects/${project.id}/knowledge/${id}`);
	assert.deepEqual((detail.body.revision as { author: unknown }).author, { type: "user" });
	assert.equal((detail.body.freshness as { state: string }).state, "not_checked");
	const appended = await call("PUT", `/api/projects/${project.id}/knowledge/${id}`, {
		...write,
		operationId: "append-1",
		expectedRevision: 1,
		reason: "Clarify",
	});
	assert.equal(appended.status, 200);
	assert.equal((await call("GET", `/api/projects/${project.id}/knowledge/${id}?revision=1`)).status, 200);
	assert.equal((await call("GET", `/api/projects/${project.id}/knowledge/${id}?revision=3`)).status, 404);
	const revisions = await call("GET", `/api/projects/${project.id}/knowledge/${id}/revisions?limit=1`);
	assert.equal((revisions.body.revisions as unknown[]).length, 1);
	assert.equal(revisions.body.more, true);
	assert.equal((await call("GET", `/api/projects/${project.id}/knowledge?limit=51`)).status, 400);

	const link = `/api/missions/${mission.id}/knowledge/${id}`;
	assert.deepEqual((await call("GET", link)).body, {
		missionId: mission.id,
		knowledgeId: id,
		linked: false,
		linkRevision: 0,
	});
	assert.equal((await call("PUT", link, { expectedLinkRevision: 0, revision: 1 })).body.linkRevision, 1);
	assert.equal((await call("DELETE", `${link}?expectedLinkRevision=0`)).status, 400);
	assert.equal((await call("PUT", link, { expectedLinkRevision: 1, revision: 2 })).body.linkRevision, 2);
	assert.equal((await call("DELETE", `${link}?expectedLinkRevision=1`)).status, 409);
	const unlinked = await call("DELETE", `${link}?expectedLinkRevision=2`);
	assert.deepEqual([unlinked.body.linked, unlinked.body.linkRevision], [false, 3]);
	assert.equal((await call("PUT", link, { expectedLinkRevision: 3, followCurrent: true })).body.linkRevision, 4);
	const listed = await call("GET", `/api/projects/${project.id}/knowledge?missionId=${mission.id}`);
	assert.equal((listed.body.entries as unknown[]).length, 1);
	assert.equal((await call("PATCH", link, {})).status, 405);
});
