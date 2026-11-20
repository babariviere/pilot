import type { WebSocket } from "ws";

export const TERMINAL_REPLAY_BYTES = 2 * 1024 * 1024;
const QUEUE_BYTES = TERMINAL_REPLAY_BYTES + 512 * 1024;

export class TerminalScrollback {
	private chunks: { data: string; bytes: number }[] = [];
	private bytes = 0;
	append(data: string): void {
		let retained = data,
			size = Buffer.byteLength(data);
		if (!size) return;
		if (size > TERMINAL_REPLAY_BYTES) {
			const bytes = Buffer.from(data);
			let start = bytes.length - TERMINAL_REPLAY_BYTES;
			while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
			retained = bytes.subarray(start).toString("utf8");
			size = bytes.length - start;
		}
		this.chunks.push({ data: retained, bytes: size });
		this.bytes += size;
		while (this.bytes > TERMINAL_REPLAY_BYTES || this.chunks.length > 4096) this.bytes -= this.chunks.shift()!.bytes;
	}
	get output(): string {
		return this.chunks.map((chunk) => chunk.data).join("");
	}
}

/** UTF-8-safe chunks, also bounding JSON escaping expansion to at most 96 KiB/frame. */
export function* terminalChunks(data: string): Generator<string> {
	const bytes = Buffer.from(data);
	for (let start = 0; start < bytes.length; ) {
		let end = Math.min(bytes.length, start + 16 * 1024);
		while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
		yield bytes.subarray(start, end).toString("utf8");
		start = end;
	}
}

/** One native send at a time, lazy replay encoding, and bounded live/control queues. */
export function terminalSender(ws: WebSocket, sessionId: string, graceMs = 1000) {
	type Entry = { bytes: number; frames: Iterator<string> };
	const queue: Entry[] = [];
	let bytes = 0,
		sending = false,
		closed = false;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	ws.once("close", () => {
		closed = true;
		queue.length = 0;
		bytes = 0;
		clearTimeout(deadline);
	});
	const overload = () => {
		if (closed) return;
		closed = true;
		queue.length = 0;
		bytes = 0;
		ws.close(1013, "Terminal stream busy; reconnect to replay output");
		deadline = setTimeout(() => ws.terminate(), graceMs);
		deadline.unref();
	};
	const pump = () => {
		if (closed || sending || ws.readyState !== ws.OPEN) return;
		const entry = queue[0];
		if (!entry) return;
		const next = entry.frames.next();
		if (next.done) {
			queue.shift();
			bytes -= entry.bytes;
			pump();
			return;
		}
		sending = true;
		try {
			ws.send(next.value, (error) => {
				sending = false;
				if (error) overload();
				else pump();
			});
		} catch {
			sending = false;
			overload();
		}
	};
	const enqueue = (size: number, frames: Iterator<string>) => {
		if (closed) return;
		if (size > TERMINAL_REPLAY_BYTES || bytes + size > QUEUE_BYTES || queue.length >= 256) {
			overload();
			return;
		}
		bytes += size;
		queue.push({ bytes: size, frames });
		pump();
	};
	return {
		message(message: object) {
			const data = JSON.stringify(message);
			const size = Buffer.byteLength(data);
			if (size > 128 * 1024) {
				overload();
				return;
			}
			enqueue(size, [data][Symbol.iterator]());
		},
		data(data: string) {
			function* frames() {
				for (const chunk of terminalChunks(data))
					yield JSON.stringify({ type: "terminal.data", sessionId, data: chunk });
			}
			enqueue(Buffer.byteLength(data), frames());
		},
	};
}
