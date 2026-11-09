/** Hidden native transport fixture. Production HTTP/SQLite with no providers or live navigation. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { nativeAttentionFixture } from "../native-attention.fixture.ts";

const f = await nativeAttentionFixture();
await f.create();
let posts = 0,
	lookups = 0,
	lost = false,
	missing = false,
	mismatch = false;
let hold = false,
	release: (() => void) | undefined,
	entered: (() => void) | undefined;
const sockets = new Set<WebSocket>();
const wss = new WebSocketServer({ noServer: true });
const proxy = createServer(async (req, res) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks),
			path = req.url!;
		const intent = body.length ? JSON.parse(body.toString()) : null;
		const lookup = path.endsWith("/receipt");
		const sends = intent && (path.startsWith("/api/operations") || intent.kind !== "read") && !lookup;
		if (lookup) lookups++;
		if (sends) {
			posts++;
			const ledger = await readFile(join(f.home, "commands.jsonl"), "utf8");
			assert.ok(ledger.endsWith("\n"));
			assert.ok(
				ledger
					.split("\n")
					.filter(Boolean)
					.some((line) => {
						const row = JSON.parse(line);
						return (
							JSON.stringify(path.startsWith("/api/operations") ? row.request?.operation : row.request) ===
							JSON.stringify(intent)
						);
					}),
				"exact outgoing intent is fsynced before send",
			);
			entered?.();
			if (hold)
				await new Promise<void>((r) => {
					release = r;
				});
		}
		if (lookup && missing) {
			res.end(JSON.stringify({ ok: false, error: { code: "unknown", message: "Missing exact receipt" } }));
			return;
		}
		const answer = await fetch(`${f.root}${path}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(body.length ? { body } : {}),
		});
		const reply = await answer.json();
		if (sends && lost) {
			lost = false;
			req.socket.destroy();
			return;
		}
		if (lookup && mismatch && reply.ok) reply.value.record.id = "wrong-action";
		res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(reply));
	} catch (e) {
		console.error(e);
		res.writeHead(500).end();
	}
});
proxy.on("upgrade", (req, socket, head) =>
	wss.handleUpgrade(req, socket, head, (ws) => {
		const remote = new WebSocket(`${f.root.replace("http:", "ws:")}/api/ws`);
		sockets.add(remote);
		remote.on("message", (bytes) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(bytes.toString());
		});
		remote.on("close", () => {
			sockets.delete(remote);
			ws.close();
		});
		ws.on("close", () => remote.close());
	}),
);
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
console.log(
	JSON.stringify({
		source: {
			profile: f.home,
			port: (proxy.address() as AddressInfo).port,
			home: { daemonId: f.host.daemonId, lineageId: f.host.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
		ledger: join(f.home, "commands.jsonl"),
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const cmd = JSON.parse(line);
	if (cmd.action === "lost") lost = true;
	if (cmd.action === "missing") missing = cmd.value;
	if (cmd.action === "mismatch") mismatch = cmd.value;
	if (cmd.action === "file") await writeFile(f.file, cmd.value ? "new package" : "exact package");
	if (cmd.action === "revoke") f.session = { ...f.session, mode: cmd.value ? "ask" : "build" };
	if (cmd.action === "stop")
		f.session = { ...f.session, inputGeneration: (f.session.inputGeneration ?? 0) + 1, outcome: "stopped" };
	if (cmd.action === "restart") await f.restart();
	if (cmd.action === "identity") await writeFile(join(f.home, "daemon-id"), "changed\n");
	if (cmd.action === "hold") hold = true;
	if (cmd.action === "waitEntered" && posts === 0)
		await new Promise<void>((r) => {
			entered = r;
		});
	if (cmd.action === "release") {
		hold = false;
		release?.();
		release = undefined;
	}
	if (cmd.action === "quit") break;
	console.log(
		JSON.stringify({ posts, lookups, state: f.store.attention.humanAction("upload")?.state, sends: f.sends }),
	);
}
for (const ws of wss.clients) ws.terminate();
for (const ws of sockets) ws.terminate();
wss.close();
proxy.closeAllConnections();
await new Promise<void>((r) => proxy.close(() => r()));
await f.close();
