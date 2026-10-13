/** pilotd: background pi agents on durable sessions. */
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { EventLoopWatchdog } from "./event-loop-watchdog.ts";
import { ProjectMemoryService } from "./project-memory.ts";

const config = loadConfig();
// Log long event-loop stalls with their likely cause. They delay IPC, HTTP and lock refreshes alike.
const watchdog = new EventLoopWatchdog();
watchdog.start();
const projects = new ProjectStore(config.home);
await projects.load();
const models = new ModelCatalog(config.agentDir);
const memory = new ProjectMemoryService(config.home, (prompt, signal) => models.summarizeMemory(prompt, signal));
// Load metadata and resume pending compaction, but a damaged/busy memory store cannot stop pilotd.
const knownMemoryProjects = new Set<string>();
for (const project of projects.list()) {
	knownMemoryProjects.add(project.id);
	try {
		await memory.load(project.id);
	} catch (error) {
		console.warn(`pilotd: memory ${project.id}: ${error}`);
	}
}
const stopMemoryProjects = projects.onChange(() => {
	const current = new Set(projects.list().map((project) => project.id));
	for (const id of knownMemoryProjects)
		if (!current.has(id)) {
			knownMemoryProjects.delete(id);
			void memory.unload(id).catch((error) => console.warn(`pilotd: memory unload ${id}: ${error}`));
		}
	for (const project of projects.list()) {
		if (knownMemoryProjects.has(project.id)) continue;
		knownMemoryProjects.add(project.id);
		void memory.load(project.id).catch((error) => console.warn(`pilotd: memory ${project.id}: ${error}`));
	}
});
const sessions = new SessionManager(
	config.home,
	projects,
	config.agentDir,
	{},
	{},
	{
		idleParkMs: config.idleParkMs,
		workspaceRetentionMs: config.workspaceRetentionMs,
		models,
	},
);
// Membership is read while sessions load (auto-archiving, worker specs), so the bridge comes first.
const missionStore = new MissionStore(join(config.home, "missions.sqlite"));
const missionService = new MissionService(missionStore, sessions, projects);
await sessions.load();
missionService.notices.start();
missionService.compaction.start();
const terminals = new TerminalManager();
const server = createDaemonServer(
	config,
	sessions,
	projects,
	models,
	terminals,
	{
		service: missionService,
		store: missionStore,
	},
	undefined,
	memory,
);
server.listen(config.port, config.host, () => {
	console.log(`pilotd listening on http://${config.host}:${config.port} (data: ${config.home})`);
});

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log("pilotd: pausing sessions");
	watchdog.stop();
	server.close();
	stopMemoryProjects();
	await memory.stop();
	await missionService.notices.stop();
	await missionService.compaction.stop();
	await Promise.all([terminals.shutdown(), sessions.shutdown()]);
	missionStore.close();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
