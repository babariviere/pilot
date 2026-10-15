/**
 * pilotd event-loop stall benchmark. Drives the synchronous mission-store work that kernel packets trigger
 * (GitHub action audits, member runs/completions, notice activity and the detail pushed to subscribers)
 * on one event loop, quiet and under synthetic disk-write pressure, with SQLite synchronous=FULL (current)
 * and NORMAL. Uses a temporary directory only; never opens user data.
 *   node scripts/bench/daemon-stalls.ts [--seconds 10] [--writers 2]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { operations, threadCpuMs } from "../../packages/daemon/src/event-loop-watchdog.ts";
import { MissionStore } from "../../packages/daemon/src/missions.ts";
import type { SessionSummary } from "../../packages/protocol/src/index.ts";

const { values } = parseArgs({
	options: { seconds: { type: "string", default: "10" }, writers: { type: "string", default: "2" } },
});
const seconds = Number(values.seconds);
const writerCount = Number(values.writers);
const home = await mkdtemp(join(tmpdir(), "pilot-stall-bench-"));

/** Separate processes that keep the disk busy, like agents building, installing and committing. */
function startWriters(count: number): ChildProcess[] {
	const script = `
		const { openSync, writeSync, fsyncSync, closeSync, unlinkSync } = require("node:fs");
		const file = process.argv[1]; const chunk = Buffer.alloc(1 << 20, 7);
		for (;;) { const fd = openSync(file, "w"); for (let i = 0; i < 256; i++) writeSync(fd, chunk); fsyncSync(fd); closeSync(fd); unlinkSync(file); }
	`;
	return Array.from({ length: count }, (_, i) =>
		spawn(process.execPath, ["-e", script, join(home, `writer-${i}`)], { stdio: "ignore" }),
	);
}

function seed(file: string) {
	const store = new MissionStore(file);
	const { id } = store.create({ projectId: "fixture", title: "Fixture" });
	const members = Array.from({ length: 12 }, (_, i) => `member-${i}`);
	for (const member of members) store.join(member, id);
	for (let i = 0; i < 100; i++) store.addTask(id, { title: `Task ${i}`, body: "x".repeat(2_000) });
	return { store, id, members };
}

function percentile(sorted: number[], p: number): number {
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]! : 0;
}

async function scenario(name: string, synchronous: "FULL" | "NORMAL", writers: number) {
	const file = join(home, `${name}-${synchronous}.sqlite`);
	const { store, id, members } = seed(file);
	(store as unknown as { db: { exec(sql: string): void } }).db.exec(`PRAGMA synchronous = ${synchronous}`);
	const children = startWriters(writers);
	await new Promise((resolve) => setTimeout(resolve, writers ? 1_000 : 0));
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	const sections: { ms: number; cpuMs: number }[] = [];
	histogram.enable();
	const end = performance.now() + seconds * 1_000;
	let n = 0;
	while (performance.now() < end) {
		// About 20 packets a second, as several working chats stream, run tools and push.
		const member = members[n % members.length]!;
		const session = {
			id: member,
			missionId: id,
			title: member,
			cwd: home,
			createdAt: 1,
			updatedAt: n,
		} as SessionSummary;
		const started = performance.now();
		const cpu = threadCpuMs();
		operations.time("bench packet", () => {
			if (n % 4 === 0)
				store.recordGitHubAction(
					member,
					{
						id: `a-${n}`,
						missionId: id,
						at: Date.now(),
						exitCode: 0,
						description: "pushed",
						summary: "branch",
					} as never,
					member,
				);
			if (n % 4 === 1) store.recordMemberRun({ ...session, state: "working", working: true });
			if (n % 4 === 2)
				store.recordMemberCompletion({
					...session,
					state: "idle",
					working: false,
					outcome: "done",
					outcomeAt: Date.now(),
				});
			store.setNoticeActivity(id, n % 2 === 0, Date.now());
			store.detail(id);
		});
		sections.push({ ms: performance.now() - started, cpuMs: threadCpuMs() - cpu });
		n++;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	histogram.disable();
	for (const child of children) child.kill("SIGKILL");
	store.close();
	const wall = sections.map((s) => s.ms).sort((a, b) => a - b);
	const cpu = sections.map((s) => s.cpuMs).sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			scenario: name,
			synchronous,
			writers,
			packets: sections.length,
			packetMs: {
				p50: +percentile(wall, 50).toFixed(2),
				p99: +percentile(wall, 99).toFixed(1),
				max: Math.round(wall.at(-1) ?? 0),
			},
			packetCpuMs: { p50: +percentile(cpu, 50).toFixed(2), p99: +percentile(cpu, 99).toFixed(1) },
			packetsOver100ms: wall.filter((ms) => ms >= 100).length,
			loopDelayMs: {
				p50: +(histogram.percentile(50) / 1e6).toFixed(1),
				p99: +(histogram.percentile(99) / 1e6).toFixed(1),
				max: Math.round(histogram.max / 1e6),
			},
		}),
	);
}

try {
	for (const [name, writers] of [
		["quiet", 0],
		["disk-pressure", writerCount],
	] as const)
		for (const synchronous of ["FULL", "NORMAL"] as const) await scenario(name, synchronous, writers);
} finally {
	await rm(home, { recursive: true, force: true });
}
