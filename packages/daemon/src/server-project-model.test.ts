import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("project model PATCH silently overwrites a save made after client preflight", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-project-model-race-"));
	const projects = new ProjectStore(home, async () => {
		assert.fail("project model settings must not execute host commands");
	});
	await projects.load();
	const project = await projects.create({
		path: home,
		name: "模型 👩🏽‍💻",
		model: "provider/original",
		workspace: "direct",
		requirePullRequest: false,
	});
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const models = new ModelCatalog(home);
	const list = t.mock.method(models, "list", async () => {
		assert.fail("project model PATCH must not read provider accounts or refresh the catalogue");
	});
	const server = createDaemonServer({ home, host: "127.0.0.1", port: 0 }, sessions, projects, models, terminals);
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}`;
	const patch = (body: unknown) =>
		fetch(url, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	// The established native helper GETs the baseline before sending its captured PATCH.
	const preflight = await fetch(url);
	assert.equal(preflight.status, 200);
	assert.deepEqual(await preflight.json(), project);
	const captured = JSON.stringify({ model: "provider/captured*#~" });
	const concurrent = await patch({ model: "other/newer/model", name: "Updated elsewhere 日本語" });
	assert.equal(concurrent.status, 200);
	assert.equal(((await concurrent.json()) as Project).model, "other/newer/model");

	// No expected model/revision is available in ProjectRequest. A matching earlier GET
	// cannot prevent this stale Save from replacing the intervening user's selection.
	const stale = await patch(JSON.parse(captured));
	assert.equal(stale.status, 200, "current contract accepts the stale Save instead of refusing it");
	const saved = (await stale.json()) as Project;
	assert.deepEqual(saved, { ...project, name: "Updated elsewhere 日本語", model: "provider/captured*#~" });
	const reopened = new ProjectStore(home);
	await reopened.load();
	assert.deepEqual(reopened.require(project.id), saved, "the unseen model selection is overwritten durably");
	assert.deepEqual(sessions.list(), [], "settings PATCH does not start chats");
	assert.equal(list.mock.callCount(), 0);

	const cleared = await patch({ model: "" });
	assert.equal(cleared.status, 200);
	const { model: _model, ...withoutModel } = saved;
	assert.deepEqual(await cleared.json(), withoutModel, "empty string clears only the project model override");
});
