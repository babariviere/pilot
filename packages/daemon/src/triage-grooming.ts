import { Worker } from "node:worker_threads";
import type { TrackedKind, TriageGuide } from "@pilot/protocol";
import type { ProjectStore } from "./projects.ts";
import type { TrackedItemStore } from "./tracked-items.ts";

export const GUIDE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["rules"],
	properties: {
		rules: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 150 } },
	},
};
export function parseGuide(text: string): string {
	if (Buffer.byteLength(text) > 12000) throw new Error("Invalid triage guide");
	const value = JSON.parse(text);
	if (
		!value ||
		Object.keys(value).join() !== "rules" ||
		!Array.isArray(value.rules) ||
		value.rules.length > 40 ||
		value.rules.some(
			(line: unknown) => typeof line !== "string" || !line.trim() || line.length > 150 || /[\x00-\x1f]/.test(line),
		)
	)
		throw new Error("Invalid triage guide");
	return value.rules.map((line: string) => line.trim()).join("\n");
}
export type TriageComplete = (
	cwd: string,
	prompt: string,
	schema: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<string>;
/** One bounded worker per run. Deadline and cancellation terminate SDK/network work as well as computation. */
export function workerTriage(agentDir?: string): TriageComplete {
	return (cwd, prompt, schema, signal) =>
		new Promise((resolve, reject) => {
			signal.throwIfAborted();
			const worker = new Worker(new URL("./triage-model-worker.ts", import.meta.url), {
				workerData: { agentDir, cwd, prompt, schema },
			});
			const finish = (error?: Error, text?: string) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				void worker.terminate();
				if (error) reject(error);
				else resolve(text!);
			};
			const abort = () => finish(new Error("Triage cancelled"));
			const timer = setTimeout(() => finish(new Error("Triage timed out")), 90_000);
			signal.addEventListener("abort", abort, { once: true });
			worker.once("message", (result) =>
				finish(result.error ? new Error("Triage model failed") : undefined, result.text),
			);
			worker.once("error", (error) => finish(error));
			worker.once("exit", (code) => {
				if (code) finish(new Error("Triage worker exited"));
			});
		});
}

/** Coalesced correction-only grooming. One global run, three new examples or one day, hourly failure backoff. */
export class TriageGroomer {
	private pending = new Map<string, { projectId: string; kind: TrackedKind; at: number; force: boolean }>();
	private timer?: ReturnType<typeof setTimeout>;
	private run?: Promise<void>;
	private controller = new AbortController();
	private disposers: Array<() => void>;
	private projects: Pick<ProjectStore, "list" | "require" | "onChange">;
	private items: TrackedItemStore;
	private complete: TriageComplete;
	private now: () => number;
	constructor(
		projects: Pick<ProjectStore, "list" | "require" | "onChange">,
		items: TrackedItemStore,
		complete: TriageComplete,
		now = Date.now,
	) {
		this.projects = projects;
		this.items = items;
		this.complete = complete;
		this.now = now;
		this.disposers = [
			items.onChange((id) => this.queue(id)),
			projects.onChange(() => {
				for (const project of projects.list()) this.queue(project.id);
			}),
		];
		for (const project of projects.list()) this.queue(project.id);
	}
	queue(projectId: string, kind?: TrackedKind, force = false): void {
		if (this.controller.signal.aborted) return;
		for (const source of kind ? [kind] : (["slack", "linear"] as const)) {
			const key = `${projectId}:${source}`,
				existing = this.pending.get(key);
			this.pending.set(key, {
				projectId,
				kind: source,
				at: Math.min(existing?.at ?? Infinity, this.now() + 2000),
				force: force || !!existing?.force,
			});
		}
		this.schedule();
	}
	async rebuild(projectId: string, kind: TrackedKind): Promise<TriageGuide> {
		this.projects.require(projectId);
		this.queue(projectId, kind, true);
		return (await this.items.triageInput(projectId, kind)).guide;
	}
	private schedule(): void {
		clearTimeout(this.timer);
		if (this.run || !this.pending.size || this.controller.signal.aborted) return;
		this.timer = setTimeout(
			() => {
				this.run = this.pump().finally(() => {
					this.run = undefined;
					this.schedule();
				});
			},
			Math.max(0, Math.min(...[...this.pending.values()].map((value) => value.at)) - this.now()),
		);
		this.timer.unref();
	}
	private async pump(): Promise<void> {
		const entry = [...this.pending.entries()].find(([, value]) => value.at <= this.now());
		if (!entry) return;
		const [key, job] = entry;
		this.pending.delete(key);
		try {
			const project = this.projects.require(job.projectId);
			const input = await this.items.triageInput(job.projectId, job.kind);
			if (!input.corrections.length && !job.force) return;
			const due = (input.guide.updatedAt || input.corrections[0]?.correctedAt || this.now()) + 86_400_000;
			if (!job.force && input.corrections.length < 3 && this.now() < due) {
				this.pending.set(key, { ...job, at: due });
				return;
			}
			const prompt =
				"Rebuild a short triage guide from the previous guide plus corrections only. Return rules and summaries, never verbatim external text, quotations, URLs, personal names or message excerpts. At most 40 short rules. Data: " +
				JSON.stringify({ kind: job.kind, previousGuide: input.guide.text, corrections: input.corrections });
			const text = parseGuide(await this.complete(project.path, prompt, GUIDE_SCHEMA, this.controller.signal));
			if (this.controller.signal.aborted) return;
			this.projects.require(job.projectId);
			await this.items.saveGuide(
				job.projectId,
				job.kind,
				text,
				input.throughSeq,
				input.guide.throughSeq,
				this.now(),
			);
		} catch {
			if (!this.controller.signal.aborted && this.projects.list().some((project) => project.id === job.projectId))
				this.pending.set(key, { ...job, at: this.now() + 3_600_000 });
		}
	}
	async stop(): Promise<void> {
		this.controller.abort();
		clearTimeout(this.timer);
		this.pending.clear();
		for (const dispose of this.disposers) dispose();
		await this.run;
	}
}
