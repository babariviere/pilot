/** Disposable real workflow confirmation host for the hidden native journey. It runs the real
 * daemon routes, OperationJournal, native capability and missions.sqlite in a temporary home,
 * behind a small proxy that can hold, drop or kill one confirmation request and restart the
 * daemon on the same files. Faux coordinator metadata only: no provider, reviewer or worker.
 * Controlled by JSON lines on stdin; replies and events are JSON lines on stdout. */
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { DaemonHello } from "@pilot/protocol";
import { GitHubSetupService } from "../github-setup.ts";
import type { MissionService } from "../mission-service.ts";
import { MissionStore } from "../missions.ts";
import { ModelCatalog } from "../models.ts";
import { ProjectStore } from "../projects.ts";
import { createDaemonServer } from "../server.ts";
import { SessionManager } from "../sessions.ts";
import { TerminalManager } from "../terminals.ts";

const host = { hostId: "daemon", daemonId: "test-daemon", lineageId: "test-lineage" };
const hello: DaemonHello = {
	...host,
	daemonVersion: "workflow-host",
	protocolVersion: 1,
	minimumClientProtocolVersion: 1,
	platform: "darwin",
	arch: "arm64",
	capabilities: {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: true,
		independentExecution: true,
	},
};

async function daemon(home: string, projectId?: string) {
	const projects = new ProjectStore(home);
	await projects.load();
	const project = projectId ? projects.require(projectId) : await projects.create({ path: home, name: "Project" });
	const sessions = new SessionManager(home, projects);
	const coordinator = { id: "lead", projectId: project.id, mode: "build", title: "Coordinator" };
	// Faux coordinator metadata only. No chat, worker or provider can start.
	sessions.get = ((id: string) => (id === "lead" ? coordinator : undefined)) as typeof sessions.get;
	sessions.spawn = (async () => {
		throw new Error("No worker may start");
	}) as typeof sessions.spawn;
	const store = new MissionStore(join(home, "missions.sqlite"));
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(home, host, { userHome: home, env: {} });
	await native.status();
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		{ store, service: {} as MissionService },
	];
	args[12] = hello;
	args[17] = native;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		project,
		store,
		port: (server.address() as AddressInfo).port,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			await sessions.shutdown();
			await terminals.shutdown();
			await native.close();
			await store.durable();
			store.close();
		},
	};
}

type Mode = "hold" | "drop" | "kill" | undefined;
type Held = { req: IncomingMessage; res: ServerResponse; body: Buffer };

async function main() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "workflow-host-")));
	let d = await daemon(home);
	// Longer than any compact summary, with meaningful tails the sheet must still disclose.
	const steps = Array.from({ length: 100 }, (_, i) => `Step ${i + 1}: keep the slice small and verified. 日本語`);
	const mission = d.store.create({
		projectId: d.project.id,
		title: "Coordinator-planned mission 日本語",
		brief: `# Plan\n${steps.join("\n")}\n\nEND OF BRIEF: reviews stay Balanced 末尾 👩‍💻`,
		planningVersion: 1,
	});
	d.store.join("lead", mission.id);
	d.store.update(mission.id, { coordinatorSessionId: "lead" });
	d.store.addDecision(
		mission.id,
		`Design before building. ${"Scope stays bounded. ".repeat(20)}DECISION TAIL: no merges 決定`,
		undefined,
		"all",
	);
	await d.store.durable();
	const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
	let mode: Mode;
	let held: Held | undefined;
	let log: { method: string; path: string; capability: boolean }[] = [];
	const forward = async ({ req, res, body }: Held, after?: (status: number, text: string) => void) => {
		const headers: Record<string, string> = {};
		for (const name of ["content-type", "x-pilot-github-capability"]) {
			const value = req.headers[name];
			if (typeof value === "string") headers[name] = value;
		}
		const response = await fetch(`http://127.0.0.1:${d.port}${req.url}`, {
			method: req.method,
			headers,
			body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
		});
		const text = await response.text();
		if (after) return after(response.status, text);
		res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
		res.end(text);
	};
	const proxy: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const path = req.url ?? "/";
			log.push({
				method: req.method ?? "",
				path,
				capability: typeof req.headers["x-pilot-github-capability"] === "string",
			});
			const request = { req, res, body };
			const confirm = req.method === "POST" && path === "/api/operations";
			const current = confirm ? mode : undefined;
			if (confirm) mode = undefined;
			if (current === "hold" || current === "kill") {
				held = request;
				emit({ event: "held" });
				if (current === "kill") {
					// The request never reaches the daemon; the client sees a lost connection.
					req.socket.destroy();
					held = undefined;
					emit({ event: "killed" });
				}
				return;
			}
			if (current === "drop") {
				// The daemon commits and answers; the client never receives the receipt.
				void forward(request, (status, text) => {
					req.socket.destroy();
					emit({ event: "dropped", status, state: JSON.parse(text).state });
				}).catch(() => req.socket.destroy());
				return;
			}
			void forward(request).catch(() => {
				res.writeHead(502);
				res.end();
			});
		});
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	emit({ port: (proxy.address() as AddressInfo).port, home, missionId: mission.id, projectId: d.project.id });
	const rows = (consent: boolean) => {
		const r = d.store.workflowConfirmations.latest(mission.id, consent);
		return r ? { operationId: r.operationId, kind: r.kind, digest: r.confirmed.package.digest } : null;
	};
	for await (const line of createInterface({ input: process.stdin })) {
		const cmd = JSON.parse(line) as { cmd: string };
		switch (cmd.cmd) {
			case "hold":
			case "drop":
			case "kill":
				mode = cmd.cmd;
				emit({ ok: cmd.cmd });
				break;
			case "release": {
				const h = held;
				held = undefined;
				if (h) await forward(h).catch(() => h.req.socket.destroy());
				emit({ ok: "release", forwarded: Boolean(h) });
				break;
			}
			case "mutate":
				// Any mission event conservatively invalidates a prepared package.
				d.store.addDecision(mission.id, "A later binding decision", undefined, "all");
				await d.store.durable();
				emit({ ok: "mutate" });
				break;
			case "restart":
				await d.close();
				d = await daemon(home, d.project.id);
				emit({ ok: "restart" });
				break;
			case "log":
				emit({ ok: "log", requests: log });
				log = [];
				break;
			case "rows":
				emit({ ok: "rows", approval: rows(false), consent: rows(true) });
				break;
			case "close":
				proxy.close();
				proxy.closeAllConnections();
				await d.close();
				await rm(home, { recursive: true, force: true });
				emit({ ok: "close" });
				return;
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
