import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

test("GitHub mission activity attributes the execution-time chat, survives reopen and bounds retention", () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-github-audit-"));
	const file = join(root, "missions.sqlite");
	let store = new MissionStore(file);
	try {
		const mission = store.create({ projectId: "p", title: "Shared" });
		store.log(mission.id, { text: "User note" });
		const action = {
			id: "ready",
			missionId: mission.id,
			summary: "gh pr ready",
			description: "marked PR #12 ready",
			at: 10,
			exitCode: 0,
		};
		store.recordGitHubAction("chat", action, "Build settings");
		store.recordGitHubAction("chat", action, "Build settings");
		assert.equal(store.events(mission.id).filter((e) => e.kind === "github").length, 1);
		const event = store.events(mission.id).find((e) => e.kind === "github")!;
		assert.equal(event.sessionId, "chat");
		assert.equal(event.at, 10);
		assert.match(event.text, /^Build settings marked PR #12 ready/);
		store.recordGitHubAction("chat", { ...action, id: "failed", exitCode: 1 }, "Build settings");
		store.recordGitHubAction(
			"chat",
			{ ...action, id: "unknown", target: "PR #12", exitCode: null },
			"Build settings",
		);
		assert.equal(store.events(mission.id)[0]!.text, "Build settings gh pr ready (PR #12) (outcome unverified)");
		assert.match(store.events(mission.id)[1]!.text, /attempted:.*failed/);
		store.recordGitHubAction("chat", { ...action, id: "outside", missionId: undefined }, "Build settings");
		store.close();
		store = new MissionStore(file);
		store.recordGitHubAction("chat", action, "Renamed chat");
		assert.equal(store.events(mission.id).filter((e) => e.kind === "github").length, 3);
		for (let i = 0; i < 1005; i++)
			store.recordGitHubAction("other", { ...action, id: String(i), at: 100 + i }, "Other chat");
		store.recordGitHubAction("chat", action, "Replay of evicted action");
		const db = new DatabaseSync(file, { readOnly: true });
		try {
			assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'github'").get()!.n, 1000);
			assert.equal(db.prepare("SELECT COUNT(*) AS n FROM github_action_events").get()!.n, 1000);
		} finally {
			db.close();
		}
		assert.equal(store.userNotes(mission.id, 10)[0]?.text, "User note");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
