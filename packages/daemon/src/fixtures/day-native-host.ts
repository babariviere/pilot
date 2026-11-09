/** Isolated real HTTP/WS daemon for the Rust Day host tests. No providers or workers. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DaemonHello, SessionSummary } from "@pilot/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { GitHubSetupService } from "../github-setup.ts";
import { daemonHello } from "../hello.ts";
import { MissionControls } from "../mission-controls.ts";
import { MissionReports } from "../mission-reports.ts";
import type { MissionService } from "../mission-service.ts";
import { MissionStore } from "../missions.ts";
import type { ModelCatalog } from "../models.ts";
import { ProjectStore } from "../projects.ts";
import { createDaemonServer } from "../server.ts";
import type { SessionManager } from "../sessions.ts";
import type { TerminalManager } from "../terminals.ts";

const home = await mkdtemp(join(tmpdir(), "day-native-host-"));
await mkdir(join(home, "project"));
await mkdir(join(home, "other"));
const projects = new ProjectStore(home);
await projects.load();
const project = await projects.create({ path: join(home, "project"), workspace: "direct" });
const other = await projects.create({ path: join(home, "other"), workspace: "direct" });
const store = new MissionStore(":memory:");
const mission = store.create({ projectId: project.id, title: "Native synthetic mission" });
const members = [randomUUID(), randomUUID(), randomUUID()];
for (const id of members) store.join(id, mission.id);
store.update(mission.id, { coordinatorSessionId: members[0] });
const task = store.addTask(mission.id, { title: "Exact task", sessionId: members[1] });
const reports = new MissionReports(store);
const source = reports.source(mission.id, members[1]!, task.id);
await reports.write(mission.id, members[1]!, {
	reportId: randomUUID(),
	version: 1,
	taskId: task.id,
	source: source.source,
	expectedPreviousId: source.expectedPreviousId,
	movement: "moving",
	summary: "Agent assessment only",
	nextStep: "Verify native host",
	evidence: ["not proof"],
});
const pauses: string[] = [],
	resumes: string[] = [];
let holdResume = false,
	resumeStop = false,
	pauseGate: (() => void) | undefined;
let entered: (() => void) | undefined;
const controls = new MissionControls(store, {
	checkpointMission: async (id) => {
		pauses.push(id);
		entered?.();
		if (pauseGate)
			await new Promise<void>((resolve) => {
				pauseGate = resolve;
			});
		return id === members[2] ? "held" : "paused";
	},
	resumeMission: async (id) => {
		resumes.push(id);
		if (resumeStop) store.controls.stop(mission.id);
		return holdResume || resumeStop ? "held" : "resumed";
	},
});
controls.setScheduleDrain(async () => {});
const chats = members.map(
	(id): SessionSummary => ({
		id,
		title: id,
		cwd: project.path,
		projectId: project.id,
		createdAt: 1,
		updatedAt: 1,
		state: "idle",
		missionId: mission.id,
	}),
);
const sessions = {
	piReload: { onChange: () => () => {}, status: () => ({ state: "idle" }) },
	setWorkspaceProcessGuard() {},
	list: () => chats,
	get: (id: string) => chats.find((c) => c.id === id),
	onChange: () => () => {},
	onArtifactsChanged: () => () => {},
} as unknown as SessionManager;
const hello = await daemonHello(home, { independentExecution: true } as DaemonHello["capabilities"]);
const native = new GitHubSetupService(
	home,
	{ hostId: "local", daemonId: hello.daemonId, lineageId: hello.lineageId! },
	{ userHome: home, env: {} },
);
await native.status();
const server = createDaemonServer(
	{ home, host: "127.0.0.1", port: 0 },
	sessions,
	projects,
	{} as ModelCatalog,
	{ isRunning: () => false } as unknown as TerminalManager,
	{ store, service: { reports, controls } as MissionService },
	undefined,
	undefined,
	undefined,
	undefined,
	undefined,
	undefined,
	hello,
	undefined,
	false,
	undefined,
	undefined,
	native,
);
await server.runtimeReady;
server.listen(0, "127.0.0.1");
await once(server, "listening");
const upstream = (server.address() as AddressInfo).port;

let posts = 0,
	lookups = 0,
	dayReads = 0,
	lost = false,
	missing = false,
	mismatch = false;
let noControls = false,
	noDay = false,
	dayRace = false,
	changeCoordinator = false,
	changeProject = false;
let gateAfterJournal = false,
	journalInvalidation = false;
const wss = new WebSocketServer({ noServer: true });
const upstreamSockets = new Set<WebSocket>();
const invalidate = () => {
	for (const ws of wss.clients) ws.send(JSON.stringify({ type: "mission-catalog.changed" }));
};
const proxy = createServer(async (req, res) => {
	try {
		const path = req.url!;
		if (path.endsWith("/controls") && req.method === "POST") {
			posts++;
			// Assert the real native journal's exact record already exists before forwarding.
			const ledger = await readFile(join(home, "commands.jsonl"), "utf8");
			assert.ok(ledger.endsWith("\n"));
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const bytes = Buffer.concat(chunks),
				body = JSON.parse(bytes.toString());
			assert.ok(
				ledger
					.split("\n")
					.filter(Boolean)
					.some((line) => {
						const record = JSON.parse(line);
						return record.mission === mission.id && JSON.stringify(record.command) === JSON.stringify(body);
					}),
				"exact command must be saved before POST",
			);
			const reply = await fetch(`http://127.0.0.1:${upstream}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
				},
				body: bytes,
			});
			const answer = await reply.text();
			if (lost) {
				lost = false;
				req.socket.destroy();
				return;
			}
			res.writeHead(reply.status, { "content-type": "application/json" }).end(answer);
			return;
		}
		if (path.includes("/controls/operations/")) {
			lookups++;
			if (missing) {
				res.end(JSON.stringify({ state: "unknown" }));
				return;
			}
		}
		const reply = await fetch(`http://127.0.0.1:${upstream}${path}`, {
			headers: { "x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? "") },
		});
		const body = await reply.json();
		if (path === "/api/hello") {
			if (noControls) delete body.capabilities.missionControls;
			if (noDay) delete body.capabilities.dayOverview;
			if (gateAfterJournal && !journalInvalidation) {
				const saved = await readFile(join(home, "commands.jsonl"), "utf8").catch(() => "");
				if (saved) {
					journalInvalidation = true;
					store.controls.stop(mission.id);
				}
			}
		}
		if (path.endsWith("/day")) {
			dayReads++;
			if (dayRace) {
				dayRace = false;
				invalidate();
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
		}
		if (path === `/api/missions/${mission.id}`) {
			if (changeCoordinator) body.mission.coordinatorSessionId = randomUUID();
			if (changeProject) body.mission.projectId = other.id;
		}
		if (mismatch && path.includes("/controls/operations/") && body.command) body.command.expectedRevision++;
		res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(body));
	} catch (error) {
		console.error(error);
		res.writeHead(500).end();
	}
});
proxy.on("upgrade", (req, socket, head) => {
	wss.handleUpgrade(req, socket, head, (ws) => {
		const remote = new WebSocket(`ws://127.0.0.1:${upstream}/api/ws`);
		upstreamSockets.add(remote);
		remote.on("message", (bytes) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(bytes.toString());
		});
		remote.on("close", () => {
			upstreamSockets.delete(remote);
			ws.close();
		});
		ws.on("close", () => remote.close());
		ws.on("error", () => remote.terminate());
		remote.on("error", () => ws.terminate());
	});
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
console.log(
	JSON.stringify({
		source: {
			profile: home,
			port: (proxy.address() as AddressInfo).port,
			home: { daemonId: hello.daemonId, lineageId: hello.lineageId },
			project_id: project.id,
			project_path: project.path,
		},
		mission: mission.id,
		members,
		other: other.id,
		ledger: join(home, "commands.jsonl"),
	}),
);

for await (const line of createInterface({ input: process.stdin })) {
	const cmd = JSON.parse(line);
	if (cmd.action === "lost") lost = true;
	if (cmd.action === "missing") missing = cmd.value;
	if (cmd.action === "mismatch") mismatch = cmd.value;
	if (cmd.action === "noControls") {
		noControls = cmd.value;
		invalidate();
	}
	if (cmd.action === "noDay") {
		noDay = cmd.value;
		invalidate();
	}
	if (cmd.action === "dayRace") dayRace = true;
	if (cmd.action === "coordinator") changeCoordinator = cmd.value;
	if (cmd.action === "project") changeProject = cmd.value;
	if (cmd.action === "gateAfterJournal") gateAfterJournal = true;
	if (cmd.action === "holdResume") holdResume = true;
	if (cmd.action === "resumeStop") resumeStop = true;
	if (cmd.action === "stop") {
		store.controls.stop(mission.id);
		invalidate();
	}
	if (cmd.action === "identity") await writeFile(join(home, "daemon-id"), `${randomUUID()}\n`);
	if (cmd.action === "capability") await writeFile(join(home, "github-app-capability"), "{}", { mode: 0o600 });
	if (cmd.action === "disconnect") {
		for (const ws of wss.clients) ws.close();
	}
	if (cmd.action === "invalidate") invalidate();
	if (cmd.action === "pauseGate") pauseGate = () => {};
	if (cmd.action === "waitPause" && pauses.length === 0)
		await new Promise<void>((resolve) => {
			entered = resolve;
		});
	if (cmd.action === "waitPaused" && store.controls.current(mission.id).state !== "paused")
		await new Promise<void>((resolve) => {
			const stop = store.onChange(() => {
				if (store.controls.current(mission.id).state === "paused") {
					stop();
					resolve();
				}
			});
		});
	if (cmd.action === "corruptJournal") await writeFile(join(home, "commands.jsonl"), "broken");
	if (cmd.action === "release") {
		const resolve = pauseGate;
		pauseGate = undefined;
		resolve?.();
	}
	if (cmd.action === "quit") break;
	console.log(
		JSON.stringify({
			posts,
			lookups,
			dayReads,
			pauses,
			resumes,
			control: store.controls.current(mission.id),
			journalInvalidation,
		}),
	);
}
for (const ws of wss.clients) ws.terminate();
for (const ws of upstreamSockets) ws.terminate();
wss.close();
proxy.closeAllConnections();
server.closeAllConnections();
await Promise.all([
	new Promise<void>((resolve) => proxy.close(() => resolve())),
	new Promise<void>((resolve) => server.close(() => resolve())),
]);
await native.close();
store.close();
await rm(home, { recursive: true, force: true });
