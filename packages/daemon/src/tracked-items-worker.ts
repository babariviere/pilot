import { parentPort, workerData } from "node:worker_threads";
import { TrackedItemDisk } from "./tracked-items-disk.ts";

const disk = new TrackedItemDisk(workerData.path);
let changed = false;
/** Projects changed by the current request, for operations that are not scoped to one project. */
const emitted = new Set<string>();
disk.onChange((projectId) => {
	changed = true;
	emitted.add(projectId);
});
parentPort!.on("message", ({ id, method, args }) => {
	try {
		changed = false;
		emitted.clear();
		let value: unknown, projectId: string | undefined, projectIds: string[] | undefined;
		switch (method) {
			case "triageContext":
				value = disk.triage.context(args.projectId, args.kind);
				break;
			case "reserveGrooming":
				value = disk.triage.reserve(args.projectId, args.kind, args.now);
				break;
			case "caseInput":
				changed = disk.cases.retire(args.projectId, args.now);
				if (changed) projectId = args.projectId;
				value = disk.cases.input(args.projectId, args.now);
				break;
			case "commonCases":
				value = disk.cases.list(args.projectId, args.now);
				break;
			case "saveCases":
				changed = disk.cases.save(args.projectId, args.input, args.groups, args.now);
				projectId = args.projectId;
				break;
			case "editCase":
				disk.cases.edit(args.projectId, args.caseId, args.edit, args.now);
				changed = true;
				projectId = args.projectId;
				break;
			case "reserveLinearSize":
				value = disk.sizes.reserve(args.projectId, args.externalId, args.version, args.now);
				break;
			case "finishLinearSize":
				disk.sizes.finish(args.projectId, args.externalId, args.version, args.size);
				break;
			case "triageInput":
				value = disk.triage.input(args.projectId, args.kind);
				break;
			case "saveGuide":
				disk.triage.save(args.projectId, args.kind, args.text, args.throughSeq, args.expectedSeq, args.now);
				changed = true;
				projectId = args.projectId;
				break;
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
			case "slackGroups":
				value = disk.slackGroups(args.handles);
				break;
			case "reserveSlackRead":
				value = disk.reserveSlackRead(args.now);
				break;
			case "saveSlackGroup":
				disk.saveSlackGroup(args.handle, args.id, args.now);
				break;
			case "reserveSlack":
				value = disk.reserveSlack(args.channel, args.ts, args.now, args.projectId, args.retry === true);
				break;
			case "finishSlack":
				disk.finishSlack(args.channel, args.ts, args.result, args.projectId);
				break;
			case "corrections":
				value =
					args.kind === "linear"
						? disk.triage.corrections(args.projectId, "linear")
						: disk.corrections(args.projectId);
				break;
			case "require":
				value = disk.require(args.id);
				break;
			case "requireExternal":
				value = disk.requireExternal(args.projectId, args.kind, args.externalId);
				break;
			case "searchSlack":
				value = disk.searchSlack(args);
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
			case "reserveSlackReactions":
				value = disk.reserveSlackReactions(args.projectId, args.now, args.recheckMs);
				break;
			case "recordSlackReaction":
				disk.recordSlackReaction(args.id, args.present, args.version);
				if (changed) projectId = disk.require(args.id).projectId;
				break;
			case "reserveSlackWaiting":
				value = disk.reserveSlackWaiting(args.projectId, args.now);
				break;
			case "slackWaitingResult":
				value = disk.slackWaitingResult(args.id, args.since, args.result);
				if (changed) projectId = disk.require(args.id).projectId;
				break;
			case "slackLinkedSessions":
				value = disk.slackLinkedSessions(args.projectId, args.sessionIds);
				break;
			case "sessionSources":
				value = disk.sessionSources(args.projectId);
				break;
			case "agentSlackStatus":
				value = disk.agentSlackStatus(args.sessionId, args.status, args.reason);
				projectIds = [...emitted];
				break;
			case "reserveSlackDone":
				value = disk.reserveSlackDone(args.projectId);
				if (changed) projectId = args.projectId;
				break;
			case "slackDoneResult":
				disk.slackDoneResult(args.id, args.outcome);
				if (changed) projectId = disk.require(args.id).projectId;
				break;
			case "slackStartResult":
				disk.slackStartResult(args.id, args.outcome);
				projectId = disk.require(args.id).projectId;
				break;
			case "patch":
				value = disk.patch(args.id, args.patch);
				projectId = disk.require(args.id).projectId;
				break;
			case "observeSlackPullRequests":
				disk.observeSlackPullRequests(args);
				if (changed) projectId = args.projectId;
				break;
			case "completeSlackMission":
				disk.completeSlackMission(args.projectId, args.missionId, args.completedAt);
				if (changed) projectId = args.projectId;
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
