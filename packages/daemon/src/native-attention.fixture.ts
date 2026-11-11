/** Real isolated daemon/SQLite/native capability. Model and input execution are forbidden by default. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentQuestion,
	HumanActionCommand,
	HumanActionContent,
	NativeAttentionRead,
	NativeAttentionRequest,
	SessionSummary,
} from "@pilot/protocol";
import { attentionDigest } from "./attention-store.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { MissionControls } from "./mission-controls.ts";
import { MissionReports } from "./mission-reports.ts";
import type { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { NativeAttention } from "./native-attention.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

export async function nativeAttentionFixture() {
	const home = await mkdtemp(join(tmpdir(), "native-attention-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, workspace: "direct" });
	const hello = await daemonHello(home, { independentExecution: true } as never);
	const host = { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId! };
	let store = new MissionStore(join(home, "missions.sqlite"));
	let journal = new OperationJournal(join(home, "operations"), host);
	const mission = store.create({ projectId: project.id, title: "Isolated attention" }),
		owner = randomUUID();
	store.join(owner, mission.id);
	store.update(mission.id, { coordinatorSessionId: owner });
	let session: SessionSummary = {
		id: owner,
		title: "Synthetic origin",
		projectId: project.id,
		cwd: home,
		mode: "build",
		missionId: mission.id,
		state: "idle",
		outcome: "question",
		createdAt: 1,
		updatedAt: 1,
		inputGeneration: 0,
	};
	let question: { id: number; kind: string; data: AgentQuestion } = {
		id: 12,
		kind: "pilot.question",
		data: {
			question: "Which exact package?",
			context: "Use the reviewed bytes.",
			options: [{ label: "Reviewed package", suggested: true }],
		},
	};
	const sessions = new SessionManager(home, projects);
	sessions.get = (id) => (id === owner ? session : undefined);
	sessions.list = () => [session];
	sessions.pendingQuestion = async () => question as never;
	sessions.spawn = async () => {
		throw new Error("Workers forbidden");
	};
	let sends = 0,
		accepted = false;
	sessions.sendDurable = async () => {
		sends++;
		throw new Error("Input executor unqualified");
	};
	sessions.lookupNativeAttentionInput = async () => accepted;
	const terminals = new TerminalManager();
	const file = join(home, "reviewed.zip");
	await writeFile(file, "exact package");
	const content: HumanActionContent = {
		projectId: project.id,
		sessionId: owner,
		missionId: mission.id,
		action: "Upload reviewed.zip",
		reason: "Browser upload requires the user",
		files: [
			{ kind: "file", uri: pathToFileURL(file).href, version: "1.0", sha256: attentionDigest("exact package") },
		],
		destination: { uri: "https://example.com/developer/upload", targetId: "package", version: "1.0" },
		completionRequirements: ["Report submission, not publication."],
	};
	// File hashes are SHA-256 over bytes, not the canonicalJSON digest used for structured scopes.
	content.files[0]!.sha256 = (await import("node:crypto")).createHash("sha256").update("exact package").digest("hex");
	let server: ReturnType<typeof createDaemonServer>,
		native: GitHubSetupService,
		capability = "",
		root = "";
	const adapter = () => new NativeAttention({ home: host, store, projects, sessions, journal });
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
				service: {
					reports: new MissionReports(store),
					controls: new MissionControls(store, {
						checkpointMission: async () => {
							throw new Error("No execution");
						},
						resumeMission: async () => {
							throw new Error("No execution");
						},
					}),
				} as MissionService,
			},
		];
		args[12] = hello;
		args[17] = native;
		server = createDaemonServer(...args);
		await server.runtimeReady;
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	};
	const stop = async () => {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		await server.closePlanning();
		await native.close();
		await store.durable();
	};
	await start();
	const envelope = () => ({ version: 1 as const, home: { ...host, hostId: "local" }, projectId: project.id });
	const post = (request: unknown, lookup = false, token = capability) =>
		fetch(`${root}/api/native-attention${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": token },
			body: JSON.stringify(request),
		});
	const read = async () => {
		const r = await (await post({ ...envelope(), kind: "read" })).json();
		if (!r.ok) throw new Error(JSON.stringify(r));
		return r.value as NativeAttentionRead;
	};
	const create = async () => {
		const command: HumanActionCommand = { kind: "create", id: "upload", operationId: randomUUID(), content };
		// Fixture-only native creation through the same authenticated boundary, not a worker tool.
		// Mint authority by reading the current ordinary question from the same origin.
		const current = await read();
		const r = await (
			await post({
				...envelope(),
				kind: "action",
				command,
				authorityDigest: current.questions[0]!.scope.authorityDigest,
			})
		).json();
		if (!r.ok) throw new Error(JSON.stringify(r));
		return r.value;
	};
	return {
		home,
		project,
		mission,
		owner,
		hello,
		host,
		sessions,
		content,
		file,
		envelope,
		post,
		read,
		create,
		adapter,
		get root() {
			return root;
		},
		get capability() {
			return capability;
		},
		get store() {
			return store;
		},
		get journal() {
			return journal;
		},
		get sends() {
			return sends;
		},
		get session() {
			return session;
		},
		set session(v: SessionSummary) {
			session = v;
		},
		get question() {
			return question;
		},
		set question(v: typeof question) {
			question = v;
		},
		set accepted(v: boolean) {
			accepted = v;
		},
		async command(command: HumanActionCommand, authorityDigest: string, lookup = false) {
			return (
				await post(
					{ ...envelope(), kind: "action", authorityDigest, command } satisfies NativeAttentionRequest,
					lookup,
				)
			).json();
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
