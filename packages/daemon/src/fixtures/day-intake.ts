/** Isolated native bridge fixture. No credentials, sources or providers outside its temp home. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { nativeIntakeFixture } from "../native-intake.fixture.ts";

const f = await nativeIntakeFixture(),
	ledger = join(f.home, "commands.jsonl");
let posts = 0,
	lookups = 0,
	lost = false;
const sockets = new Set<WebSocket>(),
	wss = new WebSocketServer({ noServer: true });
const proxy = createServer(async (req, res) => {
	try {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const bytes = Buffer.concat(chunks);
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
		const body = await reply.text();
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
	console.log(JSON.stringify({ posts, lookups, ...f.stats() }));
}
process.stdin.destroy();
for (const s of sockets) s.close();
for (const c of wss.clients) c.terminate();
proxy.closeAllConnections();
await new Promise<void>((r) => proxy.close(() => r()));
wss.close();
await f.close();
