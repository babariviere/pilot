import type { MissionStore } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";
import type { WatchService } from "./watch-service.ts";

/** Lifecycle work is independent of Control's worker. Reconcile only subscribed targets, not history. */
export class WatchLifecycle {
	private readonly stops: (() => void)[];
	private running?: Promise<void>;
	private readonly pending = new Set<string>();
	private readonly watches: WatchService;
	private readonly sessions: Pick<SessionManager, "get">;
	private readonly missions: Pick<MissionStore, "status" | "onChange" | "durable">;
	constructor(
		watches: WatchService,
		sessions: Pick<SessionManager, "get">,
		missions: Pick<MissionStore, "status" | "onChange" | "durable">,
	) {
		this.watches = watches;
		this.sessions = sessions;
		this.missions = missions;
		this.stops = [
			missions.onChange((id) => {
				// Capture before yielding: an immediate unarchive must not cancel cleanup.
				const status = missions.status(id);
				if (!status || status === "archived") this.enqueue(id);
			}),
		];
	}
	private enqueue(id: string): void {
		this.pending.add(id);
		if (this.running) return;
		this.running = (async () => {
			while (this.pending.size) {
				const id = this.pending.values().next().value!;
				this.pending.delete(id);
				try {
					await this.missions.durable();
					await this.watches.removeTarget("mission", id, "mission archived");
				} catch (error) {
					console.warn(`pilotd: watch lifecycle cleanup failed (will reconcile on restart): ${error}`);
				}
			}
		})().finally(() => {
			this.running = undefined;
			if (this.pending.size) this.enqueue(this.pending.values().next().value!);
		});
	}
	/** Run after metadata loads, before watch sources and notice delivery start. Also handles deletion while down. */
	async reconcile(): Promise<void> {
		await this.missions.durable();
		for (const kind of ["chat", "chat_prs", "mission"] as const) {
			for (const target of await this.watches.targets(kind)) {
				if (kind === "mission") {
					const status = this.missions.status(target.id);
					if (!status || status === "archived")
						await this.watches.removeTarget("mission", target.id, "mission archived");
				} else {
					const chat = this.sessions.get(target.id);
					if (!chat || chat.archivedAt !== undefined)
						await this.watches.removeTarget("chat", target.id, chat ? "chat archived" : "chat deleted");
				}
			}
		}
		await this.watches.flushRemovalAudit();
		await this.idle();
	}
	async idle(): Promise<void> {
		while (this.running) await this.running;
	}
	async stop(): Promise<void> {
		for (const stop of this.stops) stop();
		await this.idle();
	}
}
