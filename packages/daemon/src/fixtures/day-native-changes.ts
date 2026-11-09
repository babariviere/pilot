/** Disposable production daemon + retained store. No worker, provider or live profile. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DaemonHello } from "@pilot/protocol";
import { WebSocketServer } from "ws";
import { GitHubSetupService } from "../github-setup.ts";
import { daemonHello } from "../hello.ts";
import { dispositionTarget } from "../human-reviews.ts";
import { jjRepositoryIdentity } from "../jj-ownership.ts";
import { MissionControls } from "../mission-controls.ts";
import { MissionReports } from "../mission-reports.ts";
import type { MissionService } from "../mission-service.ts";
import { MissionStore } from "../missions.ts";
import { ModelCatalog } from "../models.ts";
import { ProjectStore } from "../projects.ts";
import { createDaemonServer } from "../server.ts";
import { SessionManager } from "../sessions.ts";
import { TerminalManager } from "../terminals.ts";
import { fixture, jj } from "../testing/shared-workspace.ts";

const f = fixture();
const home = join(realpathSync(f.root), "home");
const projects = new ProjectStore(home);
await projects.load();
const project = await projects.create({ path: realpathSync(f.source) });
const hello = await daemonHello(home, { independentExecution: true } as DaemonHello["capabilities"]);
const native = new GitHubSetupService(
	home,
	{ hostId: "local", daemonId: hello.daemonId, lineageId: hello.lineageId! },
	{ userHome: home, env: {} },
);
await native.status();
const capabilityBytes = readFileSync(join(home, "github-app-capability"), "utf8");
const token = JSON.parse(capabilityBytes).token as string;
let store = new MissionStore(join(home, "missions.sqlite"));
let sessions = new SessionManager(home, projects);
const terminals = new TerminalManager();
const metas: Array<Parameters<SessionManager["get"]>[0]> = [];
// Keep fixture metadata across restart, without opening any kernel session.
type FixtureMeta = Parameters<SessionManager["metas"]["set"]>[1];
const metadata: FixtureMeta[] = [];
const retained: string[] = [];
for (let index = 0; index < 2; index++) {
	const id = randomUUID();
	const scope = { version: 2 as const, sessionId: id, projectId: project.id };
	const w = await f.store.create(project.path, join(home, "sessions", id, "workspace"), undefined, undefined, scope);
	const meta = {
		id,
		title: `Retained ${index}`,
		cwd: w.path,
		projectId: project.id,
		mode: "build" as const,
		createdAt: 1,
		updatedAt: 1,
		retainedScope: scope,
		workspace: { source: project.path, base: w.base, jj: true as const, shared: w.shared! },
	};
	sessions["metas"].set(id, meta);
	metadata.push(meta);
	metas.push(id);
	writeFileSync(join(w.path, "a.txt"), "\uFEFFbefore é😀\r\n");
	jj(w.path, "commit", "-m", "base");
	writeFileSync(join(w.path, "a.txt"), "\uFEFFafter 👩‍💻\r\n");
	jj(w.path, "commit", "-m", "head");
	await f.store.observeOwnership(w.path, w.shared!);
	const revision = (rev: string) => {
		const [changeId, commitId] = jj(
			w.path,
			"--ignore-working-copy",
			"--at-op=@",
			"log",
			"--no-graph",
			"-r",
			rev,
			"-T",
			'change_id ++ "\\t" ++ commit_id',
		).split("\t");
		return { changeId: changeId!, commitId: commitId! };
	};
	const head = revision("@-"),
		base = revision("@--");
	const operationId = jj(
		w.path,
		"--ignore-working-copy",
		"--at-op=@",
		"op",
		"log",
		"--no-graph",
		"--limit",
		"1",
		"-T",
		"self.id()",
	);
	for (let n = 0; n < (!index && process.argv.includes("--large") ? 21 : 1); n++) {
		const snapshot = await sessions["reviewSnapshots"].capture({
			requestId: `retained-${index}-${n}`,
			repositoryId: await jjRepositoryIdentity(w.shared!.repository),
			changeId: head.changeId,
			operationId,
			base,
			head,
			scope: { kind: "layer" },
			source: "committed",
		});
		retained.push(snapshot.snapshotId);
	}
}
await store.durable();
const service = () =>
	({
		reports: new MissionReports(store),
		controls: new MissionControls(store, {
			checkpointMission: async () => "paused",
			resumeMission: async () => "resumed",
		}),
	}) as MissionService;
let server!: ReturnType<typeof createDaemonServer>;
let port = 0;
async function start() {
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		{ store, service: service() },
	];
	args[12] = hello;
	args[17] = native;
	server = createDaemonServer(...args);
	await server.runtimeReady;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	port = (server.address() as AddressInfo).port;
}
await start();
const upstream = async (path: string, method = "GET", body?: unknown) => {
	const r = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { "content-type": "application/json", "x-pilot-github-capability": token },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	assert.equal(r.status, 200, await r.clone().text());
	return r.json();
};
for (const snapshot of [retained[0]!, retained.at(-1)!]) {
	const id = snapshot === retained[0] ? metas[0]! : metas[1]!;
	const manifest = await upstream(`/api/sessions/${id}/review/${snapshot}?expectedProjectId=${project.id}`);
	await upstream("/api/review/requests/suggest", "POST", {
		operationId: randomUUID(),
		target: dispositionTarget(project.id, manifest),
		title: `Review ${id}`,
		reason: "Synthetic retained request",
		replacesRequestId: null,
		replacesExpectedRevision: null,
	});
}
const ledger = join(home, "commands.jsonl");
let posts = 0,
	lookups = 0,
	listReads = 0;
const flags = new Set<string>();
let held: (() => void) | undefined;
let entered: (() => void) | undefined;
let block = false;
const wss = new WebSocketServer({ noServer: true });
const invalidate = () => {
	for (const ws of wss.clients) ws.send(JSON.stringify({ type: "sessions" }));
};
const proxy = createServer(async (req, res) => {
	try {
		const path = req.url!;
		const writing = req.method === "POST" && /\/review\/requests\/(snooze|resume)$/.test(path);
		const lookup = path.includes("/review/requests/operations/");
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const bytes = Buffer.concat(chunks);
		if (writing) {
			posts++;
			const command = JSON.parse(bytes.toString());
			assert.ok(
				(await readFile(ledger, "utf8"))
					.split("\n")
					.filter(Boolean)
					.some((l) => {
						const r = JSON.parse(l);
						return r.kind === "changes" && JSON.stringify(r.command) === JSON.stringify(command);
					}),
				"fsynced exact command before send",
			);
		}
		if (lookup) {
			lookups++;
			if (flags.has("missing")) {
				res.end(JSON.stringify({ state: "unknown" }));
				return;
			}
		}
		if (path.includes("view=changes")) listReads++;
		const reply = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(bytes.length ? { body: bytes } : {}),
		});
		const body = await reply.json();
		if (writing && block) {
			block = false;
			await new Promise<void>((resolve) => {
				held = resolve;
				entered?.();
			});
		}
		if (writing && flags.delete("lost")) {
			req.socket.destroy();
			return;
		}
		if (lookup && flags.has("mismatch")) body.payloadHash = "wrong";
		if (path === `/api/projects/${project.id}/review`) {
			if (flags.has("empty")) body.chats = [];
			if (flags.has("capacity")) body.more = true;
		}
		if (path.includes("view=changes") && flags.has("endless")) {
			body.status = "available";
			body.changes = [];
			body.next = Number(new URL(path, "http://fixture").searchParams.get("after") ?? 0) + 1;
		}
		if (path.includes("view=changes") && flags.has("unavailable")) body.status = "unavailable";
		if (path.includes("/history") && flags.has("digest")) body.target.comparisonDigest = "0".repeat(64);
		if (path.includes("/patch") && flags.has("patch")) body.patch = "wrong bytes";
		if (path.includes("/history") && flags.delete("race")) {
			const r = body.attention.records[0];
			await upstream("/api/review/requests/snooze", "POST", {
				operationId: randomUUID(),
				requestId: r.requestId,
				expectedRevision: r.revision,
				reason: "Concurrent",
			});
		}
		if (path.includes("/history") && flags.delete("revoke")) sessions["metas"].delete(metas[0]!);
		if (path.includes("/history") && flags.delete("identityRead"))
			await writeFile(join(home, "daemon-id"), "revoked\n");
		if (path.includes("/history") && flags.delete("capabilityRead"))
			await writeFile(join(home, "github-app-capability"), "{}", { mode: 0o600 });
		if (path === "/api/hello" && flags.has("afterJournal")) {
			const records = (await readFile(ledger, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
			if (records.some((r) => r.kind === "changes" && !r.receipt && !r.not_sent))
				sessions["metas"].delete(metas[0]!);
		}
		res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(body));
	} catch (e) {
		console.error(e);
		res.writeHead(500).end();
	}
});
proxy.on("upgrade", (req, socket, head) =>
	wss.handleUpgrade(req, socket, head, (ws) => {
		ws.send(JSON.stringify({ type: "hello" }));
	}),
);
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const emit = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
emit({
	source: {
		profile: home,
		port: (proxy.address() as AddressInfo).port,
		home: { daemonId: hello.daemonId, lineageId: hello.lineageId },
		project_id: project.id,
		project_path: project.path,
	},
	ledger,
	retained,
	root: f.root,
});
for await (const line of createInterface({ input: process.stdin })) {
	const c = JSON.parse(line);
	if (c.action === "stats") {
		emit({ posts, lookups, listReads });
		continue;
	}
	if (c.action === "waitEntered" && !held)
		await new Promise<void>((resolve) => {
			entered = resolve;
		});
	else if (c.action === "release") {
		held?.();
		held = undefined;
	} else if (c.action === "block") block = true;
	else if (c.action === "invalidate") invalidate();
	else if (c.action === "restore") {
		for (const m of metadata) sessions["metas"].set(m.id, m);
		await writeFile(join(home, "daemon-id"), `${hello.daemonId}\n`);
		await writeFile(join(home, "github-app-capability"), capabilityBytes, { mode: 0o600 });
	} else if (c.action === "restart") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeAllConnections();
		await sessions.shutdown();
		await store.durable();
		store.close();
		store = new MissionStore(join(home, "missions.sqlite"));
		sessions = new SessionManager(home, projects);
		for (const m of metadata) sessions["metas"].set(m.id, m);
		await start();
	} else if (c.value) flags.add(c.action);
	else flags.delete(c.action);
	emit({ ok: true });
}
for (const ws of wss.clients) ws.terminate();
wss.close();
proxy.closeAllConnections();
await new Promise<void>((resolve) => proxy.close(() => resolve()));
await new Promise<void>((resolve) => server.close(() => resolve()));
await sessions.shutdown();
await terminals.shutdown();
await native.close();
await store.durable();
store.close();
await f.store.close();
f.close();
