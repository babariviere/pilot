// The unstick log: one JSON line each time the user unsticks mission planning (Continue planning, Unstick's fix,
// the repair agent and its answer) and each time a submitted round is not sent by itself. It is kept so the causes
// can be found and fixed later; Pilot never reads it back. `packages/daemon/src/missions/planning/workers/planning-unstick-log.md` explains it.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One file's size before it becomes `unstick.jsonl.1` (the one older file kept). It protects the disk from a loop
 * that stalls again and again. A line is about 1 KiB, so the two files keep the last 2,000 or so entries: far more
 * than a person unsticks before the causes are fixed.
 */
export const UNSTICK_LOG_BYTES = 1 << 20;

export class UnstickLog {
	private queue: Promise<void> = Promise.resolve();
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}
	/** Appends one entry, in order, off the caller's path. A failed write is logged and never stops planning. */
	record(entry: Record<string, unknown>): void {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
		this.queue = this.queue
			.then(() => this.append(line))
			.catch((e) => console.warn(`pilotd: unstick log not written: ${e}`));
	}
	/** Resolves once every entry recorded so far is written. */
	written(): Promise<void> {
		return this.queue;
	}
	private async append(line: string): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const size = await stat(this.file).then(
			(s) => s.size,
			() => 0,
		);
		if (size > 0 && size + Buffer.byteLength(line) > UNSTICK_LOG_BYTES) await rename(this.file, `${this.file}.1`);
		await appendFile(this.file, line, { mode: 0o600 });
	}
}
