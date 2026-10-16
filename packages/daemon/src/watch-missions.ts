import type { MissionStore } from "./missions.ts";
import type { WatchObservation } from "./watch-delivery.ts";
import type { WatchService } from "./watch-service.ts";

/** Replayable activity bridge. Cursor and matched pending notices commit together in watches.sqlite. */
export class MissionWatchSource {
	private readonly store: MissionStore;
	private readonly watches: WatchService;
	private readonly unsubscribe: () => void;
	private running?: Promise<void>;
	private dirty = false;
	private stopped = false;
	constructor(store: MissionStore, watches: WatchService) {
		this.store = store;
		this.watches = watches;
		this.unsubscribe = store.onChange(() => this.schedule());
		this.schedule();
	}
	private schedule(): void {
		this.dirty = true;
		if (this.running || this.stopped) return;
		this.running = (async () => {
			while (this.dirty && !this.stopped) {
				this.dirty = false;
				let cursor = await this.watches.cursor("missions");
				while (!this.stopped) {
					// Never publish an activity record before its originating transaction is durable.
					await this.store.durable();
					const rows = this.store.watchActivity(cursor);
					if (!rows.length) break;
					const events: WatchObservation[] = rows.map((row) => ({
						source: row.taskId ?? row.missionId,
						version: String(row.id),
						event: row.taskId ? "mission.task_done" : "mission.done",
						targets: row.taskId
							? [
									{ kind: "task", id: row.taskId, missionId: row.missionId },
									{ kind: "task", id: String(row.taskNumber), missionId: row.missionId },
									{ kind: "mission", id: row.missionId },
								]
							: [{ kind: "mission", id: row.missionId }],
						at: row.at,
						text: row.taskId
							? `Task #${row.taskNumber} completed: ${row.title}`
							: `Mission completed: ${row.title}`,
						originSessionId: row.originSessionId,
					}));
					await this.watches.consume("missions", events);
					cursor = rows.at(-1)!.id;
				}
			}
		})()
			.catch((error) => console.warn(`pilotd: mission watch failed: ${error}`))
			.finally(() => {
				this.running = undefined;
				if (this.dirty && !this.stopped) this.schedule();
			});
	}
	async idle(): Promise<void> {
		await this.running;
	}
	async stop(): Promise<void> {
		this.unsubscribe();
		await this.running;
		this.stopped = true;
	}
}
