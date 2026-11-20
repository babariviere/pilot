// Disposable real HTTP/WebSocket fixture. Node stdlib only, no PTY/accounts/persistent state.
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { writeSync } = require("node:fs");
const { WebSocketServer, ownFixtureLifetime } = require("./loopback-websocket.cjs");
let boot = randomUUID(), terminal, dropped = false, connections = 0;
const opens = [], inputs = [];
function startupFailure(code) {
	// Fixed diagnostics only. Never echo paths, environment values or arbitrary exception bodies.
	try { writeSync(2, `PILOT_TERMINAL_FIXTURE_STARTUP:${code}\n`); } catch {}
	process.exit(78);
}
const http = createServer((req, res) => {
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(req.url === "/api/stats" ? { connections, opens, inputs } : {
		daemonId: "fixture", lineageId: "fixture", daemonVersion: "0.0.0", protocolVersion: 1,
		minimumClientProtocolVersion: 1, platform: "linux", arch: "x64",
		capabilities: { powerManagement: false, systemSleepEvents: false, swiftUIArtifacts: false,
			coordinatorIsolation: false, independentExecution: true,
			...(process.argv[3] === "legacy" ? {} : { workspaceTerminalProtocol: 2 }) }
	}));
});
const server = new WebSocketServer({ server: http });
http.on("error", (error) => startupFailure(error.code === "EADDRINUSE" ? "listen-address-in-use" : "listen-failed"));
http.listen(0, "127.0.0.1", () => process.stdout.write(`${http.address().port}\n`));
server.on("connection", (ws) => {
	connections++;
	const send = (type, fields) => ws.send(JSON.stringify({ type, sessionId: "same", ...fields }));
	send("terminal.hello", { bootId: boot, terminalId: terminal });
	ws.on("message", (raw) => {
		let message;
		try { message = JSON.parse(String(raw)); } catch { ws.close(1007, "Invalid fixture JSON"); return; }
		if (message?.type === "terminal.open") {
			if (opens.length >= 8) { ws.close(1008, "Fixture open capacity"); return; }
			opens.push(message); terminal ??= randomUUID();
			if (!dropped) { dropped = true; ws.close(1013, "lost first reply"); return; }
			send("terminal.ready", { terminalId: terminal });
		} else if (message?.type === "terminal.input" && typeof message.data === "string") {
			if (inputs.length >= 8 || Buffer.byteLength(message.data) > 16 * 1024) { ws.close(1009, "Fixture input capacity"); return; }
			inputs.push(message.data);
			if (message.data === "reboot") { boot = randomUUID(); ws.close(1013, "daemon replaced"); return; }
			send("terminal.data", { data: JSON.stringify({ opens, inputs }) });
		} else if (message?.type === "terminal.close") send("terminal.exit", { code: 0 });
		else ws.close(1008, "Unknown fixture message");
	});
});
ownFixtureLifetime(() => new Promise((resolve) => { server.close(); http.close(resolve); }));
