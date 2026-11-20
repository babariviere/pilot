import { object, string } from "../../sources/linear/linear-source-json.ts";
import type { MissionStore } from "../missions.ts";
import { RuntimeBackground } from "../../runtime/lifecycle/runtime-background.ts";
import type { SourceMcpClient } from "../../sources/auth/source-mcp.ts";
import { SOURCE_REFRESH_CADENCE_MS, SOURCE_REFRESH_TIMEOUT_MS, type SourcePollContext } from "../../sources/refresh/source-poll.ts";
import { SourceRateLimited, SourceSignInRequired } from "../../sources/source-tool-rules.ts";

type TaskPollContext = Pick<SourcePollContext, "call" | "signal"> & { project?: { id: string } };

/** Read only linked issues. Global scheduling needs no Inbox team selection.
 * Rotate through 25 links per poll so large projects cannot monopolize the source. */
export function createMissionLinearPoller(store: MissionStore): (context: TaskPollContext) => Promise<void> {
	const positions = new Map<string | undefined, string>();
	return async (context) => {
		const projectId = context.project?.id;
		let links = store.linearTaskLinks(projectId, positions.get(projectId));
		if (!links.length) links = store.linearTaskLinks(projectId);
		if (!links.length) {
			positions.delete(projectId);
			return;
		}
		const me = string(object(await context.call("me", { query: "me" })).id, 200);
		const names = new Map<string, string>();
		for (const link of links) {
			context.signal.throwIfAborted();
			try {
				const issue = object(
					// Linear's get_issue refuses "identifier"; its "id" is the identifier.
					await context.call("issue", { id: link.issueId, fields: ["id", "uuid", "assigneeId"] }),
				);
				// The URL's identifier and the API's UUID may differ. Never accept a different issue.
				if (issue.id !== link.issueId && issue.uuid !== link.issueId && issue.identifier !== link.issueId)
					throw new Error("Wrong linked Linear issue returned");
				let assignee: { id: string; name: string } | null = null;
				if (issue.assigneeId !== null) {
					const id = string(issue.assigneeId, 200);
					let name = names.get(id);
					if (!name) {
						if (id === me) name = "you";
						else {
							const user = object(await context.call("me", { query: id }));
							if (user.id !== id) throw new Error("Wrong Linear user returned");
							name = string(user.displayName ?? user.name, 500);
						}
						names.set(id, name);
					}
					assignee = { id, name };
				}
				context.signal.throwIfAborted();
				store.observeLinearAssignee(link.projectId, link.resourceId, assignee, me);
			} catch (error) {
				context.signal.throwIfAborted();
				// One inaccessible/malformed issue leaves its task unchanged, without starving other links.
				// Authentication and rate limits end the current pass.
				if (error instanceof SourceRateLimited || error instanceof SourceSignInRequired) throw error;
			}
			positions.set(projectId, link.resourceId);
		}
	};
}

/** Uses the Inbox cadence and the same MCP client. The client, not the Inbox scheduler, limits shared calls.
 * One global batch, one in-flight run, bounded deadline, no Linear writes or new credentials. */
export class MissionLinearSource {
	readonly runtime = new RuntimeBackground(
		"linked-linear",
		() => {
			if (this.started) this.start();
		},
		() => {
			clearTimeout(this.timer);
			this.timer = undefined;
		},
	);
	private started = false;
	private timer?: ReturnType<typeof setTimeout>;
	private run?: { controller: AbortController; promise: Promise<void> };
	private stopped = false;
	private readonly poll: ReturnType<typeof createMissionLinearPoller>;
	private readonly mcp: SourceMcpClient;
	constructor(store: MissionStore, mcp: SourceMcpClient) {
		this.mcp = mcp;
		this.poll = createMissionLinearPoller(store);
	}
	start(): void {
		this.started = true;
		if (!this.stopped && !this.timer && !this.run) this.schedule(0);
	}
	private schedule(delay: number): void {
		if (this.stopped || this.runtime.frozen) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const controller = new AbortController();
			const deadline = setTimeout(
				() => controller.abort(new Error("Linked Linear poll timed out")),
				SOURCE_REFRESH_TIMEOUT_MS,
			);
			let next = SOURCE_REFRESH_CADENCE_MS;
			const promise = this.runtime
				.run("poll", () =>
					this.poll({
						signal: controller.signal,
						call: (tool, args) => this.mcp.call("linear", tool, args, controller.signal),
					}),
				)
				.catch((error) => {
					if (error instanceof SourceRateLimited) next = Math.max(next, error.retryAfterMs);
					// An unavailable source leaves task statuses unchanged; retry on the next cadence.
				})
				.finally(() => {
					clearTimeout(deadline);
					this.run = undefined;
					this.schedule(next);
				});
			this.run = { controller, promise };
		}, delay);
		this.timer.unref();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.run?.controller.abort(new Error("Linked Linear polling stopped"));
		await this.run?.promise;
	}
}
