import { createHash } from "node:crypto";
import type { ControlTurnOrigin } from "@pilot/kernel";
import type {
	ControlAuthorizationLevel,
	CreateMissionRequest,
	DashboardTrackedItem,
	Mission,
	Project,
	SessionSummary,
	SpawnRequest,
	StartMissionCoordinatorRequest,
	StartMissionTaskRequest,
	WatchTarget,
} from "@pilot/protocol";
import type { ControlActions } from "./control-actions.ts";
import {
	authorizationLevel,
	type ControlAuthorizationUse,
	createAuthorization,
	legacyWatchAuthorization,
} from "./control-authorizations.ts";
import { buildControlDashboard, type ControlDashboardSources } from "./control-dashboard.ts";
import type { ControlDiagnostics } from "./control-diagnostics.ts";
import type { ControlMemory } from "./control-memory.ts";
import { pullRequestChecks } from "./control-pr-checks.ts";
import type { SessionManager } from "./sessions.ts";
import type { WatchService } from "./watch-service.ts";
import { validateWatch, type WatchInput } from "./watches.ts";

export interface ControlPilotOptions extends ControlDashboardSources {
	diagnostics?: Pick<ControlDiagnostics, "call">;
	watches?: Pick<
		WatchService,
		| "add"
		| "remove"
		| "page"
		| "authority"
		| "followThrough"
		| "cancelFollowThrough"
		| "authorizationNeeded"
		| "resolveAuthorization"
	>;
	authorizations?: () => ControlMemory;
	turnOrigin?: () => Promise<ControlTurnOrigin | undefined>;
	taskDone?: (missionId: string, taskId: string) => boolean;
	taskSession?: (missionId: string, taskId: string) => string | undefined;
	isControl: (id: string) => boolean;
	sessions: Pick<SessionManager, "list" | "get" | "history">;
	/** Cached projections only. These callbacks must not perform storage or network reads. */
	missions: () => Mission[];
	projects: () => Project[];
	linear: (projectId: string) => DashboardTrackedItem[];
	checks?: (pr: string, includeStale: boolean) => Promise<unknown>;
	mutations?: {
		audit: () => ControlActions;
		startProject: (request: SpawnRequest, requestId?: string) => Promise<SessionSummary>;
		startTask: (
			missionId: string,
			taskId: string,
			request: StartMissionTaskRequest,
			requestId?: string,
		) => Promise<SessionSummary>;
		send: SessionManager["sendReported"];
		organizeAllowed?: () => boolean;
		createMission?: (request: CreateMissionRequest) => Promise<Mission>;
		startCoordinator?: (missionId: string, request: StartMissionCoordinatorRequest) => Promise<SessionSummary>;
		attachMission?: (sessionId: string, missionId: string, taskId?: string) => Promise<SessionSummary>;
	};
}
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
		if (action === "health" || action === "logs" || action === "telemetry") {
			if (!this.options.diagnostics) throw new Error("Control diagnostics unavailable");
			return this.options.diagnostics.call(action, args);
		}
		if (action === "status") return this.dashboard(args);
		if (action === "read") return this.read(args);
		if (action === "resolve_authorization") {
			if (!(await this.options.turnOrigin?.())?.userMessage)
				throw new Error("Resolving an authorization need requires a user-origin turn");
			if (!this.options.mutations || !this.options.watches?.resolveAuthorization)
				throw new Error("Control actions unavailable");
			const id = string(args, "itemId", true)!;
			return this.options.mutations.audit().perform(caller, action, args, operationId, async () => ({
				resolved: await this.options.watches!.resolveAuthorization!(id),
			}));
		}
		if (action === "checks") {
			const pr = args.pr;
			if (typeof pr !== "string" || !pr.trim() || pr.length > 2048)
				throw new Error("pr must be a GitHub pull request URL");
			if (args.includeStale !== undefined && typeof args.includeStale !== "boolean")
				throw new Error("includeStale must be a boolean");
			return (this.options.checks ?? pullRequestChecks)(pr, args.includeStale === true);
		}
		if (action === "authorize") {
			const turn = await this.options.turnOrigin?.();
			if (!turn?.userMessage)
				throw new Error("Authorization requires the active user-origin turn, not a notice or tool input");
			const memory = this.authorizationMemory();
			if (!this.options.mutations) throw new Error("Control actions unavailable");
			const id = `auth:${createHash("sha256").update(`${caller}:${operationId}`).digest("hex")}`;
			const record = createAuthorization(id, args, turn.userMessage);
			return this.options.mutations
				.audit()
				.perform(caller, action, { ...args, authorizationId: id }, operationId, () =>
					memory.authorizationCreate(record),
				);
		}
		if (action === "watch" || action === "unwatch" || action === "watches") {
			const watches = this.options.watches;
			if (!watches) throw new Error("Watches unavailable");
			if (action === "watches") return watches.page(string(args, "after"), args.limit as number | undefined);
			if (action === "unwatch") return { removed: await watches.remove(string(args, "watchId", true)!) };
			const input = validateWatch(args as unknown as WatchInput);
			const targets = this.watchTargets(input.target);
			const use = await this.authorizationOrNeed(caller, args, "watch", [targets], operationId);
			if (!this.options.mutations) throw new Error("Control actions unavailable");
			return this.options.mutations.audit().perform(
				caller,
				action,
				args,
				operationId,
				async () => {
					if (JSON.stringify(this.watchTargets(input.target)) !== JSON.stringify(targets))
						throw new Error("Watch target changed during admission");
					return watches.add({ ...input, authorizationId: use.authorizationId });
				},
				use,
				(error) => this.authorizationNeeded(caller, action, args, operationId, error),
			);
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
			if (!this.options.watches) throw new Error("Result watches unavailable; no action taken");
			const targets = action === "send" ? this.sendTargets(args) : this.startTargets(args);
			const use = await this.authorizationOrNeed(caller, args, action, targets, operationId);
			return this.options.mutations.audit().perform<unknown>(
				caller,
				action,
				args,
				operationId,
				async () => {
					const current = action === "send" ? this.sendTargets(args) : this.startTargets(args);
					if (JSON.stringify(current) !== JSON.stringify(targets))
						throw new Error("Control action target changed during admission");
					try {
						return action === "start" ? await this.start(args, operationId) : await this.send(args, operationId);
					} catch (error) {
						// New chats bind before starting. Failed pre-admission starts cannot leak watches.
						// Sends can have an uncertain acknowledgement; retain those for committed-input recovery.
						if (action === "start")
							await this.options.watches!.cancelFollowThrough(`control:start:${operationId}`, true);
						throw error;
					}
				},
				use,
				(error) => this.authorizationNeeded(caller, action, args, operationId, error),
			);
		}
		throw new Error("Unknown pilot action");
	}
	private async authorizationNeeded(
		caller: string,
		action: "start" | "send" | "watch",
		args: Record<string, unknown>,
		operationId: string,
		error: unknown,
	): Promise<void> {
		if (!operationId || operationId.length > 256) return;
		await this.options.watches?.authorizationNeeded?.({
			id: createHash("sha256").update(`${caller}:${operationId}`).digest("hex"),
			action,
			request: JSON.stringify({ action, ...args }),
			reason: error instanceof Error ? error.message.slice(0, 500) : "Authorization required",
			createdAt: Date.now(),
		});
	}
	private async authorizationOrNeed(
		caller: string,
		args: Record<string, unknown>,
		action: "start" | "send" | "watch",
		targets: WatchTarget[][],
		operationId: string,
	) {
		// Keep a complete denied request (including JSON escaping), not a clipped instruction.
		if (
			Buffer.byteLength(JSON.stringify(args)) > 16_000 ||
			Buffer.byteLength(JSON.stringify({ request: JSON.stringify({ action, ...args }) })) > 18_000
		)
			throw new Error("Control request too large to capture exactly");
		try {
			return await this.authorizationUse(args, action, targets);
		} catch (error) {
			await this.authorizationNeeded(caller, action, args, operationId, error);
			throw error;
		}
	}
	private authorizationMemory(): ControlMemory {
		if (!this.options.authorizations) throw new Error("Control authorizations unavailable");
		return this.options.authorizations();
	}
	private async authorizationUse(
		args: Record<string, unknown>,
		action: "start" | "send" | "watch",
		targets: WatchTarget[][],
	): Promise<ControlAuthorizationUse> {
		const authorizationId = string(args, "authorizationId", true)!;
		const memory = this.authorizationMemory();
		let legacyWatch: ControlAuthorizationUse["legacyWatch"];
		if (authorizationId.startsWith("watch:")) {
			if (action === "watch") throw new Error("A legacy watch cannot authorize another watch");
			const watchId = authorizationId.slice(6);
			const turn = await this.options.turnOrigin?.();
			const watch = turn && (await this.options.watches?.authority(watchId, turn.requestId));
			if (!watch || watch.authorizationId) throw new Error("Legacy watch is not part of the active delivery");
			if (args.message !== watch.note) throw new Error("Legacy watch authorizes only its exact saved note");
			legacyWatch = { watchId, note: watch.note };
			await memory.authorizationCreate(legacyWatchAuthorization(watch));
		}
		const record = await memory.authorizationGet(authorizationId);
		if (!record) throw new Error("Unknown authorization");
		if (
			record.targets.some(
				(target) => target.kind === "task" && this.options.taskDone?.(target.missionId!, target.id),
			)
		) {
			await memory.authorizationRevoke(record.id);
			throw new Error("Authorization ended because its task is done");
		}
		const level = args.level === undefined ? "investigate" : authorizationLevel(args.level);
		// A task scope follows its current, daemon-confirmed owner, never an arbitrary supplied chat ID.
		const scopedTargets = targets.map((alternatives) => [...alternatives]);
		for (const target of record.targets)
			if (target.kind === "task") {
				const owner = this.options.taskSession?.(target.missionId!, target.id);
				for (const alternatives of scopedTargets)
					if (owner && alternatives.some((item) => item.kind === "chat" && item.id === owner))
						alternatives.push(target);
			}
		const budgetUsd = action === "watch" ? 0 : args.budgetUsd;
		if (
			!legacyWatch &&
			action !== "watch" &&
			(typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0)
		)
			throw new Error("start/send require an explicit positive budgetUsd reservation");
		return {
			authorizationId,
			level: level as ControlAuthorizationLevel,
			targets: scopedTargets,
			followUps: action === "send" ? 1 : 0,
			...(action === "start" ? { initialStart: true } : {}),
			budgetUsd: typeof budgetUsd === "number" ? budgetUsd : 0,
			...(legacyWatch ? { legacyWatch } : {}),
		};
	}
	private startTargets(args: Record<string, unknown>): WatchTarget[][] {
		const missionId = string(args, "missionId");
		if (missionId) {
			const mission = this.options.missions().find((mission) => mission.id === missionId);
			if (!mission) throw new Error("Unknown mission");
			const taskId = string(args, "taskId", true)!;
			return [
				[
					{ kind: "project", id: mission.projectId },
					{ kind: "mission", id: missionId },
					{ kind: "task", id: taskId, missionId },
				],
			];
		}
		return [[{ kind: "project", id: string(args, "projectId", true)! }]];
	}
	private watchTargets(target: WatchTarget): WatchTarget[] {
		if (target.kind === "chat" || target.kind === "chat_prs")
			return [
				target,
				...this.chatTargets(target.id).filter((scope) => scope.kind === "project" || scope.kind === "mission"),
			];
		if (target.kind === "mission" || target.kind === "task") {
			const missionId = target.kind === "mission" ? target.id : target.missionId!;
			const mission = this.options.missions().find((mission) => mission.id === missionId);
			if (!mission) throw new Error("Unknown mission");
			return [target, { kind: "mission", id: missionId }, { kind: "project", id: mission.projectId }];
		}
		return [target];
	}
	private chatTargets(id: string): WatchTarget[] {
		const chat = this.options.sessions.get(id);
		if (!chat) throw new Error("Unknown chat");
		return [
			{ kind: "chat", id },
			{ kind: "chat_prs", id },
			...(chat.projectId ? [{ kind: "project" as const, id: chat.projectId }] : []),
			...(chat.missionId ? [{ kind: "mission" as const, id: chat.missionId }] : []),
			...(chat.pullRequests ?? (chat.pullRequest ? [chat.pullRequest] : [])).map((pr) => ({
				kind: "pr" as const,
				id: pr.url,
			})),
		];
	}
	private sendTargets(args: Record<string, unknown>): WatchTarget[][] {
		const id = string(args, "sessionId", true)!;
		const requested = this.chatTargets(id);
		const chat = this.options.sessions.get(id)!;
		if (!chat.missionId || args.direct === true) return [requested];
		const lead = this.options.missions().find((mission) => mission.id === chat.missionId)?.coordinatorSessionId;
		if (!lead) throw new Error("This mission has no coordinator; choose direct=true for a member");
		return [requested, this.chatTargets(lead)];
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
	private async start(args: Record<string, unknown>, operationId: string) {
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
		const requestId = `control:start:${operationId}`;
		if (missionId) {
			const mission = this.options.missions().find((m) => m.id === missionId);
			if (!mission) throw new Error("Unknown mission");
			if (projectId && projectId !== mission.projectId) throw new Error("Mission belongs to another project");
			if (!taskId) throw new Error("A mission start requires taskId");
			await this.options.watches!.followThrough(requestId, args.authorizationId as string);
			chat = await this.options.mutations!.startTask(
				missionId,
				taskId,
				{
					...choice,
					...(message ? { message: message as string } : {}),
				},
				requestId,
			);
		} else {
			if (!projectId || !message || taskId)
				throw new Error("Project starts require projectId and message, without taskId");
			await this.options.watches!.followThrough(requestId, args.authorizationId as string);
			chat = await this.options.mutations!.startProject(
				{ projectId, message: message as string, ...choice },
				requestId,
			);
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
		await this.options.watches!.followThrough(`control:send:${operationId}`, args.authorizationId as string, target);
		const result = await this.options.mutations!.send(
			target,
			args.message,
			`control:send:${operationId}`,
			"followUp",
		);
		if (result.delivery === "rejected")
			await this.options.watches?.cancelFollowThrough?.(`control:send:${operationId}`);
		return { ...result, sessionId: target, requestedSessionId: id, chatUrl: `pilot://chat/${target}` };
	}
	/** Also serves the local-user dashboard endpoint, without creating the singleton or starting a worker. */
	dashboard(args: Record<string, unknown> = {}) {
		return buildControlDashboard(this.options, args);
	}
	onDashboardChange(listener: () => void): () => void {
		return this.options.onDashboardChange?.(listener) ?? (() => {});
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
