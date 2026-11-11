/** Real daemon + controlled passive read races. All state is temporary. */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { mapSourceFixture } from "../map-source.fixture.ts";

const records = await mapSourceFixture();
const { f, decision, knowledge } = records;
let race = "",
	gets = 0,
	posts = 0;
const proxy = createServer(async (req, res) => {
	try {
		const writing = req.method === "POST" && req.url === "/api/operations";
		if (req.method !== "GET" && !writing) {
			res.writeHead(405).end();
			return;
		}
		if (writing) posts++;
		else gets++;
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		const reply = await fetch(`${f.root}${req.url}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(bytes.length ? { body: bytes } : {}),
		});
		const body = await reply.text();
		if (race && (req.url === `/api/missions/${f.missionId}` || req.url?.includes("/knowledge/"))) {
			const action = race;
			race = "";
			if (action === "leave") f.store.leave(f.owner);
			if (action === "project") f.coordinator = { ...f.coordinator!, projectId: "different-project" };
			if (action === "unlink") await records.unlink();
			await f.store.durable();
		}
		res.writeHead(reply.status, { "content-type": "application/json" }).end(body);
	} catch {
		res.writeHead(500).end();
	}
});
// Keep only hello, so race tests cannot accidentally pass merely because a WS
// invalidation arrived. The final durable native planning read must refuse.
const wss = new WebSocketServer({ noServer: true });
const upstreams = new Set<WebSocket>();
proxy.on("upgrade", (req, socket, head) =>
	wss.handleUpgrade(req, socket, head, (client) => {
		const upstream = new WebSocket(`${f.root.replace("http:", "ws:")}${req.url}`);
		upstreams.add(upstream);
		upstream.on("message", (bytes) => {
			if (JSON.parse(bytes.toString()).type === "hello" && client.readyState === WebSocket.OPEN)
				client.send(bytes.toString());
		});
		upstream.on("error", () => client.close());
		client.on("close", () => {
			upstream.close();
			upstreams.delete(upstream);
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
		ledger: join(f.home, "source-commands.jsonl"),
		mission: f.missionId,
		decision: decision.id,
		knowledge: knowledge.entry.id,
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	if (command.action === "race") race = command.value;
	if (command.action === "append") await records.append();
	if (command.action === "fill-summary") await records.fillSummary();
	if (command.action === "replace") await records.replace();
	if (command.action === "unlink") await records.unlink();
	if (command.action === "delete") f.store.removeDecision(f.missionId, decision.id);
	if (command.action === "leave") f.store.leave(f.owner);
	if (command.action === "project") f.coordinator = { ...f.coordinator!, projectId: "different-project" };
	if (command.action === "access") f.coordinator = { ...f.coordinator!, mode: "ask" };
	if (command.action === "archive") f.store.update(f.missionId, { status: "archived" });
	if (command.action === "restart") await f.restart();
	if (command.action === "quit") break;
	await f.store.durable();
	console.log(JSON.stringify({ gets, posts }));
}
for (const upstream of upstreams) upstream.close();
for (const client of wss.clients) client.close();
wss.close();
proxy.closeAllConnections();
await new Promise<void>((resolve) => proxy.close(() => resolve()));
await f.close();
