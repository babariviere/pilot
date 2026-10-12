/** Mission orchestration: validation against projects and sessions, agent tool calls and kernel contexts. */
import type { MissionAction, MissionContext } from "@pilot/kernel";
import type {
	CreateMissionRequest,
	JoinMissionRequest,
	MissionArtifactLinkWrite,
	MissionArtifactLink,
	MissionResource,
	MissionDetail,
	MissionTask,
	SessionSummary,
	StartMissionTaskRequest,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { MissionNotices } from "./mission-notices.ts";
import { CoordinatorCompaction } from "./coordinator-compaction.ts";
import { parseTaskRefs } from "./mission-task-refs.ts";
import { type MissionActor, type MissionStore, normalizeResourceWrite } from "./missions.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

const RECENT_ACTIVITY = 15;
const RECENT_USER_NOTES = 15;

/** Sent to a chat that just became a mission, so it drafts the shared state from its own conversation. */
export function draftMessage(title: string): string {
	return [
		`This chat is now part of the mission "${title}", which you coordinate.`,
		"Using the mission tool, draft the shared mission state from our conversation so far:",
		"- update the goal (one or two sentences),",
		"- write the brief: the spec of what we are building, with scope, design decisions so far and open questions,",
		"- record decisions we have already agreed on with decide,",
		"- create the initial tasks, each small enough for one chat, with dependencies where order matters.",
		"Do not start implementing tasks. Reply with a short summary so I can review the mission.",
	].join("\n");
}

function taskMessage(
	task: MissionTask,
	extra?: string,
	artifacts: MissionArtifactLink[] = [],
	links: Pick<MissionResource, "url" | "kind" | "title" | "externalId">[] = [],
): string {
	const line = (value: string) => value.replace(/\s+/g, " ").trim();
	const message = [
		`Work on mission task #${task.number}: ${task.title}`,
		...(task.body ? ["", task.body] : []),
		...(extra?.trim() ? ["", extra.trim()] : []),
		...(artifacts.length || links.length
			? [
					"",
					"Task references. Read them as needed; their content is not included here:",
					...artifacts
						.toSorted((a, b) => a.artifactId.localeCompare(b.artifactId))
						.map(
							(item) =>
								`- ${line(item.title)} (${item.kind}): ${item.artifactId}${item.revision === undefined ? "" : `, revision ${item.revision}`}`,
						),
					...links.map((item) => `- ${line(item.title ?? item.externalId ?? "Link")} (${item.kind}): ${item.url}`),
				]
			: []),
		"",
		"This task is already claimed for this chat. Start by reading the mission with the mission tool.",
	].join("\n");
	if (message.length > 4000)
		throw new Error(
			`Opening message is too long (${message.length} characters; max 4000). Shorten the task body, message or references. Put durable context in the brief, decisions or task links.`,
		);
	return message;
}

function outline(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => /^#{1,3}\s/.test(line))
		.map((line) => line.trim())
		.slice(0, 40);
}

export class MissionService {
	readonly notices: MissionNotices;
	readonly compaction: CoordinatorCompaction;
	private readonly store: MissionStore;
	private readonly sessions: SessionManager;
	private readonly projects: ProjectStore;
	/** Last context sent per member, so unrelated mission changes do not churn kernels or prompts. */
	private readonly contexts = new Map<string, string>();

	constructor(store: MissionStore, sessions: SessionManager, projects: ProjectStore) {
		this.store = store;
		this.sessions = sessions;
		this.projects = projects;
		this.notices = new MissionNotices(store, sessions);
		this.compaction = new CoordinatorCompaction(store, sessions);
		sessions.setMissionBridge({
			noticeAllowed: (sessionId, requestId) => store.noticeAllowed(sessionId, requestId),
			spawnProject: (missionId) => {
				const mission = store.require(missionId);
				if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
				return mission.projectId;
			},
			joinSpawn: (sessionId, missionId) => {
				const mission = store.require(missionId);
				if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
				this.assertSameProject(sessionId, missionId);
				store.join(sessionId, missionId);
			},
			membership: (sessionId) => {
				const missionId = store.missionOf(sessionId);
				const mission = missionId ? store.get(missionId) : undefined;
				return mission
					? {
							missionId: mission.id,
							active: mission.status === "active",
							coordinator: mission.coordinatorSessionId === sessionId,
						}
					: undefined;
			},
			context: (sessionId) => this.context(sessionId),
			call: (sessionId, call) => this.call(sessionId, call.action, call.args as Record<string, unknown>),
			pullRequestCreated: (sessionId, url) => this.linkPullRequests(sessionId, [url]),
			pullRequestsDiscovered: (sessionId, urls) => this.linkPullRequests(sessionId, urls),
			linkedPullRequests: () =>
				store
					.list()
					.filter((mission) => mission.status === "active")
					.flatMap((mission) => {
						const project = projects.get(mission.projectId);
						if (!project) return [];
						return store
							.detail(mission.id)
							.resources.filter((resource) => resource.taskId && resource.kind === "github.pr")
							.map((resource) => ({ url: resource.url, cwd: project.path, pullRequest: resource.pullRequest }));
					}),
			pullRequestUpdated: (pr) => store.updatePullRequest(pr),
		});
		store.onMembershipChange((sessionId) => {
			const context = this.context(sessionId);
			this.contexts.set(sessionId, JSON.stringify(context ?? null));
			sessions.missionChanged(sessionId, context);
		});
		store.onChange((missionId) => {
			if (!store.get(missionId)) return;
			sessions.refreshMissionPullRequests();
			for (const sessionId of store.members(missionId)) {
				const context = this.context(sessionId);
				const key = JSON.stringify(context ?? null);
				if (this.contexts.get(sessionId) === key) continue;
				this.contexts.set(sessionId, key);
				sessions.missionChanged(sessionId, context);
			}
		});
	}

	context(sessionId: string): MissionContext | undefined {
		const missionId = this.store.missionOf(sessionId);
		const mission = missionId ? this.store.get(missionId) : undefined;
		if (!mission) return undefined;
		const detail = this.store.detail(mission.id);
		return {
			id: mission.id,
			title: mission.title,
			goal: mission.goal,
			status: mission.status,
			coordinator: !mission.coordinatorSessionId
				? "user"
				: mission.coordinatorSessionId === sessionId
					? "self"
					: "other",
			tasks: detail.tasks
				.filter((task) => task.sessionId === sessionId && task.status !== "done" && task.status !== "dropped")
				.map((task) => ({ number: task.number, title: task.title, status: task.status })),
			decisions: detail.decisions.map((decision) => decision.text),
		};
	}

	private linkPullRequests(sessionId: string, urls: string[]): void {
		const id = this.store.missionOf(sessionId);
		if (!id) return;
		const tasks = this.store
			.tasks(id)
			.filter((task) => task.sessionId === sessionId && task.status !== "done" && task.status !== "dropped");
		for (const task of tasks)
			for (const url of urls) this.store.addResource(id, { url, taskId: task.id }, { sessionId });
	}

	private session(id: string): SessionSummary {
		const session = this.sessions.get(id);
		if (!session) throw new NotFound(`Unknown session: ${id}`);
		return session;
	}

	private assertSameProject(sessionId: string, missionId: string): void {
		const mission = this.store.require(missionId);
		const session = this.session(sessionId);
		if (session.projectId !== mission.projectId)
			throw new Conflict("A chat can only join a mission of its own project");
	}

	async create(request: CreateMissionRequest): Promise<MissionDetail> {
		if (!request || typeof request !== "object") throw new Error("Expected a mission object");
		if (typeof request.projectId !== "string") throw new Error("projectId is required");
		this.projects.require(request.projectId);
		const from = request.fromSessionId;
		if (from !== undefined) {
			const session = this.session(from);
			if (session.projectId !== request.projectId) throw new Conflict("The chat belongs to another project");
			if (session.archivedAt !== undefined) throw new Conflict("Restore the archived chat first");
		}
		const mission = this.store.create(request);
		if (from !== undefined) {
			this.store.join(from, mission.id);
			if (request.coordinator !== false) this.store.update(mission.id, { coordinatorSessionId: from });
			// The mission exists either way; a chat that cannot take input now can still be asked later.
			if (request.draft !== false)
				await this.sessions
					.send(from, draftMessage(mission.title), "followUp")
					.catch((error: unknown) => console.warn(`pilotd: could not ask ${from} to draft its mission: ${error}`));
		}
		return this.store.detail(mission.id);
	}

	join(sessionId: string, request: JoinMissionRequest): SessionSummary {
		if (!request || typeof request.missionId !== "string") throw new Error("missionId is required");
		this.assertSameProject(sessionId, request.missionId);
		if (request.taskId !== undefined) {
			const task = this.store.resolveTask(request.missionId, request.taskId);
			// Joining can detach previous work. Reject stale task picks before any membership changes.
			// There is no await between this check and claimTask, so another claim cannot interleave.
			if (task.sessionId && task.sessionId !== sessionId)
				throw new Conflict(`Task #${task.number} is already claimed by another chat`);
		}
		this.store.join(sessionId, request.missionId);
		if (request.taskId !== undefined) this.store.claimTask(request.missionId, request.taskId, sessionId, {});
		return this.session(sessionId);
	}

	leave(sessionId: string): SessionSummary {
		this.session(sessionId);
		this.store.leave(sessionId);
		return this.session(sessionId);
	}

	/** A new chat in the mission's project that joins and claims the task before its first turn. */
	async startTask(missionId: string, taskId: string, request: StartMissionTaskRequest = {}): Promise<SessionSummary> {
		const mission = this.store.require(missionId);
		let task = this.store.resolveTask(missionId, taskId);
		if (task.sessionId) throw new Conflict(`Task #${task.number} is already claimed by a chat`);
		if (request.message !== undefined && typeof request.message !== "string")
			throw new Error("message must be a string");
		const selection = await this.sessions.selectTaskModel(
			this.projects.require(mission.projectId).path,
			request.model,
			request.thinking,
		);
		// Recheck claims after model/settings I/O.
		if (this.store.resolveTask(missionId, taskId).sessionId)
			throw new Conflict(`Task #${task.number} is already claimed by a chat`);
		for (const key of ["artifacts", "links"] as const)
			if (request[key] !== undefined && (!Array.isArray(request[key]) || request[key].length > 40))
				throw new Error(`${key} must be an array of at most 40 references`);
		// Validate everything before saving anything or spawning. Member artifact discovery reads
		// metadata only, in bounded batches, and never wakes workers or scans other projects.
		const links = (request.links ?? []).map(normalizeResourceWrite);
		const artifacts: MissionArtifactLink[] = [];
		const linked = this.store.detail(missionId).artifacts;
		const owners = new Map(linked.map((item) => [item.artifactId, item.sessionId]));
		const wanted = new Set<string>();
		for (const ref of request.artifacts ?? []) {
			if (!ref || typeof ref.artifactId !== "string" || !ref.artifactId.trim() || ref.artifactId.length > 128)
				throw new Error("artifacts require artifactId");
			if (ref.revision !== undefined && (!Number.isSafeInteger(ref.revision) || ref.revision < 1))
				throw new Error("artifact revision must be a positive integer");
			if (!owners.has(ref.artifactId)) wanted.add(ref.artifactId);
		}
		const members = this.store.members(missionId);
		for (let i = 0; wanted.size && i < members.length; i += 4) {
			const lists = await Promise.all(members.slice(i, i + 4).map((id) => this.sessions.artifacts(id)));
			for (const items of lists)
				for (const item of items) if (wanted.delete(item.id)) owners.set(item.id, item.sessionId);
		}
		for (const ref of request.artifacts ?? []) {
			const owner = owners.get(ref.artifactId);
			if (!owner)
				throw new Conflict(
					`Artifact ${ref.artifactId} must already be linked to this mission or owned by a member chat`,
				);
			const item = await this.sessions.artifact(owner, ref.artifactId, ref.revision);
			const value: MissionArtifactLink = {
				artifactId: item.id,
				sessionId: owner,
				title: item.title,
				kind: item.kind,
				...(ref.revision !== undefined ? { revision: item.revision } : {}),
				taskId: task.id,
				linkedAt: 0,
			};
			const previous = artifacts.findIndex((item) => item.artifactId === value.artifactId);
			if (previous < 0) artifacts.push(value);
			else artifacts[previous] = value;
		}
		const detail = this.store.detail(missionId);
		task = this.store.resolveTask(missionId, task.id);
		const taskArtifacts = detail.artifacts
			.filter((item) => item.taskId === task.id && !artifacts.some((ref) => ref.artifactId === item.artifactId))
			.concat(artifacts);
		const taskLinks = detail.resources.filter((item) => item.taskId === task.id);
		const newLinks = links.filter(
			(item, index) =>
				!taskLinks.some((ref) => ref.url === item.url) && links.findIndex((ref) => ref.url === item.url) === index,
		);
		const message = taskMessage(task, request.message, taskArtifacts, [...taskLinks, ...newLinks]);
		// Async artifact reads may race a claim or membership change. Recheck before writes.
		if (this.store.resolveTask(missionId, task.id).sessionId)
			throw new Conflict(`Task #${task.number} is already claimed by a chat`);
		for (const item of artifacts)
			if (
				this.store.missionOf(item.sessionId) !== missionId &&
				!detail.artifacts.some((ref) => ref.artifactId === item.artifactId && ref.sessionId === item.sessionId)
			)
				throw new Conflict("That artifact's chat is no longer in this mission");
		this.store.attachTaskReferences(missionId, task.id, artifacts, newLinks);
		const session = await this.sessions.spawn({
			projectId: mission.projectId,
			message,
			title: task.title,
			...selection,
			...(request.mode ? { mode: request.mode } : {}),
			...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
		});
		this.store.join(session.id, missionId);
		this.store.claimTask(missionId, task.id, session.id, {});
		this.store.recordTaskStart(missionId, task.id, selection.model, selection.thinking);
		return this.session(session.id);
	}

	async linkArtifact(missionId: string, write: MissionArtifactLinkWrite, actor: MissionActor = {}) {
		if (!write || typeof write.sessionId !== "string" || typeof write.artifactId !== "string")
			throw new Error("sessionId and artifactId are required");
		if (this.store.missionOf(write.sessionId) !== missionId) throw new Conflict("That chat is not in this mission");
		const artifact = await this.sessions.artifact(write.sessionId, write.artifactId, write.revision);
		return this.store.linkArtifact(
			missionId,
			{
				sessionId: write.sessionId,
				artifactId: artifact.id,
				title: artifact.title,
				kind: artifact.kind,
				...(write.taskId !== undefined ? { taskId: write.taskId } : {}),
				...(write.revision !== undefined ? { revision: artifact.revision } : {}),
			},
			actor,
		);
	}

	/** One `mission` tool call from a member chat. Results are compact JSON for the model. */
	async call(sessionId: string, action: MissionAction, args: Record<string, unknown>): Promise<unknown> {
		const missionId = this.store.missionOf(sessionId);
		if (!missionId) throw new Error("This chat is not part of a mission. Ask the user to add it to one.");
		const mission = this.store.require(missionId);
		if (
			(["delete", "group", "start", "send", "status"].includes(action) ||
				(action === "task" && args.order !== undefined)) &&
			mission.coordinatorSessionId !== sessionId
		)
			throw new Conflict(`Only the mission coordinator can use ${action}`);
		const actor = { sessionId };
		const who = (id: string | undefined) => (id === undefined ? "user" : id === sessionId ? "you" : id);
		const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
		switch (action) {
			case "delete": {
				if (typeof args.id !== "string" || !args.id.trim())
					throw new Error("delete requires the task id or number");
				const task = this.store.resolveTask(missionId, args.id);
				this.store.removeTask(missionId, task.id, actor);
				return { id: task.id, number: task.number, deleted: true };
			}
			case "group": {
				if (args.id !== undefined) throw new Error("group requires ids, not id");
				if (!Array.isArray(args.ids)) throw new Error("group requires an ids array");
				if (typeof args.milestone !== "string")
					throw new Error("group requires milestone (use an empty string to clear)");
				return {
					tasks: this.store
						.groupTasks(missionId, parseTaskRefs(args.ids, "group"), args.milestone, actor)
						.map((task) => ({ id: task.id, number: task.number, milestone: task.milestone ?? "" })),
				};
			}
			case "start":
				if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
				if (typeof args.id !== "string" || !args.id.trim()) throw new Error("start requires the task id or number");
				return this.startTask(missionId, args.id, {
					...(args.message !== undefined ? { message: args.message as string } : {}),
					...(args.model !== undefined ? { model: args.model as string } : {}),
					...(args.thinking !== undefined ? { thinking: args.thinking as string } : {}),
					...(args.artifacts !== undefined
						? { artifacts: args.artifacts as StartMissionTaskRequest["artifacts"] }
						: {}),
					...(args.links !== undefined ? { links: args.links as StartMissionTaskRequest["links"] } : {}),
				});
			case "send": {
				if (typeof args.targetSessionId !== "string" || !args.targetSessionId.trim())
					throw new Error("send requires targetSessionId");
				if (this.store.missionOf(args.targetSessionId) !== missionId)
					throw new Conflict("That chat is not in this mission");
				if (typeof args.message !== "string" || !args.message.trim()) throw new Error("send requires message");
				await this.sessions.send(args.targetSessionId, args.message, "followUp");
				return { sessionId: args.targetSessionId, sent: true };
			}
			case "status": {
				const tasks = this.store.tasks(missionId);
				return {
					members: this.sessions.list({ missionId, archived: "all" }).map((member) => ({
						id: member.id,
						title: member.title,
						coordinator: member.id === mission.coordinatorSessionId,
						state: member.state,
						...(member.outcome !== undefined ? { outcome: member.outcome } : {}),
						...(member.outcomeAt !== undefined ? { outcomeAt: member.outcomeAt } : {}),
						...(member.outcomeReason !== undefined ? { outcomeReason: member.outcomeReason } : {}),
						...(member.archivedAt !== undefined ? { archivedAt: member.archivedAt } : {}),
						...(member.error !== undefined ? { error: member.error } : {}),
						tasks: tasks
							.filter((task) => task.sessionId === member.id)
							.map((task) => ({ number: task.number, title: task.title, status: task.status })),
					})),
				};
			}
			case "get": {
				const detail = this.store.detail(missionId);
				const { mission } = detail;
				const number = new Map(detail.tasks.map((task) => [task.id, task.number]));
				return {
					mission: {
						title: mission.title,
						goal: mission.goal,
						status: mission.status,
						coordinator: who(mission.coordinatorSessionId),
					},
					you: sessionId,
					brief: { revision: mission.briefRevision, outline: outline(detail.brief?.markdown ?? "") },
					decisions: detail.decisions.map((decision) => decision.text),
					tasks: detail.tasks
						.filter((task) => task.status !== "done" && task.status !== "dropped")
						.map((task) => ({
							id: task.id,
							number: task.number,
							title: task.title,
							status: task.status,
							resources: detail.resources.filter((resource) => resource.taskId === task.id),
							artifacts: detail.artifacts.filter((artifact) => artifact.taskId === task.id),
							...(task.sessionId ? { owner: who(task.sessionId) } : {}),
							...(task.milestone ? { milestone: task.milestone } : {}),
							...(task.dependsOn?.length
								? { dependsOn: task.dependsOn.map((dep) => number.get(dep) ?? dep) }
								: {}),
						})),
					doneTasks: detail.tasks.filter((task) => task.status === "done").length,
					openComments: detail.comments
						.filter((comment) => comment.resolvedAt === undefined)
						.map((comment) => ({
							id: comment.id,
							text: comment.text,
							...(comment.anchor ? { anchor: comment.anchor } : {}),
							by: who(comment.authorSessionId),
							...(comment.targetSessionId ? { to: who(comment.targetSessionId) } : {}),
						})),
					resources: detail.resources.map((resource) => ({
						...(resource.taskId ? { taskId: resource.taskId } : {}),
						url: resource.url,
						kind: resource.kind,
						...(resource.title ? { title: resource.title } : {}),
						...(resource.externalId ? { externalId: resource.externalId } : {}),
						...(resource.pullRequest ? { pullRequest: resource.pullRequest } : {}),
					})),
					artifacts: detail.artifacts.map((artifact) => ({
						title: artifact.title,
						kind: artifact.kind,
						artifactId: artifact.artifactId,
						...(artifact.taskId ? { taskId: artifact.taskId } : {}),
						...(artifact.revision !== undefined ? { revision: artifact.revision } : {}),
						chat: who(artifact.sessionId),
					})),
					recentUserNotes: this.store.userNotes(missionId, RECENT_USER_NOTES).map((event) => ({
						kind: event.kind,
						text: event.text,
						by: "user",
						at: new Date(event.at).toISOString(),
						...(event.health ? { health: event.health } : {}),
					})),
					recentActivity: detail.events.slice(0, RECENT_ACTIVITY).map((event) => ({
						kind: event.kind,
						text: event.text,
						by: who(event.sessionId),
						at: new Date(event.at).toISOString(),
					})),
				};
			}
			case "brief": {
				if (args.markdown !== undefined) {
					const brief = this.store.writeBrief(missionId, args.markdown, args.expectedRevision, actor);
					return { revision: brief.revision };
				}
				const revision = typeof args.revision === "number" ? args.revision : undefined;
				const brief = this.store.brief(missionId, revision);
				return brief
					? { revision: brief.revision, markdown: brief.markdown, by: who(brief.authorSessionId) }
					: {
							revision: 0,
							markdown: "",
							note: "The brief is empty. Write it with markdown and expectedRevision 0.",
						};
			}
			case "update": {
				const mission = this.store.update(
					missionId,
					{
						...(str("title") !== undefined ? { title: str("title") } : {}),
						...(str("goal") !== undefined ? { goal: str("goal") } : {}),
					},
					actor,
				);
				return { title: mission.title, goal: mission.goal };
			}
			case "tasks": {
				const detail = this.store.detail(missionId);
				return {
					tasks: detail.tasks.map((task) => ({
						...task,
						resources: detail.resources.filter((resource) => resource.taskId === task.id),
						artifacts: detail.artifacts.filter((artifact) => artifact.taskId === task.id),
						...(task.sessionId ? { sessionId: undefined, owner: who(task.sessionId) } : {}),
					})),
				};
			}
			case "task": {
				const write = {
					...(args.title !== undefined ? { title: args.title } : {}),
					...(args.body !== undefined ? { body: args.body } : {}),
					...(args.status !== undefined ? { status: args.status } : {}),
					...(args.order !== undefined ? { order: args.order } : {}),
					...(args.milestone !== undefined ? { milestone: args.milestone } : {}),
					...(args.dependsOn !== undefined ? { dependsOn: args.dependsOn } : {}),
				} as Parameters<MissionStore["addTask"]>[1];
				return args.id === undefined
					? this.store.addTask(missionId, write, actor)
					: this.store.updateTask(missionId, this.store.resolveTask(missionId, args.id).id, write, actor);
			}
			case "claim": {
				if (args.id !== undefined && args.ids !== undefined) throw new Error("claim accepts id or ids, not both");
				if (args.ids !== undefined && !Array.isArray(args.ids)) throw new Error("claim ids must be an array");
				if (args.id === undefined && args.ids === undefined) throw new Error("claim requires id or ids");
				if (args.id !== undefined && typeof args.id !== "string" && typeof args.id !== "number")
					throw new Error("claim id must be a task ID, number or range");
				const refs = parseTaskRefs(args.ids ?? args.id);
				// Preserve the single-id result and conflict error for existing callers.
				const batch =
					args.ids !== undefined || (typeof args.id === "string" && /,|^#?\d+\s*-\s*#?\d+$/.test(args.id.trim()));
				return batch
					? this.store.claimTasks(missionId, refs, sessionId)
					: this.store.claimTask(missionId, refs[0], sessionId);
			}
			case "decide":
				return this.store.addDecision(missionId, args.text, actor);
			case "comment":
				return this.store.addComment(
					missionId,
					{
						text: str("text") as string,
						...(str("anchor") ? { anchor: str("anchor") } : {}),
						...(str("targetSessionId") ? { targetSessionId: str("targetSessionId") } : {}),
					},
					actor,
				);
			case "resolve":
				if (typeof args.id !== "string") throw new Error("resolve requires the comment id");
				return this.store.resolveComment(missionId, args.id, actor);
			case "attach":
				if (typeof args.artifactId !== "string") throw new Error("attach requires artifactId");
				return this.linkArtifact(
					missionId,
					{
						sessionId,
						artifactId: args.artifactId,
						...(args.taskId !== undefined ? { taskId: args.taskId as string } : {}),
						...(typeof args.artifactRevision === "number" ? { revision: args.artifactRevision } : {}),
					},
					actor,
				);
			case "link":
				return this.store.addResource(
					missionId,
					{
						url: str("url") as string,
						...(str("title") ? { title: str("title") } : {}),
						...(args.taskId !== undefined ? { taskId: args.taskId as string } : {}),
					},
					actor,
				);
			case "log":
				return this.store.log(
					missionId,
					{
						text: str("text") as string,
						...(args.kind !== undefined ? { kind: args.kind as "update" | "handoff" } : {}),
						...(args.health !== undefined ? { health: args.health as "on_track" } : {}),
					},
					actor,
				);
			default:
				throw new Error(`Unknown mission action: ${String(action)}`);
		}
	}
}
