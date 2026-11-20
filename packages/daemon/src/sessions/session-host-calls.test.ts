import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostCallPacket, HostCalls, HostMethod, KernelCommand } from "@pilot/kernel";
import { HOST_CALL_PROFILES, HostCallDispatcher, type HostCallTable } from "./session-host-calls.ts";

type Reply = Extract<KernelCommand, { type: "host.result" }>;

const METHODS = [
	"question.guard",
	"planning",
	"planning.guard",
	"model.configuration.guard",
	"usage-history",
	"usage-history.epoch",
	"subscription.limit",
	"mission",
	"insights.backlog",
	"source.scope",
	"source.references",
	"memory",
	"knowledge",
	"liveUpdate.propose",
	"slack",
	"chatReport",
	"diagnostics",
	"diagnostics.context",
	"screen",
	"diagnostics.history",
	"diagnostics.logs",
	"diagnostics.proposal",
	"artifact.reference",
	"publication.source",
] as const satisfies readonly HostMethod[];
const worker = {};

/** Every method answers with its own name, so a test sees which handler ran. */
function dispatcher(handle?: (method: HostMethod, signal: AbortSignal) => Promise<unknown>) {
	const handled: HostMethod[] = [];
	const table = Object.fromEntries(
		METHODS.map((method) => [
			method,
			{
				failure: (error: unknown) => (error instanceof Error ? error.message : "failed"),
				...(method === "diagnostics.context" ? { readOnly: true } : {}),
				handle: async (_context: unknown, _args: unknown, signal: AbortSignal) => {
					handled.push(method);
					return handle ? handle(method, signal) : method;
				},
			},
		]),
	) as unknown as HostCallTable<undefined>;
	return { calls: new HostCallDispatcher(table), handled };
}

function call(
	calls: HostCallDispatcher<undefined>,
	packet: HostCallPacket,
	profile?: keyof typeof HOST_CALL_PROFILES,
	parked = false,
): Promise<Reply> {
	return new Promise((resolve) =>
		calls.dispatch({ sessionId: "chat", worker, context: undefined, profile, parked, reply: resolve }, packet),
	);
}

const packet = <M extends HostMethod>(method: M, args: HostCalls[M]["args"], callId: string = method): HostCallPacket =>
	({ type: "host.call", method, callId, args }) as HostCallPacket;
const sample = (method: HostMethod): HostCallPacket =>
	packet(
		method,
		(method === "mission"
			? { action: "get", args: {} }
			: method === "knowledge"
				? { action: "get", args: {} }
				: {}) as never,
	);

test("planning workers reach only their policy; every other host call is refused", async () => {
	const allowed = new Set<HostMethod>([
		"question.guard",
		"planning",
		"planning.guard",
		"model.configuration.guard",
		"usage-history",
		"usage-history.epoch",
		"subscription.limit",
		"knowledge",
		"source.scope",
		"source.references",
		"artifact.reference",
		"publication.source",
		"diagnostics.context",
	]);
	for (const method of METHODS) {
		const { calls, handled } = dispatcher();
		const reply = await call(calls, sample(method), "planning");
		if (allowed.has(method)) assert.equal(reply.result, method, method);
		else {
			assert.equal(reply.error, "Planning profile permits only its bound native port", method);
			assert.deepEqual(handled, [], method);
		}
	}
});

test("planners may read Knowledge and mission tickets, but not documentation batches or other mission actions", async () => {
	const { calls } = dispatcher();
	for (const action of ["list", "get", "create", "append", "link", "context", "preferences.get"] as const)
		assert.equal(
			(await call(calls, packet("knowledge", { action, args: {} }, action), "planning")).result,
			"knowledge",
		);
	assert.match(
		(await call(calls, packet("knowledge", { action: "batch", args: {} }), "planning")).error ?? "",
		/Planning profile/,
	);
	assert.equal((await call(calls, packet("mission", { action: "ticket", args: {} }), "planning")).result, "mission");
	for (const action of ["comment", "updateLink", "split"] as const)
		assert.match(
			(await call(calls, packet("mission", { action, args: {} }, action), "planning")).error ?? "",
			/Planning profile/,
			action,
		);
});

test("Insights chats reach only their backlog, granted history and runtime calls", async () => {
	const allowed = new Set<HostMethod>([
		"question.guard",
		"model.configuration.guard",
		"usage-history",
		"usage-history.epoch",
		"subscription.limit",
		"insights.backlog",
		"diagnostics.context",
	]);
	for (const method of METHODS) {
		const { calls, handled } = dispatcher();
		const reply = await call(calls, sample(method), "insights");
		if (allowed.has(method)) assert.equal(reply.result, method, method);
		else {
			assert.equal(reply.error, "Insights denies this capability", method);
			assert.deepEqual(handled, [], method);
		}
	}
});

test("a parked worker gets no reply unless the handler checks parking itself", async () => {
	const replies: Reply[] = [];
	const table = Object.fromEntries(
		METHODS.map((method) => [
			method,
			{
				failure: "failed",
				...(method === "planning.guard" ? { whileParked: true } : {}),
				handle: async () => method,
			},
		]),
	) as unknown as HostCallTable<undefined>;
	const calls = new HostCallDispatcher(table);
	const reply = (command: Reply) => replies.push(command);
	const caller = { sessionId: "chat", worker, context: undefined, profile: undefined, parked: true, reply };
	calls.dispatch(caller, sample("memory"));
	calls.dispatch(caller, sample("planning.guard"));
	await Promise.all(calls.running());
	assert.deepEqual(
		replies.map((entry) => entry.callId),
		["planning.guard"],
	);
});

test("a pool refuses calls over its limit, and only the calling worker can cancel a read", async () => {
	const pool = { limit: 1, busy: "Reads are busy" };
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const signals: AbortSignal[] = [];
	const table = Object.fromEntries(
		METHODS.map((method) => [
			method,
			{
				failure: "failed",
				...(method === "diagnostics.context" || method === "diagnostics.logs" ? { pool } : {}),
				handle: async (_context: unknown, _args: unknown, signal: AbortSignal) => {
					signals.push(signal);
					await released;
					return method;
				},
			},
		]),
	) as unknown as HostCallTable<undefined>;
	const calls = new HostCallDispatcher(table);
	const first = call(calls, packet("diagnostics.context", { request: { action: "chats" } }, "first"));
	try {
		const busy = await call(calls, packet("diagnostics.logs", { request: { action: "inventory" } }, "second"));
		assert.equal(busy.error, "Reads are busy");
		assert.equal(calls.running("chat", ["diagnostics.context"]).length, 1);
		assert.equal(signals[0]?.aborted, false);
		calls.cancel("chat", worker, "first");
		assert.equal(signals[0]?.aborted, true);
	} finally {
		release();
	}
	assert.equal((await first).result, "diagnostics.context");
	await Promise.all(calls.running());
	assert.equal(calls.running("chat").length, 0);
});

test("closing refuses new calls, cancels reads and drains admitted writes", async () => {
	let finishRead!: () => void;
	let finishWrite!: () => void;
	const readHeld = new Promise<void>((resolve) => {
		finishRead = resolve;
	});
	const writeHeld = new Promise<void>((resolve) => {
		finishWrite = resolve;
	});
	let readSignal: AbortSignal | undefined;
	let writeSaved = false;
	const { calls, handled } = dispatcher(async (method, signal) => {
		if (method === "diagnostics.context") {
			readSignal = signal;
			await readHeld;
			return null;
		}
		await writeHeld;
		writeSaved = true;
		return { saved: true };
	});
	const read = call(calls, sample("diagnostics.context"));
	const write = call(calls, sample("chatReport"));
	try {
		calls.beginClosing();
		assert.equal(readSignal?.aborted, true);
		assert.equal((await call(calls, sample("mission"))).error, "pilotd is shutting down");
		assert.deepEqual(handled, ["diagnostics.context", "chatReport"]);
		const draining = calls.writesToDrain();
		assert.equal(draining.length, 1);
		assert.equal(writeSaved, false);
		finishWrite();
		await Promise.all(draining);
		assert.equal(writeSaved, true);
		assert.deepEqual((await write).result, { saved: true });
	} finally {
		finishRead();
		finishWrite();
		await Promise.all([read, write]);
	}
});
