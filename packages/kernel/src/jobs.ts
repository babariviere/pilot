import type { SessionJob } from "@pilot/protocol";

/** Project the jobs extension's structured list into a bounded, running-only client response. */
export function runningJobs(value: unknown): SessionJob[] {
	if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid jobs list");
	const jobs: SessionJob[] = [];
	const ids = new Set<string>();
	for (const job of value) {
		if (!job || typeof job !== "object" || !["running", "done", "failed", "cancelled"].includes(job.state))
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
