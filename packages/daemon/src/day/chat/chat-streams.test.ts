import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, ChatServerMessage } from "@pilot/protocol";
import type { TraceCarrier } from "@pilot/telemetry";
import { ChatStreams } from "./chat-streams.ts";

type Listener = (events: AgentEvent[]) => void;

const entry = (id: number, text = "x") =>
	({ id, kind: "pi.user", model: [{ role: "user", content: text }] }) as unknown as Extract<
		AgentEvent,
		{ type: "snapshot" }
	>["entries"][number];
const snapshot = (count: number, text = "x") =>
	({
		type: "snapshot",
		entries: Array.from({ length: count }, (_, i) => entry(i + 1, text)),
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	}) as AgentEvent;
const queue: AgentEvent = { type: "queue_update", items: [] };

test("opt-in recent snapshots stay authoritative, never gain a prefix or resume a legacy stream", () => {
	const modes: boolean[] = [];
	const streams = new ChatStreams(
		(_id, listener, _trace, recent) => {
			modes.push(recent ?? false);
			const event = snapshot(60);
			if (recent && event.type === "snapshot")
				event.history = { context: { conversationId: 0, tail: 6000 }, more: true, before: 5941 };
			listener([event, queue]);
			return () => {};
		},
		{ tailEntries: 2 },
	);
	const frames: ChatServerMessage[] = [];
	const sink = (data: string) => frames.push(JSON.parse(data));
	const recent = streams.attach("s1", sink, undefined, undefined, true);
	assert.equal(frames.length, 2, "hello plus one complete bounded snapshot");
	assert.ok(!JSON.stringify(frames).includes("prefixPending"));
	recent.detach();
	const replaced = streams.attach("s1", sink, { streamId: recent.streamId, after: 1 });
	assert.equal(replaced.resumed, false);
	assert.deepEqual(modes, [true, false]);
	streams.close();
});

function harness(options: ConstructorParameters<typeof ChatStreams>[1] = {}) {
	const listeners: Listener[] = [];
	let unsubscribed = 0;
	const streams = new ChatStreams((_id, listener) => {
		listeners.push(listener);
		listener([snapshot(2), queue]);
		return () => {
			unsubscribed++;
		};
	}, options);
	const socket = () => {
		const frames: ChatServerMessage[] = [];
		return { frames, sink: (data: string) => frames.push(JSON.parse(data) as ChatServerMessage) };
	};
	return {
		streams,
		socket,
		emit: (events: AgentEvent[]) => listeners.at(-1)!(events),
		get subscriptions() {
			return listeners.length;
		},
		get unsubscribed() {
			return unsubscribed;
		},
	};
}

test("a new stream sends its hello before the synchronously delivered snapshot, then numbered batches", () => {
	const h = harness();
	const a = h.socket();
	const attached = h.streams.attach("s1", a.sink);
	h.emit([{ type: "queue_update", items: [] }]);
	assert.equal(attached.resumed, false);
	assert.deepEqual(
		a.frames.map((frame) => [frame.type, frame.type === "events" ? frame.seq : undefined]),
		[
			["chat.stream", undefined],
			["events", 1],
			["events", 2],
		],
	);
	assert.deepEqual(a.frames[0], { type: "chat.stream", sessionId: "s1", streamId: attached.streamId, resumed: false });
});

test("a new stream forwards trace context to its history subscription without retaining it for resumes", () => {
	const trace: TraceCarrier = { traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01` };
	const observed: Array<TraceCarrier | undefined> = [];
	const streams = new ChatStreams((_id, listener, carrier) => {
		observed.push(carrier);
		listener([snapshot(1)]);
		return () => undefined;
	});
	const first = streams.attach("s1", () => undefined, undefined, trace);
	first.detach();
	assert.equal(streams.attach("s1", () => undefined, { streamId: first.streamId, after: 1 }, trace).resumed, true);
	assert.deepEqual(observed, [trace]);
});

test("a resume replays only the missed batches and keeps the subscription", () => {
	const h = harness();
	const a = h.socket();
	const first = h.streams.attach("s1", a.sink);
	first.detach();
	h.emit([queue]);
	h.emit([queue]);
	const b = h.socket();
	const resumed = h.streams.attach("s1", b.sink, { streamId: first.streamId, after: 1 });
	assert.equal(resumed.resumed, true);
	assert.equal(h.subscriptions, 1);
	assert.deepEqual(
		b.frames.map((frame) => (frame.type === "events" ? frame.seq : frame.type)),
		["chat.stream", 2, 3],
	);
	h.emit([queue]);
	const last = b.frames.at(-1);
	assert.equal(last?.type === "events" && last.seq, 4);
	// The new socket also takes over a stream whose old socket is still attached.
	const c = h.socket();
	assert.equal(h.streams.attach("s1", c.sink, { streamId: first.streamId, after: 4 }).resumed, true);
	h.emit([queue]);
	assert.equal(c.frames.length, 2);
	assert.equal(b.frames.length, 4);
});

test("a resume behind the retained frames, for another session or with a bad cursor starts over", () => {
	const h = harness({ retainBytes: 400 });
	const a = h.socket();
	const first = h.streams.attach("s1", a.sink);
	for (let i = 0; i < 5; i++) h.emit([queue]);
	first.detach();
	const b = h.socket();
	const restarted = h.streams.attach("s1", b.sink, { streamId: first.streamId, after: 1 });
	assert.equal(restarted.resumed, false);
	assert.notEqual(restarted.streamId, first.streamId);
	assert.equal(h.unsubscribed, 1);
	assert.equal(b.frames[1]?.type === "events" && b.frames[1].events[0]?.type, "snapshot");
	restarted.detach();
	assert.equal(h.streams.attach("s2", h.socket().sink, { streamId: restarted.streamId, after: 1 }).resumed, false);
	assert.equal(h.streams.attach("s1", h.socket().sink, { streamId: restarted.streamId, after: 99 }).resumed, false);
});

test("detached streams release their subscription after the grace period or once they drop an unseen frame", async () => {
	const h = harness({ graceMs: 20 });
	h.streams.attach("s1", h.socket().sink).detach();
	assert.equal(h.streams.size, 1);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(h.streams.size, 0);
	assert.equal(h.unsubscribed, 1);

	const small = harness({ retainBytes: 400 });
	small.streams.attach("s1", small.socket().sink).detach();
	small.emit([queue]);
	assert.equal(small.streams.size, 1);
	for (let i = 0; i < 5; i++) small.emit([queue]);
	assert.equal(small.streams.size, 0);
	assert.equal(small.unsubscribed, 1);
});

test("refused subscriptions send nothing and leave no stream", () => {
	const streams = new ChatStreams(() => {
		throw new Error("Unknown session: s1");
	});
	const frames: string[] = [];
	assert.throws(() => streams.attach("s1", (data) => frames.push(data)), /Unknown session/);
	assert.deepEqual(frames, []);
	assert.equal(streams.size, 0);
});

test("long snapshots arrive newest first, then the older entries in a snapshot_prefix batch", () => {
	const h = harness({ tailEntries: 10, tailBytes: 1024 * 1024 });
	const a = h.socket();
	h.streams.attach("s1", a.sink);
	h.emit([snapshot(100), queue]);
	const [tail, prefix] = a.frames.slice(-2) as Extract<ChatServerMessage, { type: "events" }>[];
	const head = tail!.events[0] as Extract<AgentEvent, { type: "snapshot" }> & { prefixPending?: boolean };
	assert.equal(head.type, "snapshot");
	assert.equal(head.prefixPending, true);
	assert.equal((head as typeof head & { historyCount?: number }).historyCount, 100);
	assert.deepEqual(
		head.entries.map((entry) => Number(entry.id)),
		Array.from({ length: 10 }, (_, i) => i + 91),
	);
	assert.equal(tail!.events[1]?.type, "queue_update");
	assert.equal(prefix!.events.length, 1);
	const older = prefix!.events[0] as Extract<AgentEvent, { type: "snapshot_prefix" }>;
	assert.equal(older.type, "snapshot_prefix");
	assert.deepEqual(
		older.entries.map((entry) => Number(entry.id)),
		Array.from({ length: 90 }, (_, i) => i + 1),
	);
	assert.deepEqual([tail!.seq, prefix!.seq], [2, 3]);

	// The byte budget bounds the first frame, but always keeps the newest entry.
	const big = harness({ tailEntries: 10, tailBytes: 100 });
	const b = big.socket();
	big.streams.attach("s1", b.sink);
	big.emit([snapshot(20, "y".repeat(500))]);
	const first = (b.frames.at(-2) as Extract<ChatServerMessage, { type: "events" }>).events[0] as Extract<
		AgentEvent,
		{ type: "snapshot" }
	>;
	assert.deepEqual(
		first.entries.map((entry) => Number(entry.id)),
		[20],
	);
	// Short snapshots are sent whole.
	assert.equal((b.frames[1] as Extract<ChatServerMessage, { type: "events" }>).events[0]?.type, "snapshot");
	assert.equal(
		"prefixPending" in ((b.frames[1] as Extract<ChatServerMessage, { type: "events" }>).events[0] ?? {}),
		false,
	);
});
