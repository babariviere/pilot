/** Real isolated inventory ingress, saved SQLite across restart. No worker/provider. */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { nativePlanningFixture } from "../native-mission-planning.fixture.ts";

const f = await nativePlanningFixture();
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
for await (const line of createInterface({ input: process.stdin })) {
	const cmd = JSON.parse(line);
	if (cmd.action === "quit") break;
	if (cmd.action === "restart") await f.restart();
	if (cmd.action === "revoke") f.coordinator = cmd.value ? undefined : owner;
	if (cmd.action === "create") await f.createPlanning("New invalidation-only mission");
	if (cmd.action === "empty")
		for (const mission of f.store.list(f.project.id)) f.store.update(mission.id, { status: "archived" });
	console.log(JSON.stringify(info()));
}
await f.close();
// The native parent can keep its pipe open while waiting for orderly process exit.
process.stdin.destroy();
