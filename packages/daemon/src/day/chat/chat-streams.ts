/**
 * Resumable per-chat transcript streams. Each chat socket attaches to a stream that numbers its event batches.
 * When the socket drops (overload, sleep, a network hiccup), the stream stays subscribed for a grace period and
 * retains recent frames, so a reconnect with the last seen sequence number replays only what was missed instead
 * of a full snapshot. Large snapshots are split so the newest entries arrive first.
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, ChatServerMessage } from "@pilot/protocol";
import type { TraceCarrier } from "@pilot/telemetry";

type Subscribe = (
	sessionId: string,
	listener: (events: AgentEvent[]) => void,
	trace?: TraceCarrier,
	recent?: boolean,
) => () => void;
type Snapshot = Extract<AgentEvent, { type: "snapshot" }>;

export interface ChatStreamOptions {
	/** Frames retained for replay per stream. A resume behind the oldest retained frame gets a fresh snapshot. */
	retainBytes?: number;
	/** How long a stream without a socket stays subscribed, waiting for a resume. */
	graceMs?: number;
	/** Snapshot entries sent in the first frame. Older entries follow in a `snapshot_prefix` frame. */
	tailEntries?: number;
	/** Byte budget of the first frame's entries, so a few huge entries still paint quickly. */
	tailBytes?: number;
}

interface Frame {
	seq: number;
	data: string;
	bytes: number;
}

interface Stream {
	id: string;
	sessionId: string;
	recent: boolean;
	/** Last sequence number assigned. */
	seq: number;
	frames: Frame[];
	bytes: number;
	sink?: (data: string) => void;
	/** `seq` when the last socket detached. The client has seen at most this frame. */
	detachedAt: number;
	unsubscribe?: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ChatAttachment {
	streamId: string;
	resumed: boolean;
	/** Release the socket. The stream stays resumable for the grace period. */
	detach(): void;
}

export class ChatStreams {
	private readonly streams = new Map<string, Stream>();
	private readonly subscribe: Subscribe;
	private readonly retainBytes: number;
	private readonly graceMs: number;
	private readonly tailEntries: number;
	private readonly tailBytes: number;

	constructor(subscribe: Subscribe, options: ChatStreamOptions = {}) {
		this.subscribe = subscribe;
		this.retainBytes = options.retainBytes ?? 4 * 1024 * 1024;
		this.graceMs = options.graceMs ?? 30_000;
		this.tailEntries = options.tailEntries ?? 60;
		this.tailBytes = options.tailBytes ?? 256 * 1024;
	}

	/** Live and detached streams. */
	get size(): number {
		return this.streams.size;
	}

	/**
	 * Attach a socket's sender. With `resume`, replays frames after `resume.after` when the stream still retains
	 * every one of them; otherwise starts a new stream whose first batch holds a snapshot. The first frame sent is
	 * always `chat.stream`. Throws when subscribing fails, for example for an unknown session.
	 */
	attach(
		sessionId: string,
		sink: (data: string) => void,
		resume?: { streamId: string; after: number },
		trace?: TraceCarrier,
		recent = false,
	): ChatAttachment {
		const previous = resume ? this.streams.get(resume.streamId) : undefined;
		// A reconnect can arrive before pilotd notices the old socket closed. The new socket takes the stream over.
		const owned = previous?.sessionId === sessionId && previous.recent === recent ? previous : undefined;
		if (owned && resume && this.canReplay(owned, resume.after)) {
			clearTimeout(owned.timer);
			owned.timer = undefined;
			owned.sink = sink;
			sink(this.hello(owned, true));
			for (const frame of owned.frames) if (frame.seq > resume.after) sink(frame.data);
			return this.attachment(owned, sink, true);
		}
		if (owned) this.dispose(owned);
		// Subscribing can deliver the snapshot synchronously. Hold it until the subscription is accepted, so a
		// refused subscription sends no `chat.stream` and the hello always comes first.
		const early: string[] = [];
		const stream: Stream = {
			id: randomUUID(),
			sessionId,
			recent,
			seq: 0,
			frames: [],
			bytes: 0,
			sink: (data) => early.push(data),
			detachedAt: 0,
		};
		this.streams.set(stream.id, stream);
		try {
			stream.unsubscribe = this.subscribe(sessionId, (events) => this.push(stream, events), trace, recent);
		} catch (error) {
			this.streams.delete(stream.id);
			throw error;
		}
		stream.sink = sink;
		sink(this.hello(stream, false));
		for (const data of early) sink(data);
		return this.attachment(stream, sink, false);
	}

	close(): void {
		for (const stream of [...this.streams.values()]) this.dispose(stream);
	}

	private attachment(stream: Stream, sink: (data: string) => void, resumed: boolean): ChatAttachment {
		return {
			streamId: stream.id,
			resumed,
			detach: () => {
				if (stream.sink !== sink) return;
				stream.sink = undefined;
				stream.detachedAt = stream.seq;
				stream.timer = setTimeout(() => this.dispose(stream), this.graceMs);
				stream.timer.unref();
			},
		};
	}

	private hello(stream: Stream, resumed: boolean): string {
		const message: ChatServerMessage = {
			type: "chat.stream",
			sessionId: stream.sessionId,
			streamId: stream.id,
			resumed,
		};
		return JSON.stringify(message);
	}

	/** A resume is exact only if every frame after `after` is still retained. */
	private canReplay(stream: Stream, after: number): boolean {
		if (!Number.isSafeInteger(after) || after < 1 || after > stream.seq) return false;
		return after >= (stream.frames[0]?.seq ?? stream.seq + 1) - 1;
	}

	private push(stream: Stream, events: AgentEvent[]): void {
		if (this.streams.get(stream.id) !== stream) return;
		for (const batch of this.split(events)) {
			stream.seq++;
			const message: ChatServerMessage = {
				type: "events",
				sessionId: stream.sessionId,
				events: batch,
				seq: stream.seq,
			};
			const data = JSON.stringify(message);
			const bytes = Buffer.byteLength(data);
			stream.frames.push({ seq: stream.seq, data, bytes });
			stream.bytes += bytes;
			while (stream.bytes > this.retainBytes) stream.bytes -= stream.frames.shift()!.bytes;
			stream.sink?.(data);
		}
		// A detached stream that dropped a frame its client may not have seen can never resume. Release it now.
		if (!stream.sink && (stream.frames[0]?.seq ?? stream.seq + 1) > stream.detachedAt + 1) this.dispose(stream);
	}

	/**
	 * Split a batch holding one large snapshot into the snapshot's newest entries (with the batch's other events)
	 * and a following `snapshot_prefix` batch with the older entries, so a long chat paints its end first.
	 */
	private split(events: AgentEvent[]): AgentEvent[][] {
		const index = events.findIndex((event) => event.type === "snapshot");
		if (index < 0 || events.some((event, i) => i > index && event.type === "snapshot")) return [events];
		const snapshot = events[index] as Snapshot;
		if (snapshot.history) return [events];
		const entries = snapshot.entries;
		const counted = { ...snapshot, historyCount: entries.length } as Snapshot;
		if (entries.length <= this.tailEntries) {
			return [[...events.slice(0, index), counted, ...events.slice(index + 1)]];
		}
		let start = entries.length;
		let bytes = 0;
		while (start > 0 && entries.length - start < this.tailEntries) {
			const size = Buffer.byteLength(JSON.stringify(entries[start - 1]));
			// The newest entry is always included, whatever its size.
			if (start < entries.length && bytes + size > this.tailBytes) break;
			bytes += size;
			start--;
		}
		const tail = { ...counted, entries: entries.slice(start), prefixPending: true } as Snapshot;
		const prefix: AgentEvent = { type: "snapshot_prefix", entries: entries.slice(0, start) };
		return [[...events.slice(0, index), tail, ...events.slice(index + 1)], [prefix]];
	}

	private dispose(stream: Stream): void {
		if (this.streams.get(stream.id) !== stream) return;
		this.streams.delete(stream.id);
		clearTimeout(stream.timer);
		stream.sink = undefined;
		stream.unsubscribe?.();
	}
}
