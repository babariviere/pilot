/** Real isolated inventory ingress, saved SQLite across restart. No worker/provider. */

import { join } from "node:path";
import { serveCommands } from "../../commands.ts";
import { nativePlanningFixture } from "../../../missions/planning/native-mission-planning.fixture.ts";

const f = await nativePlanningFixture({ native: process.argv[2] !== "unavailable" });
await f.createPlanning("Second saved interview");
await f.createPlanning("Third saved interview");
const info = () => ({
	source: {
		profile: f.home,
		port: Number(new URL(f.root).port),
		home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
		project_id: f.project.id,
		project_path: f.project.path,
	},
	ledger: join(f.home, "commands.jsonl"),
	mission: f.missionId,
});
console.log(JSON.stringify(info()));
const owner = f.coordinator;
await serveCommands(async (cmd) => {
	if (cmd.action === "restart") await f.restart();
	if (cmd.action === "revoke") f.coordinator = cmd.value ? undefined : owner;
	if (cmd.action === "create") await f.createPlanning("New invalidation-only mission");
	if (cmd.action === "overflow")
		for (let count = f.store.list(f.project.id).length; count < 101; count++)
			await f.createPlanning(`Capacity mission ${count}`);
	if (cmd.action === "empty")
		for (const mission of f.store.list(f.project.id)) f.store.update(mission.id, { status: "archived" });
	return info();
});
await f.close();
