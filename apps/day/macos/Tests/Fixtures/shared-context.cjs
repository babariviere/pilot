// Disposable real HTTP/control-WebSocket fixture, no daemon state, accounts or workspace.
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { isDeepStrictEqual } = require("node:util");
const { WebSocketServer, ownFixtureLifetime } = require("./loopback-websocket.cjs");
const identity = (name) => ({ hostId: "daemon", daemonId: name, lineageId: `${name}-lineage` });
const binding = {
	schemaVersion: 1, bindingId: "shared-binding", generation: 1, logicalProjectId: "logical",
	memoryHome: { host: identity("home"), projectId: "same" }, missionHome: identity("home"),
	executionProject: { host: identity("target"), projectId: "same" },
	missionIds: ["same"], shareMemory: true, state: "active",
};
const summary = { binding, freshness: { applied: { memory: 0, mission: 0 }, complete: true, pendingCount: 0, conflictCount: 0 }, grants: [] };
const outgoing = { home: [], target: [] }, receipts = new Map(), requests = [], acknowledgments = [], sockets = new Set();
const transmitted = new Set(), notifications = [];
const inventoryWaiters = new Map(), receiptWaiters = new Map();
const servers = [];
let stopping = false;
let next = 1, loseReply = false;
function nextObservation(waiters, key) {
	if (stopping) throw Error("fixture stopped");
	if (waiters.size >= 32 || waiters.has(key)) throw Error("fixture observation capacity");
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { waiters.delete(key); reject(Error("fixture observation deadline")); }, 120_000);
		timer.unref();
		waiters.set(key, () => { clearTimeout(timer); waiters.delete(key); resolve(); });
	});
}
function observed(waiters, key) { waiters.get(key)?.(); }
function signal(phase, operationId) {
	if (stopping) return;
	if (notifications.length >= 128) throw Error("fixture notification capacity");
	notifications.push({ phase, operationId });
	for (const ws of sockets) ws.send(JSON.stringify({ type: "shared-contexts.changed" }));
}
function envelope(origin, destination, operationId, sequence, payload, kind) {
	return { schemaVersion: 1, operationId, producerId: `${origin}-producer`, sequence,
		origin: identity(origin), destination: identity(destination), kind, targetId: "same", payload,
		payloadHash: createHash("sha256").update(payload).digest("hex"), bindingId: binding.bindingId, bindingGeneration: 1 };
}
function enqueue() {
	if (next > 4 || outgoing.home.length >= 8) throw Error("fixture outbox capacity");
	const sequence = next++, payload = `{ "source": "daemon", "sequence": ${sequence} }`;
	const operation = envelope("home", "target", `original-${sequence}`, sequence, payload, "share-memory-page");
	outgoing.home.push(operation);
	signal("canonical-append", operation.operationId);
}
async function start(name) {
	const http = createServer(async (req, res) => {
		try {
			const chunks = []; let bytes = 0;
			for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw Error("oversized"); chunks.push(chunk); }
			const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : {};
			const reply = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
			if (req.url === "/fixture/stats") return reply({ requests, acknowledgments, notifications,
				outstanding: outgoing.home.length + outgoing.target.length,
				outstandingByHost: { home: outgoing.home.length, target: outgoing.target.length } });
			if (req.url === "/fixture/enqueue") { enqueue(); return reply({ ok: true }); }
			if (req.url === "/fixture/lost-reply") { loseReply = true; enqueue(); return reply({ ok: true }); }
			if (req.url === "/fixture/reconnect") { for (const ws of sockets) ws.close(1013, "fixture reconnect"); return reply({ ok: true }); }
			if (req.url === "/fixture/barrier") {
				// Ordered after all preceding invalidations on each control connection.
				for (const ws of sockets) ws.send(JSON.stringify({ type: "sessions", sessions: [] }));
				return reply({ ok: true });
			}
			if (req.url === "/api/hello") return reply({ daemonId: name, lineageId: `${name}-lineage`, daemonVersion: "test", protocolVersion: 1,
				minimumClientProtocolVersion: 1, platform: "linux", arch: "x64", capabilities: { powerManagement: false, systemSleepEvents: false,
					swiftUIArtifacts: false, coordinatorIsolation: true, independentExecution: true } });
			if (requests.length >= 1024) throw Error("fixture request capacity");
			requests.push({ name, path: req.url, operationId: body.operationId, payload: body.payload, peer: body.peer });
			if (req.url === "/api/shared-contexts") { observed(inventoryWaiters, name); return reply([summary]); }
			if (req.url === "/api/shared-contexts/shared-binding/exchange") {
				if (body.peer?.hostId !== "daemon") { res.writeHead(400); return reply({ error: "alias is not a daemon identity" }); }
				const page = outgoing[name].slice(0, 16);
				for (const operation of page) {
					// A durable false -> true transmission fence emits once, not on every read.
					if (!transmitted.has(operation.operationId)) {
						const observation = nextObservation(inventoryWaiters, name);
						transmitted.add(operation.operationId); signal("transmit-fence", operation.operationId);
						await observation; // Fresh reconciliation proves the invalidation overtook this response.
					}
				}
				return reply({ bindingId: binding.bindingId, generation: 1, operations: page, more: outgoing[name].length > 16 });
			}
			if (req.url === "/api/shared-contexts/shared-binding/ack") {
				const index = outgoing[name].findIndex((op) => op.operationId === body.operation.operationId);
				if (index >= 0 && isDeepStrictEqual(receipts.get(body.operation.operationId), body.receipt)) {
					acknowledgments.push(body.operation.operationId); outgoing[name].splice(index, 1);
					signal("source-ack", body.operation.operationId);
				}
				return reply({ ok: true });
			}
			if (req.url === "/api/operations/receipt") {
				const receipt = receipts.get(body.operationId) ?? { state: "unknown" };
				reply(receipt);
				if (receipt.state === "pending") observed(receiptWaiters, body.operationId);
				return;
			}
			if (req.url === "/api/operations") {
				if (receipts.has(body.operationId)) return reply(receipts.get(body.operationId));
				if (receipts.size >= 16) throw Error("fixture receipt capacity");
				const receipt = { operationId: body.operationId, payloadHash: body.payloadHash, destination: body.destination,
					targetId: body.targetId, state: "accepted", result: { state: "conflict" } };
				const observation = nextObservation(receiptWaiters, body.operationId);
				receipts.set(body.operationId, { ...receipt, state: "pending" });
				signal("receipt-pending", body.operationId);
				await observation; // Finalize only after a receipt-first reader has observed pending.
				receipts.set(body.operationId, receipt);
				if (name === "target") {
					const operation = envelope("target", "home", `fact-${body.operationId}`, body.sequence,
						JSON.stringify({ resultFor: body.operationId }), "share-event");
					outgoing.target.push(operation); signal("factual-append", operation.operationId);
				}
				// Finalization is a distinct notification after the receipt is durably conclusive.
				signal("receipt-final", body.operationId);
				if (loseReply && name === "target") { loseReply = false; res.destroy(); return; }
				return reply(receipt);
			}
			res.writeHead(404); reply({ error: "Not found" });
		} catch { res.writeHead(400); res.end("{}"); }
	});
	const server = new WebSocketServer({ server: http });
	servers.push({ server, http });
	server.on("connection", (ws) => {
		sockets.add(ws); ws.on("close", () => sockets.delete(ws));
		for (const type of ["sessions", "projects", "missions"]) ws.send(JSON.stringify({ type, [type]: [] }));
	});
	await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
	return http.address().port;
}
Promise.all([start("home"), start("target")]).then(([home, target]) => process.stdout.write(`${JSON.stringify({ home, target })}\n`));
// Parent-owned stdin EOF/SIGTERM cleanup and the common bounded 180-second orphan guard.
ownFixtureLifetime(async () => {
	stopping = true;
	for (const waiters of [inventoryWaiters, receiptWaiters]) for (const finish of waiters.values()) finish();
	await Promise.all(servers.map(({ server, http }) => new Promise((resolve) => {
		server.close(); http.close(resolve); http.closeAllConnections();
	})));
});
