import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { MemoryEntry, MemoryRecall } from "@pilot/protocol";
import { ControlMemoryDisk } from "./control-memory-disk.ts";
import { DuplicateNote, decode, deviceIdentity, MemoryDisk, RECORD_BYTES } from "./memory-disk.ts";
import { checkBindingKey } from "./shared-memory-common.ts";
import { recallReplica, SharedMemoryReplica } from "./shared-memory-replica.ts";

if (workerData.replicaRecall) {
	try {
		const { path, regex, lines } = workerData.replicaRecall;
		parentPort!.postMessage({ value: recallReplica(path, regex, lines) });
	} catch (error) {
		parentPort!.postMessage({ error: String(error) });
	}
} else if (workerData.recall) {
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
	let control: ControlMemoryDisk | undefined;
	const replicas = new Map<string, SharedMemoryReplica>();
	let deviceId: string | undefined;
	parentPort!.on("message", ({ id, projectId, method, args }) => {
		try {
			if (method.startsWith("control.")) {
				if (method === "control.close") {
					control?.close();
					control = undefined;
					parentPort!.postMessage({ id });
					return;
				}
				control ??= new ControlMemoryDisk(join(workerData.root, "control-chat"));
				let value: unknown;
				switch (method) {
					case "control.state":
						value = control.state();
						break;
					case "control.append":
						value = control.append(args.message);
						break;
					case "control.view":
						value = control.view();
						break;
					case "control.next":
						value = control.next();
						break;
					case "control.context":
						value = control.context(args.id, args.n);
						break;
					case "control.put":
						value = control.put(args.id, args.n, args.text);
						break;
					case "control.fail":
						value = control.fail(args.id, args.n);
						break;
					case "control.message":
						value = control.message(args.id, args.offset);
						break;
					case "control.children":
						value = control.children(args.id, args.n);
						break;
					case "control.date":
						value = control.date(args.id);
						break;
					default:
						throw new Error("Unknown control memory operation");
				}
				parentPort!.postMessage({ id, value });
				return;
			}
			if (method.startsWith("replica.")) {
				checkBindingKey(projectId);
				let replica = replicas.get(projectId);
				if (!replica) {
					if (replicas.size >= 16) {
						const [key, old] = replicas.entries().next().value!;
						old.close();
						replicas.delete(key);
					}
					replica = new SharedMemoryReplica(join(workerData.root, "shared-replicas", `${projectId}.sqlite`));
					replicas.set(projectId, replica);
				}
				let value: unknown;
				switch (method) {
					case "replica.stage":
						value = replica.stage(args.manifest, args.page);
						break;
					case "replica.activate":
						value = replica.activate(args.manifestId);
						break;
					case "replica.changes":
						value = replica.apply(args.batch);
						break;
					case "replica.read":
						value = replica.read(args.action, args.args);
						break;
					case "replica.tree":
						value = replica.tree(args.args);
						break;
					case "replica.queue":
						value = replica.queue(args.mutation);
						break;
					case "replica.proposals":
						value = replica.proposals();
						break;
					case "replica.outcome":
						value = replica.outcome(args.outcome);
						break;
					case "replica.state":
						value = replica.state();
						break;
					default:
						throw new Error("Unknown memory replica operation");
				}
				parentPort!.postMessage({ id, value });
				return;
			}
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
				store = new MemoryDisk(join(workerData.root, projectId), deviceId, undefined, workerData.originHost);
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
				case "commitSharedNote":
					value = store.commitSharedNote(args.mutation);
					break;
				case "beginCheckpoint":
					value = store.beginCheckpoint();
					break;
				case "checkpointPage":
					value = store.checkpointPage(args.checkpointId, args.cursor);
					break;
				case "changes":
					value = store.changes(args.after, args.limit);
					break;
				case "wake":
					value = store.wake(args.lines);
					break;
				case "zoom":
					value = store.zoom(args.lo, args.hi);
					break;
				case "tree":
					value = store.tree(args);
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
				...(["load", "note", "commitSharedNote", "forget", "next", "put"].includes(method)
					? { summary: store.summary() }
					: {}),
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
