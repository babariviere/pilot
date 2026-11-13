/** Isolated native bridge fixture. No credentials, sources or providers outside its temp home. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { nativeIntakeFixture } from "../native-intake.fixture.ts";
import { SourceSignInRequired } from "../source-tool-rules.ts";

const f = await nativeIntakeFixture(),
	ledger = join(f.home, "commands.jsonl");
let posts = 0,
	lookups = 0,
	lost = false,
	denied = false,
	offline = false,
	staleProfile = false,
	failSave = false;
let linearMode = "issues",
	linearReads = 0,
	malformedLinear = "";
let helloMode = "";
f.tracking.register("linear", async () => {
	linearReads++;
	if (linearMode === "error") throw new SourceSignInRequired();
	if (linearMode === "empty") return { items: [], activeIds: [], linear: { cycleStatus: "no_active_cycle" } };
	return {
		items: Array.from({ length: 102 }, (_, i) => ({
			externalId: `saved-${i}`,
			title: "Same title",
			url: `https://example.invalid/${i}`,
			status: i === 0 ? "Done" : "Todo",
			metadata: { statusType: i === 0 ? "completed" : "unstarted" },
			updatedAt: 1000 - i,
		})),
		activeIds: Array.from({ length: 102 }, (_, i) => `saved-${i}`),
		linear: {
			cycleStatus: "current",
			currentCycle: {
				id: "saved-cycle",
				number: 12,
				startsAt: "2026-11-09T00:00:00Z",
				endsAt: "2026-11-23T00:00:00Z",
				progress: 0.5,
				total: 2,
				done: 1,
				inProgress: 1,
				todo: 0,
			},
		},
	};
});
const sockets = new Set<WebSocket>(),
	wss = new WebSocketServer({ noServer: true });
const proxy = createServer(async (req, res) => {
	try {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const bytes = Buffer.concat(chunks);
		if (
			req.url?.includes("native-projects") ||
			req.url?.includes("chat-profile") ||
			req.url?.includes("saved-linear") ||
			req.url?.includes("operations")
		) {
			if (offline) {
				req.socket.destroy();
				return;
			}
			if (denied) {
				res.writeHead(403).end("{}");
				return;
			}
		}
		const writing = req.method === "POST" && req.url === "/api/operations";
		if (writing) {
			posts++;
			const op = JSON.parse(bytes.toString());
			const saved = (await readFile(ledger, "utf8"))
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			assert(
				saved.some((r) => JSON.stringify(r.operation) === JSON.stringify(op)),
				"operation saved before send",
			);
		}
		if (req.url === "/api/operations/receipt") lookups++;
		const reply = await fetch(`${f.root}${req.url}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(bytes.length ? { body: bytes } : {}),
		});
		let body = await reply.text();
		if (req.url === "/api/hello" && helloMode) {
			const v = JSON.parse(body);
			switch (helloMode) {
				case "hello-daemon":
					v.daemonId = "different-daemon";
					break;
				case "hello-lineage":
					v.lineageId = "different-lineage";
					break;
				case "hello-identity-before-protocol":
					v.daemonId = "different-daemon";
					v.protocolVersion = 0;
					break;
				case "hello-minimum":
					v.minimumClientProtocolVersion = 2;
					break;
				case "hello-missing-minimum":
					delete v.minimumClientProtocolVersion;
					break;
				case "hello-protocol":
					v.protocolVersion = 0;
					break;
				case "hello-string-protocol":
					v.protocolVersion = "1";
					break;
				case "hello-execution":
					v.capabilities.independentExecution = false;
					break;
				case "hello-string-execution":
					v.capabilities.independentExecution = "true";
					break;
				case "hello-no-day":
					delete v.capabilities.dayOverview;
					break;
				case "hello-no-controls":
					delete v.capabilities.missionControls;
					break;
			}
			body = JSON.stringify(v);
		}
		if (req.url?.includes("saved-linear") && malformedLinear) {
			const v = JSON.parse(body);
			if (malformedLinear === "project") v.projectId = f.other.id;
			if (malformedLinear === "count") v.more = 0;
			body = JSON.stringify(v);
		}
		if (writing && failSave) {
			failSave = false;
			await chmod(ledger, 0o644);
		}
		if (staleProfile && req.url?.includes("chat-profile")) {
			staleProfile = false;
			await f.projects.update(f.other.id, { name: "Changed after selection reply" });
		}
		if (writing && lost) {
			lost = false;
			req.socket.destroy();
			return;
		}
		res.writeHead(reply.status, { "content-type": "application/json" }).end(body);
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
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const c = JSON.parse(line);
	if (c.action === "quit") break;
	if (c.action === "lost") lost = true;
	if (c.action === "fail-save") failSave = true;
	if (c.action === "restore-ledger") await chmod(ledger, 0o600);
	if (c.action === "deny") denied = true;
	if (c.action === "offline") offline = true;
	if (c.action.startsWith("hello-")) helloMode = c.action;
	if (c.action === "allow") {
		denied = false;
		offline = false;
		malformedLinear = "";
		helloMode = "";
	}
	if (c.action === "saved-linear" || c.action === "linear-empty" || c.action === "linear-error") {
		linearMode = c.action === "linear-empty" ? "empty" : c.action === "linear-error" ? "error" : "issues";
		await f.tracking.poll(`${f.project.id}:linear`);
		if (c.action === "saved-linear") {
			const first = (await f.items.list({ projectId: f.project.id, kind: "linear" })).items[0]!;
			await f.items.patch(first.id, { missionId: "mission-A", sessionId: "chat-A" });
			await f.items.patch(first.id, { missionId: "mission-B", sessionId: "chat-B" });
		}
	}
	if (c.action === "linear-stale")
		await f.projects.update(f.project.id, { tracking: { linearTeam: "REPLACED", slackChannels: [] } });
	if (c.action === "linear-bad-project") malformedLinear = "project";
	if (c.action === "linear-bad-count") malformedLinear = "count";
	if (c.action === "stale-profile") staleProfile = true;
	if (c.action === "change-other") await f.projects.update(f.other.id, { name: "Changed other project" });
	if (c.action === "delete-other") await f.projects.remove(f.other.id);
	if (c.action === "delete-selected") await f.projects.remove(f.project.id);
	console.log(JSON.stringify({ posts, lookups, linearReads, ...f.stats() }));
}
process.stdin.destroy();
for (const s of sockets) s.close();
for (const c of wss.clients) c.terminate();
proxy.closeAllConnections();
await new Promise<void>((r) => proxy.close(() => r()));
wss.close();
await f.close();
