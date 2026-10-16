/** Agents pause only on evidence of an outage and resume on the first sign of recovery. */
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ConnectivityState } from "@pilot/kernel";
import type { ScheduleDetection } from "./schedule-detection.ts";

/** Wi-Fi roaming, VPN reconnects and helper startup report brief path loss. Only a lasting loss is an outage. */
export const PATH_LOSS_DEBOUNCE_MS = 3_000;

export interface ConnectivityOptions {
	pathLossDebounceMs?: number;
}

/**
 * Evidence of an outage: the OS reports no network path, or a model request failed in transport and a
 * fresh check failed too. A failed check alone (blocked check hosts) never pauses agents. Recovery: a
 * passing check, a returning path, or a kernel receiving model data.
 */
export class ConnectivityService {
	private tail: Promise<void> = Promise.resolve();
	private dispose?: () => void;
	private stopped = false;
	private watcher?: FSWatcher;
	private checkTimer?: NodeJS.Timeout;
	private pathTimer?: NodeJS.Timeout;
	private nextCheck = 0;
	private pending?: ConnectivityState;
	private saving = false;
	private offline = false;
	private pathDown = false;
	/** A kernel saw a transport failure or a silent stream, so the next check result decides. */
	private suspect = false;
	private readonly file: string;
	private readonly detection: Pick<ScheduleDetection, "subscribeConnectivity" | "setAgentsActive" | "refreshOnline">;
	private readonly publish: (online: boolean) => void;
	private readonly pathLossDebounceMs: number;
	constructor(
		file: string,
		detection: Pick<ScheduleDetection, "subscribeConnectivity" | "setAgentsActive" | "refreshOnline">,
		publish: (online: boolean) => void,
		options: ConnectivityOptions = {},
	) {
		this.file = file;
		this.detection = detection;
		this.publish = publish;
		this.pathLossDebounceMs = options.pathLossDebounceMs ?? PATH_LOSS_DEBOUNCE_MS;
	}

	async start(): Promise<void> {
		// Unknown admits requests: a failure decides. Never reuse a pre-crash offline hold either.
		await this.save({ version: 1, online: true, checkedAt: 0 });
		const check = `${basename(this.file)}.check`;
		const reachable = `${basename(this.file)}.reachable`;
		this.watcher = watch(dirname(this.file), (_event, name) => {
			if (this.stopped) return;
			if (name === reachable) this.recovered();
			if (name !== check) return;
			this.suspect = true;
			if (this.checkTimer) return;
			// Many failed requests share one debounced, bounded probe, not one probe per kernel.
			this.checkTimer = setTimeout(
				() => {
					this.checkTimer = undefined;
					this.nextCheck = Date.now() + 5_000;
					this.refresh();
				},
				Math.max(200, this.nextCheck - Date.now()),
			);
			this.checkTimer.unref();
		});
		this.watcher.on("error", (error) => console.warn(`pilotd: connectivity hints: ${error}`));
		this.dispose = this.detection.subscribeConnectivity((state) => this.checked(state));
		this.detection.setAgentsActive(true);
	}

	/** Network path from the macOS helper. `undefined` means unknown (no helper, or it disconnected). */
	setPath(path: boolean | undefined): void {
		if (this.stopped) return;
		if (path === false) {
			if (this.pathDown || this.pathTimer) return;
			this.pathTimer = setTimeout(() => {
				this.pathTimer = undefined;
				this.pathDown = true;
				this.set(false);
			}, this.pathLossDebounceMs);
			this.pathTimer.unref();
			return;
		}
		clearTimeout(this.pathTimer);
		this.pathTimer = undefined;
		if (path === true) {
			// A returning path is worth one attempt. A still-broken network fails fast and is confirmed again.
			this.pathDown = false;
			if (this.offline) this.set(true);
		} else if (this.pathDown) {
			// Without the helper, keep the hold until a check shows the network is back.
			this.pathDown = false;
			this.suspect = true;
			this.refresh();
		}
	}

	private refresh(): void {
		void this.detection.refreshOnline().catch((error) => console.warn(`pilotd: connectivity check: ${error}`));
	}

	/** A kernel received model data while held, which proves the network works. */
	private recovered(): void {
		if (this.offline) this.set(true);
	}

	private checked(state: ConnectivityState): void {
		// Detector resets (start, wake) carry no observation.
		if (state.checkedAt <= 0) return;
		const suspect = this.suspect;
		this.suspect = false;
		if (state.online) {
			// Real traffic got through, even if the helper still reports no path.
			this.pathDown = false;
			if (this.offline || suspect) this.set(true, state.checkedAt);
		} else if (this.offline || suspect) this.set(false, state.checkedAt);
	}

	/** Each result answers waiting kernels with a fresh timestamp, even when it is unchanged. */
	private set(online: boolean, checkedAt = Date.now()): void {
		this.offline = !online;
		this.pending = { version: 1, online, checkedAt };
		this.drain();
	}

	private drain(): void {
		if (this.saving) return;
		this.saving = true;
		this.tail = (async () => {
			// A slow disk keeps only the newest pending observation, never an unbounded write queue.
			while (this.pending) {
				const next = this.pending;
				this.pending = undefined;
				await this.save(next).catch((error) => console.warn(`pilotd: connectivity state: ${error}`));
			}
		})().finally(() => {
			this.saving = false;
			// An observation that arrived after the loop's last check must not be stranded.
			if (this.pending && !this.stopped) this.drain();
		});
	}

	private async save(state: ConnectivityState): Promise<void> {
		if (this.stopped) return;
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
			await rename(temp, this.file);
			this.publish(state.online);
		} finally {
			await rm(temp, { force: true });
		}
	}

	async stop(): Promise<void> {
		clearTimeout(this.checkTimer);
		clearTimeout(this.pathTimer);
		this.watcher?.close();
		this.dispose?.();
		this.detection.setAgentsActive(false);
		await this.tail;
		this.stopped = true;
	}
}
