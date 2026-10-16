import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const { WebSocketServer } = createRequire(import.meta.url)("../../Tests/Fixtures/loopback-websocket.cjs");

function masked(opcode, payload, fin = true) {
	const bytes = Buffer.from(payload), mask = randomBytes(4);
	const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length <= 65535 ? 4 : 10);
	header[0] = (fin ? 0x80 : 0) | opcode;
	if (header.length === 2) header[1] = 0x80 | bytes.length;
	else if (header.length === 4) { header[1] = 0xfe; header.writeUInt16BE(bytes.length, 2); }
	else { header[1] = 0xff; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
	const result = Buffer.alloc(bytes.length);
	for (let i = 0; i < bytes.length; i++) result[i] = bytes[i] ^ mask[i % 4];
	return Buffer.concat([header, mask, result]);
}
async function raw(port) {
	const socket = connect(port, "127.0.0.1");
	let pending = Buffer.alloc(0), failed;
	socket.on("data", (chunk) => { pending = Buffer.concat([pending, chunk]); });
	socket.on("error", (error) => { failed = error; });
	async function until(check) {
		const deadline = Date.now() + 2000;
		while (!check()) {
			if (failed) throw failed;
			assert.ok(Date.now() < deadline, "fixture frame did not arrive");
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
	}
	await once(socket, "connect");
	socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`);
	await until(() => pending.indexOf("\r\n\r\n") >= 0);
	const end = pending.indexOf("\r\n\r\n");
	assert.match(pending.subarray(0, end).toString(), /^HTTP\/1.1 101/);
	pending = pending.subarray(end + 4);
	return {
		socket,
		async frame() {
			await until(() => pending.length >= 2);
			const opcode = pending[0] & 15;
			assert.equal(pending[1] & 0x80, 0, "server frames are not masked");
			let length = pending[1] & 127, offset = 2;
			if (length === 126) { await until(() => pending.length >= 4); length = pending.readUInt16BE(2); offset = 4; }
			else if (length === 127) { await until(() => pending.length >= 10); length = Number(pending.readBigUInt64BE(2)); offset = 10; }
			assert.ok(length <= 128 * 1024);
			await until(() => pending.length >= offset + length);
			const payload = pending.subarray(offset, offset + length);
			pending = pending.subarray(offset + length);
			return { opcode, payload };
		},
	};
}
async function server(t) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	t.after(() => new Promise((resolve) => server.close(resolve)));
	await once(server, "listening"); return server;
}

test("stdlib helper handles masked/fragmented UTF-8, extended lengths, ping/pong and close", { timeout: 5000 }, async (t) => {
	const ws = await server(t);
	ws.on("connection", (peer) => peer.on("message", (body, binary) => peer.send(binary ? body : body.toString())));
	const connection = once(ws, "connection"), client = await raw(ws.address().port);
	t.after(() => client.socket.destroy());
	const [peer] = await connection;
	const text = Buffer.from("🙂 café");
	const first = masked(1, text.subarray(0, 3), false);
	client.socket.write(first.subarray(0, 1)); client.socket.write(first.subarray(1));
	client.socket.write(masked(9, "ping")); client.socket.write(masked(0, text.subarray(3)));
	const pong = await client.frame(); assert.equal(pong.opcode, 10); assert.equal(pong.payload.toString(), "ping");
	assert.equal((await client.frame()).payload.toString(), text.toString());
	const serverPong = once(peer, "pong");
	peer.ping("server"); assert.equal((await client.frame()).opcode, 9);
	client.socket.write(masked(10, "server")); await serverPong;
	client.socket.write(masked(1, "x".repeat(66000)));
	assert.equal((await client.frame()).payload.length, 66000);
	const closed = once(peer, "close");
	peer.close(1013, "fixture reconnect");
	assert.equal((await client.frame()).payload.readUInt16BE(0), 1013);
	client.socket.end(); await closed;
	assert.equal(ws.clients.size, 0);
});

test("stdlib helper accepts global WebSocket Buffer/Uint8Array binary sends and bounded binary fragments", { timeout: 5000 }, async (t) => {
	const ws = await server(t), received = [];
	ws.on("connection", (peer) => peer.on("message", (body, binary) => { received.push(binary); peer.send(binary ? body : body.toString()); }));
	const client = new globalThis.WebSocket(`ws://127.0.0.1:${ws.address().port}`);
	client.binaryType = "arraybuffer";
	t.after(() => client.close());
	await once(client, "open");
	for (const bytes of [Buffer.from([0, 255, 128, 1]), new Uint8Array([255, 0, 2])]) {
		const response = once(client, "message"); client.send(bytes);
		assert.deepEqual(new Uint8Array((await response)[0].data), new Uint8Array(bytes));
	}
	assert.deepEqual(received, [true, true]);
	const fragmented = await raw(ws.address().port);
	t.after(() => fragmented.socket.destroy());
	fragmented.socket.write(masked(2, Buffer.from([255, 0]), false));
	fragmented.socket.write(masked(0, Buffer.from([128, 1])));
	const echo = await fragmented.frame(); assert.equal(echo.opcode, 2);
	assert.deepEqual(echo.payload, Buffer.from([255, 0, 128, 1]));
	fragmented.socket.write(masked(2, Buffer.alloc(70000), false));
	fragmented.socket.write(masked(0, Buffer.alloc(70000)));
	assert.equal((await fragmented.frame()).payload.readUInt16BE(0), 1009);
});

test("stdlib helper rejects unmasked, oversized, malformed-fragment and invalid UTF-8 frames", { timeout: 5000 }, async (t) => {
	const ws = await server(t);
	const oversized = Buffer.alloc(14); oversized[0] = 0x81; oversized[1] = 0xff; oversized.writeBigUInt64BE(131073n, 2);
	for (const [bytes, code] of [
		[Buffer.from([0x81, 1, 120]), 1002], [oversized, 1009], [masked(0, "no text start"), 1002],
		[masked(9, "fragmented ping", false), 1002], [masked(1, Buffer.from([255])), 1007],
	]) {
		const client = await raw(ws.address().port);
		client.socket.write(bytes);
		assert.equal((await client.frame()).payload.readUInt16BE(0), code);
		client.socket.destroy();
	}
	assert.throws(() => new WebSocketServer({ host: "0.0.0.0" }), /loopback/);
});

test("terminal fixture runs from an isolated directory without node_modules or NODE_PATH", { timeout: 5000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-stdlib-terminal-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const file of ["loopback-websocket.cjs", "workspace-terminal.cjs"])
		await copyFile(new URL(`../../Tests/Fixtures/${file}`, import.meta.url), join(directory, file));
	const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
	const child = spawn(process.execPath, [join(directory, "workspace-terminal.cjs"), directory, "current"], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
	const exited = once(child, "exit");
	t.after(async () => {
		const fallback = setTimeout(() => child.kill("SIGKILL"), 1500); fallback.unref();
		child.stdin.end(); await exited; clearTimeout(fallback);
	});
	const lines = createInterface({ input: child.stdout });
	t.after(() => lines.close());
	const port = Number((await lines[Symbol.asyncIterator]().next()).value);
	assert.ok(port > 0);
	const first = new WebSocket(`ws://127.0.0.1:${port}`);
	t.after(() => first.close());
	const [hello] = await once(first, "message");
	const request = JSON.stringify({ type: "terminal.open", bootId: JSON.parse(hello.data).bootId, requestId: "stable" });
	first.send(request);
	assert.equal((await once(first, "close"))[0].code, 1013);
	const second = new WebSocket(`ws://127.0.0.1:${port}`);
	t.after(() => second.close());
	await once(second, "message"); second.send(request);
	assert.equal(JSON.parse((await once(second, "message"))[0].data).type, "terminal.ready");
	second.send(JSON.stringify({ type: "terminal.input", data: "once" }));
	const stats = JSON.parse(JSON.parse((await once(second, "message"))[0].data).data);
	assert.equal(stats.opens[0].requestId, stats.opens[1].requestId); assert.deepEqual(stats.inputs, ["once"]);
	second.send(JSON.stringify({ type: "terminal.close" }));
	assert.equal(JSON.parse((await once(second, "message"))[0].data).type, "terminal.exit");
});

test("fixture lifetime is parent-EOF owned, with a bounded orphan watchdog and resource cleanup", { timeout: 5000 }, async () => {
	const helper = fileURLToPath(new URL("../../Tests/Fixtures/loopback-websocket.cjs", import.meta.url));
	for (const mode of ["eof", "orphan"]) {
		const code = `const {ownFixtureLifetime}=require(${JSON.stringify(helper)}); ownFixtureLifetime(()=>new Promise(resolve=>process.stdout.write('closed\\n',resolve)),${mode === "eof" ? 180000 : 30}); process.stdout.write('ready\\n');`;
		const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "inherit"] });
		const exited = once(child, "exit"), lines = createInterface({ input: child.stdout }), iterator = lines[Symbol.asyncIterator]();
		const fallback = setTimeout(() => child.kill("SIGKILL"), 2000); fallback.unref();
		try {
			assert.equal((await iterator.next()).value, "ready");
			if (mode === "eof") { assert.equal(child.exitCode, null); child.stdin.end(); }
			assert.equal((await iterator.next()).value, "closed");
			assert.deepEqual(await exited, [0, null]);
		} finally { lines.close(); child.kill("SIGKILL"); await exited; clearTimeout(fallback); }
	}
});
