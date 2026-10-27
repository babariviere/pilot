/** Mission orchestration: validation against projects and sessions, agent tool calls and kernel contexts. */
import { randomUUID } from "node:crypto";
import type { MissionAction, MissionContext } from "@pilot/kernel";
import type {
	ArtifactRevision,
	CreateMissionRequest,
	JoinMissionRequest,
	MissionArtifactLink,
	MissionArtifactLinkWrite,
	MissionDetail,
	MissionEvent,
	MissionEventKind,
	MissionLifecycleRequest,
	MissionResource,
	MissionTask,
	MissionTaskWrite,
	SessionSummary,
	StartMissionCoordinatorRequest,
	StartMissionTaskRequest,
} from "@pilot/protocol";
import { CoordinatorCompaction } from "./coordinator-compaction.ts";
import { Conflict, NotFound } from "./errors.ts";
import { type LinearClosingGuard, linearPrGuidance, unavailableClosingGuard } from "./mission-linear-pr-guidance.ts";
import { MissionNotices } from "./mission-notices.ts";
import { parseTaskRefs } from "./mission-task-refs.ts";
import { MissionTicketReader } from "./mission-ticket-context.ts";
import { splitTicket } from "./mission-ticket-work.ts";
import { type MissionActivityQuery, type MissionActor, type MissionStore, normalizeResourceWrite } from "./missions.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import type { SourceMcpClient } from "./source-mcp.ts";
import { validateBaseBranch } from "./workspaces.ts";

/** Sent to a chat that just became a mission, so it drafts the shared state from its own conversation. */
export function draftMessage(title: string): string {
	return [
		`This chat is now part of the mission "${title}", which you coordinate.`,
		"Using the mission tool, draft the shared mission state from our conversation so far:",
		"- set a short goal and draft the brief (scope and requirements),",
		"- record agreed choices with decide,",
		"- create tasks with current status, each small enough for one chat, and dependencies where order matters.",
		"Do not start implementing tasks. Reply with a short summary so I can review the mission.",
	].join("\n");
}

function taskMessage(
	tasks: MissionTask[],
	extra?: string,
	artifacts: MissionArtifactLink[] = [],
	links: Pick<MissionResource, "url" | "kind" | "title" | "externalId">[] = [],
	continuing = false,
): string {
	const task = tasks[0]!;
	const line = (value: string) => value.replace(/\s+/g, " ").trim();
	const message = [
		...(tasks.length === 1
			? [
					`${continuing ? "Continue" : "Work on"} mission task #${task.number}: ${task.title}`,
					...(task.body ? ["", task.body] : []),
				]
			: [
					"Work on these mission tasks in order:",
					...tasks.flatMap((item) => ["", `#${item.number}: ${item.title}`, ...(item.body ? [item.body] : [])]),
					"",
					"Open one PR per task. Base the first on the requested starting branch, then each PR on the previous task's head with gh pr create --base <previous-head> --head <own-head>. Link PR URLs bottom-to-top with gh stack link. Attribute each PR with mission link + taskId. Keep plain chained PRs if stacks are unavailable.",
				]),
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
					// New links use request order; persisted links can tie on timestamp and sort by random IDs.
					...links
						.toSorted((a, b) => a.url.localeCompare(b.url))
						.map((item) => `- ${line(item.title ?? item.externalId ?? "Link")} (${item.kind}): ${item.url}`),
				]
			: []),
		"",
		tasks.length === 1
			? continuing
				? "This task is already claimed for this chat. Continue where you stopped, and read the mission with the mission tool."
				: "This task is already claimed for this chat. Start by reading the mission with the mission tool."
			: "All these tasks are already claimed for this chat. Start by reading the mission with the mission tool.",
	].join("\n");
	if (message.length > 4000)
		throw new Error(
			`Opening message is too long (${message.length} characters; max 4000). Shorten the task body, message or references. Put durable context in the brief, decisions or task links.`,
		);
	return message;
}

/** The app's Start chat acts for the user; the coordinator's start must respect user-set preferences. */
export type TaskStarter = "user" | "coordinator";

/**
 * An explicit start choice wins, else the tasks' preferred model (a user-set one first), else the project's
 * default. The coordinator cannot pick a model or thinking level that differs from a user-set preference.
 */
function taskModelChoice(
	tasks: MissionTask[],
	request: StartMissionTaskRequest,
	by: TaskStarter,
): { model?: string; thinking?: string; preferredBy?: MissionTask } {
	const requested = typeof request.model === "string" ? request.model.trim() : request.model;
	if (by === "coordinator")
		for (const task of tasks) {
			if (task.preferredModelSetBy !== "user") continue;
			const thinking = task.preferredThinking;
			if (
				(requested !== undefined && requested !== task.preferredModel) ||
				(request.thinking !== undefined && thinking !== undefined && request.thinking !== thinking)
			)
				throw new Conflict(
					`Task #${task.number} has a user-set preferred model (${task.preferredModel}${thinking ? `, thinking ${thinking}` : ""}). Omit model and thinking to use it.`,
				);
		}
	const preferred =
		tasks.find((task) => task.preferredModelSetBy === "user") ?? tasks.find((task) => task.preferredModel);
	if (!preferred?.preferredModel || (requested !== undefined && requested !== preferred.preferredModel))
		return { model: request.model, thinking: request.thinking };
	return {
		model: preferred.preferredModel,
		thinking: request.thinking ?? preferred.preferredThinking,
		...(requested === undefined ? { preferredBy: preferred } : {}),
	};
}

export class MissionService {
	private linearClosingGuard: LinearClosingGuard = unavailableClosingGuard;
	setLinearClosingGuard(guard: LinearClosingGuard): void {
		this.linearClosingGuard = guard;
	}
	prGuidance(missionId: string, taskId: string) {
		return linearPrGuidance(this.store, missionId, taskId, this.linearClosingGuard);
	}
	private ticketReader?: MissionTicketReader;
	setLinearReader(mcp: SourceMcpClient): void {
		this.ticketReader = new MissionTicketReader(mcp);
	}
	private sharing?: import("./retired-devboxes.ts").LegacyMissionOwnership;
	setSharedContext(sharing: import("./retired-devboxes.ts").LegacyMissionOwnership): void {
		this.sharing = sharing;
		this.notices.setRemoteOccupied((missionId) => sharing.remoteOccupied(missionId));
	}
	readonly notices: MissionNotices;
	readonly compaction: CoordinatorCompaction;
	private readonly store: MissionStore;
	private readonly sessions: SessionManager;
	private readonly projects: ProjectStore;
	/** Last context sent per member, so unrelated mission changes do not churn kernels or prompts. */
	private readonly contexts = new Map<string, string>();
	/** Canonical mission/task keys reserved before any asynchronous start preparation. */
	private readonly taskStarts = new Set<string>();
	/** Scoped to an explicit user start, including the final synchronous spawn admission. */
	private readonly phaseOverrides = new Set<string>();

	constructor(store: MissionStore, sessions: SessionManager, projects: ProjectStore) {
		this.store = store;
		this.sessions = sessions;
		this.projects = projects;
		this.notices = new MissionNotices(store, sessions);
		this.compaction = new CoordinatorCompaction(store, sessions);
		sessions.setMissionBridge({
			continueSession: (from, to) => store.continueSession(from, to),
			noticeAllowed: (sessionId, requestId) => this.notices.allowed(sessionId, requestId),
			spawnProject: (missionId) => {
				const mission = store.require(missionId);
				if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
				return mission.projectId;
			},
			joinSpawn: (sessionId, missionId, coordinator, taskId) => {
				const mission = store.require(missionId);
				if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
				if (coordinator && mission.coordinatorSessionId)
					throw new Conflict("The mission already has a coordinator");
				this.assertSameProject(sessionId, missionId);
				store.join(sessionId, missionId);
				// Keep claim conflicts inside spawn admission, where rejected metadata is removed.
				if (taskId !== undefined) {
					const refs = typeof taskId === "string" ? [taskId] : taskId;
					store.claimStartTasks(
						missionId,
						refs,
						sessionId,
						refs.every((ref) => this.phaseOverrides.has(`${missionId}:${ref}`)),
					);
				}
				if (coordinator) store.update(missionId, { coordinatorSessionId: sessionId });
			},
			membership: (sessionId) => {
				const shared = this.sharing?.membership(sessionId);
				return shared
					? {
							missionId: shared.grant.task.mission.missionId,
							active: shared.state === "accepted",
							coordinator: false,
						}
					: store.membership(sessionId);
			},
			leaveSpawn: (sessionId) => store.leave(sessionId),
			context: (sessionId) => this.context(sessionId),
			usageAttribution: (sessionId) => {
				const shared = this.sharing?.membership(sessionId)?.grant.task.mission;
				const missionId = shared?.missionId ?? store.missionOf(sessionId);
				const home = shared?.home ?? this.sharing?.host;
				return missionId && home ? { homeId: home.daemonId, lineageId: home.lineageId, missionId } : undefined;
			},
			missionArchivedAt: (missionId) => store.get(missionId)?.archivedAt,
			passiveMissionLifecycle: (missionId) => store.passiveLifecycle(missionId),
			renameCoordinator: (sessionId, title) => {
				const membership = store.membership(sessionId);
				if (membership?.coordinator && store.require(membership.missionId).title !== title)
					store.update(membership.missionId, { title });
			},
			call: async (sessionId, call) => {
				try {
					return await this.call(sessionId, call.action, call.args as Record<string, unknown>);
				} finally {
					// The model sees the result only after its writes are on disk.
					await store.whenDurable();
				}
			},
			whenDurable: () => store.whenDurable(),
			readArtifactReference: (sessionId, id, revision) => this.readArtifactReference(sessionId, id, revision),
			pullRequestCreated: (sessionId, url) => this.linkPullRequests(sessionId, [url]),
			githubAction: (sessionId, action) =>
				store.recordGitHubAction(sessionId, action, this.sessions.get(sessionId)?.title ?? "Chat"),
			pullRequestsDiscovered: (sessionId, urls) => this.linkPullRequests(sessionId, urls),
			validatePullRequestBinding: (sessionId, url, taskId) =>
				store.validatePullRequestBinding(sessionId, url, taskId),
			applyPullRequestBinding: (operation) => store.applyPullRequestBinding(operation),
			linkedPullRequests: () =>
				store.pullRequestMissions().flatMap((mission) => {
					const project = projects.get(mission.projectId);
					if (!project) return [];
					const linked = store
						.ownedPullRequestResources(mission.id)
						.map((resource) => ({ url: resource.url, cwd: project.path, pullRequest: resource.pullRequest }));
					const owned = store.members(mission.id).flatMap((id) => {
						const prs = sessions.ownedPullRequests(id);
						return [...new Set([...prs.map((pr) => pr.url), ...(sessions.get(id)?.boundPullRequests ?? [])])].map(
							(url) => {
								const pr = prs.find((pr) => pr.url.toLowerCase() === url.toLowerCase());
								return {
									url,
									cwd: project.path,
									pullRequest: pr ? store.memberPullRequest(mission.id, pr) : undefined,
								};
							},
						);
					});
					return [...new Map([...owned, ...linked].map((target) => [target.url.toLowerCase(), target])).values()];
				}),
			systemMessageState: (sessionId, event) => store.recordSystemMessageState(sessionId, event),
			workspaceBehind: (sessionId, text) => {
				const id = store.missionOf(sessionId);
				if (id) store.addComment(id, { text }, { sessionId });
			},
			pullRequestUpdated: (pr) => {
				const owner = sessions.pullRequestOwner(pr.url);
				const members = [...new Set([...(owner ? [owner] : []), ...store.pullRequestMembers(pr.url)])].flatMap(
					(id) => {
						const chat = sessions.get(id);
						return chat ? [chat] : [];
					},
				);
				store.updatePullRequest(pr, members, (id) =>
					store.members(id).flatMap((memberId) => sessions.ownedPullRequests(memberId)),
				);
				const projectId = owner ? sessions.get(owner)?.projectId : undefined;
				if (projectId) sessions.requestMainRefresh(projectId);
			},
		});
		store.onMembershipChange((sessionId) => {
			const context = this.context(sessionId);
			this.contexts.set(sessionId, JSON.stringify(context ?? null));
			sessions.missionChanged(sessionId, context);
		});
		store.onChange((missionId, passive, preferenceOnly) => {
			if (preferenceOnly) return;
			if (!store.get(missionId)) return;
			if (!passive) {
				sessions.refreshMissionPullRequests();
				sessions.requestMainRefresh(store.require(missionId).projectId);
			}
			for (const sessionId of store.members(missionId)) {
				const context = this.context(sessionId);
				const key = JSON.stringify(context ?? null);
				if (this.contexts.get(sessionId) === key) continue;
				this.contexts.set(sessionId, key);
				sessions.missionChanged(sessionId, context, passive);
			}
		});
	}

	/** Synchronous admission/commit excludes a previously admitted chat-archive write. */
	lifecycle(id: string, write: MissionLifecycleRequest) {
		this.sessions.assertPassiveLifecycleReady(this.store.members(id));
		return this.store.lifecycle(id, write.projectId, write.expectedStatus, write.action);
	}

	/** Resolve only persisted links. Never scan member stores or trust a worker-supplied owner/path. */
	async readArtifactReference(
		sessionId: string,
		id: string,
		revision?: number,
	): Promise<Omit<ArtifactRevision, "html">> {
		if (typeof id !== "string" || !id || id.length > 128) throw new Error("Artifact reference is not authorized");
		if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
			throw new Error("revision must be a positive integer");
		const authorize = () => {
			const missionId = this.store.missionOf(sessionId);
			if (!missionId) throw new Error("Artifact reference is not authorized");
			this.assertSameProject(sessionId, missionId);
			const refs = this.store.artifactReferences(missionId, id);
			if (!refs.length) throw new Error("Artifact reference is not authorized");
			const owners = new Set(refs.map((ref) => ref.sessionId));
			if (owners.size !== 1) throw new Error("Artifact reference has conflicting owners");
			const owner = refs[0]!.sessionId;
			// Existing links remain readable when their author leaves, but never across projects.
			this.assertSameProject(owner, missionId);
			const unpinned = refs.some((ref) => ref.revision === undefined);
			const pins = new Set(refs.map((ref) => ref.revision));
			if (revision !== undefined && !unpinned && !pins.has(revision))
				throw new Error("Artifact revision is not linked");
			if (revision === undefined && pins.size > 1)
				throw new Error("Artifact reference has conflicting revisions; specify a linked revision");
			return { missionId, owner, revision: revision ?? refs[0]!.revision };
		};
		const allowed = authorize();
		const value = await this.sessions.artifact(allowed.owner, id, allowed.revision);
		// Membership or links can change while filesystem I/O is pending. Do not disclose stale access.
		const current = authorize();
		if (
			current.missionId !== allowed.missionId ||
			current.owner !== allowed.owner ||
			current.revision !== allowed.revision
		)
			throw new Conflict("Artifact reference changed while reading; retry");
		const { html: _html, ...source } = value;
		return source;
	}

	context(sessionId: string): MissionContext | undefined {
		if (this.sharing?.membership(sessionId)) return this.sharing.context(sessionId);
		const missionId = this.store.missionOf(sessionId);
		const mission = missionId ? this.store.get(missionId) : undefined;
		if (!mission) return undefined;
		const detail = this.store.detail(mission.id, false);
		const pins = new Set(
			detail.tasks
				.filter((task) => task.sessionId === sessionId && isOpen(task))
				.flatMap((task) => task.decisionIds ?? []),
		);
		const selected = detail.decisions.filter(
			(decision) =>
				decision.audience === "all" ||
				(decision.audience === "coordinator" && mission.coordinatorSessionId === sessionId) ||
				pins.has(decision.id),
		);
		const owned = new Map(
			detail.tasks
				.filter((task) => task.sessionId === sessionId && isOpen(task))
				.map((task) => [task.id, task.number]),
		);
		const selectedIds = new Set(selected.map((decision) => decision.id));
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
			decisions: selected.map((decision) => `D${decision.number}: ${decision.text}`),
			decisionEntries: selected.map(({ id, text }) => ({ id, text })),
			decisionState: detail.decisions.map(({ id, number, text, audience }) => ({
				id,
				number,
				text,
				audience,
				selected: selectedIds.has(id),
			})),
			remainingDecisions: detail.decisions.length - selected.length,
			tickets: detail.resources
				.filter(
					(ref) =>
						ref.kind === "linear.issue" &&
						(mission.coordinatorSessionId === sessionId
							? !ref.taskId
							: ref.taskId !== undefined && owned.has(ref.taskId)),
				)
				.slice(0, 20)
				.map((ref) => ({
					resourceId: ref.id,
					url: ref.url,
					role: ref.linearRole ?? "reference",
					...(ref.taskId ? { task: owned.get(ref.taskId) } : {}),
				})),
			decisionVersion:
				JSON.stringify(detail.decisions.map(({ id, text, audience }) => [id, text, audience])) +
				JSON.stringify([...pins]),
		};
	}

	private linkPullRequests(sessionId: string, urls: string[]): void {
		this.store.linkAutomaticPullRequests(sessionId, urls);
	}

	private session(id: string): SessionSummary {
		const session = this.sessions.get(id);
		if (!session) throw new NotFound(`Unknown session: ${id}`);
		return session;
	}

	private assertSameProject(sessionId: string, missionId: string): void {
		if (this.sharing?.membership(sessionId))
			throw new Conflict("Seal/release the delegated execution before changing its mission membership");
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
		if (request.startCoordinator !== undefined && typeof request.startCoordinator !== "boolean")
			throw new Error("startCoordinator must be a boolean");
		if (from !== undefined && request.startCoordinator)
			throw new Error("startCoordinator cannot be combined with fromSessionId");
		if (from !== undefined) {
			if (request.coordinator !== undefined && typeof request.coordinator !== "boolean")
				throw new Error("coordinator must be a boolean");
			if (request.draft !== undefined && typeof request.draft !== "boolean")
				throw new Error("draft must be a boolean");
		}
		const mission =
			from === undefined
				? this.store.create(request)
				: this.store.batchChanges(() => {
						// Conversion is not an explicit move. Check and attach in one synchronous
						// transaction; notifications run only after commit, never during admission.
						const session = this.session(from);
						if (session.continuedTo) throw new Conflict("Continue in the replacement chat");
						if (session.projectId !== request.projectId)
							throw new Conflict("The chat belongs to another project");
						if (session.archivedAt !== undefined) throw new Conflict("Restore the archived chat first");
						if (
							session.control ||
							session.role !== undefined ||
							(session.mode !== undefined && session.mode !== "ask" && session.mode !== "build")
						)
							throw new Conflict("Only an ordinary Local chat can become a mission");
						if (this.sharing?.membership(from))
							throw new Conflict("Release the delegated execution before making a mission");
						if (this.store.missionOf(from) !== undefined || session.missionId !== undefined)
							throw new Conflict("The chat already belongs to a mission; conversion cannot move it");
						const mission = this.store.create(request);
						this.store.join(from, mission.id);
						if (request.coordinator !== false) this.store.update(mission.id, { coordinatorSessionId: from });
						return mission;
					});
		if (from !== undefined) {
			// The mission exists either way; a chat that cannot take input now can still be asked later.
			if (request.draft !== false)
				await this.sessions
					.send(from, draftMessage(mission.title), "followUp", `mission:draft:${randomUUID()}`)
					.catch((error: unknown) => console.warn(`pilotd: could not ask ${from} to draft its mission: ${error}`));
		}
		if (request.startCoordinator) await this.startCoordinator(mission.id, request);
		return this.store.detail(mission.id);
	}

	/** Promote inside spawn admission, before the worker sees its first input. */
	async startCoordinator(missionId: string, request: StartMissionCoordinatorRequest = {}): Promise<SessionSummary> {
		if (!request || typeof request !== "object") throw new Error("Expected coordinator start options");
		const mission = this.store.require(missionId);
		if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
		if (mission.coordinatorSessionId) throw new Conflict("The mission already has a coordinator");
		if (request.message !== undefined && typeof request.message !== "string")
			throw new Error("message must be a string");
		const message = [draftMessage(mission.title), mission.goal, request.message?.trim()].filter(Boolean).join("\n\n");
		const project = this.projects.require(mission.projectId);
		const selection = await this.sessions.selectTaskModel(
			project.path,
			request.model ?? project.model,
			request.thinking,
		);
		return this.sessions.spawn(
			{ projectId: mission.projectId, missionId, title: mission.title, message, ...selection },
			true,
		);
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

	/** Single-task UI/API entry point, sharing reservations with coordinator batches. */
	async startTask(
		missionId: string,
		taskId: string,
		request: StartMissionTaskRequest = {},
		by: TaskStarter = "user",
	): Promise<SessionSummary> {
		return this.startTasks(missionId, [taskId], request, by);
	}

	/** Reserve all canonical keys synchronously, or none, before asynchronous preparation. */
	async startTasks(
		missionId: string,
		refs: string[],
		request: StartMissionTaskRequest = {},
		by: TaskStarter = "user",
	): Promise<SessionSummary> {
		if (request.overridePhaseGating !== undefined && typeof request.overridePhaseGating !== "boolean")
			throw new Error("overridePhaseGating must be a boolean");
		if (by !== "user" && request.overridePhaseGating) throw new Conflict("Only the user can override phase gating");
		const tasks = this.store.prepareTaskStart(missionId, refs, this.taskStarts, request.overridePhaseGating);
		const keys = tasks.map((task) => `${missionId}:${task.id}`);
		for (const key of keys) this.taskStarts.add(key);
		if (request.overridePhaseGating) for (const key of keys) this.phaseOverrides.add(key);
		try {
			return await this.startReservedTasks(
				missionId,
				tasks.map((task) => task.id),
				request,
				by,
			);
		} finally {
			for (const key of keys) this.taskStarts.delete(key);
			for (const key of keys) this.phaseOverrides.delete(key);
		}
	}

	/** Task writes from the app and the tool: preferred models pass the same scope and price cap as starts. */
	async addTask(missionId: string, write: MissionTaskWrite, actor: MissionActor = {}): Promise<MissionTask> {
		const validated = await this.validatePreference(missionId, write, undefined, actor);
		return this.store.addTask(missionId, validated, actor);
	}

	async updateTask(
		missionId: string,
		taskRef: string,
		write: MissionTaskWrite,
		actor: MissionActor = {},
	): Promise<MissionTask> {
		const taskId = this.store.resolveTask(missionId, taskRef).id;
		const validated = await this.validatePreference(missionId, write, taskId, actor);
		return this.store.updateTask(missionId, taskId, validated, actor);
	}

	async taskModel(missionId: string, taskId: string, request: import("@pilot/protocol").TaskModelRequest) {
		if (this.store.require(missionId).projectId !== request.projectId)
			throw new Conflict("The confirmed project changed");
		if (!taskId || /^\d+$/.test(taskId)) throw new Error("An exact task ID is required");
		const write = await this.validatePreference(
			missionId,
			{
				preferredModel: request.preferredModel,
				preferredThinking: request.preferredThinking,
			},
			this.store.task(missionId, taskId).id,
			{},
		);
		return this.store.taskModel(missionId, request.projectId, taskId, write);
	}

	private async validatePreference(
		missionId: string,
		write: MissionTaskWrite,
		taskId: string | undefined,
		actor: MissionActor,
	): Promise<MissionTaskWrite> {
		if (!write || typeof write !== "object") throw new Error("Expected a task object");
		const { preferredModel, preferredThinking } = write;
		if (preferredModel === undefined && preferredThinking === undefined) return write;
		const task = taskId === undefined ? undefined : this.store.task(missionId, taskId);
		// Fail before model I/O; the store repeats this check atomically with the write.
		if (actor.sessionId && task?.preferredModelSetBy === "user")
			throw new Conflict(
				`Task #${task.number} has a user-set preferred model (${task.preferredModel}); only the user can change it`,
			);
		const model = preferredModel === undefined ? task?.preferredModel : preferredModel;
		if (model === null || model === undefined) {
			if (preferredThinking !== undefined && preferredThinking !== null)
				throw new Error("preferredThinking requires a preferred model");
			return write;
		}
		if (typeof model !== "string" || !model.trim())
			throw new Error("preferredModel must be a provider/modelId string");
		if (preferredThinking !== undefined && preferredThinking !== null && typeof preferredThinking !== "string")
			throw new Error("preferredThinking must be a string");
		const project = this.projects.require(this.store.require(missionId).projectId);
		const selection = await this.sessions.selectTaskModel(project.path, model, preferredThinking ?? undefined);
		return preferredModel === undefined ? write : { ...write, preferredModel: selection.model };
	}

	private async startReservedTasks(
		missionId: string,
		taskIds: string[],
		request: StartMissionTaskRequest,
		by: TaskStarter,
	): Promise<SessionSummary> {
		const mission = this.store.require(missionId);
		if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
		let tasks = this.store.prepareTaskStart(missionId, taskIds, undefined, request.overridePhaseGating);
		if (request.message !== undefined && typeof request.message !== "string")
			throw new Error("message must be a string");
		// Workspace options are checked again at spawn, but references must not be saved for a start that cannot run.
		if (request.mode !== undefined && request.mode !== "build" && request.mode !== "ask")
			throw new Error("mode must be build or ask");
		const project = this.projects.require(mission.projectId);
		if (request.baseBranch !== undefined) {
			if ((request.mode ?? "build") === "build" && project.workspace === "direct")
				throw new Error("baseBranch requires a private-clone project");
			await validateBaseBranch(request.baseBranch, project.path);
		}
		const choice = taskModelChoice(tasks, request, by);
		const selection = await this.sessions
			.selectTaskModel(project.path, choice.model, choice.thinking)
			.catch((error: unknown) => {
				if (!choice.preferredBy) throw error;
				throw new Error(
					`Preferred model of task #${choice.preferredBy.number}: ${error instanceof Error ? error.message : error}`,
				);
			});
		// Recheck claims after model/settings I/O.
		tasks = this.store.prepareTaskStart(missionId, taskIds, undefined, request.overridePhaseGating);
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
				linkedAt: 0,
			};
			const previous = artifacts.findIndex((item) => item.artifactId === value.artifactId);
			if (previous < 0) artifacts.push(value);
			else artifacts[previous] = value;
		}
		const detail = this.store.detail(missionId);
		tasks = this.store.prepareTaskStart(missionId, taskIds, undefined, request.overridePhaseGating);
		const selected = new Set(taskIds);
		const taskArtifacts = detail.artifacts
			.filter(
				(item) =>
					item.taskId && selected.has(item.taskId) && !artifacts.some((ref) => ref.artifactId === item.artifactId),
			)
			.concat(artifacts);
		const taskLinks = detail.resources.filter((item) => item.taskId && selected.has(item.taskId));
		const promptLinks = [...new Map([...links, ...taskLinks].map((item) => [item.url, item])).values()];
		const message = taskMessage(tasks, request.message, taskArtifacts, promptLinks);
		// Recheck artifact membership after asynchronous reads, before writes.
		for (const item of artifacts)
			if (
				this.store.missionOf(item.sessionId) !== missionId &&
				!detail.artifacts.some((ref) => ref.artifactId === item.artifactId && ref.sessionId === item.sessionId)
			)
				throw new Conflict("That artifact's chat is no longer in this mission");
		this.store.attachTaskReferences(missionId, taskIds, artifacts, links);
		// A released task keeps its chat. Continuing there preserves the work it already did and avoids
		// a second chat with the same title and the same opening message.
		const holders = tasks.length === 1 ? this.sessions.taskHolders(missionId, [tasks[0]!.id]) : [];
		if (holders.length === 1) {
			const holder = holders[0]!;
			this.store.claimTask(missionId, tasks[0]!.id, holder.id);
			this.store.recordTaskStart(
				missionId,
				tasks[0]!.id,
				holder.model ?? selection.model,
				holder.thinking ?? selection.thinking,
			);
			await this.sessions.send(
				holder.id,
				taskMessage(tasks, request.message, taskArtifacts, promptLinks, true),
				"followUp",
			);
			return holder;
		}
		const session = await this.sessions.spawn(
			{
				projectId: mission.projectId,
				missionId,
				message,
				title: tasks[0]!.title,
				...selection,
				...(request.mode ? { mode: request.mode } : {}),
				...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
			},
			false,
			tasks.map((task) => task.id),
		);
		for (const task of tasks) this.store.recordTaskStart(missionId, task.id, selection.model, selection.thinking);
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
		if (this.sharing?.membership(sessionId)) return this.sharing.missionCall(sessionId, action, args);
		const missionId = this.store.missionOf(sessionId);
		if (!missionId) throw new Error("This chat is not part of a mission. Ask the user to add it to one.");
		const mission = this.store.require(missionId);
		if (
			([
				"propose",
				"delete",
				"group",
				"phase",
				"start",
				"send",
				"status",
				"bindPr",
				"unbindPr",
				"split",
				"updateLink",
			].includes(action) ||
				(action === "task" &&
					(args.order !== undefined || args.model !== undefined || args.thinking !== undefined))) &&
			mission.coordinatorSessionId !== sessionId
		)
			throw new Conflict(
				`Only the mission coordinator can use ${action === "task" && args.order === undefined ? "task model or thinking" : action}`,
			);
		const actor = { sessionId };
		const who = (id: string | undefined) => (id === undefined ? "user" : id === sessionId ? "you" : id);
		const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
		switch (action) {
			case "prGuidance": {
				if (args.taskId === undefined) throw new Error("prGuidance requires taskId");
				const task = this.store.resolveTask(missionId, args.taskId);
				const result = await this.prGuidance(missionId, task.id);
				if (this.store.missionOf(sessionId) !== missionId) throw new Conflict("Mission membership changed");
				return result;
			}
			case "split":
				return splitTicket(this.store, missionId, args.resourceId, args.tasks, actor);
			case "updateLink":
				if (typeof args.resourceId !== "string") throw new Error("updateLink requires resourceId");
				return this.store.updateResource(
					missionId,
					args.resourceId,
					{ linearRole: args.linearRole as "reference" | "managed" | "contribution" },
					actor,
				);
			case "ticket": {
				const authorize = () => {
					if (this.store.missionOf(sessionId) !== missionId) throw new Conflict("Mission membership changed");
					const ref = this.store
						.detail(missionId, false)
						.resources.find((ref) => ref.id === args.resourceId && ref.kind === "linear.issue");
					if (!ref) throw new NotFound("Linked Linear ticket not found");
					return ref;
				};
				const ref = authorize();
				if (!this.ticketReader) throw new Error("Linear context is unavailable; check the Linear connection");
				const context = await this.ticketReader.read(ref);
				if (JSON.stringify(authorize()) !== JSON.stringify(ref)) throw new Conflict("Ticket link changed; retry");
				return context;
			}
			case "phase": {
				const write = { name: args.name, goal: args.goal, order: args.order } as Parameters<
					MissionStore["addPhase"]
				>[1];
				if (args.operation === "create") return this.store.addPhase(missionId, write, actor);
				const phase = this.store.resolvePhase(missionId, args.phase ?? args.id);
				if (args.operation === "delete") {
					this.store.removePhase(missionId, phase.id, actor);
					return { id: phase.id, deleted: true };
				}
				if (args.operation !== "rename" && args.operation !== "reorder")
					throw new Error("phase requires operation create, rename, reorder or delete");
				if (args.operation === "rename" && args.name === undefined) throw new Error("rename requires name");
				if (args.operation === "reorder" && args.order === undefined) throw new Error("reorder requires order");
				return this.store.updatePhase(missionId, phase.id, write, actor);
			}
			case "bindPr":
			case "unbindPr": {
				const target = str("targetSessionId");
				const url = str("url");
				if (!target?.trim() || !url?.trim()) throw new Error(`${action} requires targetSessionId and url`);
				if (this.store.missionOf(target) !== missionId) throw new Conflict("That chat is not in this mission");
				if (args.taskId !== undefined && typeof args.taskId !== "string")
					throw new Error("taskId must be a task ID or number");
				const { changed, previousOwner, taskLinkRemoved } =
					action === "bindPr"
						? await this.sessions.bindPullRequest(target, url, actor, str("taskId"))
						: await this.sessions.unbindPullRequest(target, url, actor);
				return { changed, previousOwner, taskLinkRemoved };
			}
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
			case "start": {
				if (mission.status !== "active") throw new Conflict("Reopen the mission before starting a new chat");
				if (args.id !== undefined && args.ids !== undefined) throw new Error("Use id or ids, not both");
				if (args.ids !== undefined && !Array.isArray(args.ids)) throw new Error("start requires an ids array");
				if (args.ids === undefined && (typeof args.id !== "string" || !args.id.trim()))
					throw new Error("start requires the task id or number, or ids");
				const start =
					args.ids === undefined
						? (request: StartMissionTaskRequest) =>
								this.startTask(missionId, args.id as string, request, "coordinator")
						: (request: StartMissionTaskRequest) =>
								this.startTasks(missionId, parseTaskRefs(args.ids, "start"), request, "coordinator");
				const started = await start({
					...(args.message !== undefined ? { message: args.message as string } : {}),
					...(args.model !== undefined ? { model: args.model as string } : {}),
					...(args.thinking !== undefined ? { thinking: args.thinking as string } : {}),
					...(args.artifacts !== undefined
						? { artifacts: args.artifacts as StartMissionTaskRequest["artifacts"] }
						: {}),
					...(args.links !== undefined ? { links: args.links as StartMissionTaskRequest["links"] } : {}),
				});
				// Role/membership can change during spawn. Never disclose readings to a former lead.
				if (
					this.store.missionOf(sessionId) !== missionId ||
					this.store.require(missionId).coordinatorSessionId !== sessionId
				)
					throw new Conflict("Only the mission coordinator can use start");
				// Raw session usage includes provider errors and is not an agent-facing contract.
				const { usage: _usage, ...summary } = started;
				return {
					...summary,
					chatUrl: `pilot://chat/${started.id}`,
					subscriptionUsage: this.sessions.subscriptionUsageSnapshot(),
				};
			}
			case "send": {
				if (typeof args.targetSessionId !== "string" || !args.targetSessionId.trim())
					throw new Error("send requires targetSessionId");
				if (this.store.missionOf(args.targetSessionId) !== missionId)
					throw new Conflict("That chat is not in this mission");
				if (typeof args.message !== "string" || !args.message.trim()) throw new Error("send requires message");
				if (args.mode !== undefined && args.mode !== "steer" && args.mode !== "followUp")
					throw new Error("mode must be steer or followUp");
				const mode = args.mode ?? "followUp";
				// Coordinator messages reach the chat without appearing as the user's queued messages.
				const result = await this.sessions.sendReported(
					args.targetSessionId,
					args.message,
					`mission:send:from:${sessionId}:${missionId}:${randomUUID()}`,
					mode,
				);
				return { sessionId: args.targetSessionId, sent: result.delivery !== "rejected", ...result };
			}
			case "status": {
				const target = args.targetSessionId;
				if (target !== undefined && (typeof target !== "string" || !target.trim()))
					throw new Error("status requires a non-empty targetSessionId");
				if (typeof target === "string" && this.store.missionOf(target) !== missionId)
					throw new Conflict("That chat is not in this mission");
				const tasks = this.store.tasks(missionId);
				const selected =
					typeof target === "string"
						? [this.sessions.get(target)].filter((member): member is SessionSummary => member !== undefined)
						: this.sessions.list({ missionId, archived: "all" });
				const members = selected.map((member) => {
					const claimed = tasks.filter((task) => task.sessionId === member.id);
					const prs = member.pullRequests ?? (member.pullRequest ? [member.pullRequest] : []);
					return {
						id: member.id,
						chatUrl: `pilot://chat/${member.id}`,
						title: member.title,
						coordinator: member.id === mission.coordinatorSessionId,
						state:
							member.runningJobs?.length && member.state !== "working" && member.state !== "starting"
								? "waiting on background job"
								: member.state,
						...(member.runningJobs?.length
							? {
									runningJobs: member.runningJobs.map(({ id, name, startedAt }) => ({
										id,
										name,
										startedAt,
									})),
								}
							: {}),
						...(member.branch ? { branch: member.branch } : {}),
						boundPullRequests: member.boundPullRequests ?? [],
						pullRequests: prs.map(({ number, state }) => ({ number, state, draft: state === "draft" })),
						finishedWithoutPR:
							member.id !== mission.coordinatorSessionId &&
							member.state === "idle" &&
							member.archivedAt === undefined &&
							!member.runningJobs?.length &&
							claimed.some(
								(task) =>
									task.status === "in_progress" || (member.outcome === "done" && task.status !== "dropped"),
							) &&
							!prs.some((pr) => pr.state === "open" || pr.state === "draft" || pr.state === "merged"),
						...(!member.runningJobs?.length && member.outcome !== undefined ? { outcome: member.outcome } : {}),
						...(member.outcomeAt !== undefined ? { outcomeAt: member.outcomeAt } : {}),
						...(member.outcomeReason !== undefined ? { outcomeReason: member.outcomeReason } : {}),
						...(member.archivedAt !== undefined ? { archivedAt: member.archivedAt } : {}),
						...(member.error !== undefined ? { error: member.error } : {}),
						tasks: claimed.map((task) => ({ number: task.number, title: task.title, status: task.status })),
					};
				});
				if (typeof target === "string") {
					const member = members[0];
					if (!member) throw new NotFound("Member chat not found");
					return {
						subscriptionUsage: this.sessions.subscriptionUsageSnapshot(),
						member: { ...member, lastAssistantReply: await this.sessions.lastAssistantReply(target, 1500) },
					};
				}
				return { subscriptionUsage: this.sessions.subscriptionUsageSnapshot(), members };
			}
			case "get": {
				if (args.id !== undefined) return this.taskDetail(missionId, args.id, sessionId);
				const detail = this.store.detail(missionId, false);
				const view = new MissionAgentView(detail, sessionId, this.sessions);
				const open = detail.tasks.filter(isOpen);
				const mine = open.filter((task) => task.sessionId === sessionId);
				const phaseTasks = new Map<string | undefined, MissionTask[]>();
				for (const task of detail.tasks) {
					let group = phaseTasks.get(task.phaseId);
					if (!group) {
						group = [];
						phaseTasks.set(task.phaseId, group);
					}
					group.push(task);
				}
				return {
					mission: { title: mission.title, goal: mission.goal, status: mission.status },
					...(this.sharing ? { remoteAllocations: this.sharing.missionAllocations(missionId) } : {}),
					phaseGating: mission.phaseGating ?? false,
					phases: [
						...detail.phases.map(({ missionId: _, ...phase }) => phase),
						{ id: undefined, name: "No phase" },
					].map((phase) => {
						const tasks = phaseTasks.get(phase.id) ?? [];
						return {
							...phase,
							progress: {
								done: tasks.filter((task) => task.status === "done").length,
								dropped: tasks.filter((task) => task.status === "dropped").length,
								total: tasks.length,
							},
							tasks: tasks.filter(isOpen).map((task) => task.number),
						};
					}),
					briefRevision: mission.briefRevision,
					decisions: detail.decisions.map(({ number }) => `D${number}`),
					tasks: mine.map((task) => view.task(task)),
					// Tuples avoid repeating keys for the larger, read-only list.
					openTasks: open
						.filter((task) => task.sessionId !== sessionId)
						.map((task) => [
							task.number,
							task.title,
							task.status,
							...(task.dependsOn?.length ? [view.dependencies(task)] : []),
						]),
					counts: {
						doneTasks: detail.tasks.filter((task) => task.status === "done").length,
						droppedTasks: detail.tasks.filter((task) => task.status === "dropped").length,
						links: detail.resources.length,
						artifacts: detail.artifacts.length,
						decisions: detail.decisions.length,
					},
					...(mission.coordinatorSessionId === sessionId
						? {
								decisionProposals: detail.decisionProposals,
								members: this.sessions
									.list({ missionId, archived: "all" })
									.filter(
										(member) =>
											member.id === sessionId ||
											open.some((task) => task.sessionId === member.id) ||
											(member.archivedAt === undefined &&
												(!detail.tasks.some((task) => task.sessionId === member.id) ||
													member.state === "working" ||
													member.state === "starting" ||
													!!member.runningJobs?.length)),
									)
									.map((member) => ({
										title: member.title,
										state:
											member.runningJobs?.length && member.state !== "working" && member.state !== "starting"
												? "waiting on background job"
												: member.state,
										...(member.runningJobs?.length
											? {
													runningJobs: member.runningJobs.map(({ id, name, startedAt }) => ({
														id,
														name,
														startedAt,
													})),
												}
											: {}),
										...(member.archivedAt !== undefined ? { archived: true } : {}),
										tasks: open.filter((task) => task.sessionId === member.id).map((task) => task.number),
									})),
								needsYou: {
									blockedTasks: open.filter((task) => task.status === "blocked").map((task) => task.number),
									comments: detail.comments
										.filter((comment) => !comment.targetSessionId || comment.targetSessionId === sessionId)
										.map((comment) => ({ id: comment.id, text: comment.text })),
								},
								prsInReview: detail.resources
									.filter(
										(resource) =>
											resource.kind === "github.pr" &&
											resource.taskId &&
											open.some((task) => task.id === resource.taskId && task.status === "in_review") &&
											(!resource.pullRequest || ["open", "draft"].includes(resource.pullRequest.state)),
									)
									.map((resource) => view.link(resource)),
							}
						: {}),
				};
			}
			case "links":
			case "artifacts": {
				const detail = this.store.detail(missionId, false);
				const view = new MissionAgentView(detail, sessionId, this.sessions);
				const filter = readFilter(args.filter);
				const task = args.taskId === undefined ? undefined : this.store.resolveTask(missionId, args.taskId);
				const include = (ref: { taskId?: string; pullRequest?: { state: string } }) => {
					if (task && ref.taskId !== task.id) return false;
					const linked = detail.tasks.find((item) => item.id === ref.taskId);
					const done = linked
						? !isOpen(linked)
						: ref.pullRequest?.state === "merged" || ref.pullRequest?.state === "closed";
					return filter === "all" || (filter === "done" ? done : !done);
				};
				return action === "links"
					? { links: detail.resources.filter(include).map((ref) => view.link(ref)) }
					: { artifacts: detail.artifacts.filter(include).map((ref) => view.artifact(ref)) };
			}
			case "decisions": {
				const detail = this.store.detail(missionId, false);
				const prompt = Array.isArray(args._promptDecisions)
					? (args._promptDecisions as Array<{ id: string; text: string }>)
					: (this.context(sessionId)?.decisionEntries ?? []);
				return {
					retired: prompt.filter((entry) => !detail.decisions.some((decision) => decision.id === entry.id)),
					decisions: detail.decisions
						.filter(
							(decision) => !prompt.some((entry) => entry.id === decision.id && entry.text === decision.text),
						)
						.map(({ id, number, text, audience }) => ({ id, number, text, audience })),
				};
			}
			case "activity": {
				const query = readActivityQuery(args);
				if (args.taskId !== undefined) query.taskId = this.store.resolveTask(missionId, args.taskId).id;
				const events = this.store.activity(missionId, { ...query, limit: query.limit + 1 });
				const page = events.slice(0, query.limit);
				return {
					...(args.taskId === undefined &&
					args.kind === undefined &&
					args.since === undefined &&
					args.cursor === undefined
						? {
								recentUserNotes: this.store.userNotes(missionId, query.limit).map((event) => ({
									kind: event.kind,
									text: event.text,
									by: "user",
									at: new Date(event.at).toISOString(),
									...(event.health ? { health: event.health } : {}),
								})),
							}
						: {}),
					recentActivity: page.map((event) => activityEvent(event, sessionId)),
					cursor: events.length > query.limit ? page.at(-1)!.id : null,
				};
			}
			case "comments":
				return { comments: this.store.detail(missionId, false).comments };
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
				const detail = this.store.detail(missionId, false);
				const view = new MissionAgentView(detail, sessionId, this.sessions);
				const filter = readFilter(args.filter);
				if (args.mine !== undefined && typeof args.mine !== "boolean") throw new Error("mine must be a boolean");
				if (args.milestone !== undefined && typeof args.milestone !== "string")
					throw new Error("milestone must be a string");
				const phaseId =
					args.phase === undefined
						? undefined
						: args.phase === ""
							? null
							: this.store.resolvePhase(missionId, args.phase).id;
				return {
					tasks: detail.tasks
						.filter(
							(task) =>
								(filter === "all" || (filter === "done" ? !isOpen(task) : isOpen(task))) &&
								(!args.mine || task.sessionId === sessionId) &&
								(args.milestone === undefined || args.milestone === task.milestone) &&
								(phaseId === undefined || (task.phaseId ?? null) === phaseId),
						)
						.map((task) => view.task(task, true)),
				};
			}
			case "complete":
				return this.store.completeTask(missionId, args.id, sessionId, args.completion);
			case "task": {
				const write = {
					...(args.title !== undefined ? { title: args.title } : {}),
					...(args.body !== undefined ? { body: args.body } : {}),
					...(args.status !== undefined ? { status: args.status } : {}),
					...(args.order !== undefined ? { order: args.order } : {}),
					...(args.milestone !== undefined ? { milestone: args.milestone } : {}),
					...(args.phase !== undefined
						? { phaseId: args.phase === "" ? null : this.store.resolvePhase(missionId, args.phase).id }
						: {}),
					...(args.dependsOn !== undefined ? { dependsOn: args.dependsOn } : {}),
					...(args.decisionIds !== undefined ? { decisionIds: args.decisionIds } : {}),
					// Tool strings cannot be null: an empty string clears the preference.
					...(args.model !== undefined ? { preferredModel: args.model === "" ? null : args.model } : {}),
					...(args.thinking !== undefined
						? { preferredThinking: args.thinking === "" ? null : args.thinking }
						: {}),
				} as MissionTaskWrite;
				if (args.id !== undefined && !Object.keys(write).length) {
					return this.taskDetail(missionId, args.id, sessionId);
				}
				return args.id === undefined
					? this.addTask(missionId, write, actor)
					: this.updateTask(missionId, args.id as string, write, actor);
			}
			case "claim":
			case "release": {
				if (args.id !== undefined && args.ids !== undefined)
					throw new Error(`${action} accepts id or ids, not both`);
				if (args.ids !== undefined && !Array.isArray(args.ids)) throw new Error(`${action} ids must be an array`);
				if (args.id === undefined && args.ids === undefined) throw new Error(`${action} requires id or ids`);
				if (args.id !== undefined && typeof args.id !== "string" && typeof args.id !== "number")
					throw new Error(`${action} id must be a task ID, number or range`);
				const refs = parseTaskRefs(args.ids ?? args.id, action);
				// Preserve the single-id result and conflict error for existing callers.
				const batch =
					args.ids !== undefined || (typeof args.id === "string" && /,|^#?\d+\s*-\s*#?\d+$/.test(args.id.trim()));
				if (action === "release")
					return batch
						? this.store.releaseTasks(missionId, refs, actor)
						: this.store.releaseTask(missionId, refs[0], actor);
				return batch
					? this.store.claimTasks(missionId, refs, sessionId)
					: this.store.claimTask(missionId, refs[0], sessionId);
			}
			case "propose":
				if (!str("decisionId")) throw new Error("propose requires decisionId");
				return this.store.proposeDecision(
					missionId,
					str("decisionId")!,
					args.text,
					args.remove,
					args.reason,
					actor,
				);
			case "decide":
				return this.store.addDecision(missionId, args.text, actor, args.audience);
			case "comment":
				return this.store.addComment(
					missionId,
					{
						text: str("text") as string,
						notification: args.notification as "action" | "urgent" | "informational" | "ack" | undefined,
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
			case "unlink":
				if (typeof args.url !== "string") throw new Error("unlink requires url");
				if (args.taskId !== undefined && typeof args.taskId !== "string")
					throw new Error("taskId must be a task ID or number");
				return this.store.unlinkResource(missionId, args.url, str("taskId"), actor);
			case "link":
				return this.store.addResource(
					missionId,
					{
						url: str("url") as string,
						...(args.relationship !== undefined
							? { relationship: args.relationship as "ownership" | "reference" }
							: {}),
						...(args.linearRole !== undefined
							? { linearRole: args.linearRole as "reference" | "managed" | "contribution" }
							: {}),
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

	private taskDetail(missionId: string, ref: unknown, sessionId: string) {
		const task = this.store.resolveTask(missionId, ref);
		const detail = this.store.detail(missionId, false);
		const view = new MissionAgentView(detail, sessionId, this.sessions);
		const assignee = task.sessionId ? this.sessions.get(task.sessionId) : undefined;
		const events = this.store.activity(missionId, { taskId: task.id, limit: 16 });
		return {
			...view.task(task, true),
			id: task.id,
			body: task.body ?? "",
			completion: this.store.completion(missionId, task.id) ?? null,
			dependsOn: view.dependencies(task),
			dependents: detail.tasks.filter((item) => item.dependsOn?.includes(task.id)).map((item) => item.number),
			assignee: task.sessionId
				? {
						id: task.sessionId,
						title: assignee?.title ?? "Unknown chat",
						...(assignee ? { state: assignee.state } : {}),
						...(assignee?.archivedAt !== undefined ? { archived: true } : {}),
					}
				: null,
			recentActivity: events.slice(0, 15).map((event) => activityEvent(event, sessionId)),
			activityCursor: events.length > 15 ? events[14]!.id : null,
		};
	}
}

const ACTIVITY_KINDS: MissionEventKind[] = [
	"created",
	"status",
	"handoff",
	"update",
	"brief",
	"decision",
	"comment",
	"task",
	"claim",
	"artifact",
	"resource",
	"member",
	"coordinator",
	"github",
];

function readActivityQuery(args: Record<string, unknown>): MissionActivityQuery {
	const limit = args.limit === undefined ? 15 : args.limit;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error("limit must be an integer from 1 to 100");
	if (args.kind !== undefined && !ACTIVITY_KINDS.includes(args.kind as MissionEventKind))
		throw new Error(`activity kind must be one of: ${ACTIVITY_KINDS.join(", ")}`);
	const query: MissionActivityQuery = {
		limit,
		...(args.kind !== undefined ? { kind: args.kind as MissionEventKind } : {}),
	};
	if (args.cursor !== undefined) {
		if (typeof args.cursor !== "number" || !Number.isSafeInteger(args.cursor) || args.cursor < 1)
			throw new Error("cursor must be a positive event ID");
		query.before = args.cursor;
	}
	if (args.since !== undefined) {
		if (typeof args.since === "number" && Number.isSafeInteger(args.since) && args.since >= 0) {
			query.sinceEventId = args.since;
		} else if (
			typeof args.since === "string" &&
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(args.since) &&
			Number.isFinite(Date.parse(args.since))
		) {
			query.sinceAt = Date.parse(args.since);
		} else {
			throw new Error("since must be an ISO timestamp with timezone or a nonnegative event ID");
		}
	}
	return query;
}

function activityEvent(event: MissionEvent, sessionId: string) {
	return {
		id: event.id,
		kind: event.kind,
		text: event.text,
		by: event.sessionId === undefined ? "user" : event.sessionId === sessionId ? "you" : event.sessionId,
		at: new Date(event.at).toISOString(),
		...(event.taskId ? { taskId: event.taskId } : {}),
		...(event.health ? { health: event.health } : {}),
	};
}

function isOpen(task: MissionTask): boolean {
	return task.status !== "done" && task.status !== "dropped";
}

function readFilter(value: unknown): "open" | "done" | "all" {
	if (value === undefined) return "open";
	if (value !== "open" && value !== "done" && value !== "all") throw new Error("filter must be open, done or all");
	return value;
}

/** Agent projections omit storage IDs, timestamps and cached PR history. */
class MissionAgentView {
	private readonly numbers: Map<string, number>;
	private readonly detail: MissionDetail;
	private readonly sessionId: string;
	private readonly sessions: SessionManager;
	constructor(detail: MissionDetail, sessionId: string, sessions: SessionManager) {
		this.detail = detail;
		this.sessionId = sessionId;
		this.sessions = sessions;
		this.numbers = new Map(detail.tasks.map((task) => [task.id, task.number]));
	}
	dependencies(task: MissionTask) {
		return task.dependsOn?.map((id) => this.numbers.get(id)) ?? [];
	}
	link(ref: MissionResource) {
		const pr = ref.pullRequest;
		const owner = ref.kind === "github.pr" ? this.sessions.pullRequestOwnerSummary(ref.url) : undefined;
		return {
			url: ref.url,
			...(ref.kind === "linear.issue"
				? { resourceId: ref.id, linearRole: ref.linearRole ?? "reference", linearKey: ref.linearKey }
				: {}),
			kind: ref.kind,
			...(ref.title || pr?.title ? { title: ref.title ?? pr?.title } : {}),
			...(ref.taskId ? { task: this.numbers.get(ref.taskId) } : {}),
			relationship: ref.relationship,
			...(ref.kind === "github.pr" ? { owner: owner?.title ?? null } : {}),
			...(pr ? { state: pr.state, ...(pr.readiness ? { readiness: pr.readiness.state } : {}) } : {}),
		};
	}
	artifact(ref: MissionArtifactLink) {
		return {
			artifactId: ref.artifactId,
			title: ref.title,
			kind: ref.kind,
			...(ref.taskId ? { task: this.numbers.get(ref.taskId) } : {}),
			...(ref.revision !== undefined ? { revision: ref.revision } : {}),
		};
	}
	task(task: MissionTask, full = false) {
		return {
			number: task.number,
			title: task.title,
			status: task.status,
			...(task.delegatedTo ? { delegatedTo: task.delegatedTo } : {}),
			...(task.preferredModel
				? {
						preferredModel: task.preferredModel,
						...(task.preferredThinking ? { preferredThinking: task.preferredThinking } : {}),
						preferredModelSetBy: task.preferredModelSetBy,
					}
				: {}),
			...(full && task.body ? { body: task.body } : {}),
			...(full ? { order: task.order } : {}),
			...(task.sessionId
				? {
						owner:
							task.sessionId === this.sessionId
								? "you"
								: (this.sessions.get(task.sessionId)?.title ?? "Unknown chat"),
					}
				: {}),
			...(task.milestone ? { milestone: task.milestone } : {}),
			...(task.phaseId ? { phaseId: task.phaseId } : {}),
			...(task.blockedByPhases?.length
				? { blockedByPhases: task.blockedByPhases, storedStatus: task.storedStatus }
				: {}),
			...(task.dependsOn?.length ? { dependsOn: this.dependencies(task) } : {}),
			...(full && task.decisionIds?.length
				? {
						decisions: this.detail.decisions
							.filter((d) => task.decisionIds?.includes(d.id))
							.map(({ id, number, text, audience }) => ({ id, number, text, audience })),
					}
				: {}),
			resources: this.detail.resources.filter((ref) => ref.taskId === task.id).map((ref) => this.link(ref)),
			artifacts: this.detail.artifacts.filter((ref) => ref.taskId === task.id).map((ref) => this.artifact(ref)),
		};
	}
}
