import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type BackpressureSocket, boundedSender } from "./backpressure.ts";

class Socket extends EventEmitter implements BackpressureSocket {
	readonly OPEN = 1;
	readyState = 1;
	bufferedAmount = 0;
	readonly sent: string[] = [];
	readonly callbacks: Array<(error?: Error) => void> = [];
	readonly closes: Array<[number, string]> = [];
	terminated = false;
	send(data: string, callback: (error?: Error) => void): void {
		this.sent.push(data);
		this.callbacks.push(callback);
	}
	close(code: number, reason: string): void {
		this.closes.push([code, reason]);
		this.readyState = 2;
	}
	terminate(): void {
		this.terminated = true;
		this.emit("close");
	}
}

test("bounds queued UTF-8 bytes and disconnects explicitly instead of dropping state deltas", () => {
	const socket = new Socket();
	const send = boundedSender(socket, 10);
	send("ééé"); // Six bytes, not three characters.
	send("next");
	send("overflow");
	send("must not silently resume");
	assert.deepEqual(socket.sent, ["ééé", "next"]);
	assert.equal(socket.closes.length, 1);
	assert.equal(socket.closes[0]?.[0], 1013);
	assert.match(socket.closes[0]?.[1] ?? "", /Reconnect.*snapshot/);
	socket.emit("close");
});

test("allows drained messages, also checks transport buffering, and rejects oversized snapshots", () => {
	const socket = new Socket();
	const send = boundedSender(socket, 10);
	send("1234567890");
	socket.callbacks.shift()!();
	send("another");
	assert.equal(socket.sent.length, 2);
	socket.callbacks.shift()!();
	socket.bufferedAmount = 9;
	send("xx");
	assert.equal(socket.closes.length, 1);
	socket.emit("close");
	const large = new Socket();
	boundedSender(large, 10)("12345678901");
	assert.deepEqual(large.sent, []);
	assert.equal(large.closes[0]?.[0], 1013);
	large.emit("close");
});

test("terminates a stalled close and clears the deadline on normal close", async () => {
	const stalled = new Socket();
	boundedSender(stalled, 1, 10)("too large");
	const closed = new Socket();
	boundedSender(closed, 1, 10)("too large");
	closed.emit("close");
	await delay(30);
	assert.equal(stalled.terminated, true);
	assert.equal(closed.terminated, false);
});

test("send errors disconnect and closed sockets do not queue messages", () => {
	const socket = new Socket();
	const send = boundedSender(socket, 10);
	send("state");
	socket.callbacks.shift()!(new Error("failed"));
	assert.equal(socket.closes.length, 1);
	send("more");
	assert.equal(socket.sent.length, 1);
	socket.emit("close");
});

test("default allowance accepts legitimate snapshots larger than 8 MiB without a reconnect loop", () => {
	const socket = new Socket();
	const send = boundedSender(socket);
	send("x".repeat(16 * 1024 * 1024));
	assert.equal(socket.sent.length, 1);
	assert.equal(socket.closes.length, 0);
	socket.callbacks.shift()!();
	send("fresh delta after the snapshot");
	assert.equal(socket.sent.length, 2);
	assert.equal(socket.closes.length, 0);
	socket.bufferedAmount = 64 * 1024 * 1024;
	send("live delta while a maximum-size snapshot drains");
	assert.equal(socket.closes.length, 0);
	socket.bufferedAmount = 128 * 1024 * 1024;
	send("now overloaded");
	assert.equal(socket.closes.length, 1);
	socket.emit("close");
});

test("individual messages still respect the native frame limit despite queue headroom", () => {
	const socket = new Socket();
	boundedSender(socket)("x".repeat(64 * 1024 * 1024 + 1));
	assert.equal(socket.sent.length, 0);
	assert.equal(socket.closes[0]?.[0], 1013);
	socket.emit("close");
});
