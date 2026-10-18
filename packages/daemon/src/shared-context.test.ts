// biome-ignore-all lint/complexity/useLiteralKeys: Controlled fake worker and recovery boundary inspection.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket, KernelSpec } from "@pilot/kernel";
import type {
	DelegationGrant,
	OperationHost,
	OperationReceipt,
	SharedContextBinding,
	SharedEntity,
	SharedExchangeBatch,
	SharedMemoryRead,
	SharedMissionProposal,
} from "@pilot/protocol";
import { WebSocket } from "ws";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { SharedContextService } from "./shared-context.ts";
import { TerminalManager } from "./terminals.ts";

class Worker implements SessionWorker {
	ready = Promise.resolve();
	state = "idle" as const;
	busy = false;
	children = false;
	requests: KernelCommand[] = [];
	sent: KernelCommand[] = [];
	readonly spec: KernelSpec;
	readonly packet: (packet: KernelPacket) => void;
	constructor(spec: KernelSpec, packet: (packet: KernelPacket) => void) {
		this.spec = spec;
		this.packet = packet;
	}
	send(command: KernelCommand) {
		this.sent.push(command);
	}
	async request(command: KernelCommand) {
		this.requests.push(command);
		if (command.type === "input")
			this.packet({ type: "accepted", requestId: command.requestId, delivery: "delivered" });
	}
	async jobs() {
		return [];
	}
	async hasChildren() {
		return this.children;
	}
	async close() {}
}
async function until(check: () => boolean) {
	for (let i = 0; i < 1000; i++) {
		if (check()) return;
		await delay(2);
	}
	throw new Error("fixture did not settle");
}
async function peer(t: TestContext, name: string) {
	const home = await mkdtemp(join(tmpdir(), `pilot-shared-${name}-`));
	const dir = join(home, "project");
	await mkdir(dir);
	const host: OperationHost = { hostId: "daemon", daemonId: name, lineageId: `lineage-${name}` };
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: dir, workspace: "direct" });
	const memory = new ProjectMemoryService(home, undefined, 30_000, host);
	await memory.load(project.id);
	const workers = new Map<string, Worker>();
	const sessions = new SessionManager(
		home,
		projects,
		undefined,
		{
			title: async () => undefined,
			worker: (spec, onPacket) => {
				const worker = new Worker(spec, onPacket);
				workers.set(spec.sessionId, worker);
				queueMicrotask(() => onPacket({ type: "ready", model: "test/model", working: false, usage: {} }));
				return worker;
			},
		},
		{
			runner: async () => {
				throw new Error("No live integrations");
			},
		},
		{ idleParkMs: Infinity },
	);
	t.mock.method(sessions, "selectTaskModel", async (_cwd: string, model?: string, thinking?: string) => ({
		model: model ?? "test/model",
		thinking: thinking ?? "medium",
	}));
	t.mock.method(sessions as unknown as { refreshMainViews(): Promise<void> }, "refreshMainViews", async () => {});
	const store = new MissionStore(join(home, "missions.sqlite"));
	const missions = new MissionService(store, sessions, projects);
	const sharing = new SharedContextService(host, store, memory, projects, sessions, missions);
	sessions.setProjectMemory(memory);
	sessions.setSharedContext(sharing);
	missions.setSharedContext(sharing);
	await sessions.load();
	const journal = new OperationJournal(join(home, "operations"), host);
	const cleanupExtras: (() => Promise<void>)[] = [];
	t.after(async () => {
		for (const cleanup of cleanupExtras) await cleanup();
		await sharing.stop();
		await missions.notices.stop();
		await sessions.shutdown();
		await memory.stop();
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		host,
		home,
		project,
		projects,
		memory,
		sessions,
		store,
		missions,
		sharing,
		journal,
		workers,
		cleanupExtras,
	};
}
type Peer = Awaited<ReturnType<typeof peer>>;
async function readEndpoint(peer: Peer) {
	const server = createDaemonServer(
		{ home: peer.home, host: "127.0.0.1", port: 0 },
		peer.sessions,
		peer.projects,
		new ModelCatalog(join(peer.home, "agent")),
		new TerminalManager(),
		{ store: peer.store, service: peer.missions },
		undefined,
		peer.memory,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		peer.sharing,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	peer.cleanupExtras.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shared-contexts`;
}
async function relay(source: Peer, destination: Peer, binding: SharedContextBinding) {
	const batch = await source.sharing.exchange(binding.bindingId, destination.host);
	for (const operation of batch.operations) {
		const receipt = await destination.journal.execute(operation, (op) => destination.sharing.handle(op));
		assert.notEqual(receipt.state, "pending", `${operation.kind} must settle in fixture`);
		await source.sharing.acknowledge(binding.bindingId, { operation, receipt });
	}
	return batch.operations.length;
}
async function reconcile(a: Peer, b: Peer, binding: SharedContextBinding) {
	for (let i = 0; i < 40; i++) {
		const count = (await relay(a, b, binding)) + (await relay(b, a, binding));
		if (count === 0) return;
	}
	throw new Error(
		`reconciliation failed to converge: ${JSON.stringify(a.store.sharedChanges(0).slice(-8))} ${JSON.stringify(b.store.sharingList("execution"))}`,
	);
}

test("real stores/bridges admit one bounded remote session, retain offline proposals and converge repeatedly", async (t) => {
	const home = await peer(t, "home"),
		target = await peer(t, "target");
	const mission = home.store.create({
		projectId: home.project.id,
		title: "Shared mission",
		tasks: [{ title: "Only accepted task" }, { title: "Sibling" }],
	});
	home.store.writeBrief(mission.id, "Mandatory offline brief", 0);
	await home.memory.note(home.project.id, "Canonical memory survives without the Mac", "local");
	await target.memory.note(target.project.id, "Unrelated target-local memory", "target-local");
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "explicit-link",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: home.host, projectId: home.project.id },
		missionHome: home.host,
		executionProject: { host: target.host, projectId: target.project.id },
		missionIds: [mission.id],
		shareMemory: true,
		state: "active",
	};
	await home.sharing.enroll(binding);
	await target.sharing.enroll(binding);
	await reconcile(home, target, binding);
	const task = home.store.resolveTask(mission.id, "1");
	const grant = await home.sharing.reserve(mission.id, task.id, {
		bindingId: binding.bindingId,
		expectedRevision: home.store.sharedDefinitionRevision(task.id),
		expectedPreviousEpoch: 0,
		model: "test/model",
	});
	assert.throws(() => home.store.prepareTaskStart(mission.id, [task.id]), /occupied/);
	await reconcile(home, target, binding);
	await until(
		() => target.workers.has(grant.session.sessionId) && !target.sessions["starting"].has(grant.session.sessionId),
	);
	const worker = target.workers.get(grant.session.sessionId)!;
	assert.equal(worker.spec.mission?.coordinator, "other");
	assert.equal(worker.spec.mission?.sharedContext, true);
	assert.equal(target.store.list().length, 0, "replica must not be a writable synthetic local mission");
	assert.equal(target.sessions.get(grant.session.sessionId)?.projectId, target.project.id);
	assert.equal(
		worker.requests.filter(
			(command) =>
				command.type === "input" &&
				command.requestId === target.sharing.membership(grant.session.sessionId)!.operationId,
		).length,
		1,
	);
	assert.match(
		JSON.stringify(await target.missions.call(grant.session.sessionId, "brief", {})),
		/Mandatory offline brief/,
	);
	assert.match(
		JSON.stringify(await target.sharing.memoryCall(grant.session.sessionId, "recall", { regex: "Canonical" })),
		/Canonical memory/,
	);
	worker.packet({ type: "memory.call", callId: "offline-recall", action: "recall", args: { regex: "Canonical" } });
	worker.packet({ type: "mission.call", callId: "offline-brief", action: "brief", args: {} });
	await until(
		() =>
			worker.sent.some((command) => command.type === "memory.result" && command.callId === "offline-recall") &&
			worker.sent.some((command) => command.type === "mission.result" && command.callId === "offline-brief"),
	);
	assert.match(
		JSON.stringify(
			worker.sent.find((command) => command.type === "memory.result" && command.callId === "offline-recall"),
		),
		/Canonical memory/,
	);
	await assert.rejects(target.missions.call(grant.session.sessionId, "claim", { id: "2" }), /home authority/);
	await target.sharing.memoryCall(grant.session.sessionId, "note", { text: "Remote provisional contribution" });
	const local = (await target.sharing.memoryCall(grant.session.sessionId, "wake", {})) as SharedMemoryRead;
	assert.equal(local.proposals[0]?.state, "pending");
	assert.equal(
		(await home.memory.recall(home.project.id, "Remote")).matches,
		0,
		"partition does not canonically commit a proposal",
	);
	await reconcile(home, target, binding);
	assert.equal((await home.memory.recall(home.project.id, "Remote")).matches, 1);
	await home.memory.note(home.project.id, "Second canonical change", "local");
	home.store.writeBrief(mission.id, "Updated during execution", 1);
	await reconcile(home, target, binding);
	assert.match(
		JSON.stringify(await target.missions.call(grant.session.sessionId, "brief", {})),
		/Updated during execution/,
	);
	assert.equal(
		(await target.memory.recall(target.project.id, "Remote")).matches,
		0,
		"shared notes never silently merge into target project memory",
	);
	assert.ok(
		worker.requests.some((command) => command.type === "input" && command.requestId.startsWith("shared-context:")),
		"live context changes have durable notice identities",
	);
	const occupied = home.store.sharedAllocation(task.id);
	assert.ok(occupied);
	await assert.rejects(
		home.sharing.reserve(mission.id, task.id, {
			bindingId: binding.bindingId,
			expectedRevision: home.store.sharedDefinitionRevision(task.id),
			expectedPreviousEpoch: grant.executionEpoch,
			model: "test/model",
		}),
		/occupied/,
	);
});

async function enrolled(t: TestContext) {
	const home = await peer(t, "home"),
		target = await peer(t, "target");
	const mission = home.store.create({ projectId: home.project.id, title: "M", tasks: [{ title: "Bounded" }] });
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "binding",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: home.host, projectId: home.project.id },
		missionHome: home.host,
		executionProject: { host: target.host, projectId: target.project.id },
		missionIds: [mission.id],
		shareMemory: true,
		state: "active",
	};
	await home.sharing.enroll(binding);
	await target.sharing.enroll(binding);
	await reconcile(home, target, binding);
	const task = home.store.resolveTask(mission.id, "1");
	const grant = await home.sharing.reserve(mission.id, task.id, {
		bindingId: binding.bindingId,
		expectedRevision: home.store.sharedDefinitionRevision(task.id),
		expectedPreviousEpoch: 0,
		model: "test/model",
	});
	return { home, target, mission, binding, task, grant };
}

test("repeated partitions keep one accepted execution and import lost-ack provisional notes exactly once", async (t) => {
	const { home, target, mission, binding, task, grant } = await enrolled(t);
	await reconcile(home, target, binding);
	await until(
		() => target.workers.has(grant.session.sessionId) && !target.sessions["starting"].has(grant.session.sessionId),
	);
	const worker = target.workers.get(grant.session.sessionId)!;
	const inputId = target.sharing.membership(grant.session.sessionId)!.operationId;
	for (let cycle = 1; cycle <= 3; cycle++) {
		const text = `Partition round ${cycle}: preserve the bounded target's contribution`;
		await target.sharing.memoryCall(grant.session.sessionId, "note", { text });
		const offline = (await target.sharing.memoryCall(grant.session.sessionId, "wake", {})) as SharedMemoryRead;
		assert.ok(offline.proposals.some((proposal) => proposal.state === "pending" && proposal.mutation.text === text));
		assert.equal((await home.memory.recall(home.project.id, `Partition round ${cycle}:`)).matches, 0);
		await assert.rejects(target.missions.call(grant.session.sessionId, "claim", { id: task.id }), /home authority/);
		assert.throws(() => home.store.prepareTaskStart(mission.id, [task.id]), /occupied/);
		// The home commits, but the target loses every acknowledgment. Repeated transport delivery
		// must use the same durable operation, never create a second note or execution.
		const batch = await target.sharing.exchange(binding.bindingId, home.host);
		for (const operation of batch.operations) {
			const receipt = await home.journal.execute(operation, (op) => home.sharing.handle(op));
			assert.deepEqual(await home.journal.execute(operation, (op) => home.sharing.handle(op)), receipt);
		}
		await reconcile(home, target, binding);
		assert.equal((await home.memory.recall(home.project.id, `Partition round ${cycle}:`)).matches, 1);
		assert.equal(target.sessions.list().length, 1);
		assert.equal(home.store.sharedTaskGrant(task.id)?.delegationId, grant.delegationId);
		assert.equal(
			worker.requests.filter((command) => command.type === "input" && command.requestId === inputId).length,
			1,
		);
		assert.equal(target.store.list().length, 0, "a replica must not elect or materialize another mission authority");
	}
});

test("Control replica freshness tracks mission checkpoint/delta imports, not later memory sync", async (t) => {
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const { home, target, mission, binding } = await enrolled(t);
	await reconcile(home, target, binding);
	const read = () => target.store.controlSharedContext(target.host).find((g) => g.missionId === mission.id)!.replica!;
	assert.equal(read().complete, true);
	assert.equal(read().replicaSyncedAt, 1000);
	now = 2000;
	home.store.writeBrief(mission.id, "Canonical update", 0);
	await reconcile(home, target, binding);
	assert.equal(read().replicaSyncedAt, 2000);
	now = 3000;
	await home.memory.note(home.project.id, "Memory-only update", "author");
	await reconcile(home, target, binding);
	assert.equal(read().replicaSyncedAt, 2000);
	assert.equal((await target.sharing.summaries())[0]!.freshness.lastSyncedAt, 3000);
});

test("cancel before delayed offer retains an epoch tombstone and only target acknowledgment releases home", async (t) => {
	const { home, target, mission, binding, task, grant } = await enrolled(t);
	const offer = (await home.sharing.exchange(binding.bindingId, target.host)).operations.find(
		(operation) => operation.kind === "share-offer",
	)!;
	home.sharing.cancel(grant.delegationId);
	await home.store.durable();
	assert.throws(() => home.store.prepareTaskStart(mission.id, [task.id]), /occupied/);
	const cancel = (await home.sharing.exchange(binding.bindingId, target.host)).operations.find(
		(operation) => operation.kind === "share-cancel",
	)!;
	const receipt = await target.journal.execute(cancel, (operation) => target.sharing.handle(operation));
	assert.equal(receipt.state, "accepted");
	assert.throws(
		() => home.store.prepareTaskStart(mission.id, [task.id]),
		/occupied/,
		"lost acknowledgment cannot release source ownership",
	);
	await home.sharing.acknowledge(binding.bindingId, { operation: cancel, receipt });
	assert.equal(home.store.sharedAllocation(task.id), undefined);
	assert.equal(
		(await target.journal.execute(offer, (operation) => target.sharing.handle(operation))).state,
		"rejected",
	);
	assert.equal(target.sessions.list().length, 0);
});

test("seal waits for actual child inspection, retains late facts, and never treats a result as ownership release", async (t) => {
	const { home, target, mission, binding, task, grant } = await enrolled(t);
	await reconcile(home, target, binding);
	await until(
		() => target.workers.has(grant.session.sessionId) && !target.sessions["starting"].has(grant.session.sessionId),
	);
	const worker = target.workers.get(grant.session.sessionId)!;
	worker.packet({ type: "working", working: false, completion: { outcome: "done", outcomeAt: 1 } });
	await reconcile(home, target, binding);
	assert.ok(home.store.sharedAllocation(task.id), "finished turn is not a sealed allocation");
	assert.notEqual(
		home.store.resolveTask(mission.id, task.id).status,
		"done",
		"unreviewed result cannot satisfy dependencies",
	);
	worker.packet({ type: "working", working: false, completion: { outcome: "done", outcomeAt: 2 } });
	await until(() => !target.sessions["starting"].has(grant.session.sessionId));
	worker.children = true;
	assert.equal(
		(await target.sharing.seal(grant.delegationId)).sealed,
		false,
		"idle child kernel is still a live-process blocker",
	);
	await assert.rejects(target.sessions.send(grant.session.sessionId, "new input"), /fenced/);
	assert.throws(() => home.store.prepareTaskStart(mission.id, [task.id]), /occupied/);
	worker.children = false;
	assert.equal((await target.sharing.seal(grant.delegationId)).sealed, true);
	assert.ok(home.store.sharedAllocation(task.id), "target local seal still needs durable home import");
	home.store.removeTask(mission.id, task.id);
	await reconcile(home, target, binding);
	assert.equal(home.store.sharedAllocation(task.id), undefined);
	assert.ok(
		home.sharing.audit(binding.bindingId, grant.delegationId).events.length > 0,
		"late evidence survives physical task deletion",
	);
	assert.equal(home.store.tasks(mission.id).length, 0, "late result must not resurrect task");
});

test("HTTP/WebSocket receipt finalization and lost acknowledgment reconcile bidirectionally to event quiescence", async (t) => {
	const home = await peer(t, "wire-home"),
		target = await peer(t, "wire-target");
	async function endpoint(peer: Peer) {
		const server = createDaemonServer(
			{ home: peer.home, host: "127.0.0.1", port: 0 },
			peer.sessions,
			peer.projects,
			new ModelCatalog(join(peer.home, "agent")),
			new TerminalManager(),
			{ store: peer.store, service: peer.missions },
			undefined,
			peer.memory,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				daemonId: peer.host.daemonId,
				lineageId: peer.host.lineageId,
				daemonVersion: "test",
				protocolVersion: 1,
				minimumClientProtocolVersion: 1,
				platform: "linux",
				arch: "x64",
				capabilities: {
					powerManagement: false,
					systemSleepEvents: false,
					swiftUIArtifacts: false,
					coordinatorIsolation: false,
					independentExecution: true,
				},
			},
			undefined,
			peer.sharing,
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/ws`);
		let invalidations = 0;
		ws.on("message", (data) => {
			if (JSON.parse(String(data)).type === "shared-contexts.changed") invalidations++;
		});
		await once(ws, "open");
		const barrier = async () => {
			const pong = once(ws, "pong");
			ws.ping();
			await pong;
		};
		const request = async (path: string, body?: unknown) => {
			const response = await fetch(
				`${base}/api${path}`,
				body === undefined
					? undefined
					: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
			);
			assert.ok(response.ok, `${path} ${response.status}: ${response.ok ? "" : await response.text()}`);
			return response.json();
		};
		t.after(async () => {
			ws.terminate();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		});
		return { request, barrier, count: () => invalidations };
	}
	const a = await endpoint(home),
		b = await endpoint(target);
	const mission = home.store.create({ projectId: home.project.id, title: "Wire", tasks: [{ title: "Task" }] });
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "wire",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: home.host, projectId: home.project.id },
		missionHome: home.host,
		executionProject: { host: target.host, projectId: target.project.id },
		missionIds: [mission.id],
		shareMemory: true,
		state: "active",
	};
	await a.request("/shared-contexts", binding);
	await b.request("/shared-contexts", binding);
	await a.barrier();
	await b.barrier();
	const count = a.count();
	const batch = (await a.request("/shared-contexts/wire/exchange", { peer: target.host })) as SharedExchangeBatch;
	await a.barrier();
	assert.equal(a.count(), count, "export/transmission fence must not cancel its own courier via an invalidation");
	const again = (await a.request("/shared-contexts/wire/exchange", { peer: target.host })) as SharedExchangeBatch;
	assert.deepEqual(again.operations, batch.operations, "lost export response preserves original immutable envelopes");
	let lost = true;
	async function deliver(source: typeof a, destination: typeof b, peer: OperationHost) {
		const page = (await source.request("/shared-contexts/wire/exchange", { peer })) as SharedExchangeBatch;
		for (const operation of page.operations) {
			const before = destination.count();
			let receipt = (await destination.request("/operations/receipt", operation)) as
				| OperationReceipt
				| { state: "unknown" };
			if (receipt.state === "unknown")
				receipt = (await destination.request("/operations", operation)) as OperationReceipt;
			assert.equal(receipt.state, "accepted");
			if (lost) {
				lost = false;
				await destination.barrier();
				assert.ok(
					destination.count() >= before + 2,
					"mutation and durable final receipt both invalidate, even when reply ownership is lost",
				);
				continue;
			}
			await source.request("/shared-contexts/wire/ack", { operation, receipt });
		}
		return page.operations.length;
	}
	for (let pass = 0; pass < 16; pass++) {
		if ((await deliver(a, b, target.host)) + (await deliver(b, a, home.host)) === 0) break;
		assert.ok(pass < 15, "bounded real transport exchange converges");
	}
	await a.barrier();
	await b.barrier();
	const quiet = [a.count(), b.count()];
	assert.equal((await deliver(a, b, target.host)) + (await deliver(b, a, home.host)), 0);
	await a.barrier();
	await b.barrier();
	assert.deepEqual([a.count(), b.count()], quiet, "caught-up exchange must generate no further sharing events");
});

test("binding-qualified cancellation cannot poison another binding's colliding delegation identity", async (t) => {
	const { home, target, mission, binding, grant } = await enrolled(t);
	const other = { ...binding, bindingId: "other-binding" };
	await home.sharing.enroll(other);
	await target.sharing.enroll(other);
	await reconcile(home, target, other);
	const payload = canonicalJSON({ delegationId: grant.delegationId, executionEpoch: grant.executionEpoch });
	const cancel = {
		schemaVersion: 1 as const,
		operationId: "cancel-in-other-binding",
		producerId: "other-binding-cancel",
		sequence: 1,
		origin: home.host,
		destination: target.host,
		kind: "share-cancel",
		targetId: other.bindingId,
		bindingId: other.bindingId,
		bindingGeneration: other.generation,
		payload,
		payloadHash: payloadHash(payload),
	};
	assert.equal(
		(await target.journal.execute(cancel, (operation) => target.sharing.handle(operation))).state,
		"accepted",
	);
	await reconcile(home, target, binding);
	assert.equal(target.sharing.membership(grant.session.sessionId)?.state, "accepted");
	assert.equal(target.sharing.membership(grant.session.sessionId)?.grant.bindingId, binding.bindingId);
	assert.ok(home.store.sharedAllocation(home.store.resolveTask(mission.id, "1").id));
});

test("canonical CAS keeps conflicting brief/decision proposals visible and commits new task proposals only at home", async (t) => {
	const { home, target, mission, binding, grant } = await enrolled(t);
	await reconcile(home, target, binding);
	const brief = (await target.missions.call(grant.session.sessionId, "brief", {
		markdown: "Remote wording",
		expectedRevision: 0,
	})) as { proposalId: string };
	home.store.writeBrief(mission.id, "Concurrent home wording", 0);
	await reconcile(home, target, binding);
	assert.equal(home.store.brief(mission.id)?.markdown, "Concurrent home wording");
	assert.ok(home.sharing.conflicts(binding.bindingId).some((proposal) => proposal.proposalId === brief.proposalId));
	const decision = (await target.missions.call(grant.session.sessionId, "decide", {
		text: "Proposed, not binding",
		audience: "all",
	})) as { proposalId: string };
	assert.equal(home.store.detail(mission.id).decisions.length, 0);
	await reconcile(home, target, binding);
	assert.equal(home.store.detail(mission.id).decisions.length, 0);
	await home.sharing.resolveProposal(binding.bindingId, decision.proposalId, {
		expectedRevision: 0,
		action: "decide",
		args: { text: "User approved wording", audience: "all" },
	});
	await reconcile(home, target, binding);
	assert.equal(home.store.detail(mission.id).decisions[0]?.text, "User approved wording");
	const proposed = (await target.missions.call(grant.session.sessionId, "task", {
		title: "Follow-up proposal",
		body: "Not separately executable here",
	})) as { proposalId: string };
	assert.equal(home.store.tasks(mission.id).length, 1);
	await reconcile(home, target, binding);
	assert.equal(home.store.tasks(mission.id).length, 2);
	const outcome = target.store.sharingGet<{ state: string; canonicalId: string }>(
		`proposal:${binding.bindingId}`,
		proposed.proposalId,
	);
	assert.equal(outcome?.state, "committed");
	assert.ok(outcome?.canonicalId);
	await assert.rejects(
		target.missions.call(grant.session.sessionId, "claim", { id: outcome!.canonicalId }),
		/home authority/,
	);
});

test("revocation requested during model selection fences final acceptance before any worker can start", async (t) => {
	const { home, target, binding } = await enrolled(t);
	const offer = (await home.sharing.exchange(binding.bindingId, target.host)).operations.find(
		(operation) => operation.kind === "share-offer",
	)!;
	let entered!: () => void, release!: () => void;
	const selecting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.mock.method(target.sessions, "selectTaskModel", async () => {
		entered();
		await gate;
		return { model: "test/model", thinking: "medium" };
	});
	const delivery = target.journal.execute(offer, (operation) => target.sharing.handle(operation));
	try {
		await selecting;
		const revoke = target.sharing.enroll({ ...binding, state: "revoked" });
		release();
		await delivery;
		await revoke;
	} finally {
		release();
	}
	await target.journal.recover((operation) => target.sharing.handle(operation));
	assert.equal((await target.journal.lookup(offer))?.state, "rejected");
	assert.equal(target.sessions.list().length, 0);
	assert.equal(target.workers.size, 0);
});

test("memory authority may be the execution host and remains separate from its execution workspace project", async (t) => {
	const home = await peer(t, "mission-home"),
		target = await peer(t, "memory-home");
	const contextDir = join(target.home, "canonical-context");
	await mkdir(contextDir);
	const contextProject = await target.projects.create({ path: contextDir, workspace: "direct" });
	await target.memory.load(contextProject.id);
	await target.memory.note(contextProject.id, "Execution-host canonical context", "canonical-origin");
	await target.memory.note(target.project.id, "Unrelated workspace memory", "workspace-origin");
	const mission = home.store.create({
		projectId: home.project.id,
		title: "Different homes",
		tasks: [{ title: "Bounded" }],
	});
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "memory-at-target",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: target.host, projectId: contextProject.id },
		missionHome: home.host,
		executionProject: { host: target.host, projectId: target.project.id },
		missionIds: [mission.id],
		shareMemory: true,
		state: "active",
	};
	await home.sharing.enroll(binding);
	await target.sharing.enroll(binding);
	await reconcile(home, target, binding);
	const task = home.store.resolveTask(mission.id, "1");
	const grant = await home.sharing.reserve(mission.id, task.id, {
		bindingId: binding.bindingId,
		expectedRevision: home.store.sharedDefinitionRevision(task.id),
		expectedPreviousEpoch: 0,
		model: "test/model",
	});
	await reconcile(home, target, binding);
	assert.match(
		JSON.stringify(await target.sharing.memoryCall(grant.session.sessionId, "recall", { regex: "Execution-host" })),
		/Execution-host canonical context/,
	);
	assert.doesNotMatch(
		JSON.stringify(await target.sharing.memoryCall(grant.session.sessionId, "wake", {})),
		/Unrelated workspace memory/,
	);
	const outcome = (await target.sharing.memoryCall(grant.session.sessionId, "note", {
		text: "Committed at its own authority",
	})) as { state: string };
	assert.equal(outcome.state, "committed");
	assert.equal((await target.memory.recall(contextProject.id, "Committed")).matches, 1);
	assert.equal((await target.memory.recall(target.project.id, "Committed")).matches, 0);
	const provenance = (await target.memory.recall(contextProject.id, "Execution-host")).entries[0]!.sharedOrigin;
	assert.deepEqual(provenance, { host: target.host, sessionId: "canonical-origin" });
});

test("checkpoint export persists its immutable manifest/cursor and resumes in bounded batches", async (t) => {
	const home = await peer(t, "paged-home"),
		target = await peer(t, "paged-target");
	const mission = home.store.create({ projectId: home.project.id, title: "Paged", tasks: [{ title: "Task" }] });
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "paged",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: home.host, projectId: home.project.id },
		missionHome: home.host,
		executionProject: { host: target.host, projectId: target.project.id },
		missionIds: [mission.id],
		shareMemory: true,
		state: "active",
	};
	await home.sharing.enroll(binding);
	await target.sharing.enroll(binding);
	const cursors: number[] = [];
	const manifest = { checkpointId: "immutable", sequence: 19, count: 19, digest: "f".repeat(64) };
	const begin = t.mock.method(home.memory, "beginCheckpoint", async () => manifest);
	t.mock.method(home.memory, "checkpointPage", async (_project: string, _checkpoint: string, cursor: number) => {
		cursors.push(cursor);
		return { checkpointId: manifest.checkpointId, cursor, entries: [], ...(cursor < 18 ? { next: cursor + 1 } : {}) };
	});
	const first = await home.sharing.exchange(binding.bindingId, target.host);
	assert.deepEqual(cursors, [0, 1, 2, 3, 4, 5, 6, 7]);
	for (const operation of first.operations)
		await home.sharing.acknowledge(binding.bindingId, {
			operation,
			receipt: {
				operationId: operation.operationId,
				payloadHash: operation.payloadHash,
				destination: operation.destination,
				targetId: operation.targetId,
				state: "accepted",
				result: operation.kind === "share-mission-checkpoint" ? { applied: true } : { staged: true },
			},
		});
	await home.sharing.stop();
	const resumed = new SharedContextService(
		home.host,
		home.store,
		home.memory,
		home.projects,
		home.sessions,
		home.missions,
	);
	t.after(() => resumed.stop());
	await resumed.exchange(binding.bindingId, target.host);
	assert.deepEqual(cursors.slice(8), [8, 9, 10, 11, 12, 13, 14, 15]);
	assert.equal(begin.mock.callCount(), 1, "restart must not create a new checkpoint/page zero");
});

test("offline pending notes notify every accepted binding-local chat with durable overlay revisions", async (t) => {
	const { home, target, mission, binding, grant } = await enrolled(t);
	await reconcile(home, target, binding);
	const second = home.store.addTask(mission.id, { title: "Independent accepted task" });
	await reconcile(home, target, binding);
	const other = await home.sharing.reserve(mission.id, second.id, {
		bindingId: binding.bindingId,
		expectedRevision: home.store.sharedDefinitionRevision(second.id),
		expectedPreviousEpoch: 0,
		model: "test/model",
	});
	await reconcile(home, target, binding);
	await until(
		() => target.workers.has(other.session.sessionId) && !target.sessions["starting"].has(other.session.sessionId),
	);
	const worker = target.workers.get(other.session.sessionId)!;
	const previous = new Set(worker.requests.map((command) => ("requestId" in command ? command.requestId : "")));
	await target.sharing.memoryCall(grant.session.sessionId, "note", { text: "Binding-local pending contribution" });
	await Promise.all(target.sharing["contextJobs"].values());
	assert.ok(
		worker.requests.some(
			(command) =>
				command.type === "input" &&
				command.requestId.startsWith("shared-context:") &&
				!previous.has(command.requestId),
		),
		"other chat receives new overlay revision notice without Mac reconciliation",
	);
	const read = (await target.sharing.memoryCall(other.session.sessionId, "wake", {})) as SharedMemoryRead;
	assert.ok((read.state.overlayRevision ?? 0) > 0);
	assert.equal(read.proposals[0]?.mutation.text, "Binding-local pending contribution");
});

test("unknown enrollment/proposal/grant configuration fields never enter shared domain records", async (t) => {
	const { home, target, mission, binding, grant } = await enrolled(t);
	await assert.rejects(
		target.sharing.enroll({ ...binding, unexpectedConfig: { token: "private" } } as SharedContextBinding),
		/schema/,
	);
	await assert.rejects(
		target.sharing.enroll({
			...binding,
			memoryHome: { ...binding.memoryHome, host: { ...binding.memoryHome.host, auth: "private" } },
		} as SharedContextBinding),
		/schema/,
	);
	await reconcile(home, target, binding);
	await assert.rejects(
		target.missions.call(grant.session.sessionId, "task", { id: "1", body: "valid", auth: { token: "private" } }),
		/schema/,
	);
	assert.equal(target.store.sharingList(`proposal:${binding.bindingId}`).length, 0);
	assert.equal(home.store.require(mission.id).title, "M");
	assert.equal(JSON.stringify(await target.sharing.summaries()).includes("unexpectedConfig"), false);
});

test("task completion needs both an explicit status proposal and settled eligible target evidence", async (t) => {
	const { home, target, mission, binding, grant, task } = await enrolled(t);
	await home.projects.update(home.project.id, { requirePullRequest: false });
	await reconcile(home, target, binding);
	await target.missions.call(grant.session.sessionId, "task", { id: task.id, status: "done" });
	await reconcile(home, target, binding);
	assert.notEqual(
		home.store.resolveTask(mission.id, task.id).status,
		"done",
		"proposal alone is not settled execution evidence",
	);
	const worker = target.workers.get(grant.session.sessionId)!;
	worker.packet({ type: "working", working: false, completion: { outcome: "done", outcomeAt: 44 } });
	await reconcile(home, target, binding);
	assert.equal(home.store.resolveTask(mission.id, task.id).status, "done");
	assert.ok(home.store.sharedAllocation(task.id), "completion still does not release execution ownership");
});

test("accepted session recovery keeps the same allocation/input identity and reads durable context without home", async (t) => {
	const { home, target, binding, grant } = await enrolled(t);
	await reconcile(home, target, binding);
	await target.sharing.memoryCall(grant.session.sessionId, "note", {
		text: "Pending survives target service restart",
	});
	await Promise.all(target.sharing["contextJobs"].values());
	await target.sharing.stop();
	await target.missions.notices.stop();
	await target.sessions.shutdown();
	const workers = new Map<string, Worker>();
	const sessions = new SessionManager(
		target.home,
		target.projects,
		undefined,
		{
			title: async () => undefined,
			worker: (spec, onPacket) => {
				const worker = new Worker(spec, onPacket);
				workers.set(spec.sessionId, worker);
				queueMicrotask(() => onPacket({ type: "ready", model: "test/model", working: false, usage: {} }));
				return worker;
			},
		},
		{
			runner: async () => {
				throw new Error("offline integration fixture");
			},
		},
		{ idleParkMs: Infinity },
	);
	t.mock.method(sessions as unknown as { refreshMainViews(): Promise<void> }, "refreshMainViews", async () => {});
	const missions = new MissionService(target.store, sessions, target.projects),
		sharing = new SharedContextService(target.host, target.store, target.memory, target.projects, sessions, missions);
	sessions.setProjectMemory(target.memory);
	sessions.setSharedContext(sharing);
	missions.setSharedContext(sharing);
	target.cleanupExtras.push(async () => {
		await sharing.stop();
		await missions.notices.stop();
		await sessions.shutdown();
	});
	t.mock.method(home.memory, "wake", async () => {
		throw new Error("home is unreachable");
	});
	await sessions.load();
	await sharing.recover();
	assert.equal(sessions.list().length, 1);
	assert.equal(sessions.list()[0]?.id, grant.session.sessionId);
	assert.equal(
		sharing.membership(grant.session.sessionId)?.operationId,
		target.sharing.membership(grant.session.sessionId)?.operationId,
	);
	assert.match(
		JSON.stringify(await sharing.memoryCall(grant.session.sessionId, "wake", {})),
		/Pending survives target service restart/,
	);
	await sharing.assertRunnable(grant.session.sessionId);
	assert.ok(sharing.membership(grant.session.sessionId));
	assert.equal((await sharing.summaries())[0]?.binding.bindingId, binding.bindingId);
});

test("required pinned artifacts gate offer acceptance and pending recovery keeps the original session identity", async (t) => {
	const { home, target, mission, binding } = await enrolled(t);
	await reconcile(home, target, binding);
	const task = home.store.addTask(mission.id, { title: "Requires offline reference" });
	const author = await home.sessions.spawn({ projectId: home.project.id, title: "Author", message: "fixture" });
	home.missions.join(author.id, { missionId: mission.id });
	const artifact = {
		id: "required-artifact",
		sessionId: author.id,
		projectId: home.project.id,
		title: "Required source",
		kind: "html" as const,
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		source: "Offline reference contents",
		html: "prepared preview",
		libraries: [],
	};
	t.mock.method(home.sessions, "artifact", async () => artifact);
	home.store.linkArtifact(mission.id, {
		artifactId: artifact.id,
		sessionId: author.id,
		title: artifact.title,
		kind: artifact.kind,
		revision: 1,
		taskId: task.id,
	});
	await reconcile(home, target, binding);
	await assert.rejects(
		home.sharing.reserve(mission.id, task.id, {
			bindingId: binding.bindingId,
			expectedRevision: home.store.sharedDefinitionRevision(task.id),
			expectedPreviousEpoch: 0,
			model: "test/model",
		}),
		/Classify every linked/,
	);
	const grant = await home.sharing.reserve(mission.id, task.id, {
		bindingId: binding.bindingId,
		expectedRevision: home.store.sharedDefinitionRevision(task.id),
		expectedPreviousEpoch: 0,
		model: "test/model",
		references: [
			{ host: home.host, sessionId: author.id, artifactId: artifact.id, revision: 1, requirement: "required" },
		],
	});
	const batch = await home.sharing.exchange(binding.bindingId, target.host),
		offer = batch.operations.find((operation) => operation.kind === "share-offer")!,
		reference = batch.operations.find((operation) => operation.kind === "share-reference")!;
	assert.equal(
		(await target.journal.execute(offer, (operation) => target.sharing.handle(operation))).state,
		"pending",
	);
	assert.equal(target.sessions.get(grant.session.sessionId), undefined);
	const staged = await target.journal.execute(reference, (operation) => target.sharing.handle(operation));
	assert.equal(staged.state, "accepted");
	await home.sharing.acknowledge(binding.bindingId, { operation: reference, receipt: staged });
	await target.journal.recover((operation) => target.sharing.handle(operation));
	const receipt = (await target.journal.lookup(offer))!;
	assert.equal(receipt.state, "accepted");
	await home.sharing.acknowledge(binding.bindingId, { operation: offer, receipt });
	const offline = await target.sharing.readArtifact(grant.session.sessionId, artifact.id, 1);
	assert.equal(offline.source, artifact.source);
	assert.equal("html" in offline, false);
	assert.equal(target.sessions.get(grant.session.sessionId)?.id, grant.session.sessionId);
	await assert.rejects(target.sharing.readArtifact(grant.session.sessionId, artifact.id, 2), /not authorized/);
});

test("binding-authorized HTTP reads expose canonical/replica versions and pending context without host-local leakage", async (t) => {
	const { home, target, mission, binding, grant } = await enrolled(t);
	await home.memory.note(home.project.id, "Home memory zero", "author");
	await home.memory.note(home.project.id, "Home memory one", "author");
	await target.memory.note(target.project.id, "Unrelated execution workspace notes", "local");
	await reconcile(home, target, binding);
	const homeBase = `${await readEndpoint(home)}/${binding.bindingId}`,
		targetBase = `${await readEndpoint(target)}/${binding.bindingId}`;
	const get = async (base: string, path: string) => {
		const response = await fetch(`${base}/${path}`);
		assert.equal(response.status, 200, await response.clone().text());
		return response.json();
	};
	const before = await get(targetBase, `missions/${mission.id}/versions?limit=1`);
	assert.equal(before.source, "replica");
	assert.equal(before.entities.length, 1);
	assert.equal(before.next, 1);
	const task = home.store.resolveTask(mission.id, "1");
	const replica = await get(targetBase, `missions/${mission.id}`);
	assert.equal(
		replica.snapshot.entities.find((e: SharedEntity) => e.id === task.id).definitionRevision,
		home.store.sharedDefinitionRevision(task.id),
	);
	const canonical = await get(homeBase, `missions/${mission.id}/versions`);
	assert.equal(canonical.source, "canonical");
	assert.deepEqual(canonical.entities, (await get(targetBase, `missions/${mission.id}/versions`)).entities);
	const pending = (await target.missions.call(grant.session.sessionId, "brief", {
		markdown: "Offline draft",
		expectedRevision: 0,
	})) as { proposalId: string };
	await target.sharing.memoryCall(grant.session.sessionId, "note", { text: "Pending shared note" });
	const view = await get(targetBase, `missions/${mission.id}`);
	assert.ok(
		view.proposals.some((p: SharedMissionProposal) => p.proposalId === pending.proposalId && p.state === "pending"),
	);
	assert.notEqual(view.snapshot.detail.brief?.markdown, "Offline draft");
	const memory = await get(targetBase, "memory/wake?lines=1");
	assert.equal(memory.value.nodes.length, 1);
	assert.ok(memory.proposals.some((p: { mutation: { text: string } }) => p.mutation.text === "Pending shared note"));
	assert.doesNotMatch(JSON.stringify(memory), /Unrelated execution workspace/);
	const tree = await get(targetBase, "memory/tree?depth=2");
	assert.equal(tree.value.count, 2);
	assert.equal(tree.state.sequence, 2);
	assert.equal(tree.value.nodes[0].children.length, 2);
	assert.match(JSON.stringify(tree), /Home memory zero/);
	assert.doesNotMatch(JSON.stringify(tree), /Unrelated execution workspace/);
	assert.equal((await get(homeBase, "memory/wake?lines=1")).value.nodes.length, 1);
	assert.equal((await get(homeBase, "memory/tree?depth=2")).value.count, 2);
	assert.equal((await get(targetBase, "memory/tree?depth=1&reveal=0")).value.nodes[0].children[0].lo, 0);
	assert.equal((await get(targetBase, "memory/zoom?lo=0&hi=1")).value.length, 2);
	assert.equal((await get(targetBase, "memory/recall?regex=Home&lines=1")).value.entries.length, 1);
	await target.sharing.memoryCall(grant.session.sessionId, "recall", { regex: "Home memory zero" });
	await target.sharing.memoryCall(grant.session.sessionId, "note", {
		text: "Offline correction proposal",
		replaces: [0],
	});
	await home.memory.note(home.project.id, "Concurrent canonical correction", "author", [0]);
	home.store.writeBrief(mission.id, "Concurrent canonical brief", 0);
	await reconcile(home, target, binding);
	for (const base of [homeBase, targetBase]) {
		const read = await get(base, "memory/wake");
		assert.ok(
			read.proposals.some(
				(p: { state: string; mutation: { text: string } }) =>
					p.state === "conflict" && p.mutation.text === "Offline correction proposal",
			),
		);
		assert.ok(read.state.conflictCount > 0);
	}
	assert.equal(
		(await fetch(`${targetBase}/missions/${mission.id}/versions?after=1&sequence=${before.sequence}`)).status,
		409,
	);
	const conflicts = await get(homeBase, "conflicts");
	assert.ok(
		conflicts.some((p: SharedMissionProposal) => p.proposalId === pending.proposalId && p.state === "conflict"),
	);
	assert.ok(
		(await get(targetBase, `missions/${mission.id}`)).proposals.some(
			(p: SharedMissionProposal) => p.proposalId === pending.proposalId && p.state === "conflict",
		),
	);
	for (const path of [
		"memory/wake?projectId=other",
		"memory/recall?regex=Home&sessionId=foreign",
		"memory/tree?path=/tmp",
		"memory/wake?lines=1&lines=2",
		"memory/tree?reveal=oops",
		"memory/wake?lines=-1",
	]) {
		assert.equal((await fetch(`${targetBase}/${path}`)).status, 400, path);
	}
	assert.equal((await fetch(`${targetBase}/missions/foreign`)).status, 404);
	assert.equal((await fetch(`${targetBase}/missions/${mission.id}/versions?after=1`)).status, 409);
	assert.equal(
		(
			await fetch(`${targetBase}/memory/wake`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId: target.project.id }),
			})
		).status,
		404,
	);
	await target.sharing.enroll({ ...binding, state: "revoked" });
	for (const path of ["memory/wake", "memory/tree", `missions/${mission.id}`, `missions/${mission.id}/versions`])
		assert.equal((await fetch(`${targetBase}/${path}`)).status, 409);
	await reconcile(home, target, binding);
	assert.equal((await home.sharing.exchange(binding.bindingId, target.host)).operations.length, 0);
	assert.equal((await target.sharing.exchange(binding.bindingId, home.host)).operations.length, 0);
});

test("shared read routes fail closed for incomplete, disabled and unknown enrollment", async (t) => {
	const { home, target, mission, binding } = await enrolled(t);
	const incomplete = { ...binding, bindingId: "staging" };
	await target.sharing.enroll(incomplete);
	const base = await readEndpoint(target),
		scope = `${base}/${incomplete.bindingId}`;
	for (const path of ["memory/wake", "memory/tree", `missions/${mission.id}`, `missions/${mission.id}/versions`])
		assert.equal((await fetch(`${scope}/${path}`)).status, 409, path);
	assert.equal((await fetch(`${base}/unknown/memory/wake`)).status, 409);
	const disabled = { ...binding, bindingId: "no-memory", shareMemory: false };
	await target.sharing.enroll(disabled);
	for (const path of ["memory/wake", "memory/tree"])
		assert.equal((await fetch(`${base}/${disabled.bindingId}/${path}`)).status, 409);
	await home.memory.note(home.project.id, `api_key: ${"A".repeat(24)}`, "test");
	const source = await readEndpoint(home),
		response = await fetch(`${source}/${binding.bindingId}/memory/wake`);
	assert.equal(response.status, 409);
	assert.doesNotMatch(await response.text(), /A{24}/);
});

test("a delayed placement POST cannot create a new execution after a later grant accepted and sealed", async (t) => {
	const { home, target, mission, binding } = await enrolled(t);
	const task = home.store.addTask(mission.id, { title: "Epoch-fenced placement" });
	await reconcile(home, target, binding);
	const base = (await readEndpoint(home)).replace(/\/api\/shared-contexts$/, ""),
		url = `${base}/api/missions/${mission.id}/tasks/${task.id}/delegations`;
	const inventory = (await (
		await fetch(`${base}/api/shared-contexts`)
	).json()) as import("@pilot/protocol").SharedContextSummary[];
	assert.equal(
		inventory.flatMap((summary) => summary.grants).filter((grant) => grant.task.taskId === task.id).length,
		0,
	);
	const delayed = {
		bindingId: binding.bindingId,
		expectedRevision: home.store.sharedDefinitionRevision(task.id),
		expectedPreviousEpoch: 0,
		model: "test/model",
	};
	const post = (body: unknown) =>
		fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const accepted = await post({ ...delayed });
	assert.equal(accepted.status, 201, await accepted.clone().text());
	const grant = (await accepted.json()) as DelegationGrant;
	assert.equal(grant.executionEpoch, 1);
	await reconcile(home, target, binding);
	await until(
		() => target.workers.has(grant.session.sessionId) && !target.sessions["starting"].has(grant.session.sessionId),
	);
	target.workers
		.get(grant.session.sessionId)!
		.packet({ type: "working", working: false, completion: { outcome: "done", outcomeAt: 1 } });
	await reconcile(home, target, binding);
	assert.equal((await target.sharing.seal(grant.delegationId, binding.bindingId)).sealed, true);
	await reconcile(home, target, binding);
	assert.equal(home.store.sharedTaskGrant(task.id)?.state, "sealed");
	assert.equal(
		home.store.sharedDefinitionRevision(task.id),
		delayed.expectedRevision,
		"internal execution projections do not fence a delayed placement through definition CAS",
	);
	const sessions = target.sessions
			.list()
			.map((session) => session.id)
			.sort(),
		count = home.store.sharingOutboxCount(binding.bindingId);
	assert.equal(
		(await post(delayed)).status,
		409,
		"old epoch-zero request must fail even though the task definition still matches",
	);
	const { expectedPreviousEpoch: _ignored, ...legacy } = delayed;
	for (const body of [
		legacy,
		{ ...delayed, expectedPreviousEpoch: -1 },
		{ ...delayed, expectedPreviousEpoch: "1" },
		{ ...delayed, expectedPreviousEpoch: 1.5 },
		{ ...delayed, expectedPreviousEpoch: Number.MAX_SAFE_INTEGER },
	])
		assert.equal((await post(body)).status, 409, "missing/invalid epochs cannot default to the current grant");
	const next = {
		...grant,
		executionEpoch: 2,
		delegationId: "atomic-retry",
		session: { ...grant.session, sessionId: "atomic-retry-session" },
		state: "reserved" as const,
		context: { ...grant.context, mission: home.store.sharedHead() },
	};
	assert.throws(
		() => home.store.reserveSharedGrant(next, 0),
		/epoch CAS/,
		"the domain transaction independently rejects stale intent",
	);
	assert.throws(
		() => home.store.reserveSharedGrant(next, undefined as unknown as number),
		/epoch CAS/,
		"programmatic calls cannot omit the fence",
	);
	assert.equal(home.store.sharedTaskGrant(task.id)?.delegationId, grant.delegationId);
	assert.equal(home.store.sharingOutboxCount(binding.bindingId), count);
	assert.ok(
		!(await home.sharing.exchange(binding.bindingId, target.host)).operations.some(
			(operation) => operation.kind === "share-offer",
		),
	);
	assert.deepEqual(
		target.sessions
			.list()
			.map((session) => session.id)
			.sort(),
		sessions,
		"a stale POST must not create another target session",
	);
	const refreshed = await post({ ...delayed, expectedPreviousEpoch: grant.executionEpoch });
	assert.equal(refreshed.status, 201, await refreshed.clone().text());
	assert.equal(
		((await refreshed.json()) as DelegationGrant).executionEpoch,
		2,
		"an explicit fresh request can reserve the next epoch",
	);
});
