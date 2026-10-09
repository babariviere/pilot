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

const config = loadConfig();
const projects = new ProjectStore(config.home);
await projects.load();
const sessions = new SessionManager(
	config.home,
	projects,
	config.agentDir,
	{},
	{},
	{
		idleParkMs: config.idleParkMs,
		workspaceRetentionMs: config.workspaceRetentionMs,
	},
);
// Membership is read while sessions load (auto-archiving, worker specs), so the bridge comes first.
const missionStore = new MissionStore(join(config.home, "missions.sqlite"));
const missionService = new MissionService(missionStore, sessions, projects);
await sessions.load();
const terminals = new TerminalManager();
const server = createDaemonServer(config, sessions, projects, new ModelCatalog(config.agentDir), terminals, {
	service: missionService,
	store: missionStore,
});
server.listen(config.port, config.host, () => {
	console.log(`pilotd listening on http://${config.host}:${config.port} (data: ${config.home})`);
});

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log("pilotd: pausing sessions");
	server.close();
	await Promise.all([terminals.shutdown(), sessions.shutdown()]);
	missionStore.close();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
