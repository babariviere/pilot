// biome-ignore-all lint/complexity/useLiteralKeys: Instrument private SQLite query plans, not production API.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SharedContextBinding } from "@pilot/protocol";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";
import { SharedContextService } from "./shared-context.ts";

test("large shared manifests and concurrent context activity retain bounded indexed work and report heartbeat", {
	skip: !process.env.CI,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-sharing-stress-"));
	const stores: MissionStore[] = [],
		memories: ProjectMemoryService[] = [],
		managers: SessionManager[] = [],
		services: SharedContextService[] = [],
		missions: MissionService[] = [];
	t.after(async () => {
		await Promise.all(services.map((service) => service.stop()));
		await Promise.all(missions.map((mission) => mission.notices.stop()));
		await Promise.all(managers.map((manager) => manager.shutdown()));
		await Promise.all(memories.map((memory) => memory.stop()));
		for (const store of stores) store.close();
		await rm(root, { recursive: true, force: true });
	});
	async function peer(name: string) {
		const home = join(root, name),
			projectPath = join(home, "project");
		await mkdir(projectPath, { recursive: true });
		const projects = new ProjectStore(home);
		await projects.load();
		const project = await projects.create({ path: projectPath, workspace: "direct" });
		const host = { hostId: "daemon", daemonId: name, lineageId: `lineage-${name}` };
		const memory = new ProjectMemoryService(home, undefined, 30_000, host);
		memories.push(memory);
		await memory.load(project.id);
		const store = new MissionStore(":memory:");
		stores.push(store);
		const sessions = new SessionManager(home, projects);
		managers.push(sessions);
		const mission = new MissionService(store, sessions, projects);
		missions.push(mission);
		const sharing = new SharedContextService(host, store, memory, projects, sessions, mission);
		services.push(sharing);
		sessions.setSharedContext(sharing);
		mission.setSharedContext(sharing);
		return { home, project, host, memory, store, sessions, sharing };
	}
	const source = await peer("source"),
		target = await peer("target");
	const mission = source.store.create({
		projectId: source.project.id,
		title: "Large context",
		tasks: Array.from({ length: 42 }, (_, i) => ({ title: `Task ${i}`, body: "bounded context ".repeat(360) })),
	});
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "large",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: source.host, projectId: source.project.id },
		missionHome: source.host,
		executionProject: { host: target.host, projectId: target.project.id },
		missionIds: [mission.id],
		shareMemory: false,
		state: "active",
	};
	await source.sharing.enroll(binding);
	await target.sharing.enroll(binding);
	let fullFragmentScans = 0;
	const original = target.store.sharingList.bind(target.store);
	t.mock.method(target.store, "sharingList", (namespace: string) => {
		if (namespace.startsWith("fragment:") && !namespace.endsWith(":meta")) fullFragmentScans++;
		return original(namespace);
	});
	const journal = new OperationJournal(join(target.home, "operations"), target.host);
	// Same-process idle/session-read reference, not a historical implementation or GUI baseline.
	async function measure(run: () => Promise<void>) {
		const histogram = monitorEventLoopDelay({ resolution: 5 });
		histogram.enable();
		await delay(10);
		histogram.reset();
		const cpu = process.cpuUsage(),
			resources = process.resourceUsage(),
			elu = performance.eventLoopUtilization(),
			start = performance.now();
		let last = performance.now(),
			maxGap = 0,
			ticks = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			maxGap = Math.max(maxGap, now - last);
			last = now;
			ticks++;
			source.sessions.list();
		}, 5);
		try {
			await run();
			await delay(5);
		} finally {
			clearInterval(timer);
			histogram.disable();
		}
		const used = process.cpuUsage(cpu),
			end = process.resourceUsage(),
			wallMs = performance.now() - start;
		return {
			wallMs,
			userCpuMs: used.user / 1000,
			systemCpuMs: used.system / 1000,
			cpuToWall: (used.user + used.system) / 1000 / wallMs,
			eventLoopUtilization: performance.eventLoopUtilization(elu).utilization,
			maxHeartbeatGapMs: maxGap,
			ticks,
			eventLoopDelayMs: {
				p50: histogram.percentile(50) / 1e6,
				p95: histogram.percentile(95) / 1e6,
				p99: histogram.percentile(99) / 1e6,
				max: histogram.max / 1e6,
			},
			fsRead: end.fsRead - resources.fsRead,
			fsWrite: end.fsWrite - resources.fsWrite,
			involuntaryContextSwitches: end.involuntaryContextSwitches - resources.involuntaryContextSwitches,
			rssBytes: process.memoryUsage().rss,
		};
	}
	const idleSessionReadBaseline = await measure(() => delay(300));
	let maxOutboxReadLimit = 0;
	const readOutbox = source.store.sharingOutbox.bind(source.store);
	t.mock.method(source.store, "sharingOutbox", (bindingId: string, destination?: string, limit = 4096) => {
		maxOutboxReadLimit = Math.max(maxOutboxReadLimit, limit);
		return readOutbox(bindingId, destination, limit);
	});
	let operations = 0;
	const transferMetrics = await measure(async () => {
		for (let pass = 0; pass < 64; pass++) {
			const batch = await source.sharing.exchange(binding.bindingId, target.host);
			if (!batch.operations.length) break;
			for (const operation of batch.operations) {
				const receipt = await journal.execute(operation, (item) => target.sharing.handle(item));
				assert.equal(receipt.state, "accepted");
				await source.sharing.acknowledge(binding.bindingId, { operation, receipt });
				operations++;
			}
			assert.ok(pass < 63, "bounded pages must converge");
		}
	});
	assert.ok(maxOutboxReadLimit <= 17, "exchange should deserialize at most one bounded page plus the more sentinel");
	assert.ok(operations > 50, "fixture exercises a fragmented complete manifest");
	assert.equal(fullFragmentScans, 1, "full payload reassembly happens once, not once per fragment");
	const plan = source.store["db"]
		.prepare(
			"EXPLAIN QUERY PLAN SELECT value FROM shared_outbox WHERE binding_id=? AND destination=? AND acknowledged=0 ORDER BY sequence LIMIT 16",
		)
		.all(binding.bindingId, JSON.stringify(["daemon", target.host.daemonId, target.host.lineageId]));
	assert.match(JSON.stringify(plan), /shared_outbox_active/);
	t.diagnostic(
		JSON.stringify({
			kind: "large-manifest",
			operations,
			fullFragmentScans,
			wallMs: transferMetrics.wallMs,
			maxHeartbeatGapMs: transferMetrics.maxHeartbeatGapMs,
			heartbeats: transferMetrics.ticks,
			maxOutboxReadLimit,
			idleSessionReadBaseline,
			transferMetrics,
		}),
	);
	const costs: number[] = [];
	const cpuCosts: { user: number; system: number }[] = [];
	for (const enrolled of [false, true]) {
		const store = new MissionStore(":memory:");
		stores.push(store);
		const scope = store.create({ projectId: "p", title: "CPU", tasks: [{ title: "Task" }] });
		if (enrolled) store.shareMission(scope.id);
		const begin = performance.now();
		const cpu = process.cpuUsage();
		for (let i = 0; i < 2000; i++) store.updateTask(scope.id, "1", { body: `edit ${i}` });
		costs.push(performance.now() - begin);
		cpuCosts.push(process.cpuUsage(cpu));
		assert.equal(store.sharedHead() === 0, !enrolled);
	}
	t.diagnostic(
		JSON.stringify({
			kind: "canonical-write-comparison",
			unenrolledMs: costs[0],
			enrolledMs: costs[1],
			cpuMicroseconds: { unenrolled: cpuCosts[0], enrolled: cpuCosts[1] },
			edits: 2000,
		}),
	);
});
