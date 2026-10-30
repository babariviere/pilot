import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { test } from "node:test";
import type { KernelCommand, KernelPacket, KernelSpec } from "./protocol.ts";
import { KernelSession } from "./session.ts";
import { type IpcChannel, IpcSender, runKernelWorker } from "./worker.ts";

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

test("auto handoff configuration wins startup races and never waits for queued commands", async (t) => {
	const events = ["message", "disconnect", "SIGTERM", "SIGINT"] as const;
	const emitter: EventEmitter = process;
	const previous = new Map(events.map((event) => [event, emitter.listeners(event)]));
	const descriptors = new Map(
		["send", "connected"].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]),
	);
	const packets: KernelPacket[] = [];
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", {
		configurable: true,
		value: (packet: KernelPacket, callback: (error: Error | null) => void) => {
			packets.push(packet);
			callback(null);
			return true;
		},
	});
	t.after(() => {
		for (const event of events) {
			for (const listener of emitter.listeners(event)) {
				if (!previous.get(event)!.includes(listener))
					emitter.removeListener(event, listener as (...args: unknown[]) => void);
			}
		}
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(process, key, descriptor);
			else Reflect.deleteProperty(process, key);
		}
	});
	let resolveOpen!: (session: KernelSession) => void;
	let opening!: () => void;
	const opened = new Promise<void>((resolve) => {
		opening = resolve;
	});
	t.mock.method(KernelSession, "open", async () => {
		opening();
		return await new Promise<KernelSession>((resolve) => {
			resolveOpen = resolve;
		});
	});
	const configured: boolean[] = [];
	let finishCommand!: () => void;
	const session = {
		configureAutoHandoff(enabled: boolean) {
			configured.push(enabled);
		},
		executionEvidence: async () => undefined,
		watch: async () =>
			await new Promise<void>((resolve) => {
				finishCommand = resolve;
			}),
	} as unknown as KernelSession;
	runKernelWorker();
	const receive = emitter.listeners("message").find((listener) => !previous.get("message")!.includes(listener))!;
	const send = (command: KernelCommand) => receive(command);
	send({ type: "autoHandoff.configure", enabled: true });
	send({ type: "start", spec: { autoHandoff: true } as KernelSpec });
	await opened;
	send({ type: "autoHandoff.configure", enabled: false });
	resolveOpen(session);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(configured, [false], "latest startup value, including false, overrides the start spec");
	assert.ok(packets.some((packet) => packet.type === "ready"));
	send({ type: "watch", watchId: "blocked" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	send({ type: "autoHandoff.configure", enabled: true });
	assert.deepEqual(configured, [false, true], "configuration bypasses a blocked command queue");
	finishCommand();
	await new Promise<void>((resolve) => setImmediate(resolve));
});

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

test("a stalled but connected IPC channel preserves FIFO past repeated send deadlines", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const channel = new Channel();
	const failures: Error[] = [];
	const sender = new IpcSender(channel, (error) => failures.push(error), options);
	const first = sender.send(packet("stalled"));
	const second = sender.send(packet("queued"));
	t.mock.timers.tick(options.timeoutMs * 100);
	assert.deepEqual(failures, []);
	assert.equal(sender.pendingPackets, 2);
	assert.deepEqual(channel.sent, [packet("stalled")]);
	channel.callbacks[0]!(null);
	channel.callbacks[1]!(null);
	await Promise.all([first, second]);
	assert.deepEqual(channel.sent, [packet("stalled"), packet("queued")]);
	assert.equal(sender.pendingBytes, 0);
	t.mock.timers.tick(options.timeoutMs * 100);
	assert.deepEqual(failures, []);
});

test("a closed channel rejects stalled and queued sends at its next channel check", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const channel = new Channel();
	const failures: Error[] = [];
	const sender = new IpcSender(channel, (error) => failures.push(error), options);
	const rejected = Promise.all([
		assert.rejects(sender.send(packet("stalled")), /disconnected/),
		assert.rejects(sender.send(packet("queued")), /disconnected/),
	]);
	channel.connected = false;
	t.mock.timers.tick(options.timeoutMs);
	await rejected;
	assert.equal(failures.length, 1);
	assert.equal(sender.pendingBytes, 0);
	channel.callbacks[0]!(null);
	assert.equal(channel.sent.length, 1);
});
