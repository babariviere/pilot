import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MissionService } from "../missions/mission-service.ts";
import { MissionStore } from "../missions/missions.ts";
import { ModelCatalog } from "../models/models.ts";
import { ProjectStore } from "../projects/projects.ts";
import { SessionManager } from "../sessions/sessions.ts";
import { TerminalManager } from "../sessions/terminals/terminals.ts";
import { createDaemonFixtureServer } from "../testing/daemon-server.ts";
import { AgentCli } from "./agent-cli.ts";

test("CLI reads its mission over loopback without granting writes or access to another mission", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-agent-cli-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const terminals = new TerminalManager();
	const server = createDaemonFixtureServer({
		config: { home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		models: new ModelCatalog("/unused"),
		terminals,
		missions: { store, service },
	});
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const mission = store.create({ projectId: "project", title: "Current mission" });
	const other = store.create({ projectId: "project", title: "Other mission" });
	store.writeBrief(mission.id, "Current brief", 0);
	store.writeBrief(other.id, "Other brief", 0);
	const task = store.addTask(mission.id, { title: "Current task" });
	const scope = { sessionId: "chat", projectId: "project", missionId: mission.id };
	const grant = sessions.agentCli.grant(() => scope)!;
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-cli/v1`;
	const headers = { Authorization: `Bearer ${grant.endpoint.token}` };
	assert.equal((await fetch(`${base}/context`)).status, 401);
	assert.deepEqual(await (await fetch(`${base}/context`, { headers })).json(), scope);
	assert.deepEqual(await (await fetch(`${base}/missions/${mission.id}/tasks`, { headers })).json(), {
		tasks: [{ id: task.id, number: task.number, title: task.title, status: task.status }],
	});
	assert.equal((await fetch(`${base}/missions/${other.id}/brief`, { headers })).status, 404);
	assert.equal((await fetch(`${base}/chats/other`, { headers })).status, 404);
	assert.equal((await fetch(`${base}/context?projectId=other`, { headers })).status, 400);
	for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
		assert.equal((await fetch(`${base}/missions/${mission.id}/brief`, { method, headers })).status, 405);
	assert.equal(store.brief(mission.id)?.markdown, "Current brief");
	assert.equal(store.get(mission.id)?.briefRevision, 1);

	const child = spawn(
		fileURLToPath(new URL("./bin/pilot", import.meta.url)),
		["missions", "brief", mission.id, "--json"],
		{
			cwd: home,
			env: {
				PILOT_CLI_NODE: process.execPath,
				PILOT_CLI_PORT: String(grant.endpoint.port),
				PILOT_CLI_TOKEN: grant.endpoint.token,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (text) => {
		stdout += text;
	});
	child.stderr.setEncoding("utf8").on("data", (text) => {
		stderr += text;
	});
	const [code] = await once(child, "close");
	assert.equal(code, 0, stderr);
	assert.deepEqual(JSON.parse(stdout), { brief: "Current brief" });
	grant.revoke();
	assert.equal((await fetch(`${base}/context`, { headers })).status, 401);
});

test("a transcript read rechecks its live worker grant before releasing text", async () => {
	const api = new AgentCli();
	api.port = () => 4319;
	const grant = api.grant(() => ({ sessionId: "chat", projectId: null, missionId: null }))!;
	const pending = api.read(
		"GET",
		`Bearer ${grant.endpoint.token}`,
		new URL("http://localhost/api/agent-cli/v1/chats/chat"),
		{
			chats: () => [],
			history: async (id, before, limit) => {
				assert.deepEqual([id, before, limit], ["chat", Number.MAX_SAFE_INTEGER, 20]);
				return { entries: [], more: false };
			},
		},
	);
	grant.revoke();
	await assert.rejects(pending, { status: 401 });
});
