import type { AgentEvent } from "@pilot/protocol";

/** A worker's observed run and inbox, including the gap between accepted input and working IPC. */
export class WorkerActivity {
	private observed = false;
	private running = false;
	private queued = false;

	get busy(): boolean {
		return !this.observed || this.running || this.queued;
	}

	/** A new snapshot after acceptance is a barrier, even for an idempotent retry emitting no events. */
	reset(): void {
		this.observed = false;
	}

	observe(events: readonly AgentEvent[]): void {
		for (const event of events) {
			if (event.type === "snapshot") {
				this.observed = true;
				this.running = event.run !== undefined;
				this.queued = event.inbox.length !== 0;
			} else if (event.type === "run_start") this.running = true;
			else if (event.type === "run_end") this.running = false;
			else if (event.type === "inbox_update") this.queued = event.items.length !== 0;
		}
	}
}
