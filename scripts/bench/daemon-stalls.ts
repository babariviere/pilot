/**
 * pilotd event-loop stall benchmark. Drives the synchronous mission-store work that kernel packets trigger
 * (GitHub action audits, member runs/completions, notice activity and the detail pushed to subscribers)
 * on one event loop, on a quiet disk and while other processes write and sync files. With --baseline, also runs
 * that commit's missions.ts (for example the disk-backed store before it moved to memory) under the same load.
 * Reports event-loop cost per packet and how long the replica takes to make it durable. Temporary files only.
 *   node scripts/bench/daemon-stalls.ts [--baseline <commit>] [--seconds 8] [--writers 2] [--writer-mbps 150]
 *     [--writer-batch-mb 64]
 * Saturating the disk (for example --writer-mbps 2000 --writer-batch-mb 256) writes gigabytes; keep runs short.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { operations, threadCpuMs } from "../../packages/daemon/src/event-loop-watchdog.ts";
import { MissionStore } from "../../packages/daemon/src/missions.ts";
import type { SessionSummary } from "../../packages/protocol/src/index.ts";

const { values } = parseArgs({
	options: {
		baseline: { type: "string" },
		seconds: { type: "string", default: "8" },
		writers: { type: "string", default: "2" },
		"writer-mbps": { type: "string", default: "150" },
		"writer-batch-mb": { type: "string", default: "64" },
	},
});
const seconds = Number(values.seconds);
const writerCount = Number(values.writers);
const writerMbps = Number(values["writer-mbps"]);
const writerBatch = Number(values["writer-batch-mb"]);
const home = await mkdtemp(join(tmpdir(), "pilot-stall-bench-"));

/**
 * Separate processes that write a batch and sync it at a bounded rate, like agents building, installing and
 * committing. Large batches make each sync a long flush that other syncs queue behind. The rate bounds disk wear:
 * about writers × rate × (seconds + 1) per busy scenario.
 */
function startWriters(count: number): ChildProcess[] {
	const script = `
		const { openSync, writeSync, fsyncSync, closeSync, unlinkSync } = require("node:fs");
		const [file, mbps, batch] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])];
		const chunk = Buffer.alloc(1 << 20, 7); const pause = new Int32Array(new SharedArrayBuffer(4));
		const fd = openSync(file, "w");
		for (let i = 0; ; i++) {
			const started = Date.now();
			for (let j = 0; j < batch; j++) writeSync(fd, chunk, 0, chunk.length, ((i % 4) * batch + j) * 1048576);
			fsyncSync(fd);
			Atomics.wait(pause, 0, 0, Math.max(0, (batch * 1000 / mbps) - (Date.now() - started)));
		}
	`;
	return Array.from({ length: count }, (_, i) =>
		spawn(process.execPath, ["-e", script, join(home, `writer-${i}`), String(writerMbps), String(writerBatch)], {
			stdio: "ignore",
		}),
	);
}

function percentile(sorted: number[], p: number): number {
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]! : 0;
}

function summary(values: number[]) {
	const sorted = values.toSorted((a, b) => a - b);
	return {
		p50: +percentile(sorted, 50).toFixed(2),
		p99: +percentile(sorted, 99).toFixed(1),
		max: Math.round(sorted.at(-1) ?? 0),
	};
}

type Store = typeof MissionStore;

/** A commit's missions.ts, importing the current sibling modules. */
async function baselineStore(commit: string): Promise<Store> {
	if (!/^[a-f\d]{6,40}$/.test(commit)) throw new Error("Pass a baseline commit hash");
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const source = execFileSync("git", ["show", `${commit}:packages/daemon/src/missions.ts`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	}).replaceAll('from "./', `from "${join(root, "packages/daemon/src")}/`);
	const path = join(home, "baseline-missions.ts");
	await writeFile(path, source);
	return ((await import(pathToFileURL(path).href)) as { MissionStore: Store }).MissionStore;
}

async function scenario(disk: string, variant: string, Store: Store, writers: number) {
	const file = join(home, `${disk}-${variant}.sqlite`);
	const store = new Store(file);
	const durableStore = store as unknown as { durable?: () => Promise<void> };
	const { id } = store.create({ projectId: "fixture", title: "Fixture" });
	const members = Array.from({ length: 12 }, (_, i) => `member-${i}`);
	for (const member of members) store.join(member, id);
	for (let i = 0; i < 100; i++) store.addTask(id, { title: `Task ${i}`, body: "x".repeat(2_000) });
	await durableStore.durable?.();
	const children = startWriters(writers);
	await new Promise((resolve) => setTimeout(resolve, writers ? 1_000 : 0));
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	const packets: number[] = [];
	const cpu: number[] = [];
	const durable: Promise<number>[] = [];
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
		const cpuAt = threadCpuMs();
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
		packets.push(performance.now() - started);
		cpu.push(threadCpuMs() - cpuAt);
		if (durableStore.durable) durable.push(durableStore.durable().then(() => performance.now() - started));
		n++;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	histogram.disable();
	const durableMs = await Promise.all(durable);
	for (const child of children) child.kill("SIGKILL");
	store.close();
	console.log(
		JSON.stringify({
			disk,
			store: variant,
			packets: packets.length,
			packetMs: summary(packets),
			packetCpuMs: summary(cpu),
			packetsOver100ms: packets.filter((ms) => ms >= 100).length,
			loopDelayMs: {
				p50: +(histogram.percentile(50) / 1e6 - 10).toFixed(1),
				p99: +(histogram.percentile(99) / 1e6 - 10).toFixed(1),
				max: Math.round(histogram.max / 1e6 - 10),
			},
			...(durableMs.length ? { durableAfterMs: summary(durableMs) } : {}),
		}),
	);
}

try {
	const variants: [string, Store][] = [
		...(values.baseline
			? [[`baseline ${values.baseline.slice(0, 8)}`, await baselineStore(values.baseline)] as [string, Store]]
			: []),
		["current", MissionStore],
	];
	for (const [disk, writers] of [
		["quiet", 0],
		["busy", writerCount],
	] as const)
		for (const [name, Store] of variants) await scenario(disk, name, Store, writers);
} finally {
	await rm(home, { recursive: true, force: true });
}
