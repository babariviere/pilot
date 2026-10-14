import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PowerSettings, PowerStatus, SessionSummary } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { openPowerHelper, type PowerHelper, type PowerHelperFactory, type PowerSample } from "./power-helper.ts";

export interface PowerSessions {
	readonly powerPause: { since: number; wakeToken?: string } | undefined;
	list(): SessionSummary[];
	onChange(listener: (session: SessionSummary) => void): () => void;
	pauseForSleep(wakeToken?: string): Promise<void>;
	resumeAfterSleep(): Promise<void>;
}

/** Pure policy: unknown lid, AC or network state never authorizes a system-wide override. */
export function closedLidAllowed(state: PowerSample): boolean {
	return (
		state.available && state.lidClosed !== null && !state.sleeping && state.connectedToPower && state.wifiConnected
	);
}
export function laterWake(
	pause: NonNullable<PowerSessions["powerPause"]>,
	state: PowerSample,
	allowClosedLid = false,
): boolean {
	return (
		state.available &&
		!state.sleeping &&
		state.fullWake &&
		state.online &&
		(state.lidClosed !== true || (allowClosedLid && closedLidAllowed(state))) &&
		pause.wakeToken !== undefined &&
		state.wakeToken !== pause.wakeToken
	);
}

/** One serialized evaluator. Coalesce stream/activity bursts; never queue one operation per token. */
export class PowerService {
	private settings: PowerSettings = { keepAwake: true, closedLid: false };
	private state?: PowerSample;
	private helper?: PowerHelper;
	private stopSessions?: () => void;
	private working = new Set<string>();
	private listeners = new Set<() => void>();
	private dirty = false;
	private evaluating?: Promise<void>;
	private stopping = false;
	private retry?: NodeJS.Timeout;
	private failures = 0;
	private error?: string;
	private applied?: string;
	private keepingAwake = false;
	private configuring = false;
	private published = "";
	private readonly home: string;
	private readonly sessions: PowerSessions;
	private readonly factory: PowerHelperFactory;
	constructor(home: string, sessions: PowerSessions, factory: PowerHelperFactory = openPowerHelper) {
		this.home = home;
		this.sessions = sessions;
		this.factory = factory;
	}

	async start(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(join(this.home, "power-settings.json"), "utf8"));
			if (typeof saved.keepAwake !== "boolean" || typeof saved.closedLid !== "boolean")
				throw new Error("Invalid energy settings");
			this.settings = saved;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.error = "Energy settings could not be loaded. Closed-lid operation is off.";
		}
		for (const session of this.sessions.list()) this.record(session);
		this.stopSessions = this.sessions.onChange((session) => {
			const previous = this.working.has(session.id);
			this.record(session);
			if (previous !== this.working.has(session.id)) this.schedule();
		});
		await this.connect();
	}
	refresh(): void {
		for (const session of this.sessions.list()) this.record(session);
		this.schedule();
	}
	private record(session: SessionSummary): void {
		const busy =
			session.archivedAt === undefined &&
			!session.sleepPaused &&
			((session.working ??
				(session.state === "working" || session.state === "starting" || !!session.runningJobs?.length)) ||
				(session.state === "idle" && session.subagents?.some((agent) => agent.state === "working")));
		if (busy) this.working.add(session.id);
		else this.working.delete(session.id);
	}
	private async connect(): Promise<void> {
		if (this.stopping) return;
		try {
			const helper = await this.factory(
				(state) => {
					this.state = state;
					this.failures = 0;
					this.schedule();
				},
				() => this.lost(),
			);
			if (this.stopping) await helper.close();
			else {
				this.helper = helper;
				this.schedule();
			}
		} catch {
			this.lost();
		}
	}
	private lost(): void {
		this.helper = undefined;
		this.applied = undefined;
		this.keepingAwake = false;
		this.error = "Energy helper unavailable. Closed-lid operation is off.";
		// If monitoring disappears during a closed-lid session, preserve work, never keep blindly running.
		if (!this.stopping && (this.state?.lidClosed === true || this.state?.closedLidActive))
			void this.sessions.pauseForSleep(this.state?.wakeToken).catch(() => {
				this.error = "Could not save paused agents.";
				this.publish();
			});
		this.state = undefined;
		this.schedule();
		this.publish();
		if (!this.stopping && !this.retry) {
			this.retry = setTimeout(
				() => {
					this.retry = undefined;
					void this.connect();
				},
				Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)),
			);
			this.retry.unref();
		}
	}
	private schedule(): void {
		this.dirty = true;
		if (this.evaluating || this.stopping) return;
		this.evaluating = Promise.resolve()
			.then(async () => {
				while (this.dirty && !this.stopping) {
					this.dirty = false;
					try {
						await this.evaluate();
					} catch {
						this.error = "Energy operation failed. Check administrator permission in Energy settings.";
					}
					this.publish();
				}
			})
			.finally(() => {
				this.evaluating = undefined;
				if (this.dirty && !this.stopping) this.schedule();
			});
	}
	/** Useful as an explicit boundary in tests and configuration, not a polling loop. */
	async settled(): Promise<void> {
		while (this.evaluating) await this.evaluating;
	}
	private async evaluate(): Promise<void> {
		const state = this.state;
		const helper = this.helper;
		if (this.sessions.powerPause && !this.settings.keepAwake) await this.sessions.resumeAfterSleep();
		if (!state || !helper) return;
		const pause = this.sessions.powerPause;
		if (pause && laterWake(pause, state, this.settings.closedLid)) await this.sessions.resumeAfterSleep();
		if (
			this.settings.keepAwake &&
			!this.sessions.powerPause &&
			(state.sleeping || (state.lidClosed === true && !closedLidAllowed(state)))
		) {
			// Durable latch and kernel close must finish BEFORE clearing the system-wide override.
			try {
				await this.sessions.pauseForSleep(state.wakeToken);
			} catch (error) {
				// A disk/teardown failure must not strand a global sleep override on a departing laptop.
				try {
					await helper.close();
				} finally {
					this.keepingAwake = false;
				}
				throw error;
			}
		}
		if (this.helper !== helper || this.state !== state) {
			this.dirty = true;
			return;
		}
		const awake = this.settings.keepAwake && !this.sessions.powerPause && this.working.size > 0;
		const closedLid = awake && this.settings.closedLid && state.authorized && closedLidAllowed(state);
		const key = JSON.stringify([awake, closedLid]);
		if (this.applied !== key) {
			await helper.request({ action: "activity", awake, closedLid });
			this.applied = key;
			this.keepingAwake = awake;
			this.error = undefined;
		}
		if (state.sleeping) await helper.request({ action: "allowSleep" });
		else if (!closedLid && state.lidClosed === true) await helper.request({ action: "sleep" });
	}
	status(): PowerStatus {
		return {
			settings: { ...this.settings },
			available: this.state?.available ?? false,
			authorized: this.state?.authorized ?? false,
			keepingAwake: this.keepingAwake,
			closedLidActive: this.state?.closedLidActive ?? false,
			paused: !!this.sessions.powerPause,
			connectedToPower: this.state?.connectedToPower ?? false,
			wifiConnected: this.state?.wifiConnected ?? false,
			...(this.error ? { error: this.error } : {}),
		};
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private publish(): void {
		const value = JSON.stringify(this.status());
		if (value === this.published) return;
		this.published = value;
		for (const listener of this.listeners) listener();
	}
	async configure(value: unknown): Promise<PowerStatus> {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected energy settings");
		const v = value as PowerSettings;
		if (typeof v.keepAwake !== "boolean" || typeof v.closedLid !== "boolean")
			throw new Error("Energy settings must be booleans");
		if (this.configuring) throw new Conflict("Energy setup is already in progress");
		this.configuring = true;
		try {
			if (((v.keepAwake && v.closedLid) || this.state?.closedLidActive) && !this.state?.authorized) {
				if (!this.helper) throw new Conflict("Energy helper is unavailable. Use the bundled macOS app.");
				await this.helper.request({ action: "authorize" });
			}
			await mkdir(this.home, { recursive: true, mode: 0o700 });
			const file = join(this.home, "power-settings.json");
			const temp = `${file}.${randomUUID()}.tmp`;
			const next = { keepAwake: v.keepAwake, closedLid: v.closedLid };
			await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
			await rename(temp, file);
			this.settings = next;
			// Disabling the feature is an explicit user action, unlike restoring Wi-Fi while still shut.
			this.applied = undefined;
			this.schedule();
			await this.settled();
			this.publish();
			return this.status();
		} finally {
			this.configuring = false;
		}
	}
	async stop(): Promise<void> {
		this.stopping = true;
		clearTimeout(this.retry);
		this.stopSessions?.();
		await this.evaluating;
		await this.helper?.close();
		this.helper = undefined;
	}
}
