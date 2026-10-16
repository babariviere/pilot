import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlActions } from "./control-actions.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlPilot } from "./control-pilot.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

test("attachment requires accepted suggestion, idle/same-project membership and matching task claim", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-attach-")),
		source = join(home, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source });
	const sessions = new SessionManager(home, projects, undefined, {
		worker: () => {
			throw new Error("no worker should wake");
		},
	});
	const id = "11111111-1111-4111-8111-111111111111";
	await mkdir(join(home, "sessions", id), { recursive: true });
	await writeFile(
		join(home, "sessions", id, "meta.json"),
		JSON.stringify({
			id,
			title: "Idle",
			cwd: source,
			projectId: project.id,
			mode: "build",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	const store = new MissionStore(join(home, "missions.sqlite"));
	const missions = new MissionService(store, sessions, projects);
	await sessions.load();
	const mission = await missions.create({ projectId: project.id, title: "Goal" });
	const task = await missions.addTask(mission.mission.id, { title: "Matching work" });
	const memory = new ControlMemory(home),
		audit = new ControlActions(
			memory,
			() => true,
			async () => {},
		);
	t.after(async () => {
		await missions.notices.stop();
		await sessions.shutdown();
		await memory.stop();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	let notice = false;
	const service = new ControlPilot({
		isControl: (id) => id === "control",
		sessions,
		projects: () => projects.list(),
		missions: () => store.list(),
		linear: () => [],
		mutations: {
			audit: () => audit,
			startProject: async () => {
				throw new Error("wrong path");
			},
			startTask: async () => {
				throw new Error("wrong path");
			},
			send: async () => {
				throw new Error("wrong path");
			},
			organizeAllowed: () => !notice,
			attachMission: async (sessionId, missionId, taskId) => {
				const chat = sessions.attachIdleToMission(sessionId, () => missions.join(sessionId, { missionId, taskId }));
				await store.durable();
				return chat;
			},
		},
	});
	const args = {
		sessionId: id,
		missionId: mission.mission.id,
		taskId: String(task.number),
		authorization: "accepted_suggestion",
	};
	await assert.rejects(
		service.call("control", "mission_attach", { ...args, authorization: "user_request" }, "request"),
		/accept/,
	);
	notice = true;
	await assert.rejects(service.call("control", "mission_attach", args, "notice"), /forbidden/);
	notice = false;
	const busy = await sessions.spawn({ projectId: project.id, workspace: "direct", message: "busy" });
	await assert.rejects(service.call("control", "mission_attach", { ...args, sessionId: busy.id }, "busy"), /idle/);
	await service.call("control", "mission_attach", args, "attach");
	assert.equal(store.membership(id)?.missionId, mission.mission.id);
	assert.equal(store.resolveTask(mission.mission.id, String(task.number)).sessionId, id);
	assert.equal((await audit.page())[0]!.phase, "succeeded");
	const foreign = store.create({ projectId: "other", title: "Foreign" });
	await assert.rejects(
		service.call("control", "mission_attach", { ...args, missionId: foreign.id, taskId: undefined }, "foreign"),
		/own project/,
	);
	assert.equal(store.membership(id)?.missionId, mission.mission.id, "failed join preserves old membership");
});
