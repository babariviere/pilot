import type {
	CreateMissionRequest,
	DashboardTrackedItem,
	Mission,
	Project,
	SessionSummary,
	SpawnRequest,
	StartMissionCoordinatorRequest,
	StartMissionTaskRequest,
} from "@pilot/protocol";
import type { ControlActions } from "./control-actions.ts";
import type { SessionManager } from "./sessions.ts";
import type { WatchService } from "./watch-service.ts";
import { validateWatch, type WatchInput } from "./watches.ts";

export interface ControlPilotOptions {
	watches?: Pick<WatchService, "add" | "remove" | "page">;
	isControl: (id: string) => boolean;
	sessions: Pick<SessionManager, "list" | "get" | "history">;
	/** Cached projections only. These callbacks must not perform storage or network reads. */
	missions: () => Mission[];
	projects: () => Project[];
	linear: (projectId: string) => DashboardTrackedItem[];
	mutations?: {
		audit: () => ControlActions;
		startProject: (request: SpawnRequest) => Promise<SessionSummary>;
		startTask: (missionId: string, taskId: string, request: StartMissionTaskRequest) => Promise<SessionSummary>;
		send: SessionManager["sendReported"];
		organizeAllowed?: () => boolean;
		createMission?: (request: CreateMissionRequest) => Promise<Mission>;
		startCoordinator?: (missionId: string, request: StartMissionCoordinatorRequest) => Promise<SessionSummary>;
		attachMission?: (sessionId: string, missionId: string, taskId?: string) => Promise<SessionSummary>;
	};
}
const short = (text: string | undefined, n = 160) => text?.replace(/[\r\n]/g, " ").slice(0, n);
function string(args: Record<string, unknown>, key: string, required = false): string | undefined {
	const value = args[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > 128)
		throw new Error(`${key} must be a nonempty ID`);
	return value;
}
export class ControlPilot {
	readonly options: ControlPilotOptions;
	constructor(options: ControlPilotOptions) {
		this.options = options;
	}
	async call(caller: string, action: string, args: Record<string, unknown>, operationId = ""): Promise<unknown> {
		if (!this.options.isControl(caller)) throw new Error("Only the control chat may call pilot");
		if (action === "status") return this.status(args);
		if (action === "read") return this.read(args);
		if (action === "watch" || action === "unwatch" || action === "watches") {
			const watches = this.options.watches;
			if (!watches) throw new Error("Watches unavailable");
			if (action === "watches") return watches.page(string(args, "after"), args.limit as number | undefined);
			if (action === "unwatch") return { removed: await watches.remove(string(args, "watchId", true)!) };
			return watches.add(validateWatch(args as unknown as WatchInput));
		}
		if (action === "mission_create") return this.createMission(caller, args, operationId);
		if (action === "mission_attach") {
			this.assertOrganize(args, true);
			const mutations = this.options.mutations!;
			if (!mutations.attachMission) throw new Error("Mission attachment unavailable");
			const sessionId = string(args, "sessionId", true)!,
				missionId = string(args, "missionId", true)!,
				taskId = string(args, "taskId");
			return mutations.audit().perform(caller, action, args, operationId, async () => {
				this.assertOrganize(args, true);
				const chat = await mutations.attachMission!(sessionId, missionId, taskId);
				return {
					sessionId: chat.id,
					missionId: chat.missionId,
					chatUrl: `pilot://chat/${chat.id}`,
					...(taskId ? { taskId } : {}),
				};
			});
		}
		if (action === "start" || action === "send") {
			if (!this.options.mutations) throw new Error("Control actions unavailable");
			return this.options.mutations
				.audit()
				.perform<unknown>(caller, action, args, operationId, () =>
					action === "start" ? this.start(args) : this.send(args, operationId),
				);
		}
		throw new Error("Unknown pilot action");
	}
	private assertOrganize(args: Record<string, unknown>, attachment = false): void {
		if (!this.options.mutations?.organizeAllowed?.())
			throw new Error("Creating or attaching missions is forbidden while handling a watch notice");
		if (
			attachment
				? args.authorization !== "accepted_suggestion"
				: args.authorization !== "user_request" && args.authorization !== "accepted_suggestion"
		)
			throw new Error(
				attachment ? "User must accept the attachment suggestion" : "User request or accepted suggestion required",
			);
	}
	private async createMission(caller: string, args: Record<string, unknown>, operationId: string) {
		this.assertOrganize(args);
		const mutations = this.options.mutations!;
		if (!mutations.createMission || !mutations.startCoordinator) throw new Error("Mission creation unavailable");
		const projectId = string(args, "projectId", true)!;
		if (typeof args.goal !== "string" || !args.goal.trim() || args.goal.length > 3500)
			throw new Error("goal must be 1..3500 characters");
		if (args.brief !== undefined && (typeof args.brief !== "string" || Buffer.byteLength(args.brief) > 32_000))
			throw new Error("brief exceeds 32,000 characters");
		const goal = args.goal.trim(),
			brief = args.brief as string | undefined;
		const created = await mutations.audit().perform(caller, "mission_create", args, operationId, async () => {
			this.assertOrganize(args);
			const mission = await mutations.createMission!({
				projectId,
				goal,
				title: goal.replace(/\s+/g, " ").slice(0, 100),
				...(brief !== undefined ? { brief } : {}),
				startCoordinator: false,
			});
			return { missionId: mission.id, title: mission.title, projectId: mission.projectId };
		});
		const coordinator = await mutations
			.audit()
			.perform(
				caller,
				"coordinator_start",
				{ missionId: created.missionId },
				`${operationId}:coordinator`,
				async () => {
					this.assertOrganize(args);
					const chat = await mutations.startCoordinator!(created.missionId, {});
					return { sessionId: chat.id, chatUrl: `pilot://chat/${chat.id}`, model: chat.model };
				},
			);
		return { ...created, coordinator };
	}
	private async start(args: Record<string, unknown>) {
		const projectId = string(args, "projectId"),
			missionId = string(args, "missionId"),
			taskId = string(args, "taskId");
		const message = args.message;
		if (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > 4000))
			throw new Error("message must be 1..4000 characters");
		for (const key of ["model", "thinking"])
			if (
				args[key] !== undefined &&
				(typeof args[key] !== "string" || !String(args[key]).trim() || String(args[key]).length > 256)
			)
				throw new Error(`Invalid ${key}`);
		const choice = {
			...(args.model ? { model: args.model as string } : {}),
			...(args.thinking ? { thinking: args.thinking as string } : {}),
		};
		let chat: SessionSummary;
		if (missionId) {
			const mission = this.options.missions().find((m) => m.id === missionId);
			if (!mission) throw new Error("Unknown mission");
			if (projectId && projectId !== mission.projectId) throw new Error("Mission belongs to another project");
			if (!taskId) throw new Error("A mission start requires taskId");
			chat = await this.options.mutations!.startTask(missionId, taskId, {
				...choice,
				...(message ? { message: message as string } : {}),
			});
		} else {
			if (!projectId || !message || taskId)
				throw new Error("Project starts require projectId and message, without taskId");
			chat = await this.options.mutations!.startProject({ projectId, message: message as string, ...choice });
		}
		return {
			id: chat.id,
			chatUrl: `pilot://chat/${chat.id}`,
			title: chat.title,
			projectId: chat.projectId,
			missionId: chat.missionId,
			model: chat.model,
		};
	}
	private async send(args: Record<string, unknown>, operationId: string) {
		const id = string(args, "sessionId", true)!;
		if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 4000)
			throw new Error("message must be 1..4000 characters");
		if (args.direct !== undefined && typeof args.direct !== "boolean") throw new Error("direct must be a boolean");
		const chat = this.options.sessions.get(id);
		if (!chat) throw new Error("Unknown chat");
		if (this.options.isControl(id)) throw new Error("Use a user message, not send, for the control chat itself");
		let target = id;
		if (chat.missionId && !args.direct) {
			const mission = this.options.missions().find((m) => m.id === chat.missionId);
			if (!mission?.coordinatorSessionId)
				throw new Error("This mission has no coordinator; choose direct=true for a member");
			target = mission.coordinatorSessionId;
		}
		const result = await this.options.mutations!.send(
			target,
			args.message,
			`control:send:${operationId}`,
			"followUp",
		);
		return { ...result, sessionId: target, requestedSessionId: id, chatUrl: `pilot://chat/${target}` };
	}
	private status(args: Record<string, unknown>) {
		const projectId = string(args, "projectId"),
			missionId = string(args, "missionId");
		const projects = this.options.projects(),
			missions = this.options.missions();
		if (projectId && !projects.some((p) => p.id === projectId)) throw new Error("Unknown project");
		const mission = missionId ? missions.find((m) => m.id === missionId) : undefined;
		if (missionId && !mission) throw new Error("Unknown mission");
		if (projectId && mission && mission.projectId !== projectId)
			throw new Error("Mission belongs to another project");
		const selected = projectId ?? mission?.projectId;
		const chats = this.options.sessions.list({
			archived: "false",
			...(selected ? { projectId: selected } : {}),
			...(missionId ? { missionId } : {}),
		});
		const ms = missions.filter((m) => (!selected || m.projectId === selected) && (!missionId || m.id === missionId));
		const prs = chats.flatMap((chat) =>
			(chat.pullRequests ?? (chat.pullRequest ? [chat.pullRequest] : []))
				.filter((pr) => pr.state === "open" || pr.state === "draft")
				.map((pr) => ({
					sessionId: chat.id,
					url: pr.url,
					title: short(pr.title),
					number: pr.number,
					state: pr.state,
				})),
		);
		const items = projects
			.filter((p) => !selected || p.id === selected)
			.slice(0, 200)
			.flatMap((project) =>
				this.options
					.linear(project.id)
					.filter((item) => !missionId || item.missionId === missionId || item.missionIds?.includes(missionId))
					.map((item) => ({
						projectId: project.id,
						id: item.id,
						identifier: item.externalId,
						title: short(item.title),
						status: short(item.status, 60),
						url: item.url?.slice(0, 2048),
					})),
			);
		const data = {
			untrusted: true,
			source: "daemon-memory",
			projects: projects
				.filter((p) => !selected || p.id === selected)
				.slice(0, 200)
				.map((p) => ({ id: p.id, name: short(p.name, 100) })),
			chats: chats.slice(0, 100).map((chat) => ({
				id: chat.id,
				chatUrl: `pilot://chat/${chat.id}`,
				title: short(chat.title),
				projectId: chat.projectId,
				missionId: chat.missionId,
				state: chat.state,
				working: chat.working,
				outcome: chat.outcome,
				model: chat.model,
			})),
			missions: ms.slice(0, 50).map((m) => ({
				id: m.id,
				projectId: m.projectId,
				title: short(m.title),
				status: m.status,
				tasksDone: m.tasksDone,
				tasksTotal: m.tasksTotal,
				coordinatorSessionId: m.coordinatorSessionId,
			})),
			pullRequests: prs.slice(0, 100),
			linear: items.slice(0, 100),
			totals: { chats: chats.length, missions: ms.length, pullRequests: prs.length, linear: items.length },
			truncated: false,
		};
		const lists = [data.projects, data.chats, data.missions, data.pullRequests, data.linear];
		while (Buffer.byteLength(JSON.stringify(data)) > 24_000) {
			const longest = lists.reduce((a, b) => (a.length > b.length ? a : b));
			longest.pop();
			data.truncated = true;
		}
		data.truncated ||=
			data.chats.length < chats.length ||
			data.missions.length < ms.length ||
			data.pullRequests.length < prs.length ||
			data.linear.length < items.length;
		return data;
	}
	private async read(args: Record<string, unknown>) {
		const id = string(args, "sessionId", true)!;
		const chat = this.options.sessions.get(id);
		if (!chat) throw new Error("Unknown chat");
		if (args.view !== undefined && args.view !== "result" && args.view !== "tail")
			throw new Error("view must be result or tail");
		const limit = args.limit ?? 12;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 40)
			throw new Error("limit must be 1..40");
		// One bounded cold read, never a subscription or worker start. No unbounded backward search.
		const page = await this.options.sessions.history(id, Number.MAX_SAFE_INTEGER, args.view === "tail" ? limit : 64);
		const messages = page.entries.flatMap((entry) =>
			(entry.model ?? []).flatMap((message) => {
				if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n");
				return text ? [{ role: message.role, text }] : [];
			}),
		);
		const chosen =
			args.view === "tail" ? messages.slice(-limit) : messages.filter((m) => m.role === "assistant").slice(-1);
		let left = 12_000;
		const quoted = chosen
			.toReversed()
			.flatMap((m) => {
				if (!left) return [];
				const text = m.text.slice(-left);
				left -= text.length;
				return [{ role: m.role, text }];
			})
			.reverse();
		return {
			untrusted: true,
			sessionId: id,
			chatUrl: `pilot://chat/${id}`,
			quotedContent: quoted,
			truncated: page.more || chosen.reduce((n, m) => n + m.text.length, 0) > 12_000,
		};
	}
}
