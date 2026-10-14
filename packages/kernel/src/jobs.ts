import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-durable";
import type { SessionJob } from "@pilot/protocol";

/** Project the jobs extension's structured list into a bounded, running-only client response. */
export function runningJobs(value: unknown): SessionJob[] {
	if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid jobs list");
	const jobs: SessionJob[] = [];
	const ids = new Set<string>();
	for (const job of value) {
		if (
			!job ||
			typeof job !== "object" ||
			!["running", "done", "failed", "cancelled", "interrupted"].includes(job.state)
		)
			throw new Error("Invalid job state");
		if (job.state !== "running") continue;
		if (
			!validText(job.id, 1024) ||
			!validText(job.name, 1024) ||
			!validText(job.outputPath, 16_384) ||
			!job.outputPath.startsWith("/") ||
			!Number.isFinite(job.startedAt) ||
			job.startedAt < 0 ||
			job.startedAt > 8.64e15 ||
			ids.has(job.id)
		)
			throw new Error("Invalid running job");
		ids.add(job.id);
		jobs.push({ id: job.id, name: job.name, state: "running", startedAt: job.startedAt, outputPath: job.outputPath });
	}
	return jobs;
}

function validText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
}

/** The jobs extension has no lifecycle bus. Probe only known live jobs, never idle sessions. */
export class JobsMonitor {
	private current: SessionJob[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private reading?: Promise<void>;
	private dirty = false;
	private stopped = false;
	private readonly read: () => Promise<SessionJob[]>;
	private readonly changed: (jobs: SessionJob[]) => void;
	constructor(read: () => Promise<SessionJob[]>, changed: (jobs: SessionJob[]) => void) {
		this.read = read;
		this.changed = changed;
	}

	readonly native: ExtensionFactory = (pi) => {
		pi.on("tool_result", async (event) => {
			if (event.toolName === "jobs") await this.refresh();
		});
	};

	prepare(extension: Extension): Extension {
		return {
			...extension,
			tools: extension.tools?.map((tool) =>
				tool.name !== "jobs"
					? tool
					: {
							...tool,
							execute: async (args, api, context) => {
								try {
									return await tool.execute(args, api, context);
								} finally {
									await this.refresh();
								}
							},
						},
			),
		};
	}

	refresh(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.reading) {
			// A start/stop can finish after an older list call captured its snapshot.
			this.dirty = true;
			return this.reading;
		}
		return (this.reading ??= this.update().finally(() => {
			this.reading = undefined;
		}));
	}

	private async update(): Promise<void> {
		clearTimeout(this.timer);
		try {
			do {
				this.dirty = false;
				const jobs = await this.read();
				if (this.stopped) return;
				if (JSON.stringify(jobs) !== JSON.stringify(this.current)) {
					this.current = jobs;
					this.changed(jobs);
				}
			} while (this.dirty);
		} catch {
			// An inspection failure must not break tools or erase a known live job. The notice cap still applies.
		} finally {
			if (!this.stopped && this.current.length) {
				this.timer = setTimeout(() => void this.refresh(), 1_000);
				this.timer.unref();
			}
		}
	}

	async close(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		await this.reading;
		if (this.current.length) this.changed([]);
		this.current = [];
	}
}
