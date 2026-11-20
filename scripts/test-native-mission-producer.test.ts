import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MissionCatalogSources } from "../packages/daemon/src/mission-catalog.ts";
import { ModelCatalog } from "../packages/daemon/src/models.ts";
import { ProjectStore } from "../packages/daemon/src/projects.ts";
import { SessionManager } from "../packages/daemon/src/sessions.ts";
import { TerminalManager } from "../packages/daemon/src/terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "../packages/daemon/src/testing/daemon-server.ts";
import type { Mission, OperationHost } from "../packages/protocol/src/index.ts";

const home: OperationHost = { hostId: "daemon", daemonId: "producer", lineageId: "producer-lineage" };
function mission(id = "same", patch: Partial<Mission> = {}): Mission {
	return {
		id,
		projectId: "p",
		title: "Mission",
		goal: "",
		status: "active",
		briefRevision: 0,
		needsYouCount: 0,
		tasksDone: 0,
		tasksTotal: 0,
		createdAt: 1,
		updatedAt: 2,
		...patch,
	};
}
test("Local mission catalog uses canonical source identity and clips large replies", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "native-mission-producer-"));
	const projects = new ProjectStore(directory);
	const sessions = new SessionManager(directory, projects);
	const terminals = new TerminalManager();
	let definitions: Mission[] = [];
	const sources: MissionCatalogSources = {
		host: home,
		missions: () => definitions,
	};
	t.mock.method(sessions, "list", () => []);
	const history = t.mock.method(sessions, "history", async () => {
		throw new Error("History must not be read");
	});
	const args: Parameters<typeof createDaemonServer>[0] = {
		config: { home: directory, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		models: new ModelCatalog(directory),
		terminals,
	};
	args.catalog = sources;
	const server = createDaemonServer(args);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await rm(directory, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.mock.method(Date, "now", () => 5000);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mission-catalog`;
	definitions = [mission("same", { status: "archived", tasksDone: 2, tasksTotal: 3 })];
	const response = await fetch(url);
	assert.equal(response.status, 200);
	const dashboard = await response.json();
	assert.deepEqual(dashboard, {
		logicalMissions: [
			{
				id: JSON.stringify([home.daemonId, home.lineageId, "same"]),
				mission: { home, missionId: "same" },
				title: "Mission",
				status: "archived",
				tasksDone: 2,
				tasksTotal: 3,
				provenance: [{ kind: "canonical", sourceHost: home, projectId: "p" }],
			},
		],
		totals: { logicalMissions: 1 },
		truncated: false,
	});
	const scoped = await fetch(`${url}?projectId=p`);
	assert.deepEqual(await scoped.json(), dashboard);
	definitions = Array.from({ length: 70 }, (_, i) => mission(`mission-${i}`, { title: "T".repeat(300) }));
	const clipped = await (await fetch(url)).json();
	assert.equal(clipped.totals.logicalMissions, 70);
	assert.equal(clipped.truncated, true);
	assert.ok(clipped.logicalMissions.length <= 50);
	assert.ok(Buffer.byteLength(JSON.stringify(clipped)) <= 24_000);
	assert.equal(history.mock.callCount(), 0);
});
