/** Released hidden bridge fixture. Isolated real daemon and durable fake-session admission only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { nativeIntakeFixture } from "../native-intake.fixture.ts";

const f = await nativeIntakeFixture(),
	ledger = join(f.home, "commands.jsonl");
const worker = await f.sessions.spawnDurable(
	{ projectId: f.project.id, mode: "build", model: "fake/model", message: "Synthetic work only" },
	randomUUID(),
	randomUUID(),
);
const chat = await f.sessions.spawnDurable(
	{ projectId: f.project.id, mode: "ask", model: "fake/model", message: "Synthetic standalone only" },
	randomUUID(),
	randomUUID(),
);
// The real SessionManager still owns input metadata/admission. Only its passive
// summary is synthetic, like a fake worker's saved final activity notification.
const get = f.sessions.get.bind(f.sessions);
let outcomeAt = 100,
	heldOwner = false;
f.sessions.get = (id) => {
	const s = get(id);
	if (id === worker.id && s && heldOwner) return { ...s, archivedAt: 1 };
	return id === chat.id && s
		? { ...s, working: false, state: "idle", outcome: "done", outcomeAt, outcomeReason: "Synthetic report" }
		: s;
};
const mission = f.store.create({ projectId: f.project.id, title: "Synthetic result" });
f.store.join(worker.id, mission.id);
const task = f.store.addTask(mission.id, { title: "Delivered fixture", sessionId: worker.id });
const pr = f.store.addResource(mission.id, {
	taskId: task.id,
	url: "https://github.com/example/repo/pull/1",
	relationship: "reference",
});
f.store.updatePullRequest({
	number: 1,
	url: pr.url,
	title: "Synthetic PR",
	state: "merged",
	mergedAt: 100,
	checkedAt: 110,
});
f.store.linkArtifact(mission.id, {
	sessionId: worker.id,
	taskId: task.id,
	artifactId: "fake-artifact",
	title: "Output",
	kind: "visual",
	revision: 1,
});
f.store.completeTask(mission.id, task.id, worker.id, {
	commit: "a".repeat(40),
	checks: "Synthetic checks",
	issues: "Not deployed",
});
await f.store.durable();
let posts = 0,
	lookups = 0,
	lost = false,
	denied = false,
	malformed = "",
	corruptLookup = false,
	failSave = false,
	race = false;
let outputUrl: string | null = null,
	outputRace = "",
	outputReads = 0;
const sockets = new Set<WebSocket>(),
	wss = new WebSocketServer({ noServer: true });
const proxy = createServer(async (req, res) => {
	try {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c);
		const bytes = Buffer.concat(chunks);
		const writing = req.method === "POST" && req.url === "/api/operations";
		const lookup = req.url === "/api/operations/receipt";
		if (req.url?.endsWith("delivered-work") && outputRace && ++outputReads === 2) {
			const mode = outputRace;
			outputRace = "";
			if (mode === "deny") denied = true;
			else if (mode === "delete") f.store.removeResource(mission.id, pr.id);
			else if (mode === "retarget") outputUrl = "https://github.com/example/repo/pull/2";
			else f.store.updateTask(mission.id, task.id, { body: randomUUID() });
			await f.store.durable();
		}
		if (denied && (writing || lookup || req.url?.endsWith("delivered-work"))) {
			res.writeHead(403).end("{}");
			return;
		}
		if (writing) {
			posts++;
			const op = JSON.parse(bytes.toString());
			const saved = (await readFile(ledger, "utf8"))
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			assert(
				saved.some((r) => JSON.stringify(r.operation) === JSON.stringify(op)),
				"exact operation saved before send",
			);
			if (race) {
				race = false;
				f.store.updateTask(mission.id, task.id, { body: "Changed at POST" });
			}
		}
		if (lookup) lookups++;
		const reply = await fetch(`${f.root}${req.url}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(bytes.length ? { body: bytes } : {}),
		});
		const body = await reply.json();
		if (req.url?.endsWith("delivered-work") && outputUrl !== null && body.pullRequests?.[0]) {
			// Adversarial wire target with the same resource/delivery identity.
			body.pullRequests[0].url = outputUrl;
			body.pullRequests[0].pullRequest.url = outputUrl;
		}
		if (writing && failSave) {
			failSave = false;
			await chmod(ledger, 0o644);
		}
		if (writing && lost) {
			lost = false;
			req.socket.destroy();
			return;
		}
		if ((writing || (lookup && corruptLookup)) && malformed && body.receipt?.state === "accepted") {
			if (malformed === "domain-only") body.receipt = { state: "unknown" };
			else if (malformed === "wrong-owner") {
				body.verificationReceipt.verification.messageReceipt.sessionId = "other";
				body.receipt.result = structuredClone(body.verificationReceipt.verification);
			} else if (malformed === "wrong-note") {
				body.verificationReceipt.verification.note += "changed";
				body.receipt.result = structuredClone(body.verificationReceipt.verification);
			} else if (malformed === "wrong-envelope") body.verificationReceipt.operation.producerId = "other";
		}
		res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(body));
	} catch (e) {
		console.error(e);
		res.writeHead(500).end();
	}
});
proxy.on("upgrade", (req, socket, head) =>
	wss.handleUpgrade(req, socket, head, (client) => {
		const upstream = new WebSocket(`${f.root.replace("http:", "ws:")}${req.url}`);
		sockets.add(upstream);
		upstream.on("message", (b) => {
			if (client.readyState === WebSocket.OPEN) client.send(b.toString());
		});
		upstream.on("error", () => client.close());
		client.on("close", () => {
			upstream.close();
			sockets.delete(upstream);
		});
	}),
);
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
console.log(
	JSON.stringify({
		source: {
			profile: f.home,
			port: (proxy.address() as AddressInfo).port,
			home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
		ledger,
		task: { kind: "task", projectId: f.project.id, missionId: mission.id, taskId: task.id },
		chat: { kind: "chat", projectId: f.project.id, sessionId: chat.id },
		worker: worker.id,
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const c = JSON.parse(line);
	if (c.action === "quit") break;
	if (c.action === "lost") lost = true;
	if (c.action === "deny") denied = true;
	if (c.action === "allow") denied = false;
	if (c.action === "race") race = true;
	if (c.action === "hold-owner") heldOwner = true;
	if (c.action.startsWith("output-url:")) outputUrl = c.action.slice(11);
	if (c.action.startsWith("output-race:")) {
		outputRace = c.action.slice(12);
		outputReads = 0;
	}
	if (c.action === "delete-output") f.store.removeResource(mission.id, pr.id);
	if (c.action === "new-delivery") f.store.updateTask(mission.id, task.id, { body: randomUUID() });
	if (c.action === "new-outcome") outcomeAt++;
	if (c.action.startsWith("malformed:")) malformed = c.action.slice(10);
	if (c.action === "corrupt-lookup") corruptLookup = true;
	if (c.action === "valid-pair") {
		malformed = "";
		corruptLookup = false;
	}
	if (c.action === "fail-save") failSave = true;
	if (c.action === "restore-ledger") await chmod(ledger, 0o600);
	if (c.action === "move-port") {
		for (const client of wss.clients) client.terminate();
		proxy.closeAllConnections();
		await new Promise<void>((r) => proxy.close(() => r()));
		proxy.listen(0, "127.0.0.1");
		await once(proxy, "listening");
	}
	const meta = JSON.parse(await readFile(join(f.home, "sessions", worker.id, "meta.json"), "utf8"));
	console.log(
		JSON.stringify({
			port: (proxy.address() as AddressInfo).port,
			posts,
			lookups,
			...f.stats(),
			messages: meta.pending.filter((p: { content: string }) => p.content !== "Synthetic work only"),
		}),
	);
}
process.stdin.destroy();
for (const s of sockets) s.close();
for (const c of wss.clients) c.terminate();
proxy.closeAllConnections();
await new Promise<void>((r) => proxy.close(() => r()));
wss.close();
await f.close();
