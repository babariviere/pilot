import { parentPort, workerData } from "node:worker_threads";
import { TrackedItemDisk } from "./tracked-items-disk.ts";

const disk = new TrackedItemDisk(workerData.path);
let changed = false;
disk.onChange(() => {
	changed = true;
});
parentPort!.on("message", ({ id, method, args }) => {
	try {
		changed = false;
		let value: unknown, projectId: string | undefined;
		switch (method) {
			case "load": {
				value = args.projectIds.flatMap((projectId: string) =>
					(["linear", "slack"] as const).map((kind) => ({
						projectId,
						kind,
						preview: disk.preview(projectId, kind),
						checkpoint: disk.checkpoint(`${projectId}:${kind}`),
					})),
				);
				break;
			}
			case "list":
				value = disk.list(args);
				break;
			case "require":
				value = disk.require(args.id);
				break;
			case "commit":
				disk.commit(args.projectId, args.kind, args.items, args.checkpoint);
				projectId = args.projectId;
				break;
			case "patch":
				value = disk.patch(args.id, args.patch);
				projectId = disk.require(args.id).projectId;
				break;
			case "close":
				disk.close();
				parentPort!.postMessage({ id });
				parentPort!.close();
				return;
			default:
				throw new Error("Unknown tracking store operation");
		}
		parentPort!.postMessage({
			id,
			value,
			...(projectId
				? {
						...(changed ? { projectId } : {}),
						snapshots: (["linear", "slack"] as const).map((kind) => ({
							projectId,
							kind,
							preview: disk.preview(projectId!, kind),
							checkpoint: disk.checkpoint(`${projectId}:${kind}`),
						})),
					}
				: {}),
		});
	} catch (error) {
		parentPort!.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
			notFound: error instanceof Error && error.constructor.name === "NotFound",
		});
	}
});
