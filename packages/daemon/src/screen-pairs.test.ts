/** A gallery shows each reported screen once: the current worker's latest pairs, with both captures pinned. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { MissionReportWrite } from "@pilot/protocol";
import { MissionReports } from "./mission-reports.ts";
import { MissionStore } from "./missions.ts";
import { projectScreenPairs } from "./screen-pairs.ts";

test("screen pairs follow the current worker's latest screens report and its pinned image links", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const mission = store.create({ projectId: "p", title: "Synthetic", planningVersion: 1 });
	const elsewhere = store.create({ projectId: "q", title: "Other project", planningVersion: 1 });
	store.join("worker", mission.id);
	store.join("next", mission.id);
	store.join("theirs", elsewhere.id);
	const task = store.addTask(mission.id, { title: "Work", sessionId: "worker" });
	const reports = new MissionReports(store);
	const link = (missionId: string, artifactId: string, revision: number, taskId = task.id, sessionId = "worker") =>
		store.linkArtifact(missionId, {
			sessionId,
			artifactId,
			title: `Row (${artifactId})`,
			kind: "image",
			taskId,
			revision,
		});
	const report = async (
		missionId: string,
		taskId: string,
		pairs: { before?: string; after: string }[],
		who = "worker",
	) => {
		const source = reports.source(missionId, who, taskId);
		const write: MissionReportWrite = {
			version: 1,
			reportId: randomUUID(),
			taskId,
			source: source.source,
			expectedPreviousId: source.expectedPreviousId,
			movement: "moving",
			summary: "Done",
			nextStep: "Check",
			evidence: [],
			delivery: { commit: "a".repeat(40), checks: "Pass", issues: "", screens: { pairs } },
		};
		await reports.write(missionId, who, write);
	};

	assert.deepEqual(projectScreenPairs(store, "p"), []);
	link(mission.id, "before", 1);
	link(mission.id, "after", 1);
	link(mission.id, "new", 1);
	await report(mission.id, task.id, [{ before: "before", after: "after" }]);
	link(mission.id, "after", 2);
	const first = projectScreenPairs(store, "p");
	assert.deepEqual(
		first.map(({ reportedAt: _, ...p }) => p),
		[
			{
				missionId: mission.id,
				taskId: task.id,
				sessionId: "worker",
				before: { artifactId: "before", revision: 1, title: "Row (before)" },
				after: { artifactId: "after", revision: 2, title: "Row (after)" },
			},
		],
		"the newest pinned link of each capture",
	);

	// A later report replaces the pairs; a new screen has no Before.
	await report(mission.id, task.id, [{ after: "new" }]);
	assert.deepEqual(
		projectScreenPairs(store, "p").map((p) => [p.before, p.after.artifactId]),
		[[undefined, "new"]],
	);

	// Another project's screens stay there.
	const theirs = store.addTask(elsewhere.id, { title: "Theirs", sessionId: "theirs" });
	link(elsewhere.id, "theirs", 1, theirs.id, "theirs");
	await report(elsewhere.id, theirs.id, [{ after: "theirs" }], "theirs");
	assert.deepEqual(
		projectScreenPairs(store, "p").map((p) => p.after.artifactId),
		["new"],
	);

	// A new worker on the task hides the old worker's screens until it reports its own.
	store.updateTask(mission.id, task.id, { sessionId: "next" });
	assert.deepEqual(projectScreenPairs(store, "p"), []);

	// A capture no longer pinned on the task leaves its images on their own.
	store.updateTask(mission.id, task.id, { sessionId: "worker" });
	store.unlinkArtifact(mission.id, "new", { sessionId: "worker" }, task.id);
	assert.deepEqual(projectScreenPairs(store, "p"), []);
});
