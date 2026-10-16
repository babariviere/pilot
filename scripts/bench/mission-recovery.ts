/** Offline startup recovery comparison. node scripts/bench/mission-recovery.ts <baseline commit> [samples] */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MissionNotices } from "../../packages/daemon/src/mission-notices.ts";
import { MissionService } from "../../packages/daemon/src/mission-service.ts";
import { MissionStore } from "../../packages/daemon/src/missions.ts";
import type { ProjectStore } from "../../packages/daemon/src/projects.ts";
import type { SessionManager } from "../../packages/daemon/src/sessions.ts";
import type { SessionSummary } from "../../packages/protocol/src/index.ts";

const baseline = process.argv[2];
const rounds = Number(process.argv[3] ?? 3);
if (!baseline || !/^[a-f\d]{6,40}$/.test(baseline)) throw new Error("Pass a baseline commit hash");
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Samples must be between 1 and 10");
const root = fileURLToPath(new URL("../../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "pilot-recovery-bench-"));
try {
	const source = execFileSync("git", ["show", `${baseline}:packages/daemon/src/mission-notices.ts`], {
		cwd: root,
		encoding: "utf8",
	}).replaceAll('from "./', `from "${join(root, "packages/daemon/src")}/`);
	const legacyPath = join(home, "baseline.ts");
	await writeFile(legacyPath, source);
	const { MissionNotices: LegacyNotices } = (await import(pathToFileURL(legacyPath).href)) as {
		MissionNotices: typeof MissionNotices;
	};
	const samples = new Map<string, { wallMs: number; cpuMs: number; notifications: number; details: number }[]>();
	for (let round = 0; round <= rounds; round++) {
		const variants = [
			{ name: "baseline", Notices: LegacyNotices },
			{ name: "current", Notices: MissionNotices },
		];
		if (round % 2) variants.reverse();
		for (const { name, Notices } of variants) {
			const store = new MissionStore(":memory:");
			const chats = new Map<string, SessionSummary>();
			const ids: string[] = [];
			for (let mission = 0; mission < 3; mission++) {
				const { id } = store.create({ projectId: "fixture", title: `Mission ${mission}` });
				ids.push(id);
				for (let member = 0; member < 40; member++) {
					const sessionId = `member-${mission}-${member}`;
					store.join(sessionId, id);
					const pr = {
						number: mission * 40 + member + 1,
						url: `https://github.com/o/r/pull/${mission * 40 + member + 1}`,
						title: "Fixture PR",
						state: "open" as const,
						checkedAt: 1,
					};
					for (let index = 0; index < 2; index++) {
						const task = store.addTask(id, { title: "Fixture task", body: "x".repeat(8_000) });
						store.claimTask(id, task.id, sessionId);
						store.addResource(id, { url: pr.url, taskId: task.id });
					}
					chats.set(sessionId, {
						id: sessionId,
						missionId: id,
						title: "Fixture chat",
						cwd: home,
						sessionPath: home,
						state: "idle",
						createdAt: 1,
						updatedAt: 1,
						pullRequest: pr,
					});
				}
			}
			const sessions = {
				list: () => [...chats.values()],
				get: (id: string) => chats.get(id),
				onChange: () => () => {},
				ownedPullRequests: (id: string) => [chats.get(id)!.pullRequest!],
				setMissionBridge: () => {},
				missionChanged: () => {},
				refreshMissionPullRequests: () => {},
				requestMainRefresh: () => {},
			} as unknown as SessionManager;
			// Real subscribers rebuild every member context on each mission notification.
			new MissionService(store, sessions, {} as ProjectStore);
			const notices = new Notices(store, sessions);
			let notifications = 0;
			let details = 0;
			store.onChange(() => notifications++);
			const detail = store.detail.bind(store);
			store.detail = (...args) => {
				details++;
				return detail(...args);
			};
			try {
				const cpu = process.cpuUsage();
				const start = performance.now();
				notices.start();
				const wallMs = performance.now() - start;
				const used = process.cpuUsage(cpu);
				for (const id of ids) assert.ok(store.ownedPullRequestResources(id).every((r) => r.pullRequest));
				if (name === "current") assert.equal(notifications, 3);
				if (round) {
					const list = samples.get(name) ?? [];
					list.push({ wallMs, cpuMs: (used.user + used.system) / 1000, notifications, details });
					samples.set(name, list);
				}
			} finally {
				await notices.stop();
				store.close();
			}
		}
	}
	for (const [variant, values] of samples) {
		const median = (key: keyof (typeof values)[number]) =>
			Math.round(values.map((v) => v[key]).sort((a, b) => a - b)[Math.floor(values.length / 2)]!);
		console.log(
			JSON.stringify({
				variant,
				missions: 3,
				members: 120,
				tasks: 240,
				taskBodyBytes: 8_000,
				samples: rounds,
				wallMs: median("wallMs"),
				cpuMs: median("cpuMs"),
				notifications: median("notifications"),
				details: median("details"),
			}),
		);
	}
} finally {
	await rm(home, { recursive: true, force: true });
}
