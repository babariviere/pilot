/** Cheap change detection for a subagent's private `runs.sqlite`, without opening SQLite. */
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Size and modification time of the database and its WAL. Every commit appends to the WAL, and a
 * checkpoint rewrites the database, so any committed change alters the signature. A spurious change
 * only costs one cheap incremental read.
 */
export function subagentStorageSignature(directory: string): string {
	return ["runs.sqlite", "runs.sqlite-wal"]
		.map((name) => {
			try {
				const stat = statSync(join(directory, name));
				return `${stat.size}:${stat.mtimeMs}`;
			} catch {
				return "-";
			}
		})
		.join("/");
}
