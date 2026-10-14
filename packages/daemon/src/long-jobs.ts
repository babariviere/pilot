import type { NeedsYouReason, SessionJob } from "@pilot/protocol";
import { reasonLine } from "./needs-you-reason.ts";

export const LONG_JOB_MS = 60 * 60 * 1_000;

function oldestJob(jobs: SessionJob[], now: number): SessionJob | undefined {
	let oldest: SessionJob | undefined;
	for (const job of jobs) {
		if (job.state !== "running" || !Number.isFinite(job.startedAt) || job.startedAt < 0 || job.startedAt > now)
			continue;
		if (!oldest || job.startedAt < oldest.startedAt) oldest = job;
	}
	return oldest;
}

/** Live-only user attention, never an agent outcome or a coordinator notice. */
export function longJobAttention(
	jobs: SessionJob[],
	now = Date.now(),
): { attentionReason: NeedsYouReason; attentionAt: number } | undefined {
	const job = oldestJob(jobs, now);
	if (!job || now - job.startedAt < LONG_JOB_MS) return undefined;
	const minutes = Math.floor((now - job.startedAt) / 60_000);
	const duration = `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	return {
		attentionReason: {
			kind: "long_job",
			detail: `${reasonLine(job.name)?.slice(0, 150) ?? "Job"} has run for ${duration}`,
		},
		attentionAt: job.startedAt + LONG_JOB_MS,
	};
}

/** At most one one-shot timer per chat. No timer remains once its oldest job is overdue. */
export class LongJobTimers {
	private readonly pending = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

	update(id: string, jobs: SessionJob[], changed: () => void): void {
		const now = Date.now();
		const job = oldestJob(jobs, now);
		const at = job ? job.startedAt + LONG_JOB_MS : undefined;
		const previous = this.pending.get(id);
		if (at !== undefined && at > now && previous?.at === at) return;
		if (previous) clearTimeout(previous.timer);
		this.pending.delete(id);
		if (at === undefined || at <= now) return;
		const timer = setTimeout(() => {
			this.pending.delete(id);
			changed();
		}, at - now);
		timer.unref();
		this.pending.set(id, { at, timer });
	}

	close(): void {
		for (const { timer } of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
	}
}
