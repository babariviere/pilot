import { randomUUID } from "node:crypto";
import type {
	DashboardScheduledItem,
	SchedulePatch,
	ScheduleRequest,
	ScheduledItem,
	ScheduleTarget,
	SpawnRequest,
} from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";
import type { MissionStore } from "./missions.ts";
import type { ScheduleStore } from "./schedule-store.ts";
import type { TrackedItemStore } from "./tracked-items.ts";
import type { WiFiDetector } from "./wifi-detection.ts";

/** Detection plugs in here. Initial online state is not an offline→online edge. */
export type ScheduleTriggerEvent =
	| { type: "sleep"; at: number }
	| { type: "wake"; full: boolean }
	| { type: "online"; online: boolean; initial?: boolean }
	| { type: "network"; previous: string | null; current: string | null };
export interface ScheduleTriggerSource {
	readonly online: boolean;
	/** Validate cached reachability before dispatching due work. */
	refreshOnline?(): Promise<boolean>;
	/** Use online events with initial:true to resynchronize a suspended detector without inventing an edge. */
	subscribe(listener: (event: ScheduleTriggerEvent) => void): () => void;
	/** Detection can suspend its probes when no pending schedules remain. */
	setActive?(active: boolean): void;
}
export interface ScheduleClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): () => void;
}
const clock: ScheduleClock = {
	now: Date.now,
	setTimeout(callback, ms) {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return () => clearTimeout(timer);
	},
};
// Each durable observation increments the CAS revision exactly once. Discount only those
// writes when comparing queued events; a user edit clears both latches and remains a barrier.
const saveRevision = (row: Pick<ScheduledItem, "revision" | "sleepObserved" | "wakeObserved">) =>
	row.revision - Number(!!row.sleepObserved) - Number(!!row.wakeObserved);
export interface ScheduleDispatch {
	spawn(request: SpawnRequest): Promise<{ id: string }>;
	send(id: string, message: string, mode: "followUp", requestId: string): Promise<void>;
	get(id: string): { projectId?: string } | undefined;
}
export interface ScheduleServiceDeps {
	sessions: ScheduleDispatch;
	projects: Pick<ProjectStore, "require">;
	missions?: Pick<MissionStore, "require">;
	trackedItems?: Pick<TrackedItemStore, "require" | "patch">;
	clock?: ScheduleClock;
	triggers?: ScheduleTriggerSource;
	wifi?: WiFiDetector;
}
/** One serial dispatcher. No detection/polling here; one nearest-deadline timer while online. */
export class ScheduleService {
	private readonly time: ScheduleClock;
	private online = false;
	private started = false;
	private stopped = false;
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
	private sweepQueued = false;
	private cancelTimer?: () => void;
	private disposers: Array<() => void> = [];
	readonly store: ScheduleStore;
	private readonly deps: ScheduleServiceDeps;
	constructor(store: ScheduleStore, deps: ScheduleServiceDeps) {
		this.store = store;
		this.deps = deps;
		this.time = deps.clock ?? clock;
	}
	async load(): Promise<void> {
		await this.store.load(this.time.now());
	}
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		if (this.deps.wifi)
			this.disposers.push(
				this.deps.wifi.subscribe((event) => {
					void this.signal({ type: "network", ...event }).catch(() =>
						console.warn("pilotd: Wi-Fi schedule dispatch failed"),
					);
				}),
			);
		this.online = this.deps.triggers?.online ?? false;
		this.disposers.push(
			this.store.onChange(() => {
				// A durable claim removes the last pending item before admission can take a long time.
				if (this.store.pendingItems().length === 0) {
					this.deps.triggers?.setActive?.(false);
					this.deps.wifi?.setActive(false);
				}
				this.requestSweep();
			}),
		);
		if (this.deps.triggers)
			this.disposers.push(
				this.deps.triggers.subscribe((event) => {
					void this.signal(event).catch((error) => console.warn(`pilotd: schedule trigger: ${error}`));
				}),
			);
		this.requestSweep();
	}
	private enqueue(work: () => Promise<void>): Promise<void> {
		if (this.stopped) return Promise.reject(new ServiceUnavailable("Scheduler stopped"));
		if (this.queued >= 64) return Promise.reject(new ServiceUnavailable("Scheduler busy; retry shortly"));
		this.queued++;
		const next = this.tail.then(work);
		this.tail = next
			.catch(() => {})
			.finally(() => {
				this.queued--;
			});
		return next;
	}
	private requestSweep(): void {
		if (!this.started || this.stopped || this.sweepQueued) return;
		this.sweepQueued = true;
		void this.enqueue(async () => {
			this.sweepQueued = false;
			await this.sweep();
		}).catch((error) => {
			this.sweepQueued = false;
			console.warn(`pilotd: schedule dispatch: ${error}`);
		});
	}
	/** Injectable fast path for daemon detectors (not an HTTP endpoint). */
	signal(event: ScheduleTriggerEvent): Promise<void> {
		if (!this.started || this.stopped) return Promise.reject(new ServiceUnavailable("Scheduler not running"));
		if (this.queued >= 64) return Promise.reject(new ServiceUnavailable("Scheduler busy; retry shortly"));
		// Capture candidates now: a schedule created after the event must wait for the next one.
		const candidates = this.store.pendingItems();
		const becameOnline = event.type === "online" && event.online && !this.online && !event.initial;
		if (event.type === "online") this.online = event.online;
		return this.enqueue(async () => {
			for (const candidate of candidates) {
				try {
					const item = this.store.require(candidate.id);
					// Latch writes advance the CAS revision, but must not invalidate already queued
					// sleep→wake events. Every edit clears both latches and advances this save revision.
					if (item.state !== "pending" || saveRevision(item) !== saveRevision(candidate)) continue;
					if (
						event.type === "sleep" &&
						Math.floor(event.at) > item.updatedAt &&
						(item.trigger === "on_wake" || item.trigger === "on_back") &&
						!item.sleepObserved
					)
						await this.store.replace(item, { ...item, sleepObserved: true });
					else if (
						event.type === "wake" &&
						event.full &&
						item.sleepObserved &&
						item.trigger === "on_back" &&
						!item.wakeObserved
					)
						await this.store.replace(item, { ...item, wakeObserved: true });
					else if (
						(event.type === "wake" && event.full && item.sleepObserved && item.trigger === "on_wake") ||
						(becameOnline && item.trigger === "on_online") ||
						(event.type === "network" &&
							item.trigger === "on_join_network" &&
							event.current !== null &&
							event.current !== event.previous &&
							item.networkNames!.includes(event.current)) ||
						(event.type === "network" &&
							item.trigger === "on_leave_network" &&
							event.previous !== null &&
							event.current !== event.previous &&
							item.networkNames!.includes(event.previous))
					)
						await this.fire(item);
				} catch (error) {
					if (!(error instanceof Conflict || error instanceof NotFound)) throw error;
				}
			}
			await this.sweep();
		});
	}
	private async sweep(): Promise<void> {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		const pending = this.store.pendingItems();
		if (
			this.online &&
			this.deps.triggers?.refreshOnline &&
			pending.some(
				(item) =>
					(item.trigger === "at" && item.at! <= this.time.now()) ||
					(item.trigger === "on_back" && item.sleepObserved && item.wakeObserved),
			)
		)
			this.online = await this.deps.triggers.refreshOnline();
		for (const item of pending) {
			if (this.stopped) break;
			if (!this.online) continue;
			if (
				(item.trigger === "at" && item.at! <= this.time.now()) ||
				(item.trigger === "on_back" && item.sleepObserved && item.wakeObserved)
			) {
				try {
					const current = this.store.require(item.id);
					if (current.state === "pending" && current.revision === item.revision) await this.fire(current);
				} catch (error) {
					if (!(error instanceof NotFound)) throw error;
				}
			}
		}
		this.arm();
	}
	private arm(): void {
		const pending = this.store.pendingItems();
		this.deps.wifi?.setActive(
			!this.stopped &&
				pending.some((item) => item.trigger === "on_join_network" || item.trigger === "on_leave_network"),
		);
		this.deps.triggers?.setActive?.(
			!this.stopped &&
				pending.some((item) => item.trigger !== "on_join_network" && item.trigger !== "on_leave_network"),
		);
		if (this.stopped || !this.online) return;
		const next = Math.min(...pending.filter((item) => item.trigger === "at").map((item) => item.at!));
		if (Number.isFinite(next))
			this.cancelTimer = this.time.setTimeout(
				() => {
					this.cancelTimer = undefined;
					this.requestSweep();
				},
				Math.min(2_147_483_647, Math.max(0, next - this.time.now())),
			);
	}
	private async fire(item: ScheduledItem): Promise<void> {
		if (this.stopped) return;
		let claimed: ScheduledItem;
		try {
			claimed = await this.store.replace(item, {
				...item,
				state: "dispatching",
				claimedAt: this.time.now(),
				updatedAt: this.time.now(),
			});
		} catch (error) {
			if (error instanceof Conflict || error instanceof NotFound) return;
			throw error;
		}
		let next: ScheduledItem;
		let sessionId: string | undefined;
		try {
			if (claimed.target.kind === "chat") {
				// Recheck the local ticket's project binding before admission.
				await this.validateTrackedItem(claimed.target.trackedItemId, claimed.projectId);
				sessionId = (await this.deps.sessions.spawn(claimed.target.spawn)).id;
				if (claimed.target.trackedItemId)
					await this.deps.trackedItems!.patch(claimed.target.trackedItemId, { sessionId, start: true });
			} else {
				sessionId = claimed.target.sessionId;
				if (!this.deps.sessions.get(sessionId)) throw new NotFound("Target chat was deleted");
				await this.deps.sessions.send(sessionId, claimed.target.message, "followUp", `schedule:${claimed.id}`);
			}
			next = { ...claimed, sessionId, state: "fired", firedAt: this.time.now(), updatedAt: this.time.now() };
		} catch (error) {
			next = {
				...claimed,
				sessionId,
				state: "failed",
				error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
				updatedAt: this.time.now(),
			};
		}
		// A persistence failure leaves the durable claim intact. Never redispatch automatically.
		await this.store.replace(claimed, next);
	}
	async create(request: ScheduleRequest): Promise<ScheduledItem> {
		this.assertOpen();
		const data = await this.validate(request);
		const now = this.time.now();
		return this.store.create({
			...data,
			id: randomUUID(),
			revision: 1,
			state: "pending",
			createdAt: now,
			updatedAt: now,
		});
	}
	async update(id: string, patch: SchedulePatch): Promise<ScheduledItem> {
		this.assertOpen();
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Schedule patch is required");
		for (const key of ["title", "trigger", "at", "networkNames", "target", "expectedRevision"] as const)
			if (patch[key] === null) throw new Error(`${key} cannot be null`);
		if (
			patch.expectedRevision !== undefined &&
			(!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1)
		)
			throw new Error("expectedRevision must be a positive integer");
		const old = this.store.require(id);
		if (old.state !== "pending") throw new Conflict("Only pending schedules can be edited");
		if (patch.expectedRevision !== undefined && patch.expectedRevision !== old.revision)
			throw new Conflict("Schedule changed; reload before editing");
		const trigger = patch.trigger ?? old.trigger;
		const data = await this.validate({
			title: patch.title ?? old.title,
			trigger,
			at: trigger === "at" ? (patch.at ?? old.at) : patch.at,
			networkNames:
				patch.networkNames ??
				(trigger === "on_join_network" || trigger === "on_leave_network" ? old.networkNames : undefined),
			target: patch.target ?? old.target,
		});
		return this.store.replace(old, {
			...old,
			...data,
			at: data.at,
			networkNames: data.networkNames,
			projectId: data.projectId,
			sessionId: data.sessionId,
			wakeObserved: undefined,
			sleepObserved: undefined,
			updatedAt: this.time.now(),
		});
	}
	/** Pending rows are cancelled, terminal rows dismissed. In-flight claims cannot be cancelled. */
	async remove(id: string): Promise<void> {
		this.assertOpen();
		const old = this.store.require(id);
		if (old.state === "dispatching") throw new Conflict("Schedule is already dispatching");
		if (old.state === "pending")
			await this.store.replace(old, { ...old, state: "cancelled", updatedAt: this.time.now() });
		else await this.store.remove(old);
	}
	list(projectId?: string): ScheduledItem[] {
		return this.store.list(projectId);
	}
	wifiStatus(requestAuthorization = false) {
		if (!this.deps.wifi) throw new ServiceUnavailable("Wi-Fi detection unavailable");
		return requestAuthorization ? this.deps.wifi.requestAuthorization() : this.deps.wifi.status();
	}
	snapshot(projectId?: string, ws = false): Promise<string> {
		return this.store.snapshot(projectId, ws);
	}
	require(id: string): ScheduledItem {
		return this.store.require(id);
	}
	onChange(listener: () => void): () => void {
		return this.store.onChange(listener);
	}
	dashboard(projectId: string): DashboardScheduledItem[] {
		return this.store.dashboard(projectId);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancelTimer?.();
		for (const dispose of this.disposers.splice(0)) dispose();
		this.deps.triggers?.setActive?.(false);
		this.deps.wifi?.setActive(false);
		await this.tail;
	}
	private assertOpen(): void {
		if (this.stopped) throw new ServiceUnavailable("Scheduler stopped");
	}
	private async validateTrackedItem(id: string | undefined, projectId: string | undefined): Promise<void> {
		if (id === undefined) return;
		if (typeof id !== "string" || !id.trim() || id.length > 200)
			throw new Error("trackedItemId must be 1 to 200 characters");
		if (!this.deps.trackedItems) throw new ServiceUnavailable("Tracking unavailable");
		const item = await this.deps.trackedItems.require(id);
		if (!projectId || item.projectId !== projectId) throw new Error("Ticket must belong to this project");
	}
	private async validate(
		request: ScheduleRequest,
	): Promise<Pick<ScheduledItem, "title" | "trigger" | "at" | "networkNames" | "target" | "projectId" | "sessionId">> {
		if (!request || typeof request !== "object" || Array.isArray(request))
			throw new Error("Schedule request is required");
		const trigger = request.trigger === undefined ? "on_back" : request.trigger;
		if (!["on_back", "on_wake", "on_online", "at", "on_join_network", "on_leave_network"].includes(trigger))
			throw new Error("Invalid schedule trigger");
		let networkNames: string[] | undefined;
		if (trigger === "on_join_network" || trigger === "on_leave_network") {
			if (
				!Array.isArray(request.networkNames) ||
				request.networkNames.length < 1 ||
				request.networkNames.length > 32 ||
				request.networkNames.some(
					(name) => typeof name !== "string" || !name.length || Buffer.byteLength(name) > 32,
				)
			)
				throw new Error("networkNames must contain 1 to 32 Wi-Fi names of 1 to 32 UTF-8 bytes");
			networkNames = [...new Set(request.networkNames)];
		} else if (request.networkNames !== undefined) throw new Error("networkNames is only valid for network triggers");
		if (trigger === "at") {
			if (
				typeof request.at !== "number" ||
				!Number.isSafeInteger(request.at) ||
				request.at < 0 ||
				request.at > 8.64e15
			)
				throw new Error("at must be epoch milliseconds");
		} else if (request.at !== undefined) throw new Error("at is only valid for an at trigger");
		if (
			request.title !== undefined &&
			(typeof request.title !== "string" || !request.title.trim() || request.title.length > 200)
		)
			throw new Error("title must be 1 to 200 characters");
		const raw = request.target;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("target is required");
		let target: ScheduleTarget, projectId: string | undefined, sessionId: string | undefined, message: string;
		if (raw.kind === "chat") {
			const spawn = raw.spawn;
			if (!spawn || typeof spawn !== "object" || Array.isArray(spawn)) throw new Error("spawn is required");
			const copy: SpawnRequest = { message: spawn.message };
			for (const key of [
				"missionId",
				"projectId",
				"cwd",
				"title",
				"model",
				"thinking",
				"baseBranch",
				"mode",
				"workspace",
			] as const) {
				const value = spawn[key];
				if (value !== undefined) {
					if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
					(copy as unknown as Record<string, string>)[key] = value;
				}
			}
			if (copy.mode !== undefined && !["build", "ask"].includes(copy.mode)) throw new Error("Invalid chat mode");
			if (copy.workspace !== undefined && !["clone", "direct"].includes(copy.workspace))
				throw new Error("Invalid workspace");
			projectId = copy.projectId;
			if (copy.missionId) {
				if (!this.deps.missions) throw new NotFound("Unknown mission");
				const mission = this.deps.missions.require(copy.missionId);
				if (mission.status !== "active") throw new Conflict("Mission is not active");
				if (projectId && projectId !== mission.projectId) throw new Conflict("Mission belongs to another project");
				if (copy.cwd !== undefined) throw new Error("missionId does not allow cwd");
				projectId = mission.projectId;
			}
			const project = projectId ? this.deps.projects.require(projectId) : undefined;
			if (!projectId && !copy.cwd) throw new Error("projectId, missionId or cwd is required");
			if (copy.workspace && (copy.mode === "ask" || !project || copy.cwd))
				throw new Error("workspace override requires a Build project without cwd");
			if (
				copy.baseBranch &&
				(!project || copy.cwd || (copy.mode !== "ask" && (copy.workspace ?? project.workspace) === "direct"))
			)
				throw new Error("baseBranch requires a branch-backed project");
			await this.validateTrackedItem(raw.trackedItemId, projectId);
			target = {
				kind: "chat",
				spawn: copy,
				...(raw.trackedItemId !== undefined ? { trackedItemId: raw.trackedItemId } : {}),
			};
			message = copy.message;
		} else if (raw.kind === "message") {
			if ("trackedItemId" in raw) throw new Error("trackedItemId is only valid for a chat target");
			if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) throw new Error("sessionId is required");
			const session = this.deps.sessions.get(raw.sessionId);
			if (!session) throw new NotFound("Unknown target chat");
			sessionId = raw.sessionId;
			projectId = session.projectId;
			target = { kind: "message", sessionId, message: raw.message };
			message = raw.message;
		} else throw new Error("target kind must be chat or message");
		if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
		if (Buffer.byteLength(JSON.stringify(target)) > 16_384) throw new Error("Schedule target exceeds 16 KiB");
		return {
			title:
				request.title?.trim() ??
				(target.kind === "chat" ? target.spawn.title?.trim().slice(0, 200) : undefined) ??
				message.trim().split("\n")[0].slice(0, 200),
			trigger,
			at: request.at,
			networkNames,
			target,
			projectId,
			sessionId,
		};
	}
}
