/** Linear-only tracking work on the shared source scheduler: prefill, starts, settings lookups and item decoration. */
import type {
	LinearParentHeader,
	LinearTeamOption,
	LinearWorkflowStateOption,
	TrackedItem,
	TrackedItemPrefill,
	TrackingJson,
	TrackingLookup,
} from "@pilot/protocol";
import type { JobToken } from "./background-job-diagnostics.ts";
import { jobFailureReason } from "./background-job-diagnostics.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { linearParentHeaders, linearPrefill, linearStart } from "./linear-source.ts";
import { workflowStates } from "./linear-workflow.ts";
import { parseSourceId, sourceId } from "./source-kinds.ts";
import { abortable, type SourceScheduler, TRACKING_BUSY, TRACKING_STOPPED } from "./source-poll.ts";
import { SourceRateLimited, SourceSignInRequired } from "./source-tool-rules.ts";
import { lookupLinearTeams } from "./tracking-lookup.ts";

export interface LinearTrackingOptions {
	/** Read-only: the mission whose managed link resolved to each Linear issue UUID. */
	managedMissions?: (projectId: string, issueIds: string[]) => Map<string, string>;
}

export class LinearTracking {
	private readonly scheduler: SourceScheduler;
	private readonly managedMissions?: LinearTrackingOptions["managedMissions"];
	constructor(scheduler: SourceScheduler, options: LinearTrackingOptions = {}) {
		this.scheduler = scheduler;
		this.managedMissions = options.managedMissions;
		scheduler.jobDiagnostics.register("linear_parent_header", "linear");
	}

	/** Linear teams for the project settings picker. Read-only, never stored. */
	teams(query?: string): Promise<TrackingLookup<LinearTeamOption>> {
		return this.scheduler.lookup("linear", (call) => lookupLinearTeams(call, query));
	}
	states(team: string): Promise<TrackingLookup<LinearWorkflowStateOption>> {
		return this.scheduler.lookup("linear", async (call) => ({
			items: workflowStates(await call("states", { team })),
			more: false,
		}));
	}

	/** Link Linear items to the mission that manages the same issue, so they never look new. Read-only. */
	withManagers<T extends { externalId?: string; missionId?: string; missionIds?: string[] }>(
		projectId: string,
		items: T[],
	): T[] {
		const ids = items.flatMap((item) => (item.externalId ? [item.externalId] : []));
		const managers = ids.length ? this.managedMissions?.(projectId, ids) : undefined;
		if (!managers?.size) return items;
		return items.map((item) => {
			const missionId = item.externalId ? managers.get(item.externalId) : undefined;
			if (!missionId || item.missionIds?.includes(missionId)) return item;
			return {
				...item,
				missionId: item.missionId ?? missionId,
				missionIds: [...(item.missionIds ?? []), missionId],
			};
		});
	}

	/** Attach cached parent headers to Linear sub-issues. Headers live in each project's Linear checkpoint, so
	 * this reads no disk and makes no source calls. */
	withParents<T extends { metadata?: Record<string, TrackingJson>; linearParent?: LinearParentHeader }>(
		items: T[],
		projectOf: (item: T) => string,
	): T[] {
		const headers = new Map<string, Record<string, LinearParentHeader>>();
		return items.map((item) => {
			const parentId = item.metadata?.parentId;
			if (typeof parentId !== "string") return item;
			const projectId = projectOf(item);
			let project = headers.get(projectId);
			if (!project) {
				const id = sourceId(projectId, "linear"),
					checkpoint = this.scheduler.items.checkpoint(id);
				project =
					checkpoint?.configKey === this.scheduler.currentKey(id) ? linearParentHeaders(checkpoint?.cursor) : {};
				headers.set(projectId, project);
			}
			const header = project[parentId];
			return header ? { ...item, linearParent: header } : item;
		});
	}

	prefill(itemId: string): Promise<TrackedItemPrefill> {
		const s = this.scheduler;
		if (!s.open()) throw new ServiceUnavailable(TRACKING_STOPPED);
		const name = `prefill:${itemId}`;
		const existing = s.slot(name);
		if (existing) return existing.promise as Promise<TrackedItemPrefill>;
		if (!s.free()) throw new ServiceUnavailable(TRACKING_BUSY);
		let parentJob: JobToken | undefined;
		let parentRead = false;
		// The slot is held before reading disk, so repeated clicks cannot race.
		return s.admit(name, { ms: 60_000, message: "Prefill timed out" }, (signal, slot) =>
			abortable(
				(async () => {
					const item = this.withParents([await s.items.require(itemId)], (item) => item.projectId)[0]!;
					signal.throwIfAborted();
					const id = sourceId(item.projectId, "linear"),
						key = s.currentKey(id);
					if (item.kind !== "linear" || !key || s.items.checkpoint(id)?.configKey !== key)
						throw new Conflict("Sync this project's Linear source first");
					if ((s.health(id)?.nextPollAt ?? 0) > Date.now() && s.health(id)?.status !== "ok")
						throw new Conflict("Linear is unavailable right now. Try again shortly.");
					slot.sourceId = id;
					slot.key = key;
					const project = structuredClone(s.projects.require(item.projectId));
					const result = await linearPrefill(
						{
							project,
							config: project.tracking!,
							signal,
							call: (tool, args) => s.read("linear", tool, args, signal),
							observe: (event) => {
								if (event.stage !== "parent_headers") return;
								parentJob ??= s.jobDiagnostics.begin(
									"linear_parent_header",
									"linear",
									project.id,
									s.jobConfigKey(project.id) ?? "",
								);
								if (event.readAttempts && !parentRead) {
									parentRead = true;
									s.jobDiagnostics.stage(parentJob, "lookup", false);
								}
								if (event.phase === "completed")
									s.jobDiagnostics.end(
										parentJob,
										event.outcome === "partial" ? "partial" : event.count ? "success" : "no_work",
										event.reason,
										event.count,
									);
							},
						},
						item,
					);
					if (s.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
					return result;
				})(),
				signal,
			).catch((error) => {
				if (parentJob)
					s.jobDiagnostics.end(
						parentJob,
						signal.aborted ? "cancelled" : "failure",
						jobFailureReason(error, signal),
					);
				if (slot.sourceId && (error instanceof SourceRateLimited || error instanceof SourceSignInRequired)) {
					s.failed(slot.sourceId, slot.key!, error);
					s.sourcesChanged(parseSourceId(slot.sourceId)!.projectId);
				}
				throw error;
			}),
		);
	}

	/** Best effort, single flight per item, sharing the slots with all other MCP work, no retry queue. */
	start(item: TrackedItem): Promise<void> {
		const s = this.scheduler;
		if (item.kind !== "linear") return Promise.resolve();
		const name = `start:${item.id}`;
		const existing = s.slot(name);
		if (existing) return existing.promise as Promise<void>;
		if (!s.open() || !s.free()) return s.items.linearStartResult(item.id, "error");
		const id = sourceId(item.projectId, "linear");
		const key = s.currentKey(id) ?? "";
		return s.admit(
			name,
			{ ms: 60_000, message: "Linear start timed out" },
			(signal) =>
				abortable(
					(async () => {
						if (!key || s.items.checkpoint(id)?.configKey !== key)
							throw new Conflict("Sync Linear before starting");
						const health = s.health(id);
						if (health && health.status !== "ok" && health.nextPollAt > Date.now())
							throw new Conflict("Source is backing off");
						const project = structuredClone(s.projects.require(item.projectId));
						return linearStart(
							{
								project,
								config: project.tracking!,
								signal,
								call: (tool, args) => {
									signal.throwIfAborted();
									if (s.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
									if (
										JSON.stringify(s.projects.require(item.projectId).tracking?.linearStateMappings) !==
										JSON.stringify(project.tracking?.linearStateMappings)
									)
										throw new Conflict("Linear start states changed");
									return s.write("linear", tool, args, signal);
								},
							},
							item,
						);
					})(),
					signal,
				)
					.catch(() => "error" as const)
					.then((outcome) => s.items.linearStartResult(item.id, outcome)),
			{ sourceId: id, key },
		);
	}
}
