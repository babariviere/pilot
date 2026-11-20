/** Synthetic control-socket fanout. Pass a checkout root to compare the same probe against another revision. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";

const root = pathToFileURL(`${resolve(process.argv[2] ?? ".")}/packages/daemon/src/`);
const modules = existsSync(new URL("sessions/", root))
	? ["server", "sessions/sessions", "projects/projects", "models/models", "sessions/terminals/terminals"]
	: ["server", "sessions", "projects", "models", "terminals"];
const [{ createDaemonServer }, { SessionManager }, { ProjectStore }, { ModelCatalog }, { TerminalManager }] =
	await Promise.all(modules.map((name) => import(new URL(`${name}.ts`, root).href)));
const home = await mkdtemp(join(tmpdir(), "pilot-event-fanout-"));
const projects = new ProjectStore(home);
await projects.load();
const sessions = new SessionManager(home, projects);
const terminals = new TerminalManager();
const summaries: SessionSummary[] = Array.from({ length: 5_000 }, (_, i) => ({
	id: `session-${i}`,
	cwd: home,
	title: `Synthetic session ${i}`,
	state: "idle",
	createdAt: 1,
	updatedAt: 1,
}));
sessions.list = () => summaries;
const listeners = new Set<(session: SessionSummary) => void>();
sessions.onChange = (listener: (session: SessionSummary) => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const config = { home, host: "127.0.0.1", port: 0 };
const models = new ModelCatalog(home);
const composition = await import(new URL("daemon-services.ts", root).href).catch((error: NodeJS.ErrnoException) => {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
	return undefined;
});
// Only this comparison probe supports the pre-refactor signature, never the production server.
const server = composition
	? createDaemonServer(composition.createDaemonServices({ config, sessions, projects, models, terminals }))
	: createDaemonServer(config, sessions, projects, models, terminals);
const sockets: WebSocket[] = [];
try {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const expected = 20_000;
	let received = 0;
	let done!: () => void;
	const delivered = new Promise<void>((resolve) => {
		done = resolve;
	});
	for (let i = 0; i < 2; i++) {
		const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`);
		sockets.push(socket);
		socket.on("message", (raw) => {
			if (JSON.parse(String(raw)).type === "session" && ++received === expected) done();
		});
		await once(socket, "open");
	}
	await yieldTurn();
	let last = performance.now(),
		largestGap = 0;
	const heartbeat = setInterval(() => {
		const now = performance.now();
		largestGap = Math.max(largestGap, now - last);
		last = now;
	}, 5);
	const cpu = process.cpuUsage(),
		started = performance.now();
	try {
		for (let i = 0; i < 10_000; i++) {
			const summary = {
				...summaries[i % summaries.length]!,
				state: i < summaries.length ? ("working" as const) : ("idle" as const),
				updatedAt: i + 2,
			};
			for (const listener of listeners) listener(summary);
			if (i % 100 === 99) await yieldTurn();
		}
		await delivered;
		const used = process.cpuUsage(cpu);
		assert.equal(received, expected);
		console.log(
			JSON.stringify({
				sessions: summaries.length,
				events: 10_000,
				sockets: sockets.length,
				deliveries: received,
				wallMs: performance.now() - started,
				cpuMs: (used.user + used.system) / 1000,
				largestHeartbeatGapMs: largestGap,
				rssMiB: process.memoryUsage().rss / 1024 / 1024,
			}),
		);
	} finally {
		clearInterval(heartbeat);
	}
} finally {
	for (const socket of sockets) socket.terminate();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await Promise.all([sessions.shutdown(), terminals.shutdown()]);
	await rm(home, { recursive: true, force: true });
}
