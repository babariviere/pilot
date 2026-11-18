/**
 * Synthetic only: node scripts/bench/planning-inventory.ts. The planning list read (NativeMissionPlanning.inventory)
 * over 100 unpublished planning missions, with and without the stuck-planner check. Five planners are idle with long
 * histories (their last message several pages back), so the check reads their saved history; the rest work.
 * Nothing reads a real session or starts a worker.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PLANNING_PROFILE } from "@pilot/kernel";
import type { DurableOperation, SessionSummary } from "@pilot/protocol";
import { ColdViewReader } from "../../packages/daemon/src/cold-view-reader.ts";
import { daemonHello } from "../../packages/daemon/src/hello.ts";
import { MissionInterviews } from "../../packages/daemon/src/mission-interviews.ts";
import { MissionStore } from "../../packages/daemon/src/missions.ts";
import { NativeMissionPlanning } from "../../packages/daemon/src/native-mission-planning.ts";
import { OperationJournal, payloadHash } from "../../packages/daemon/src/operation-journal.ts";
import { PlanningWorkers } from "../../packages/daemon/src/planning-workers.ts";
import { ProjectStore } from "../../packages/daemon/src/projects.ts";
import { SessionManager } from "../../packages/daemon/src/sessions.ts";
import { WorkflowConfirmations } from "../../packages/daemon/src/workflow-confirmations.ts";
import { openSessionStorage } from "../../packages/kernel/src/storage.ts";

const MISSIONS = 100;
const STUCK = 5;
/** Entries per stuck planner, and tool entries after its last message (about 5 history pages of 64). */
const ENTRIES = 3000;
const AFTER_LAST_MESSAGE = 300;
const ROUNDS = 20;

const home = await mkdtemp(join(tmpdir(), "pilot-planning-inventory-bench-"));
const histories = new Map<string, string>();
const closers: Array<() => Promise<void>> = [];
try {
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, workspace: "direct" });
	const hello = await daemonHello(home, {
		independentExecution: true,
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: true,
		coordinatorIsolation: true,
	});
	const host = { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId! };
	const store = new MissionStore(join(home, "missions.sqlite"));
	const journal = new OperationJournal(join(home, "operations"), host);
	const confirmations = () => new WorkflowConfirmations({ store, journal, authorize: () => "bench" });
	const interviews = new MissionInterviews({
		store,
		journal,
		confirmations: confirmations(),
		authorize: () => "bench",
	});
	const operation = (targetId: string, request: { purpose: string }): DurableOperation => {
		const payload = JSON.stringify(request);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...host, hostId: "fixture" },
			destination: host,
			targetId,
			kind: request.purpose,
			payload,
			payloadHash: payloadHash(payload),
		};
	};
	const owners = new Map<string, SessionSummary>();
	for (let i = 0; i < MISSIONS; i++) {
		const ownerSessionId = randomUUID();
		const stuck = i < STUCK;
		owners.set(ownerSessionId, {
			id: ownerSessionId,
			title: `Planner ${i}`,
			projectId: project.id,
			cwd: home,
			mode: "build",
			state: stuck ? "idle" : "working",
			working: !stuck,
			createdAt: 1,
			updatedAt: 1,
			...(stuck ? { outcome: "done" as const, outcomeAt: 2 } : {}),
		});
		const create = operation(randomUUID(), {
			purpose: "interview-create",
			projectId: project.id,
			title: `Mission ${i}`,
			ownerSessionId,
			questions: [
				{
					id: "outcome",
					section: "outcome",
					prompt: "What should change?",
					options: [{ id: "a", meaning: "A" }],
					recommendedOptionId: "a",
				},
			],
		} as { purpose: string });
		await journal.execute(create, (op, entry) => interviews.admit(op, entry.firstEntry));
		const fence = store.interviews.lookup(create)!.fence;
		store.planningWorkers.create(() => ({
			version: 1,
			binding: {
				version: 1 as const,
				profile: PLANNING_PROFILE,
				home,
				host: journal.destination,
				projectId: project.id,
				missionId: fence.missionId,
				ownerSessionId,
				enrollmentId: fence.enrollmentId,
				creationOperationId: "bench-create",
			},
			creation: create,
			goal: "Bench",
			configurationDigest: "bench",
			revision: 1,
			phase: "active",
			hold: null,
			pendingHold: null,
			continuation: null,
		}));
		if (!stuck) continue;
		// A long planner history: its last message, then many tool steps after it.
		const directory = join(home, "histories", ownerSessionId);
		const owned = await openSessionStorage(directory);
		const harness = await Harness.open(
			owned.storage,
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			for (let e = 0; e < ENTRIES; e++) {
				const last = e === ENTRIES - AFTER_LAST_MESSAGE - 1;
				await tx.appendEntry(
					root.id,
					last || e % 50 === 0
						? {
								kind: "pi.assistant",
								model: [
									{
										role: "assistant" as const,
										content: [
											{
												type: "text" as const,
												text: `Which database should the export use? ${e} ${"words ".repeat(200)}`,
											},
										],
										api: "bench",
										provider: "bench",
										model: "bench",
										usage: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											totalTokens: 0,
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
										},
										stopReason: "stop" as const,
										timestamp: e,
									},
								],
							}
						: { kind: "pilot.activity", data: { text: `Tool step ${e} ${"body ".repeat(200)}` } },
				);
			}
		}, context);
		await harness.close(context);
		owned.release();
		histories.set(ownerSessionId, directory);
	}
	await store.durable();

	const cold = new ColdViewReader();
	closers.push(async () => cold.close());
	const sessions = new SessionManager(home, projects);
	let pageReads = 0;
	sessions.get = (id) => owners.get(id);
	// Each real planner has its own history. Idle planners of the worst case share one here, so their reads of it
	// take turns, as reads of separate histories would not collide.
	const turns = new Map<string, Promise<unknown>>();
	sessions.history = async (id, before, limit) => {
		pageReads++;
		const directory = histories.get(id);
		// Planners made idle for the worst case share the first long history.
		const dir = directory ?? [...histories.values()][0]!;
		const turn = (turns.get(dir) ?? Promise.resolve()).then(() => cold.readEarlier(dir, before, limit));
		turns.set(
			dir,
			turn.catch(() => {}),
		);
		const read = await turn;
		return { entries: read.entries, more: read.more };
	};
	sessions.planningIdentity = () => ({ inputGeneration: 0, permission: { level: "investigate" } }) as never;
	sessions.assertPlanningOpen = () => {};
	const workers = new PlanningWorkers({ home, store, journal, projects, sessions, confirmations: confirmations() });
	closers.push(() => workers.close());
	const native = new NativeMissionPlanning({
		store,
		journal,
		projects,
		sessions,
		confirmations: confirmations(),
		workers,
	});

	const stuckView = workers.stuckView.bind(workers);
	const run = async (label: string, stuckCheck: boolean) => {
		// "before": the list read as it was, with no stuck check.
		workers.stuckView = stuckCheck ? stuckView : () => undefined;
		const times: number[] = [];
		pageReads = 0;
		let stuckRows = 0;
		let missing: unknown[] = [];
		for (let r = 0; r < ROUNDS; r++) {
			const start = performance.now();
			const list = await native.inventory(project.id);
			times.push(performance.now() - start);
			stuckRows = list.items.filter((i) => i.stuck?.plannerSays).length;
			missing = list.items.filter((i) => !i.stuck?.plannerSays).map((i) => [i.stage, i.stuck?.line ?? "not stuck"]);
		}
		const first = times[0]!;
		times.sort((a, b) => a - b);
		return {
			label,
			firstMs: +first.toFixed(1),
			medianMs: +times[Math.floor(times.length / 2)]!.toFixed(1),
			p90Ms: +times[Math.floor(times.length * 0.9)]!.toFixed(1),
			historyPagesPerRead: pageReads / ROUNDS,
			stuckRowsWithWords: stuckRows,
			otherRows: missing.slice(0, 2),
		};
	};
	// Warm SQLite and the module graph, without the stuck check, so "after" starts with no kept words.
	workers.stuckView = () => undefined;
	await native.inventory(project.id);
	const results = [await run("before (no stuck check)", false), await run(`after, ${STUCK} stuck`, true)];
	// Worst case: every planner idle and stuck. The first read fills the kept words; later reads reuse them.
	for (const owner of owners.values())
		Object.assign(owner, { state: "idle", working: false, outcome: "done", outcomeAt: 2 });
	results.push(await run("before, all idle", false), await run("after, all idle and stuck", true));
	console.log(
		JSON.stringify(
			{
				fixture: {
					missions: MISSIONS,
					stuck: STUCK,
					entries: ENTRIES,
					afterLastMessage: AFTER_LAST_MESSAGE,
					rounds: ROUNDS,
				},
				results,
			},
			null,
			2,
		),
	);
	store.close();
} finally {
	for (const close of closers.reverse()) await close().catch(() => {});
	await rm(home, { recursive: true, force: true });
}
