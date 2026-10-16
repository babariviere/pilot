import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

async function fixture(t: TestContext, label: string) {
	const home = await mkdtemp(join(tmpdir(), `pilot terminal ${label} '$(); `));
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects);
	t.mock.method(sessions, "assertWritable", () => {});
	t.mock.method(sessions, "changeBase", () => ({ cwd: home }));
	const terminals = new TerminalManager(() => ({ file: "/bin/sh", args: [] }));
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const socket of sockets) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	async function connect() {
		const ws = new WebSocket(
			`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/same/terminal/ws?protocol=2&cols=80&rows=24`,
		);
		sockets.push(ws);
		const messages: { type: string; [key: string]: unknown }[] = [];
		let failure: Error | undefined;
		ws.on("error", (error) => {
			failure = error;
		});
		ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		async function next(type: string) {
			const deadline = Date.now() + 4000;
			while (!messages.some((message) => message.type === type)) {
				if (failure) throw failure;
				assert.ok(Date.now() < deadline, `waiting for ${type}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const index = messages.findIndex((message) => message.type === type);
			return messages.splice(index, 1)[0]!;
		}
		const hello = await next("terminal.hello");
		return { ws, hello, next, messages, send: (message: object) => ws.send(JSON.stringify(message)) };
	}
	return { home, terminals, server, connect };
}

test("two host endpoints with colliding session IDs run in their own literal workspace and reconnect without restarting", {
	timeout: 15_000,
}, async (t) => {
	const local = await fixture(t, "local"),
		remote = await fixture(t, "remote");
	const a = await local.connect(),
		b = await remote.connect();
	const request = { type: "terminal.open", bootId: remote.terminals.bootId, requestId: randomUUID(), restart: true };
	a.send({ type: "terminal.open", bootId: local.terminals.bootId, requestId: randomUUID() });
	b.send(request);
	const aId = String((await a.next("terminal.ready")).terminalId),
		bId = String((await b.next("terminal.ready")).terminalId);
	a.send({ type: "terminal.input", terminalId: aId, data: "printf '__cwd__%s__end__\\n' \"$PWD\"\r" });
	b.send({ type: "terminal.input", terminalId: bId, data: "printf '__cwd__%s__end__\\n' \"$PWD\"\r" });
	async function output(client: typeof a, expected: string) {
		let result = "";
		while (!result.includes(expected)) result += String((await client.next("terminal.data")).data);
		return result;
	}
	assert.ok((await output(a, `__cwd__${local.home}__end__`)).includes(local.home));
	await output(b, `__cwd__${remote.home}__end__`);
	b.ws.close();
	await once(b.ws, "close");
	assert.ok(remote.terminals.isRunning("same"));
	const reconnect = await remote.connect();
	reconnect.send(request);
	assert.equal((await reconnect.next("terminal.ready")).terminalId, bId);
	await output(reconnect, `__cwd__${remote.home}__end__`);
	assert.equal(local.terminals.currentId("same"), aId);
	const freeze = remote.server.runtimeResources.freezeAdmissions();
	const refused = await remote.connect();
	refused.send({
		type: "terminal.open",
		bootId: remote.terminals.bootId,
		requestId: randomUUID(),
		restart: true,
		terminalId: bId,
	});
	const [code] = await once(refused.ws, "close");
	assert.equal(code, 1013);
	assert.equal(remote.terminals.currentId("same"), bId);
	assert.ok((await remote.server.runtimeResources.blockers()).some((blocker) => blocker.kind === "terminal"));
	freeze();
	reconnect.send({ type: "terminal.input", terminalId: randomUUID(), data: "must not run\r" });
	assert.match(String((await reconnect.next("error")).message), /instance/);
	reconnect.send({ type: "terminal.input", terminalId: bId, data: "é".repeat(16 * 1024) });
	assert.match(String((await reconnect.next("error")).message), /Invalid/);
	reconnect.send({ type: "terminal.close", terminalId: bId });
	await reconnect.next("terminal.exit");
	assert.equal(remote.terminals.isRunning("same"), false);
	assert.equal(local.terminals.isRunning("same"), true);
});

test("wrong daemon boot cannot recreate a lost shell and pre-handshake sockets are capped", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, "boot");
	const wrong = await f.connect();
	const wrongClosed = once(wrong.ws, "close");
	wrong.send({ type: "terminal.open", bootId: randomUUID(), requestId: randomUUID() });
	assert.match(String((await wrong.next("error")).message), /daemon restarted/);
	await wrongClosed;
	assert.equal(f.terminals.isRunning("same"), false);
	for (let i = 0; i < 64; i++) await f.connect();
	await assert.rejects(f.connect(), /socket hang up|Unexpected server response|ECONNRESET/);
});

test("the Swift loopback fixture supports lost-reply retry and older-runtime negotiation", {
	timeout: 10_000,
}, async () => {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	for (const mode of ["legacy", "current"]) {
		const child = spawn(
			process.execPath,
			[join(root, "apps/macos/Tests/Fixtures/workspace-terminal.cjs"), root, mode],
			{ stdio: ["pipe", "pipe", "inherit"] },
		);
		const exited = once(child, "exit");
		const lines = createInterface({ input: child.stdout });
		try {
			const line = await lines[Symbol.asyncIterator]().next();
			const port = Number(line.value);
			assert.ok(port > 0);
			const base = `http://127.0.0.1:${port}`;
			const hello = await (await fetch(`${base}/api/hello`)).json();
			assert.equal(hello.capabilities.workspaceTerminalProtocol, mode === "current" ? 2 : undefined);
			if (mode === "current") {
				const first = new WebSocket(base.replace("http:", "ws:"));
				const greeting = JSON.parse(String((await once(first, "message"))[0]));
				const request = JSON.stringify({ type: "terminal.open", bootId: greeting.bootId, requestId: randomUUID() });
				first.send(request);
				await once(first, "close");
				const second = new WebSocket(base.replace("http:", "ws:"));
				await once(second, "message");
				second.send(request);
				assert.equal(JSON.parse(String((await once(second, "message"))[0])).type, "terminal.ready");
				second.send(JSON.stringify({ type: "terminal.input", data: "once" }));
				const response = JSON.parse(String((await once(second, "message"))[0]));
				const stats = JSON.parse(response.data);
				assert.equal(stats.opens[0].requestId, stats.opens[1].requestId);
				assert.deepEqual(stats.inputs, ["once"]);
				second.close();
				await once(second, "close");
			} else assert.equal((await (await fetch(`${base}/api/stats`)).json()).connections, 0);
		} finally {
			lines.close();
			child.kill("SIGTERM");
			await exited;
		}
	}
});
