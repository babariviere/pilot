/** Isolated stored artifact, released hidden native bridge. No live source or provider. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { nativeIntakeFixture } from "../native-intake.fixture.ts";

const f = await nativeIntakeFixture();
const worker = await f.sessions.spawnDurable(
	{ projectId: f.project.id, mode: "build", model: "fake/model", message: "Synthetic work only" },
	randomUUID(),
	randomUUID(),
);
const mission = f.store.create({ projectId: f.project.id, title: "Synthetic captured output" });
f.store.join(worker.id, mission.id);
const task = f.store.addTask(mission.id, { title: "Saved output", sessionId: worker.id });
const artifactId = randomUUID();
const directory = join(f.home, "sessions", worker.id, "artifacts", artifactId);
await mkdir(directory, { recursive: true });
const artifact = {
	id: artifactId,
	sessionId: worker.id,
	projectId: f.project.id,
	revision: 1,
	title: "Saved output",
	kind: "html",
	source: "<script>throw Error('never execute')</script>",
	html: "historical prepared document must stay private",
	createdAt: 1,
	updatedAt: 2,
	libraries: [],
};
await writeFile(join(directory, "1.json"), JSON.stringify(artifact));
await writeFile(join(directory, "2.json"), JSON.stringify({ ...artifact, revision: 2, source: "newer" }));
await writeFile(join(directory, "latest.json"), JSON.stringify({ ...artifact, revision: 2 }));
f.store.linkArtifact(mission.id, {
	taskId: task.id,
	sessionId: worker.id,
	artifactId,
	title: artifact.title,
	kind: "html",
	revision: 1,
});
f.store.completeTask(mission.id, task.id, worker.id, { commit: "a".repeat(40), checks: "Synthetic", issues: "" });
await f.store.durable();
console.log(
	JSON.stringify({
		source: {
			profile: f.home,
			port: Number(new URL(f.root).port),
			home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
		ledger: join(f.home, "commands.jsonl"),
		task: { kind: "task", projectId: f.project.id, missionId: mission.id, taskId: task.id },
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const { action } = JSON.parse(line);
	if (action === "quit") break;
	if (action === "missing") await rename(join(directory, "1.json"), join(directory, "saved.json"));
	if (action === "oversize") await writeFile(join(directory, "1.json"), " ".repeat(1024 * 1024 + 1));
	if (action === "redacted")
		await writeFile(join(directory, "1.json"), JSON.stringify({ ...artifact, source: "password=synthetic" }));
	if (action === "stale") f.store.updateTask(mission.id, task.id, { body: "new definition" });
	if (action === "leave") f.store.leave(worker.id);
	await f.store.durable();
	const meta = JSON.parse(await readFile(join(f.home, "sessions", worker.id, "meta.json"), "utf8"));
	console.log(
		JSON.stringify({
			...f.stats(),
			messages: meta.pending.filter((p: { content: string }) => p.content !== "Synthetic work only"),
			verification: f.store.userVerifications.current("not-an-operation"),
		}),
	);
}
process.stdin.destroy();
await f.close();
