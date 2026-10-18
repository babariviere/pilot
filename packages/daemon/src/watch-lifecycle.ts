import type { WatchTarget } from "@pilot/protocol";
import type { ControlMemory } from "./control-memory.ts";
import type { MissionStore } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";
import type { WatchRemoval } from "./watch-delivery.ts";
import type { WatchService } from "./watch-service.ts";

/** Lifecycle work is independent of Control's agent. Reconcile saved targets/grants, not chat history. */
export class WatchLifecycle {
	private readonly stops: (() => void)[];
	private running?: Promise<void>;
	private readonly pending = new Set<string>();
	private readonly watches: WatchService;
	private readonly sessions: Pick<SessionManager, "get">;
	private readonly missions: Pick<MissionStore, "status" | "onChange" | "durable">;
	private readonly memory: () => ControlMemory;
	constructor(
		watches: WatchService,
		sessions: Pick<SessionManager, "get">,
		missions: Pick<MissionStore, "status" | "onChange" | "durable">,
		memory: () => ControlMemory,
	) {
		this.watches = watches;
		this.sessions = sessions;
		this.missions = missions;
		this.memory = memory;
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
				const reason = this.archivedReason(target);
				if (reason) await this.watches.removeTarget(kind === "mission" ? "mission" : "chat", target.id, reason);
			}
		}
		await this.watches.flushRemovalAudit();
		await this.idle();
		await this.reconcileAuthorizations();
	}
	private archivedReason(target: WatchTarget): WatchRemoval["reason"] | undefined {
		if (target.kind === "mission") {
			const status = this.missions.status(target.id);
			return !status || status === "archived" ? "mission archived" : undefined;
		}
		if (target.kind === "chat" || target.kind === "chat_prs") {
			const chat = this.sessions.get(target.id);
			if (!chat) return "chat deleted";
			if (chat.archivedAt !== undefined) return "chat archived";
		}
		return undefined;
	}
	/** Pre-upgrade cleanup may have acknowledged its outbox but left the grant behind. */
	private async reconcileAuthorizations(): Promise<void> {
		const memory = this.memory();
		let after: string | undefined;
		do {
			const page = await memory.authorizationPage(after, 100);
			for (const record of page.authorizations) {
				if (!record.watchId || record.id !== `watch:${record.watchId}` || record.revokedAt !== undefined) continue;
				const removal = await memory.auditOperation(`watch-removed:${record.watchId}`);
				const reason = removal
					? "watch removed during archive cleanup"
					: record.targets.map((target) => this.archivedReason(target)).find(Boolean);
				// Absence alone is not revocation: fired one-time watches retain delivery authority.
				if (reason) await memory.revokeWatchAuthorization(record.watchId, reason);
			}
			after = page.next;
		} while (after);
	}
	async idle(): Promise<void> {
		while (this.running) await this.running;
	}
	async stop(): Promise<void> {
		for (const stop of this.stops) stop();
		await this.idle();
	}
}
