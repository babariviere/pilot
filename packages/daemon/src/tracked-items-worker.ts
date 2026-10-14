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
			case "slackCached":
				value = disk.slackCached(args.channel, args.ts, args.projectId);
				break;
			case "reserveSlack":
				value = disk.reserveSlack(args.channel, args.ts, args.now, args.projectId);
				break;
			case "finishSlack":
				disk.finishSlack(args.channel, args.ts, args.result, args.projectId);
				break;
			case "corrections":
				value = disk.corrections(args.projectId);
				break;
			case "require":
				value = disk.require(args.id);
				break;
			case "commit":
				disk.commit(args.projectId, args.kind, args.items, args.checkpoint, args.activeIds);
				projectId = args.projectId;
				break;
			case "linearStartResult":
				disk.linearStartResult(args.id, args.outcome);
				projectId = disk.require(args.id).projectId;
				break;
			case "patch":
				value = disk.patch(args.id, args.patch);
				projectId = disk.require(args.id).projectId;
				break;
			case "retainSlack":
				disk.retainSlack(args.projectId, args.channels);
				projectId = args.projectId;
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
