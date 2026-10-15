/** One reachability source and one durable admission file, independent from the app's lifetime. */
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ConnectivityState } from "@pilot/kernel";
import type { ScheduleDetection } from "./schedule-detection.ts";

export class ConnectivityService {
	private tail: Promise<void> = Promise.resolve();
	private dispose?: () => void;
	private stopped = false;
	private watcher?: FSWatcher;
	private checkTimer?: NodeJS.Timeout;
	private nextCheck = 0;
	private pending?: ConnectivityState;
	private saving = false;
	private readonly file: string;
	private readonly detection: Pick<ScheduleDetection, "subscribeConnectivity" | "setAgentsActive" | "refreshOnline">;
	private readonly publish: (online: boolean) => void;
	constructor(
		file: string,
		detection: Pick<ScheduleDetection, "subscribeConnectivity" | "setAgentsActive" | "refreshOnline">,
		publish: (online: boolean) => void,
	) {
		this.file = file;
		this.detection = detection;
		this.publish = publish;
	}

	async start(): Promise<void> {
		// Never reuse a pre-crash online observation when recovering durable requests.
		await this.save({ version: 1, online: false, checkedAt: 0 });
		this.watcher = watch(dirname(this.file), (_event, name) => {
			if (name !== `${basename(this.file)}.check` || this.checkTimer || this.stopped) return;
			// Many failed requests share one debounced, bounded probe, not one probe per kernel.
			this.checkTimer = setTimeout(
				() => {
					this.checkTimer = undefined;
					this.nextCheck = Date.now() + 5_000;
					void this.detection
						.refreshOnline()
						.catch((error) => console.warn(`pilotd: connectivity check: ${error}`));
				},
				Math.max(200, this.nextCheck - Date.now()),
			);
			this.checkTimer.unref();
		});
		this.watcher.on("error", (error) => console.warn(`pilotd: connectivity hints: ${error}`));
		this.dispose = this.detection.subscribeConnectivity((state) => {
			this.pending = state;
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
			});
		});
		this.detection.setAgentsActive(true);
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
		this.watcher?.close();
		this.dispose?.();
		this.detection.setAgentsActive(false);
		await this.tail;
		this.stopped = true;
	}
}
