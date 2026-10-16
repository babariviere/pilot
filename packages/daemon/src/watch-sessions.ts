import type { SessionSummary } from "@pilot/protocol";
import type { SessionManager } from "./sessions.ts";
import type { WatchObservation } from "./watch-delivery.ts";
import type { WatchService } from "./watch-service.ts";

/** Lifecycle-only projection. Token streaming never sends RPCs or scans subscriptions. */
export class SessionWatchSource {
	private readonly seen = new Map<string, string>();
	private readonly pending = new Map<string, WatchObservation[]>();
	private running?: Promise<void>;
	private stopped = false;
	private readonly unsubscribe: () => void;
	private readonly watches: WatchService;
	constructor(watches: WatchService, sessions: Pick<SessionManager, "list" | "onChange">) {
		this.watches = watches;
		// Recover committed outcomes after a crash. Worker timestamps and versions reject old/replayed work.
		for (const session of sessions.list({ archived: "all" })) this.observe(session);
		this.unsubscribe = sessions.onChange((session) => this.observe(session));
	}
	private version(s: SessionSummary): string {
		return JSON.stringify([s.state, s.working, s.outcome, s.outcomeAt, !!s.runningJobs?.length]);
	}
	private observe(s: SessionSummary): void {
		if (this.stopped) return;
		const version = this.version(s);
		if (this.seen.get(s.id) === version) return;
		this.seen.delete(s.id);
		this.seen.set(s.id, version);
		if (this.seen.size > 50000) this.seen.delete(this.seen.keys().next().value!);
		const outcome = s.state === "failed" ? "failed" : s.outcome;
		if (
			s.working ||
			s.state === "working" ||
			s.state === "starting" ||
			s.runningJobs?.length ||
			!["done", "failed", "stopped"].includes(outcome ?? "")
		)
			return;
		const targets: WatchObservation["targets"] = [{ kind: "chat", id: s.id }];
		if (s.projectId) targets.push({ kind: "project", id: s.projectId });
		if (s.missionId) targets.push({ kind: "mission", id: s.missionId });
		const event: WatchObservation = {
			source: s.id,
			version: JSON.stringify([s.state === "failed" ? s.updatedAt : (s.outcomeAt ?? s.updatedAt), outcome]),
			event: "chat.settled",
			targets,
			at: s.state === "failed" ? s.updatedAt : (s.outcomeAt ?? Date.now()),
			text: `Chat ${s.title ?? s.id} ${outcome}`,
			outcome: outcome as "done" | "failed" | "stopped",
		};
		const key = `${s.id}:${event.version}`;
		if (this.pending.size >= 50000 && !this.pending.has(key)) {
			console.warn("pilotd: watch session queue full");
			return;
		}
		this.pending.set(key, outcome === "failed" ? [event, { ...event, event: "chat.failed" }] : [event]);
		this.drain();
	}
	private drain(): void {
		if (this.running || this.stopped) return;
		this.running = (async () => {
			while (this.pending.size && !this.stopped) {
				const batch: [string, WatchObservation[]][] = [];
				for (const entry of this.pending) {
					batch.push(entry);
					if (batch.length === 64) break;
				}
				await this.watches.observe(batch.flatMap(([, events]) => events));
				for (const [id, events] of batch) if (this.pending.get(id) === events) this.pending.delete(id);
			}
		})()
			.catch((error) => console.warn(`pilotd: chat watch observation failed: ${error}`))
			.finally(() => {
				this.running = undefined;
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
