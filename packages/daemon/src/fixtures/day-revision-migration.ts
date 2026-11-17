/** Released native bridge journey with a real daemon/journal and fake checkpoint participants. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { publishedPlanningFixture } from "../published-planning.fixture.ts";

await test("native revision and migration fixture", async (t) => {
	const f = await publishedPlanningFixture(t, { native: true, twoSlices: true });
	const owners = [randomUUID(), randomUUID(), randomUUID()];
	for (const owner of owners) f.store.join(owner, f.missionId);
	const tasks = f.store.tasks(f.missionId);
	f.store.updateTask(f.missionId, tasks[0]!.id, { sessionId: owners[0]! });
	f.store.updateTask(f.missionId, tasks[1]!.id, { sessionId: owners[1]! });
	const independent = f.store.addTask(f.missionId, { title: "Independent guide" });
	f.store.updateTask(f.missionId, independent.id, { sessionId: owners[2]! });
	const paused: string[] = [];
	t.mock.method(f.sessions, "checkpointMission", async (id: string) => {
		paused.push(id);
		return "paused" as const;
	});
	const proposal = await f.store.revisions.propose(
		f.missionId,
		{
			operationId: randomUUID(),
			source: f.store.revisions.source(f.missionId),
			summary: "Clarify importer",
			delta: { tasks: [{ id: tasks[0]!.id, title: "Reviewed importer" }] },
		},
		{},
	);
	const old = f.store.create({
		projectId: f.project.id,
		title: "Old importer",
		brief: "Keep this history",
		tasks: [{ title: "Unfinished old work" }],
	});
	f.store.linkSuccessor(old.id, f.missionId, f.project.id, randomUUID());
	await f.store.durable();
	const ledger = join(f.home, "commands.jsonl");
	let posts = 0,
		lost = false;
	const sockets = new Set<WebSocket>();
	const wss = new WebSocketServer({ noServer: true });
	const proxy = createServer(async (req, res) => {
		try {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const bytes = Buffer.concat(chunks);
			const writing = req.url === "/api/operations" && req.method === "POST";
			if (writing) {
				posts++;
				const op = JSON.parse(bytes.toString());
				const records = (await readFile(ledger, "utf8"))
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l));
				assert.ok(records.some((r) => JSON.stringify(r.operation) === JSON.stringify(op)));
			}
			const response = await fetch(`${f.root}${req.url}`, {
				method: req.method,
				headers: {
					"content-type": "application/json",
					"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
				},
				...(bytes.length ? { body: bytes } : {}),
			});
			const body = await response.text();
			if (writing && lost) {
				lost = false;
				req.socket.destroy();
				return;
			}
			res.writeHead(response.status, { "content-type": "application/json" }).end(body);
		} catch (error) {
			console.error(error);
			res.writeHead(500).end();
		}
	});
	proxy.on("upgrade", (req, socket, head) =>
		wss.handleUpgrade(req, socket, head, (client) => {
			const upstream = new WebSocket(`${f.root.replace("http:", "ws:")}${req.url}`);
			sockets.add(upstream);
			upstream.on("message", (bytes) => {
				if (JSON.parse(bytes.toString()).type === "hello" && client.readyState === WebSocket.OPEN)
					client.send(bytes.toString());
			});
			client.on("close", () => {
				upstream.close();
				sockets.delete(upstream);
			});
			upstream.on("error", () => client.close());
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
			mission: f.missionId,
			old: old.id,
			proposal: proposal.id,
			digest: proposal.digest,
			owners,
		}),
	);
	for await (const line of createInterface({ input: process.stdin })) {
		const command = JSON.parse(line);
		if (command.action === "close" || command.action === "quit") {
			console.log("{}");
			break;
		}
		if (command.action === "lost") lost = true;
		if (command.action === "change-old") f.store.update(old.id, { goal: "Changed old context" });
		console.log(
			JSON.stringify({
				posts,
				paused,
				oldStatus: f.store.require(old.id).status,
				independentHeld: f.store.revisionTaskHeld(f.missionId, independent.id),
				inputs: f.inputs.length,
			}),
		);
	}
	for (const socket of sockets) socket.terminate();
	process.stdin.destroy();
	for (const client of wss.clients) client.terminate();
	proxy.closeAllConnections();
	proxy.close();
	wss.close();
});
