/** Audited against node-pty 1.1.0 UnixTerminal/CustomWriteStream. No private queue mutation. */
import { createRequire } from "node:module";
import type { IPty } from "node-pty";

export const PTY_INPUT_CHUNK = 16 * 1024;
export const PTY_INPUT_BYTES = 256 * 1024;
export const PTY_INPUT_TASKS = 64;
const require = createRequire(import.meta.url);

export class BoundedPtyInput {
	private closed = false;
	private readonly stream: unknown;
	private readonly queue: unknown;
	private readonly pty: Pick<IPty, "write">;
	constructor(
		pty: Pick<IPty, "write">,
		platform = process.platform,
		version = require("node-pty/package.json").version,
	) {
		this.pty = pty;
		if (!["darwin", "linux"].includes(platform) || version !== "1.1.0")
			throw new Error("Unsupported PTY input implementation");
		this.stream = (pty as unknown as { _writeStream?: unknown })._writeStream;
		this.queue = (this.stream as { _writeQueue?: unknown } | undefined)?._writeQueue;
		this.usage();
	}
	private usage(): { bytes: number; tasks: number } {
		const stream = (this.pty as unknown as { _writeStream?: unknown })._writeStream;
		if (!stream || stream !== this.stream || typeof stream !== "object") throw new Error("Unknown PTY input stream");
		const queue = (stream as { _writeQueue?: unknown })._writeQueue;
		if (queue !== this.queue || !Array.isArray(queue) || queue.length > PTY_INPUT_TASKS)
			throw new Error("Unknown PTY input queue");
		let bytes = 0;
		for (const task of queue) {
			if (
				!task ||
				!Buffer.isBuffer(task.buffer) ||
				!Number.isInteger(task.offset) ||
				task.offset < 0 ||
				task.offset > task.buffer.byteLength
			)
				throw new Error("Unknown PTY input task");
			// A partially written task retains its entire allocation, not only the unwritten suffix.
			bytes += task.buffer.byteLength;
			if (bytes > PTY_INPUT_BYTES) throw new Error("PTY input queue exceeds capacity");
		}
		return { bytes, tasks: queue.length };
	}
	write(data: string): void {
		if (this.closed) throw new Error("Terminal input is closed");
		const bytes = Buffer.byteLength(data);
		if (!bytes) return;
		if (bytes > PTY_INPUT_CHUNK) throw new Error("Terminal input chunk exceeds capacity");
		const pending = this.usage();
		if (pending.tasks >= PTY_INPUT_TASKS || pending.bytes + bytes > PTY_INPUT_BYTES)
			throw new Error("Terminal input is busy; input was not accepted");
		// Both inspection and enqueue are synchronous. fs.write callbacks cannot interleave here.
		this.pty.write(data);
	}
	close(): void {
		this.closed = true;
	}
}
