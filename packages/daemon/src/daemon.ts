/** pilotd: background pi agents on durable sessions. */
import { loadConfig } from "./config.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const config = loadConfig();
const projects = new ProjectStore(config.home);
await projects.load();
const sessions = new SessionManager(config.home, projects, config.agentDir, {}, {}, { idleParkMs: config.idleParkMs });
await sessions.load();
const terminals = new TerminalManager();
const server = createDaemonServer(config, sessions, projects, new ModelCatalog(config.agentDir), terminals);
server.listen(config.port, config.host, () => {
	console.log(`pilotd listening on http://${config.host}:${config.port} (data: ${config.home})`);
});

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log("pilotd: pausing sessions");
	server.close();
	terminals.shutdown();
	await sessions.shutdown();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
