/** Disposable real daemon service graph. No providers, schedules or user config.
 * Only model IPC is a deterministic peer; lease, HTTP, journals and restart are real. */
import { fork } from "node:child_process";
import { join } from "node:path";
import { daemonHello } from "../hello.ts";
import { ModelCatalog } from "../models.ts";
import { ProjectStore } from "../projects.ts";
import { ownRuntime, type RuntimeBuild } from "../runtime-owner.ts";
import { createDaemonServer } from "../server.ts";
import { SessionManager, Worker } from "../sessions.ts";
import { TerminalManager } from "../terminals.ts";

const [home, portText, buildText, seed] = process.argv.slice(2);
if (!home || !portText || !buildText) throw new Error("Missing private fixture inputs");
const port = Number(portText);
const build = JSON.parse(buildText) as RuntimeBuild;
const owner = await ownRuntime(home, port, true, build, join(home, "fixture-runtime"));
const hello = await daemonHello(home, {
	independentExecution: true,
	coordinatorIsolation: false,
	powerManagement: false,
	systemSleepEvents: false,
	swiftUIArtifacts: false,
});
const projects = new ProjectStore(home);
const modes = ["healthy", "unresponsive", "healthy", "job"];
let starts = 0;
const opened: string[] = [];
const sessions = new SessionManager(home, projects, undefined, {
	title: async () => undefined,
	worker: (spec, receive, exit) => {
		starts++;
		opened.push(spec.sessionId);
		const child = fork(
			new URL("./update-pause-worker.ts", import.meta.url),
			[modes.shift() ?? "healthy", join(home, "canceled-job")],
			{
				execArgv: [],
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				env: { PATH: process.env.PATH },
			},
		);
		return new Worker(spec, receive, exit, undefined, { child });
	},
});
const terminals = new TerminalManager();
const server = createDaemonServer(
	{ home, port, host: "127.0.0.1" },
	sessions,
	projects,
	new ModelCatalog(home),
	terminals,
	undefined,
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
	undefined,
	undefined,
	undefined,
	undefined,
	owner,
);
await server.runtimeReady;
// Use the same combined maintenance state as ordinary daemon startup.
await sessions.load(server.runtimeFrozen());
const chats = [];
if (seed === "seed") {
	await sessions.resumeMaintenance();
	for (const message of ["healthy", "broken", "held", "owned job"])
		chats.push(await sessions.spawn({ cwd: home, message }));
	await Promise.all((sessions as unknown as { starting: Map<string, Promise<unknown>> }).starting.values());
	await sessions.stop(chats[2]!.id);
}
owner.ready(hello);
process.send?.({ ready: true, hello, chats, starts, frozen: server.runtimeFrozen(), boot: owner.identity().boot });
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	await sessions.shutdown();
	await terminals.shutdown();
	await owner.close();
	process.exit(0);
}
process.on("message", (value) => {
	if (value === "close") void close();
	if (value && typeof value === "object" && "stop" in value && typeof value.stop === "string")
		void sessions.stop(value.stop).then(() => process.send?.({ stopped: value.stop }));
	if (value === "status")
		void (async () => {
			await Promise.all((sessions as unknown as { starting: Map<string, Promise<unknown>> }).starting.values());
			process.send?.({ starts, opened, frozen: server.runtimeFrozen(), sessions: sessions.list() });
		})();
});
process.on("SIGTERM", () => void close());
