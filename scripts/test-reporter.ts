/** Human-readable output plus the slowest per-file execution times (not import/startup time). */

import { relative } from "node:path";
import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

type Event = { type: string; data: { file?: string; duration_ms?: number } };
export default async function* reporter(source: AsyncIterable<Event>) {
	const files = new Map<string, number>();
	async function* collect() {
		for await (const event of source) {
			if (event.type === "test:summary" && event.data.file && event.data.duration_ms !== undefined)
				files.set(event.data.file, event.data.duration_ms);
			yield event;
		}
	}
	yield* Readable.from(collect()).pipe(spec());
	yield "\nSlowest test files (execution, excluding imports):\n";
	for (const [file, ms] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 15))
		yield `${(ms / 1000).toFixed(2).padStart(7)}s  ${relative(process.cwd(), file)}\n`;
}
