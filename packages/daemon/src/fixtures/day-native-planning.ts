/** Isolated proxy drives real native Rust/daemon failure paths, never a live user home. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { interviewHistoryFixture } from "../interview-history.fixture.ts";

const { f, nextRound } = await interviewHistoryFixture();
const ledger = join(f.home, "commands.jsonl");
let posts = 0,
	lookups = 0,
	lost = false,
	mismatch = false,
	missing = false;
let hold: (() => void) | undefined;
let block = false;
let missingHistory = false;
let entered: (() => void) | undefined;
const sockets = new Set<WebSocket>();
const wss = new WebSocketServer({ noServer: true });
const proxy = createServer(async (req, res) => {
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		const writing = req.url === "/api/operations" && req.method === "POST";
		if (writing) {
			posts++;
			const op = JSON.parse(bytes.toString());
			const lines = (await readFile(ledger, "utf8"))
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			assert.ok(
				lines.some((r) => JSON.stringify(r.operation) === JSON.stringify(op)),
				"exact envelope saved before POST",
			);
		}
		if (req.url === "/api/operations/receipt") {
			lookups++;
			if (missing) {
				res.end(JSON.stringify({ state: "unknown" }));
				return;
			}
		}
		const reply = await fetch(`${f.root}${req.url}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(bytes.length ? { body: bytes } : {}),
		});
		const body = await reply.json();
		if (missingHistory && body.view) delete body.view.interviewHistory;
		if (writing && block) {
			block = false;
			await new Promise<void>((resolve) => {
				hold = resolve;
				entered?.();
			});
		}
		if (writing && lost) {
			lost = false;
			req.socket.destroy();
			return;
		}
		if (mismatch && req.url === "/api/operations/receipt") body.payloadHash = "mismatch";
		res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(body));
	} catch (error) {
		console.error(error);
		res.writeHead(500).end();
	}
});
proxy.on("upgrade", (req, socket, head) => {
	wss.handleUpgrade(req, socket, head, (client) => {
		const upstream = new WebSocket(`${f.root.replace("http:", "ws:")}${req.url}`);
		sockets.add(upstream);
		upstream.on("message", (bytes) => {
			if (client.readyState === WebSocket.OPEN) client.send(bytes.toString());
		});
		client.on("close", () => {
			upstream.close();
			sockets.delete(upstream);
		});
		upstream.on("error", () => client.close());
	});
});
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
		mission: f.missionId,
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	if (command.action === "lost") lost = command.value;
	if (command.action === "missing") missing = command.value;
	if (command.action === "mismatch") mismatch = command.value;
	if (command.action === "block") block = command.value;
	if (command.action === "entered" && !hold)
		await new Promise<void>((resolve) => {
			entered = resolve;
		});
	if (command.action === "release") {
		hold?.();
		hold = undefined;
	}
	if (command.action === "owner") f.coordinator = undefined;
	if (command.action === "next-round") await nextRound();
	if (command.action === "missing-history") missingHistory = command.value;
	if (command.action === "restart") {
		for (const socket of sockets) socket.close();
		await f.restart();
	}
	console.log(JSON.stringify({ posts, lookups, held: !!hold }));
}
for (const socket of sockets) socket.close();
for (const client of wss.clients) client.close();
proxy.closeAllConnections();
proxy.close();
wss.close();
await f.close();
