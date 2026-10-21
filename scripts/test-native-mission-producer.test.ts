import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildMissionCatalog,
	type MissionCatalogSources,
	type SharedMissionGroup,
} from "../packages/daemon/src/mission-catalog.ts";
import { ModelCatalog } from "../packages/daemon/src/models.ts";
import { ProjectStore } from "../packages/daemon/src/projects.ts";
import { createDaemonServer } from "../packages/daemon/src/server.ts";
import { SessionManager } from "../packages/daemon/src/sessions.ts";
import { TerminalManager } from "../packages/daemon/src/terminals.ts";
import type { Mission, OperationHost } from "../packages/protocol/src/index.ts";

const fixtureURL = new URL("../apps/macos/Tests/Fixtures/logical-mission-producer.json", import.meta.url);
const home: OperationHost = { hostId: "daemon", daemonId: "producer", lineageId: "producer-lineage" };
const remote: OperationHost = { hostId: "alias", daemonId: "remote", lineageId: "remote-lineage" };
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
function replica(bindingId: string, sequence: number, title = "Replica", complete = true): SharedMissionGroup {
	return {
		projectId: "p",
		missionId: "same",
		tasks: [],
		tasksTotal: 0,
		replica: {
			id: bindingId,
			bindingId,
			projectId: "p",
			missionId: "same",
			missionHome: remote,
			title,
			status: "active",
			complete,
			sequence,
			consistency: "committed",
			replicaAgeMs: null,
		},
	};
}

test("native mission fixtures are real production HTTP/service payloads, not a second projection", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "native-mission-producer-"));
	const projects = new ProjectStore(directory);
	const sessions = new SessionManager(directory, projects);
	const terminals = new TerminalManager();
	let definitions: Mission[] = [];
	let shared: SharedMissionGroup[] = [];
	const sources: MissionCatalogSources = {
		host: home,
		missions: () => definitions,
		sharedContext: () => shared,
	};
	t.mock.method(sessions, "list", () => []);
	const history = t.mock.method(sessions, "history", async () => {
		throw new Error("History must not be read");
	});
	const args: Parameters<typeof createDaemonServer> = [
		{ home: directory, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(directory),
		terminals,
	];
	args[20] = sources;
	const server = createDaemonServer(...args);
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
	const scenarios: Array<{ name: string; definitions: Mission[]; shared: SharedMissionGroup[] }> = [
		{
			name: "canonical-and-alias",
			definitions: [mission("same", { status: "archived", tasksDone: 2, tasksTotal: 3 })],
			shared: [
				replica("remote-copy", 3),
				{
					...replica("local-copy", 100, "Stale"),
					replica: {
						...replica("local-copy", 100, "Stale").replica!,
						missionHome: { ...home, hostId: "label" },
					},
				},
			],
		},
		{
			name: "greatest-complete",
			definitions: [],
			shared: [replica("old", 2, "Old"), replica("new", 3, "New"), replica("partial", 99, "Partial", false)],
		},
		{
			name: "equal-sequence-conflict",
			definitions: [],
			shared: [replica("left", 3, "Left"), replica("right", 3, "Right")],
		},
		{
			name: "provenance-cap",
			definitions: [],
			shared: Array.from({ length: 20 }, (_, i) => replica(`binding-${i}`, i, `Sequence ${i}`)),
		},
		{ name: "incomplete-only", definitions: [], shared: [replica("partial", 9, "Not authoritative", false)] },
		{
			name: "task-only-provisional",
			definitions: [],
			shared: [
				{
					projectId: "p",
					missionId: "same",
					tasksTotal: 1000,
					tasks: [
						{
							id: "proposal",
							bindingId: "copy",
							projectId: "p",
							missionId: "same",
							missionHome: remote,
							source: "replica",
							consistency: "provisional",
							title: "Not a mission definition",
							status: "done",
						},
					],
				},
			],
		},
		{
			name: "home-grant-only",
			definitions: [],
			shared: [
				{
					projectId: "p",
					missionId: "same",
					tasksTotal: 1,
					tasks: [
						{
							id: "grant",
							bindingId: "copy",
							projectId: "p",
							missionId: "same",
							missionHome: { ...home, hostId: "home-alias" },
							source: "mission-home",
							consistency: "committed",
							title: "Not a mission definition",
							status: "done",
						},
					],
				},
			],
		},
		{
			name: "self-replica-without-definition",
			definitions: [],
			shared: [
				{
					...replica("self", 11, "Stale self-copy"),
					replica: {
						...replica("self", 11, "Stale self-copy").replica!,
						missionHome: { ...home, hostId: "home-alias" },
					},
				},
			],
		},
		{ name: "same-id-different-home", definitions: [mission()], shared: [replica("remote", 1)] },
		{ name: "clipped", definitions: Array.from({ length: 70 }, (_, i) => mission(`mission-${i}`)), shared: [] },
	];
	const cases = [];
	for (const scenario of scenarios) {
		definitions = scenario.definitions;
		shared = scenario.shared;
		const response = await fetch(url);
		assert.equal(response.status, 200);
		const dashboard = await response.json();
		assert.deepEqual(dashboard, JSON.parse(JSON.stringify(buildMissionCatalog(home, definitions, shared, 5000))));
		assert.ok(Array.isArray(dashboard.logicalMissions));
		// Legacy definitions live in a separate historical capture, not this compact endpoint.
		assert.deepEqual(dashboard.missions, []);
		assert.deepEqual(dashboard.replicaMissions, []);
		assert.ok(Buffer.byteLength(JSON.stringify(dashboard)) <= 24_000);
		const scoped = await fetch(`${url}?projectId=p`);
		assert.deepEqual((await scoped.json()).logicalMissions, dashboard.logicalMissions);
		cases.push({ name: scenario.name, definitions, dashboard });
	}
	assert.equal(history.mock.callCount(), 0);
	const captured = { sourcePin: { hostId: "local", daemonId: home.daemonId, lineageId: home.lineageId }, cases };
	if (process.env.PILOT_REFRESH_MISSION_FIXTURE === "1") {
		await writeFile(fixtureURL, `${JSON.stringify(captured, null, 2)}\n`);
	} else {
		assert.deepEqual(
			captured,
			JSON.parse(await readFile(fixtureURL, "utf8")),
			"producer changed: intentionally refresh the fixture and review native parity, do not hand-edit producer JSON",
		);
	}
});
