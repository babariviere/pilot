import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { TERMINAL_REPLAY_BYTES, TerminalScrollback, terminalChunks, terminalSender } from "./terminal-output.ts";

test("scrollback and frames bound real UTF-8 bytes including oversized chunks and tiny-output storms", () => {
	const buffer = new TerminalScrollback();
	buffer.append("🙂".repeat(TERMINAL_REPLAY_BYTES));
	assert.ok(Buffer.byteLength(buffer.output) <= TERMINAL_REPLAY_BYTES);
	assert.ok(!buffer.output.includes("�"));
	const value = "é🙂\u0000".repeat(10_000);
	const chunks = [...terminalChunks(value)];
	assert.equal(chunks.join(""), value);
	assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 16 * 1024));
	for (let i = 0; i < 10_000; i++) buffer.append("x");
	assert.equal(buffer.output.length, 4096);
});
class Socket extends EventEmitter {
	terminated = false;
	OPEN = 1;
	readyState = 1;
	sent: string[] = [];
	callbacks: ((error?: Error) => void)[] = [];
	closes: number[] = [];
	send(data: string, callback: (error?: Error) => void) {
		this.sent.push(data);
		this.callbacks.push(callback);
	}
	close(code: number) {
		this.closes.push(code);
	}
	terminate() {
		this.terminated = true;
		this.emit("close");
	}
}
test("replay is lazy and ordered, with one native send and bounded stalled-consumer queues", () => {
	const socket = new Socket(),
		sender = terminalSender(socket as unknown as WebSocket, "session");
	sender.message({ type: "terminal.ready" });
	sender.data("\u0000".repeat(TERMINAL_REPLAY_BYTES));
	sender.data("live");
	assert.equal(socket.sent.length, 1);
	while (socket.callbacks.length) socket.callbacks.shift()!();
	assert.ok(socket.sent.every((frame) => Buffer.byteLength(frame) <= 128 * 1024));
	assert.equal(JSON.parse(socket.sent.at(-1)!).data, "live");
	sender.data("x".repeat(TERMINAL_REPLAY_BYTES));
	sender.data("x".repeat(TERMINAL_REPLAY_BYTES));
	assert.deepEqual(socket.closes, [1013]);
	socket.emit("close");
});

test("oversized control frames and stalled closes release the terminal socket after bounded grace", async () => {
	const socket = new Socket();
	terminalSender(socket as unknown as WebSocket, "session", 10).message({ error: "x".repeat(128 * 1024) });
	assert.deepEqual(socket.closes, [1013]);
	assert.deepEqual(socket.sent, []);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(socket.terminated, true);
});
