/** Offline kernel-activity hot-path comparison. node scripts/bench/daemon-activity.ts <baseline commit> */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MissionStore } from "../../packages/daemon/src/missions.ts";
import type { SessionSummary } from "../../packages/protocol/src/index.ts";

const baseline = process.argv[2];
if (!baseline || !/^[a-f\d]{6,40}$/.test(baseline)) throw new Error("Pass a baseline commit hash");
const root = fileURLToPath(new URL("../../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "pilot-activity-bench-"));
try {
	const source = execFileSync("git", ["show", `${baseline}:packages/daemon/src/missions.ts`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	}).replaceAll('from "./', `from "${join(root, "packages/daemon/src")}/`);
	const legacyPath = join(home, "baseline.ts");
	await writeFile(legacyPath, source);
	const { MissionStore: LegacyStore } = (await import(pathToFileURL(legacyPath).href)) as {
		MissionStore: typeof MissionStore;
	};
	const seed = join(home, "seed.sqlite");
	const seedStore = new MissionStore(seed);
	const { id } = seedStore.create({ projectId: "fixture", title: "Fixture" });
	seedStore.join("member", id);
	seedStore.close();
	const db = new DatabaseSync(seed);
	const insert = db.prepare(`INSERT INTO tasks
		(id, mission_id, number, title, body, status, sort, session_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'done', ?, ?, 1, 1)`);
	db.exec("BEGIN");
	for (let i = 0; i < 1000; i++)
		insert.run(`task-${i}`, id, i + 1, `Fixture ${i}`, "x".repeat(8_000), i, i % 100 ? "other" : "member");
	db.exec("COMMIT");
	db.close();
	const session: SessionSummary = {
		id: "member",
		missionId: id,
		title: "Fixture",
		cwd: home,
		sessionPath: home,
		state: "working",
		createdAt: 1,
		updatedAt: 1,
	};
	const samples = new Map<string, { elapsedMs: number; cpuMs: number }[]>();
	for (let round = 0; round < 6; round++) {
		const variants = [
			{ name: "baseline", Store: LegacyStore },
			{ name: "current", Store: MissionStore },
		];
		if (round % 2) variants.reverse();
		for (const { name, Store } of variants) {
			const file = join(home, `${round}-${name}.sqlite`);
			await copyFile(seed, file);
			const store = new Store(file);
			try {
				const cpu = process.cpuUsage();
				const start = performance.now();
				// Same summary/working burst in each version. Legacy summaries resolve membership via full get.
				for (let i = 0; i < 100; i++) {
					const membership =
						name === "current"
							? store.membership(session.id)
							: (() => {
									const missionId = store.missionOf(session.id);
									const mission = missionId ? store.get(missionId) : undefined;
									return mission
										? { missionId: mission.id, active: mission.status === "active", coordinator: false }
										: undefined;
								})();
					assert.equal(membership?.missionId, id);
					if (i === 0) store.recordMemberRun(session);
				}
				for (let i = 0; i < 20; i++)
					store.recordMemberCompletion({ ...session, state: "idle", outcome: "done", outcomeAt: 2 + i });
				const elapsedMs = performance.now() - start;
				const used = process.cpuUsage(cpu);
				if (round) {
					const list = samples.get(name) ?? [];
					list.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000 });
					samples.set(name, list);
				}
			} finally {
				store.close();
			}
		}
	}
	for (const [variant, values] of samples) {
		const median = (key: "elapsedMs" | "cpuMs") => Math.round(values.map((v) => v[key]).sort((a, b) => a - b)[2]!);
		console.log(
			JSON.stringify({
				variant,
				tasks: 1000,
				taskBodyBytes: 8_000,
				summaryUpdates: 100,
				runSnapshots: 1,
				completionUpdates: 20,
				samples: values.length,
				elapsedMs: median("elapsedMs"),
				cpuMs: median("cpuMs"),
			}),
		);
	}
} finally {
	await rm(home, { recursive: true, force: true });
}
