/** Isolated production HTTP ingress with real SQLite/journal, no provider or worker. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableOperation, InterviewQuestion, SessionSummary } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { MissionControls } from "./mission-controls.ts";
import { MissionInterviews } from "./mission-interviews.ts";
import { MissionPlans } from "./mission-plans.ts";
import { MissionReports } from "./mission-reports.ts";
import type { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { KnowledgeService } from "./project-knowledge.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { WorkflowConfirmations } from "./workflow-confirmations.ts";

export async function nativePlanningFixture(options: { native?: boolean } = {}) {
	const home = await mkdtemp(join(tmpdir(), "native-planning-"));
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
	let store = new MissionStore(join(home, "missions.sqlite"));
	let journal = new OperationJournal(join(home, "operations"), host);
	const owner = randomUUID();
	let coordinator: SessionSummary | undefined = {
		id: owner,
		title: "Synthetic planning owner",
		projectId: project.id,
		cwd: project.path,
		mode: "build",
		state: "idle",
		createdAt: 1,
		updatedAt: 1,
	};
	const question: InterviewQuestion = {
		id: "outcome",
		section: "outcome",
		prompt: "What should change?",
		options: [{ id: "fix", meaning: "Fix the importer" }],
		recommendedOptionId: "fix",
	};
	const confirmations = () => new WorkflowConfirmations({ store, journal, authorize: () => "fixture" });
	const interviews = () =>
		new MissionInterviews({ store, journal, confirmations: confirmations(), authorize: () => "fixture" });
	const plans = () => new MissionPlans({ store, journal, authorize: () => {} });
	const operation = (targetId: string, request: { purpose: string }, bindingId?: string): DurableOperation => {
		const payload = JSON.stringify(request);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...host, hostId: bindingId ? "local" : "fixture" },
			destination: host,
			targetId,
			kind: request.purpose,
			payload,
			payloadHash: payloadHash(payload),
			...(bindingId ? { bindingId, bindingGeneration: 1 } : {}),
		};
	};
	const create = operation(randomUUID(), {
		purpose: "interview-create",
		projectId: project.id,
		title: "Synthetic planning",
		ownerSessionId: owner,
		questions: [question],
	} as { purpose: string });
	await journal.execute(create, (op, entry) => interviews().admit(op, entry.firstEntry));
	const missionId = store.interviews.lookup(create)!.fence.missionId;
	const sessions = new SessionManager(home, projects);
	const extraOwners = new Map<string, SessionSummary>();
	sessions.get = (id) => (id === owner ? coordinator : extraOwners.get(id));
	sessions.spawn = async () => {
		throw new Error("Fixture forbids workers");
	};
	const terminals = new TerminalManager();
	let native: GitHubSetupService;
	let server: ReturnType<typeof createDaemonServer>;
	let capability = "",
		root = "";
	const start = async () => {
		native = new GitHubSetupService(home, { ...host, hostId: "local" }, { userHome: home, env: {} });
		await native.status();
		capability = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token;
		const args: Parameters<typeof createDaemonServer> = [
			{ home, host: "127.0.0.1", port: 0 },
			sessions,
			projects,
			new ModelCatalog(home),
			terminals,
			{
				store,
				knowledge: new KnowledgeService(store, projects, sessions),
				service: {
					reports: new MissionReports(store),
					controls: new MissionControls(store, {
						checkpointMission: async () => {
							throw new Error("Fixture forbids execution");
						},
						resumeMission: async () => {
							throw new Error("Fixture forbids execution");
						},
					}),
				} as MissionService,
			},
		];
		args[12] = hello;
		if (options.native !== false) args[17] = native;
		server = createDaemonServer(...args);
		await server.runtimeReady;
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	};
	await start();
	const stop = async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await server.closePlanning();
		await native.close();
		await store.durable();
	};
	return {
		home,
		project,
		projects,
		sessions,
		missionId,
		owner,
		hello,
		question,
		operation,
		get root() {
			return root;
		},
		get capability() {
			return capability;
		},
		get store() {
			return store;
		},
		set coordinator(value: SessionSummary | undefined) {
			coordinator = value;
		},
		get coordinator() {
			return coordinator;
		},
		async createPlanning(title: string, projectId = project.id) {
			const ownerSessionId = randomUUID();
			extraOwners.set(ownerSessionId, { ...coordinator!, id: ownerSessionId, projectId });
			const op = operation(randomUUID(), {
				purpose: "interview-create",
				projectId,
				title,
				ownerSessionId,
				questions: [question],
			} as { purpose: string });
			const result = await journal.execute(op, (op, entry) => interviews().admit(op, entry.firstEntry));
			assertAccepted(result);
			return store.interviews.lookup(op)!.fence.missionId;
		},
		inventory(token = capability, projectId = project.id) {
			return fetch(`${root}/api/projects/${projectId}/planning-inventory`, {
				headers: { "x-pilot-github-capability": token },
			});
		},
		async read(token = capability, projectId = project.id) {
			return fetch(`${root}/api/projects/${projectId}/missions/${missionId}/planning`, {
				headers: { "x-pilot-github-capability": token },
			});
		},
		async post(op: DurableOperation, receipt = false, token = capability) {
			return fetch(`${root}/api/operations${receipt ? "/receipt" : ""}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-pilot-github-capability": token },
				body: JSON.stringify(op),
			});
		},
		/** Fixture-only authorized coordinator publication, never exposed by production HTTP. */
		async questions(questions: InterviewQuestion[], kind?: "revisit") {
			const current = store.interviews.latest(missionId)!;
			const op = operation(missionId, {
				purpose: "interview-questions",
				expected: { fence: current.fence, revision: current.revision },
				questions,
				...(kind ? { kind } : {}),
			} as { purpose: string });
			assertAccepted(await journal.execute(op, (op, entry) => interviews().admit(op, entry.firstEntry)));
		},
		async plan(request: { purpose: string }, targetId = missionId) {
			const op = operation(targetId, request);
			const r = await journal.execute(op, (op, entry) => plans().admit(op, entry.firstEntry));
			if (r.state !== "accepted") throw new Error(JSON.stringify(r));
			return r;
		},
		async restart() {
			await stop();
			store.close();
			store = new MissionStore(join(home, "missions.sqlite"));
			journal = new OperationJournal(join(home, "operations"), host);
			await start();
		},
		async close() {
			await stop();
			await sessions.shutdown();
			await terminals.shutdown();
			store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

function assertAccepted(result: { state: string }): void {
	if (result.state !== "accepted") throw new Error(JSON.stringify(result));
}
