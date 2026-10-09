/** Mission orchestration: validation against projects and sessions, agent tool calls and kernel contexts. */
import type { MissionAction, MissionContext } from "@pilot/kernel";
import type {
	CreateMissionRequest,
	JoinMissionRequest,
	MissionArtifactLinkWrite,
	MissionDetail,
	MissionTask,
	SessionSummary,
	StartMissionTaskRequest,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionActor, MissionStore } from "./missions.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

const RECENT_ACTIVITY = 15;

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

function taskMessage(task: MissionTask, extra?: string): string {
	return [
		`Work on mission task #${task.number}: ${task.title}`,
		...(task.body ? ["", task.body] : []),
		...(extra?.trim() ? ["", extra.trim()] : []),
		"",
		"This task is already claimed for this chat. Start by reading the mission with the mission tool.",
	].join("\n");
}

function outline(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => /^#{1,3}\s/.test(line))
		.map((line) => line.trim())
		.slice(0, 40);
}

export class MissionService {
	private readonly store: MissionStore;
	private readonly sessions: SessionManager;
	private readonly projects: ProjectStore;
	/** Last context sent per member, so unrelated mission changes do not churn kernels or prompts. */
	private readonly contexts = new Map<string, string>();

	constructor(store: MissionStore, sessions: SessionManager, projects: ProjectStore) {
		this.store = store;
		this.sessions = sessions;
		this.projects = projects;
		sessions.setMissionBridge({
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
				return missionId ? { missionId, active: store.get(missionId)?.status === "active" } : undefined;
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
		const task = this.store.resolveTask(missionId, taskId);
		if (task.sessionId) throw new Conflict(`Task #${task.number} is already claimed by a chat`);
		if (request.message !== undefined && typeof request.message !== "string")
			throw new Error("message must be a string");
		const session = await this.sessions.spawn({
			projectId: mission.projectId,
			message: taskMessage(task, request.message),
			title: task.title,
			...(request.model ? { model: request.model } : {}),
			...(request.thinking ? { thinking: request.thinking } : {}),
			...(request.mode ? { mode: request.mode } : {}),
			...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
		});
		this.store.join(session.id, missionId);
		this.store.claimTask(missionId, task.id, session.id, {});
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
				...(write.revision !== undefined ? { revision: artifact.revision } : {}),
			},
			actor,
		);
	}

	/** One `mission` tool call from a member chat. Results are compact JSON for the model. */
	async call(sessionId: string, action: MissionAction, args: Record<string, unknown>): Promise<unknown> {
		const missionId = this.store.missionOf(sessionId);
		if (!missionId) throw new Error("This chat is not part of a mission. Ask the user to add it to one.");
		const actor = { sessionId };
		const who = (id: string | undefined) => (id === undefined ? "user" : id === sessionId ? "you" : id);
		const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
		switch (action) {
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
						chat: who(artifact.sessionId),
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
			case "tasks":
				return {
					tasks: this.store.tasks(missionId).map((task) => ({
						...task,
						resources: this.store.detail(missionId).resources.filter((resource) => resource.taskId === task.id),
						...(task.sessionId ? { sessionId: undefined, owner: who(task.sessionId) } : {}),
					})),
				};
			case "task": {
				const write = {
					...(args.title !== undefined ? { title: args.title } : {}),
					...(args.body !== undefined ? { body: args.body } : {}),
					...(args.status !== undefined ? { status: args.status } : {}),
					...(args.milestone !== undefined ? { milestone: args.milestone } : {}),
					...(args.dependsOn !== undefined ? { dependsOn: args.dependsOn } : {}),
				} as Parameters<MissionStore["addTask"]>[1];
				return args.id === undefined
					? this.store.addTask(missionId, write, actor)
					: this.store.updateTask(missionId, this.store.resolveTask(missionId, args.id).id, write, actor);
			}
			case "claim":
				if (args.id === undefined) throw new Error("claim requires the task id or number");
				return this.store.claimTask(missionId, args.id, sessionId);
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
