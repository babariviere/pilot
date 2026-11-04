import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatSettingsService } from "./chat-settings.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("hook writes require enabled feature and native authority, reject stale and invalid edits", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-hook-api-"));
	const settings = await ChatSettingsService.open(home);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(
		home,
		{ hostId: "fixture", daemonId: "fixture", lineageId: "fixture" },
		{ userHome: home, env: {} },
	);
	await native.status();
	const token = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token as string;
	const hello = await daemonHello(home, {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: false,
		independentExecution: true,
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		hello,
		undefined,
		false,
		undefined,
		undefined,
		native,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		settings,
	);
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
	const put = (body: unknown, capability = token) =>
		fetch(`${base}/${project.id}/automations`, {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
			body: JSON.stringify(body),
		});
	const start = (body: unknown, capability = token) =>
		fetch(`${base}/${project.id}/flows/start`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
			body: JSON.stringify(body),
		});
	const flowRequest = {
		requestId: "12345678-1234-1234-1234-123456789abc",
		expectedRevision: 1,
		flowId: "fix-review",
		message: "Fix bug",
	};
	let starts = 0;
	t.mock.method(sessions, "startFlow", async (id: string, body: unknown) => {
		assert.equal(id, project.id);
		assert.deepEqual(body, flowRequest);
		starts++;
		return { id: "flow-root" } as Awaited<ReturnType<typeof sessions.startFlow>>;
	});
	assert.equal((await start(flowRequest)).status, 404);
	assert.equal((await put({ expectedRevision: 0, items: [] })).status, 404);
	const root = base.replace("/api/projects", "");
	const capability = async () => (await (await fetch(`${root}/api/hello`)).json()).capabilities.automations;
	assert.equal(await capability(), undefined);
	const toggle = (on: boolean, tokenValue = token) =>
		fetch(`${root}/api/chat-settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-pilot-github-capability": tokenValue },
			body: JSON.stringify({ automations: on, expectedRevision: settings.settings().revision }),
		});
	assert.equal((await toggle(true, "wrong")).status, 403);
	assert.equal(settings.automationsEnabled(), false);
	assert.equal((await toggle(true)).status, 200);
	assert.equal(await capability(), 1);
	assert.equal((await start(flowRequest, "wrong")).status, 403);
	assert.equal(starts, 0, "no engine admission without native authority");
	const flowResponse = await start(flowRequest);
	assert.equal(flowResponse.status, 202);
	assert.deepEqual(await flowResponse.json(), { id: "flow-root" });
	assert.equal(starts, 1);
	assert.equal((await put({ expectedRevision: 0, items: [] }, "wrong")).status, 403);
	const hook = {
		id: "setup",
		name: "Setup",
		enabled: true,
		on: ["workspace.created"],
		action: { type: "shell", run: { shell: "true" } },
	};
	const saved = await put({ expectedRevision: 0, items: [hook] });
	assert.equal(saved.status, 200);
	assert.deepEqual(await saved.json(), { revision: 1, items: [hook] });
	const stale = await put({ expectedRevision: 0, items: [] });
	assert.equal(stale.status, 409);
	assert.deepEqual((await stale.json()).current, { revision: 1, items: [hook] });
	assert.equal((await put({ expectedRevision: 1, items: [{ ...hook, action: { type: "future" } }] })).status, 400);
	for (const [method, url] of [
		["POST", base],
		["PATCH", `${base}/${project.id}`],
	]) {
		assert.equal(
			(
				await fetch(url!, {
					method,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: home, automations: { revision: 1, items: [] } }),
				})
			).status,
			400,
		);
	}
	assert.equal((await (await fetch(base)).json())[0].automations.revision, 1);
	assert.equal((await toggle(false)).status, 200);
	assert.equal((await start(flowRequest)).status, 404);
	assert.equal(starts, 1);
	assert.equal(await capability(), undefined);
	assert.equal((await put({ expectedRevision: 1, items: [] })).status, 404);
	assert.equal(sessions.list().length, 0, "settings never start chats");
});
