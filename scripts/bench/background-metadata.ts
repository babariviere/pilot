/** Offline PR-projection and row-polling probe. No providers, agents or live state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RepositoryChanges } from "../../packages/daemon/src/changes.ts";
import { MissionStore } from "../../packages/daemon/src/missions.ts";
import { type ProcessOptions, subprocesses } from "../../packages/daemon/src/subprocess.ts";
import { untrackedStats } from "../../packages/daemon/src/untracked-stats.ts";

const root = mkdtempSync(join(tmpdir(), "pilot-metadata-bench-"));
const git = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.com",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.com",
		},
	});
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
let store: MissionStore | undefined;
const run = subprocesses.run.bind(subprocesses);
try {
	const file = join(root, "missions.sqlite");
	store = new MissionStore(file);
	const { id } = store.create({ projectId: "fixture", title: "Fixture", tasks: [{ title: "Owned" }] });
	store.addResource(id, { url: "https://github.com/octo/repo/pull/42", taskId: "1" });
	store.close();
	store = undefined;
	const db = new DatabaseSync(file);
	try {
		const insert = db.prepare(`INSERT INTO tasks
			(id, mission_id, number, title, body, status, sort, created_at, updated_at)
			VALUES (?, ?, ?, 'Fixture', ?, 'pending', ?, 1, 1)`);
		db.exec("BEGIN");
		for (let i = 0; i < 1000; i++) insert.run(`task-${i}`, id, i + 2, "x".repeat(8_000), i + 1);
		db.exec("COMMIT");
	} finally {
		db.close();
	}
	store = new MissionStore(file);
	const current = () =>
		store!.pullRequestMissions().flatMap((mission) => store!.ownedPullRequestResources(mission.id));
	const baseline = () =>
		store!
			.list()
			.filter((mission) => mission.status === "active")
			.flatMap((mission) =>
				store!
					.detail(mission.id)
					.resources.filter((resource) => resource.kind === "github.pr" && resource.relationship === "ownership")
					.map(({ url, pullRequest }) => ({ url, ...(pullRequest ? { pullRequest } : {}) })),
			);
	assert.deepEqual(current(), baseline());
	const samples = new Map<string, { wall: number[]; cpu: number[] }>();
	for (let round = 0; round < 6; round++) {
		const variants = [
			["baseline", baseline],
			["current", current],
		] as const;
		for (const [name, read] of round % 2 ? [...variants].reverse() : variants) {
			const start = performance.now();
			const cpu = process.cpuUsage();
			// Repeated PR refreshes alongside a large task history, without network or kernel work.
			for (let i = 0; i < 20; i++) assert.equal(read().length, 1);
			const elapsed = performance.now() - start;
			const used = process.cpuUsage(cpu);
			if (round) {
				const sample = samples.get(name) ?? { wall: [], cpu: [] };
				sample.wall.push(elapsed);
				sample.cpu.push((used.user + used.system) / 1000);
				samples.set(name, sample);
			}
		}
	}
	for (const [name, values] of samples)
		console.log(
			JSON.stringify({
				workload: "20 PR projections, 1001 tasks, 8 MB bodies",
				name,
				wallMs: median(values.wall),
				cpuMs: median(values.cpu),
			}),
		);
	store.close();
	store = undefined;
	// Ignore SQLite so only the synthetic text files affect the diff.
	git("init", "--quiet", "-b", "main");
	writeFileSync(join(root, ".gitignore"), "missions.sqlite*\n");
	git("add", ".gitignore");
	git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture");
	for (let i = 0; i < 1000; i++) writeFileSync(join(root, `file-${i}`), "fixture\n".repeat(64));
	let commands = 0;
	subprocesses.run = (command: string, args: string[], options: ProcessOptions) => {
		commands++;
		return run(command, args, {
			...options,
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		});
	};
	for (let round = 0; round < 4; round++) {
		for (const name of round % 2 ? ["branch", "summary"] : ["summary", "branch"]) {
			commands = 0;
			const before = untrackedStats.bytesRead;
			const start = performance.now();
			const cache = new RepositoryChanges();
			const value = name === "branch" ? await cache.branch(root) : await cache.summary(root);
			assert.equal(value.branch, "main");
			if ("fileCount" in value) assert.equal(value.fileCount, 1000);
			console.log(
				JSON.stringify({
					workload: "row refresh, 1000 untracked files",
					name,
					round,
					wallMs: performance.now() - start,
					commands,
					scannedBytes: untrackedStats.bytesRead - before,
				}),
			);
		}
	}
} finally {
	subprocesses.run = run;
	store?.close();
	await untrackedStats.close();
	await subprocesses.close();
	rmSync(root, { recursive: true, force: true });
}
