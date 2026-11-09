/** Native host journey through a real, isolated planning worker. No UI or live provider. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { planningWorkerFixture } from "../planning-workers.fixture.ts";

const f = await planningWorkerFixture();
try {
	const enrolled = await f.post(f.enrollment);
	assert.equal(enrolled.state, "accepted", JSON.stringify(enrolled) + f.logs());
	const mission = enrolled.result.missionId as string,
		owner = f.specs[0]!.sessionId;
	await f.changed(
		() => f.store.planningWorkers.get(mission)?.phase === "held" && f.sessions.get(owner)?.state === "idle",
	);
	console.log(
		JSON.stringify({
			source: {
				profile: f.home,
				port: Number(new URL(f.base).port),
				home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
				project_id: f.project.id,
				project_path: f.project.path,
			},
			ledger: join(f.home, "commands.jsonl"),
			mission,
		}),
	);
	for await (const line of createInterface({ input: process.stdin })) {
		const command = JSON.parse(line);
		if (command.action === "idle")
			await f.changed(
				() => f.store.planningWorkers.get(mission)?.phase === "active" && f.sessions.get(owner)?.state === "idle",
			);
		if (command.action === "close") {
			await f.close();
			console.log(JSON.stringify({ closed: true, workers: f.kernels.length }));
			break;
		}
		console.log(
			JSON.stringify({ requests: await f.requestCount(), phase: f.store.planningWorkers.get(mission)?.phase }),
		);
	}
} finally {
	await f.close();
	process.stdin.destroy();
}
