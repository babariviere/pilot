/** Real native creation journey. Temporary profile, production daemon and forked faux kernel only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DurableOperation } from "@pilot/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { planningWorkerFixture } from "../planning-workers.fixture.ts";

const f = await planningWorkerFixture(undefined, { journey: process.argv.includes("--journey") });
// Hold the actual first provider response, not a fabricated admission receipt.
const releaseFile = join(f.root, "release-generation");
const extension = join(f.root, "agent", "offline.ts");
const waitCode = `
import { watch, existsSync } from 'node:fs';
const waitForGeneration = signal => new Promise((resolve, reject) => {
 const file=${JSON.stringify(releaseFile)};
 if (existsSync(file)) return resolve();
 const finish = error => { watcher.close(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
 const abort = () => finish(new Error('Fixture generation cancelled'));
 const watcher=watch(${JSON.stringify(f.root)}, () => { if(existsSync(file)) finish(); });
 signal?.addEventListener('abort', abort, {once:true});
 if(signal?.aborted) abort(); else if(existsSync(file)) finish();
});
`;
await writeFile(
	extension,
	waitCode +
		(await readFile(extension, "utf8"))
			.replace("async transcript =>", "async (transcript, options) =>")
			.replace("{ appendFileSync(", "{ if(n===0) await waitForGeneration(options?.signal); appendFileSync("),
);
const ledger = join(f.home, "commands.jsonl");
let posts = 0,
	lookups = 0,
	profiles = 0;
let lost = false,
	missing = false,
	mismatch = "",
	unavailable = false,
	wrongProject = false;
let dropBefore = false;
let changeAfterJournal = false,
	blockPost = false,
	blockPlanRead = false;
let release: (() => void) | undefined, entered: (() => void) | undefined;
let enrollment: DurableOperation | undefined;
let missionId: string | undefined;
const sockets = new Set<WebSocket>();
let forwardEvents = true;
let holdEvents = false;
const retainedEvents: Array<{ client: WebSocket; body: string }> = [];
let readOutage = false,
	readDenied = false,
	holdDay = false;
let dayRelease: (() => void) | undefined, dayEntered: (() => void) | undefined;
let effects = 0;
const wss = new WebSocketServer({ noServer: true });
const proxy = createServer(async (req, res) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		const attentionRead = req.url === "/api/native-attention" && JSON.parse(bytes.toString() || "{}").kind === "read";
		if (req.method !== "GET" && !attentionRead) effects++;
		const read = req.url?.endsWith("/day") || req.url?.endsWith("/planning-inventory") || attentionRead;
		if (read && (readOutage || readDenied)) {
			res.writeHead(readDenied ? 403 : 503).end();
			return;
		}
		const writing = req.url === "/api/operations" && req.method === "POST";
		const profile = req.url?.endsWith("/planning-profile");
		if (profile) {
			profiles++;
			if (unavailable) {
				res.writeHead(503).end();
				return;
			}
			if (changeAfterJournal && (await readFile(ledger, "utf8").catch(() => "")).trim()) {
				changeAfterJournal = false;
				await f.projectUpdate();
			}
		}
		if (writing) {
			posts++;
			const op = JSON.parse(bytes.toString()) as DurableOperation;
			const records = (await readFile(ledger, "utf8"))
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			assert.ok(
				records.some((r) => JSON.stringify(r.operation) === JSON.stringify(op)),
				"fsynced exact native intent precedes POST",
			);
			if (op.kind === "planning-enroll") {
				enrollment = op;
				const request = JSON.parse(op.payload);
				assert.equal(f.sessions.get(request.ownerSessionId), undefined, "new owner, never adopted");
				const discovery = await fetch(`${f.base}/api/projects/${f.project.id}/planning-profile`, {
					headers: { "x-pilot-github-capability": f.capability },
				}).then((r) => r.json());
				assert.deepEqual(request.profile, discovery.profile);
				assert.equal(request.configurationDigest, discovery.configurationDigest);
				assert.equal(op.bindingId, discovery.configurationDigest);
				assert.equal(request.projectId, f.project.id);
				assert.equal(request.model, "faux/faux-1");
			}
		}
		if (req.url === "/api/operations/receipt") {
			lookups++;
			if (missing) {
				res.end(JSON.stringify({ state: "unknown" }));
				return;
			}
		}
		if (writing && dropBefore) {
			dropBefore = false;
			req.socket.destroy();
			return;
		}
		const response = await fetch(`${f.base}${req.url}`, {
			method: req.method,
			headers: {
				"content-type": "application/json",
				"x-pilot-github-capability": String(req.headers["x-pilot-github-capability"] ?? ""),
			},
			...(bytes.length ? { body: bytes } : {}),
		});
		const body = await response.json();
		if (holdDay && req.url?.endsWith("/day")) {
			holdDay = false;
			await new Promise<void>((resolve) => {
				dayRelease = resolve;
				dayEntered?.();
			});
			dayRelease = undefined;
		}
		if (writing && body.state === "accepted" && enrollment?.operationId === body.operationId)
			missionId = body.result.missionId;
		if (wrongProject && req.url === `/api/projects/${f.project.id}`) body.path = `${body.path}/different`;
		if ((writing && blockPost) || (blockPlanRead && req.method === "GET" && req.url?.endsWith("/planning"))) {
			blockPost = false;
			blockPlanRead = false;
			await new Promise<void>((r) => {
				release = r;
				entered?.();
			});
		}
		if (writing && lost) {
			lost = false;
			req.socket.destroy();
			return;
		}
		if (req.url === "/api/operations/receipt" && mismatch) {
			if (mismatch === "owner") body.result.ownerSessionId = randomUUID();
			else if (mismatch === "enrollment") body.result.enrollmentId = randomUUID();
			else body.payloadHash = "mismatch";
		}
		res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
	} catch (error) {
		console.error(error);
		res.writeHead(500).end();
	}
});
proxy.on("upgrade", (req, socket, head) => {
	wss.handleUpgrade(req, socket, head, (client) => {
		const upstream = new WebSocket(`${f.base.replace("http:", "ws:")}${req.url}`);
		sockets.add(upstream);
		upstream.on("message", (bytes) => {
			if (holdEvents) {
				assert.ok(retainedEvents.length < 128, "bounded terminal WS ordering fixture");
				retainedEvents.push({ client, body: bytes.toString() });
				return;
			}
			if (forwardEvents && client.readyState === WebSocket.OPEN) client.send(bytes.toString());
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
	}),
);
try {
	for await (const line of createInterface({ input: process.stdin })) {
		const command = JSON.parse(line);
		if (command.action === "read-outage") readOutage = command.value;
		if (command.action === "read-denied") readDenied = command.value;
		if (command.action === "hold-day") holdDay = command.value;
		if (command.action === "day-entered" && !dayRelease)
			await new Promise<void>((resolve) => {
				dayEntered = resolve;
			});
		if (command.action === "release-day") dayRelease?.();
		if (command.action === "notice")
			for (const client of wss.clients) client.send(JSON.stringify({ type: "mission-catalog.changed" }));
		if (command.action === "lost") lost = command.value;
		if (command.action === "quiet") forwardEvents = !command.value;
		if (command.action === "hold-events") {
			holdEvents = command.value;
			if (!holdEvents)
				for (const event of retainedEvents.splice(0)) {
					if (event.client.readyState === WebSocket.OPEN) event.client.send(event.body);
				}
		}
		if (command.action === "drop-before") dropBefore = command.value;
		if (command.action === "missing") missing = command.value;
		if (command.action === "mismatch") mismatch = command.value ? (command.detail ?? "hash") : "";
		if (command.action === "unavailable") unavailable = command.value;
		if (command.action === "project") wrongProject = command.value;
		if (command.action === "change-after-journal") changeAfterJournal = command.value;
		if (command.action === "configuration") await f.projectUpdate();
		if (command.action === "block") blockPost = command.value;
		if (command.action === "block-plan-read") blockPlanRead = command.value;
		if (command.action === "entered" && !release)
			await new Promise<void>((r) => {
				entered = r;
			});
		if (command.action === "release") {
			release?.();
			release = undefined;
		}
		if (command.action === "generate") await writeFile(releaseFile, "go");
		const id = missionId;
		const owner = id && f.store.planningWorkers.get(id)?.binding.ownerSessionId;
		if (command.action === "held")
			await f.changed(
				() => !!id && f.store.planningWorkers.get(id)?.phase === "held" && f.sessions.get(owner!)?.state === "idle",
			);
		if (command.action === "published")
			await f.changed(
				() =>
					!!id && f.store.planningWorkers.get(id)?.phase === "active" && f.sessions.get(owner!)?.state === "idle",
			);
		if (command.action === "reported")
			await f.changed(
				() =>
					!!id &&
					f.service.reports.latest(id).length === 1 &&
					f.sessions.get(f.store.planningWorkers.get(id)?.start?.sessionId ?? "")?.state === "idle",
			);
		if (command.action === "owner" && id) f.store.update(id, { coordinatorSessionId: null });
		if (command.action === "stop" && owner) await f.sessions.stop(owner);
		if (command.action === "pause" && id && owner)
			await f.service.controls.execute(id, {
				version: 1,
				action: "pause",
				operationId: randomUUID(),
				home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId! },
				projectId: f.project.id,
				coordinatorSessionId: owner,
				expectedRevision: 0,
			});
		if (command.action === "drain") await f.server.closePlanning();
		if (command.action === "restart") {
			for (const socket of sockets) socket.close();
			await f.restart();
		}
		if (command.action === "close" || command.action === "quit") {
			console.log(JSON.stringify({ closing: true }));
			break;
		}
		console.log(
			JSON.stringify({
				posts,
				effects,
				lookups,
				profiles,
				held: !!release,
				heldEvents: retainedEvents.length,
				requests: await f.requestCount(),
				mission: id,
				owner,
				enrollment: enrollment?.targetId,
				goal: enrollment && JSON.parse(enrollment.payload).goal,
				tasks: id ? f.store.tasks(id).length : 0,
				workers: f.specs.length,
			}),
		);
	}
} finally {
	dayRelease?.();
	release?.();
	for (const socket of sockets) socket.close();
	for (const client of wss.clients) client.close();
	proxy.closeAllConnections();
	await new Promise<void>((r) => proxy.close(() => r()));
	wss.close();
	await f.close();
	process.stdin.destroy();
}
