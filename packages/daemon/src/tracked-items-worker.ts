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
		let value: unknown, projectId: string | undefined, projectIds: string[] | undefined;
		switch (method) {
			case "load": {
				value = args.projectIds.flatMap((projectId: string) =>
					(["linear", "slack"] as const).map((kind) => ({
						projectId,
						kind,
						preview: disk.preview(projectId, kind),
						checkpoint: disk.checkpoint(`${projectId}:${kind}`),
						inbox: disk.inboxCounts(projectId, kind),
					})),
				);
				break;
			}
			case "list":
				value = disk.list(args);
				break;
			case "inbox":
				value = disk.inbox(args);
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
			case "reserveSlackStart":
				value = disk.reserveSlackStart(args.id);
				projectId = disk.require(args.id).projectId;
				break;
			case "slackStartResult":
				disk.slackStartResult(args.id, args.outcome);
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
			case "slackLabelEffects": {
				// Every project's effects in one message, so startup never exceeds the store's request bound.
				const changedIds: string[] = [];
				let failure: unknown;
				for (const entry of args.entries as Array<{ projectId: string; close: string[] }>)
					try {
						if (disk.slackLabelEffects(entry.projectId, entry.close)) changedIds.push(entry.projectId);
					} catch (error) {
						failure ??= error;
					}
				projectIds = changedIds;
				// Other projects' changes are still reported; the caller retries the failed ones on the next change.
				value = failure ? { error: failure instanceof Error ? failure.message : String(failure) } : undefined;
				break;
			}
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
			...(projectIds?.length ? { projectIds, snapshots: projectIds.flatMap(snapshots) } : {}),
			...(projectId
				? {
						...(changed ? { projectId } : {}),
						snapshots: snapshots(projectId),
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

function snapshots(projectId: string) {
	return (["linear", "slack"] as const).map((kind) => ({
		projectId,
		kind,
		preview: disk.preview(projectId, kind),
		checkpoint: disk.checkpoint(`${projectId}:${kind}`),
		inbox: disk.inboxCounts(projectId, kind),
	}));
}
