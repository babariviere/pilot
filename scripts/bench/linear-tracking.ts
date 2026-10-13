/** Offline 500-ticket Linear fixture. No credentials, network or external writes. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pollLinear } from "../../packages/daemon/src/linear-source.ts";
import { ProjectStore } from "../../packages/daemon/src/projects.ts";
import { SourceRegistry } from "../../packages/daemon/src/sources.ts";
import { TrackedItemStore } from "../../packages/daemon/src/tracked-items.ts";

const home = await mkdtemp(join(tmpdir(), "pilot-linear-bench-"));
const projects = new ProjectStore(home);
await projects.load();
const project = await projects.create({ path: home, tracking: { linearTeam: "team-root", slackChannels: [] } });
const items = new TrackedItemStore(join(home, "items.sqlite"));
await items.load([project.id]);
const rows = Array.from({ length: 500 }, (_, i) => ({
	id: `issue-${i}`,
	identifier: `ENG-${i + 1}`,
	title: `Representative ticket ${i + 1}`,
	url: `https://linear.app/example/issue/ENG-${i + 1}`,
	status: i % 2 ? "Done" : "Todo",
	statusType: i % 2 ? "completed" : "unstarted",
	priority: 3,
	estimate: 2,
	assigneeId: "me",
	teamId: "team-child",
	cycleId: "c1",
	gitBranchName: `eng-${i + 1}-ticket`,
	updatedAt: new Date(Date.now() - 60_000).toISOString(),
}));
let calls = 0;
const registry = new SourceRegistry(projects, items, {
	async call(kind, tool, args) {
		// Real MCP replies arrive through worker IPC, not an uninterrupted microtask chain.
		await delay(0);
		if (kind !== "linear") throw new Error("Unexpected server");
		calls++;
		if (tool === "cycles")
			return [{ id: "c1", number: 1, startsAt: "2026-10-05T00:00:00Z", endsAt: "2026-10-19T00:00:00Z" }];
		if (tool !== "issues" || args.assignee !== "me" || args.includeSubTeams !== true)
			throw new Error("Unexpected call");
		const eligible = args.updatedAt ? rows.filter((row) => row.updatedAt >= String(args.updatedAt)) : rows;
		const offset = Number(args.cursor ?? 0),
			end = offset + Number(args.limit);
		return { issues: eligible.slice(offset, end), hasNextPage: end < eligible.length, cursor: String(end) };
	},
});
registry.register("linear", pollLinear);
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
await delay(500);
const baselineP99Ms = lag.percentile(99) / 1e6;
lag.reset();
const latencies: number[] = [];
const started = performance.now(),
	cpu = process.cpuUsage();
try {
	for (let poll = 0; poll < 40; poll++) {
		if (poll) rows[0]!.updatedAt = new Date().toISOString();
		const start = performance.now();
		await registry.poll(`${project.id}:linear`);
		latencies.push(performance.now() - start);
		const dashboard = registry.dashboard(project.id)[0]!;
		if (dashboard.items.length !== 5 || dashboard.total !== 500 || dashboard.linear?.currentCycle?.total !== 500)
			throw new Error("Unbounded or incomplete dashboard");
	}
	latencies.sort((a, b) => a - b);
	console.log(
		JSON.stringify(
			{
				tickets: rows.length,
				polls: latencies.length,
				calls,
				totalMs: performance.now() - started,
				pollP95Ms: latencies[Math.floor(latencies.length * 0.95)],
				baselineP99Ms,
				eventLoopP99Ms: lag.percentile(99) / 1e6,
				cpu: process.cpuUsage(cpu),
				heapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
			},
			null,
			2,
		),
	);
} finally {
	lag.disable();
	await registry.stop();
	await items.close();
	await rm(home, { recursive: true, force: true });
}
