import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { MemoryEntry, MemoryRecall } from "@pilot/protocol";
import { DuplicateNote, decode, deviceIdentity, MemoryDisk, RECORD_BYTES } from "./memory-disk.ts";

if (workerData.recall) {
	// Dedicated, terminable worker: even a pathological regex cannot stall writes, wake or pilotd.
	const { dir, count, regex, lines } = workerData.recall;
	try {
		const pattern = new RegExp(regex, "i");
		const fd = openSync(join(dir, "log"), "r");
		const entries: MemoryEntry[] = [];
		// Latest correction per stable id; replaced notes stay searchable with a marker.
		const replacedBy = new Map<string, number>();
		let matches = 0,
			bytes = 0;
		try {
			const buf = Buffer.alloc(RECORD_BYTES * 64);
			for (let index = 0; index < count; ) {
				const n = Math.min(64, count - index),
					size = n * RECORD_BYTES;
				if (readSync(fd, buf, 0, size, index * RECORD_BYTES) !== size) throw new Error("Incomplete memory scan");
				for (let i = 0; i < n; i++, index++) {
					const entry = decode<MemoryEntry>(buf.subarray(i * RECORD_BYTES, (i + 1) * RECORD_BYTES));
					for (const id of entry.replaces ?? []) replacedBy.set(id, entry.index);
					if (!pattern.test(`#${entry.index} ${new Date(entry.at).toISOString().slice(0, 10)} ${entry.text}`))
						continue;
					matches++;
					entries.push(entry);
					bytes += Buffer.byteLength(JSON.stringify(entry));
					while (entries.length > lines || bytes > 20_000)
						bytes -= Buffer.byteLength(JSON.stringify(entries.shift()!));
				}
			}
		} finally {
			closeSync(fd);
		}
		parentPort!.postMessage({
			value: {
				count,
				matches,
				entries: entries.reverse().map((entry) => {
					const by = replacedBy.get(entry.id);
					return by === undefined ? entry : { ...entry, replacedBy: by };
				}),
				truncated: matches > entries.length,
			} satisfies MemoryRecall,
		});
	} catch (error) {
		parentPort!.postMessage({ error: String(error) });
	}
} else {
	const stores = new Map<string, MemoryDisk>();
	let deviceId: string | undefined;
	parentPort!.on("message", ({ id, projectId, method, args }) => {
		try {
			if (!/^[\w-]{1,100}$/.test(projectId)) throw new Error("Invalid project id");
			if (method === "unload") {
				stores.get(projectId)?.close();
				stores.delete(projectId);
				parentPort!.postMessage({ id, value: { ok: true } });
				return;
			}
			let store = stores.get(projectId);
			if (!store) {
				deviceId ??= deviceIdentity(workerData.root);
				store = new MemoryDisk(join(workerData.root, projectId), deviceId);
				stores.set(projectId, store);
			}
			let value: unknown;
			switch (method) {
				case "load":
					value = store.summary();
					break;
				case "note":
					value = store.note(args.text, args.sessionId, args.replaces ?? []);
					break;
				case "wake":
					value = store.wake(args.lines);
					break;
				case "zoom":
					value = store.zoom(args.lo, args.hi);
					break;
				case "forget":
					store.forget(args.lo, args.hi);
					value = { ok: true };
					break;
				case "next":
					value = store.next();
					break;
				case "put":
					value = store.put(args.lo, args.hi, args.epoch, args.text);
					break;
				case "diagnostic":
					store.diagnostic(args.trace);
					value = { ok: true };
					break;
				default:
					throw new Error("Unknown memory operation");
			}
			parentPort!.postMessage({
				id,
				value,
				...(["load", "note", "forget", "next", "put"].includes(method) ? { summary: store.summary() } : {}),
			});
		} catch (error) {
			parentPort!.postMessage({
				id,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof DuplicateNote ? { conflict: true } : {}),
			});
		}
	});
}
