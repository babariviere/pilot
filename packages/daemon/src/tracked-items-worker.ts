import { parentPort, workerData } from "node:worker_threads";
import { NotFound } from "./errors.ts";
import { TrackedItemDisk } from "./tracked-items-disk.ts";
import {
	sourceSnapshots,
	type TrackedItemMethod,
	type TrackedItemOpContext,
	type TrackedItemReply,
	trackedItemOps,
} from "./tracked-items-ops.ts";

const disk = new TrackedItemDisk(workerData.path);
const changed = new Set<string>();
const refreshed = new Set<string>();
disk.onChange((projectId) => changed.add(projectId));
const context: TrackedItemOpContext = {
	disk,
	changed: (projectId) => changed.add(projectId),
	refreshed: (projectId) => refreshed.add(projectId),
};
const reply = (message: TrackedItemReply) => parentPort!.postMessage(message);
parentPort!.on(
	"message",
	({ id, method, args }: { id: number; method: TrackedItemMethod | "close"; args: unknown[] }) => {
		changed.clear();
		refreshed.clear();
		if (method === "close") {
			disk.close();
			reply({ id, ok: true });
			parentPort!.close();
			return;
		}
		try {
			if (!Object.hasOwn(trackedItemOps, method)) throw new Error("Unknown tracking store operation");
			const op = trackedItemOps[method] as (context: TrackedItemOpContext, ...args: unknown[]) => unknown;
			const value = op(context, ...args);
			const projects = new Set([...changed, ...refreshed]);
			reply({
				id,
				ok: true,
				value,
				changed: [...changed],
				snapshots: [...projects].flatMap((projectId) => sourceSnapshots(disk, projectId)),
			});
		} catch (error) {
			reply({
				id,
				ok: false,
				message: error instanceof Error ? error.message : String(error),
				...(error instanceof NotFound ? { code: "not_found" } : {}),
			});
		}
	},
);
