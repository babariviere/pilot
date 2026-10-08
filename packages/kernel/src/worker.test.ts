import assert from "node:assert/strict";
import { test } from "node:test";
import type { KernelPacket } from "./protocol.ts";
import { type IpcChannel, IpcSender } from "./worker.ts";

class Channel implements IpcChannel {
	connected = true;
	readonly sent: KernelPacket[] = [];
	readonly callbacks: Array<(error: Error | null) => void> = [];
	send(packet: KernelPacket, callback: (error: Error | null) => void): boolean {
		this.sent.push(packet);
		this.callbacks.push(callback);
		return false;
	}
}
const packet = (id: string): KernelPacket => ({ type: "accepted", requestId: id });
const options = { maxBytes: 1024, maxPacketBytes: 1024, maxPackets: 3, timeoutMs: 1000 };

test("IPC awaits each callback and preserves FIFO order even when send reports pressure", async () => {
	const channel = new Channel();
	const sender = new IpcSender(channel, assert.fail, options);
	const promises = [sender.send(packet("one")), sender.send(packet("two")), sender.send(packet("three"))];
	assert.deepEqual(channel.sent, [packet("one")]);
	assert.equal(sender.pendingPackets, 3);
	assert.ok(sender.pendingBytes > 0);
	channel.callbacks[0]!(null);
	await promises[0];
	assert.deepEqual(channel.sent, [packet("one"), packet("two")]);
	channel.callbacks[1]!(null);
	channel.callbacks[2]!(null);
	await Promise.all(promises);
	assert.deepEqual(channel.sent, [packet("one"), packet("two"), packet("three")]);
	assert.equal(sender.pendingBytes, 0);
	assert.equal(sender.pendingPackets, 0);
});

for (const cap of ["count", "bytes", "packet"] as const) {
	test(`IPC ${cap} overflow fails explicitly, rejects every waiter, and retains no queued deltas`, async () => {
		const channel = new Channel();
		const failures: Error[] = [];
		const sender = new IpcSender(channel, (error) => failures.push(error), {
			...options,
			maxPackets: cap === "count" ? 1 : 3,
			maxBytes: cap === "bytes" ? 70 : 1024,
			maxPacketBytes: cap === "packet" ? 70 : 1024,
		});
		const first = sender.send(packet("one"));
		const firstRejected = assert.rejects(first, /limit/);
		const next = sender.send(packet(cap === "packet" ? "x".repeat(100) : "two"));
		await assert.rejects(next, /limit/);
		await firstRejected;
		assert.equal(failures.length, 1);
		assert.equal(sender.pendingBytes, 0);
		assert.equal(sender.pendingPackets, 0);
		channel.callbacks[0]!(null);
		assert.equal(channel.sent.length, 1, "a late callback cannot resume a failed queue");
		await assert.rejects(sender.send(packet("later")), /limit/);
	});
}

test("IPC callback failure and disconnect reject pending sends without unhandled notifications", async () => {
	const channel = new Channel();
	const failures: Error[] = [];
	const sender = new IpcSender(channel, (error) => failures.push(error), options);
	const first = sender.send(packet("one"));
	const second = sender.send(packet("two"));
	const rejected = Promise.all([assert.rejects(first, /broken/), assert.rejects(second, /broken/)]);
	channel.callbacks[0]!(new Error("broken"));
	await rejected;
	assert.equal(failures.length, 1);
	const disconnected = new IpcSender(channel, (error) => failures.push(error), options);
	channel.connected = false;
	await assert.rejects(disconnected.send(packet("offline")), /disconnected/);
	assert.equal(failures.length, 2);
});

test("stalled IPC callback has a bounded deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const channel = new Channel();
	const failures: Error[] = [];
	const sender = new IpcSender(channel, (error) => failures.push(error), options);
	const rejected = assert.rejects(sender.send(packet("stalled")), /timed out/);
	t.mock.timers.tick(options.timeoutMs);
	await rejected;
	assert.equal(failures.length, 1);
	assert.equal(sender.pendingBytes, 0);
});
