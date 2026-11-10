/** Read-only inventory. A preview is not proof that a session has no live writers. */
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { abandonedAtomicFiles } from "../packages/daemon/src/temporary-storage.ts";

const home = resolve(process.argv[2] ?? join(homedir(), ".local/share/pilot"));
if ((await realpath(home)) !== home) throw new Error("Refusing an aliased Pilot home");
const known = new Set(["durable", "artifacts", "workspace", "workspace-recovery", "automation-logs"]);
const review: { path: string; bytes: number; partial: boolean; reason: string; archived: boolean | null }[] = [];
const atomicFiles = await abandonedAtomicFiles(home, "home", Date.now());
let sessions = 0;
let artifactBytes = 0;

async function size(path: string): Promise<{ bytes: number; partial: boolean }> {
	let bytes = 0;
	let visited = 0;
	const pending = [path];
	while (pending.length) {
		const next = pending.pop()!;
		if (++visited > 50_000) return { bytes, partial: true };
		const info = await lstat(next).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (!info) return { bytes, partial: true };
		if (info.isSymbolicLink()) continue;
		if (info.isFile()) bytes += info.size;
		else if (info.isDirectory()) {
			for await (const child of await opendir(next)) {
				if (pending.length + visited >= 50_000) return { bytes, partial: true };
				pending.push(join(next, child.name));
			}
		}
	}
	return { bytes, partial: false };
}

for await (const session of await opendir(join(home, "sessions"))) {
	if (!session.isDirectory()) continue;
	sessions++;
	const directory = join(home, "sessions", session.name);
	const meta = await readFile(join(directory, "meta.json"), "utf8")
		.then(JSON.parse)
		.catch(() => undefined);
	const archived = meta ? typeof meta.archivedAt === "number" : null;
	atomicFiles.push(...(await abandonedAtomicFiles(directory, "session", Date.now())));
	for await (const entry of await opendir(directory)) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "artifacts") artifactBytes += (await size(join(directory, entry.name))).bytes;
		if (known.has(entry.name)) continue;
		const path = join(directory, entry.name);
		review.push({
			path,
			...(await size(path)),
			reason: "Unknown folder or legacy scratch; manual review required, never automatically deleted",
			archived,
		});
	}
}
review.sort((a, b) => b.bytes - a.bytes);
console.log(
	JSON.stringify(
		{
			home,
			sessions,
			atomicFiles,
			review,
			artifactBytes,
			note: "No changes made. Logical bytes, not reclaimable disk space. Partial sizes are lower bounds. Saved artifacts, history, recovery data, databases, locks and operation receipts are preserved.",
		},
		null,
		2,
	),
);
