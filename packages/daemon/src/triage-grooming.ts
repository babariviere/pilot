import { Worker } from "node:worker_threads";
import type { TrackedKind, TriageGuide } from "@pilot/protocol";
import { type BackgroundJobDiagnostics, jobConfigurationKey } from "./background-job-diagnostics.ts";
import type { ProjectStore } from "./projects.ts";
import { CASE_SCHEMA, parseCases } from "./slack-cases.ts";
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
			let settled = false;
			const finish = (error?: Error, text?: string) => {
				if (settled) return;
				settled = true;
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
	private diagnostics?: BackgroundJobDiagnostics;
	constructor(
		projects: Pick<ProjectStore, "list" | "require" | "onChange">,
		items: TrackedItemStore,
		complete: TriageComplete,
		now = Date.now,
		diagnostics?: BackgroundJobDiagnostics,
	) {
		this.projects = projects;
		this.items = items;
		this.complete = complete;
		this.now = now;
		this.diagnostics = diagnostics;
		for (const kind of ["slack", "linear"] as const) diagnostics?.register("triage_rebuild", kind);
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
			try {
				this.diagnostics?.queue(
					"triage_rebuild",
					source,
					projectId,
					jobConfigurationKey(this.projects.require(projectId).tracking),
					this.pending.get(key)?.at,
				);
			} catch {
				/* Deleted projects have no evidence identity. */
			}
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
			Math.min(
				2_147_483_647,
				Math.max(0, Math.min(...[...this.pending.values()].map((value) => value.at)) - this.now()),
			),
		);
		this.timer.unref();
	}
	private async pump(): Promise<void> {
		const entry = [...this.pending.entries()].find(([, value]) => value.at <= this.now());
		if (!entry) return;
		const [key, job] = entry;
		this.pending.delete(key);
		let token: import("./background-job-diagnostics.ts").JobToken | undefined;
		let outcome: import("./background-job-diagnostics.ts").JobOutcome = "no_work";
		let reason: import("./background-job-diagnostics.ts").JobReason | undefined;
		try {
			const project = this.projects.require(job.projectId);
			token = this.diagnostics?.begin(
				"triage_rebuild",
				job.kind,
				job.projectId,
				jobConfigurationKey(project.tracking),
			);
			if (token) this.diagnostics?.stage(token, "eligibility");
			const input = await this.items.triageInput(job.projectId, job.kind);
			const caseInput =
				job.kind === "slack" && "caseInput" in this.items
					? await this.items.caseInput(job.projectId, this.now())
					: undefined;
			const newCases = caseInput?.items.some((item) => !item.caseId) ?? false;
			if (!input.corrections.length && !job.force && !newCases) {
				const expiry = caseInput?.cases
					.map((entry) => entry.lastSeen + 30 * 86_400_000 + 1)
					.filter((at) => at > this.now());
				if (expiry?.length) this.pending.set(key, { ...job, at: Math.min(...expiry) });
				return;
			}
			const due = (input.guide.updatedAt || input.corrections[0]?.correctedAt || this.now()) + 86_400_000;
			if (!job.force && !newCases && input.corrections.length < 3 && this.now() < due) {
				this.pending.set(key, { ...job, at: due });
				outcome = "skipped";
				reason = "eligibility";
				return;
			}
			const retryAt =
				"reserveGrooming" in this.items ? await this.items.reserveGrooming(job.projectId, job.kind, this.now()) : 0;
			if (retryAt) {
				this.pending.set(key, { ...job, at: retryAt });
				outcome = "backoff";
				reason = "cooldown";
				return;
			}
			let prompt =
				"Rebuild a short triage guide from the previous guide plus corrections only. Return rules and summaries, never verbatim external text, quotations, URLs, personal names or message excerpts. At most 40 short rules. Data: " +
				JSON.stringify({ kind: job.kind, previousGuide: input.guide.text, corrections: input.corrections });
			let schema: Record<string, unknown> = GUIDE_SCHEMA;
			if (caseInput) {
				prompt +=
					" Also group recent bug summaries into stable common cases. Return cases alongside rules. Each group has caseId (existing identity or null for a new case), short name, one-line description and itemIds (local ordinal strings). Cover every input item exactly once. Preserve all existing memberships and respect user rename/merge/split corrections. Never use raw Slack text. Guide rules must be shaped ONLY by corrections, not by case summaries. Data: " +
					JSON.stringify({
						cases: caseInput.cases,
						items: caseInput.items.map((item, index) => ({ ...item, id: String(index) })),
					});
				schema = {
					type: "object",
					additionalProperties: false,
					required: ["rules", "cases"],
					properties: { rules: GUIDE_SCHEMA.properties.rules, cases: CASE_SCHEMA },
				};
			}
			if (token) this.diagnostics?.stage(token, "classification");
			const raw = await this.complete(project.path, prompt, schema, this.controller.signal);
			if (token) this.diagnostics?.progress(token);
			if (Buffer.byteLength(raw) > 100_000) throw new Error("Invalid grooming output");
			const output = JSON.parse(raw);
			if (caseInput && (!output || Object.keys(output).sort().join() !== "cases,rules"))
				throw new Error("Invalid grooming output");
			const proposedText = caseInput ? parseGuide(JSON.stringify({ rules: output.rules })) : parseGuide(raw);
			const text = input.corrections.length ? proposedText : input.guide.text;
			const groups = caseInput ? parseCases(output.cases, caseInput) : undefined;
			if (this.controller.signal.aborted) return;
			this.projects.require(job.projectId);
			if (token) this.diagnostics?.stage(token, "commit");
			if (caseInput && groups) {
				await this.items.saveCases(job.projectId, caseInput, groups, this.now());
				outcome = "success";
			}
			if (!job.force && (!input.corrections.length || (input.corrections.length < 3 && this.now() < due))) return;
			await this.items.saveGuide(
				job.projectId,
				job.kind,
				text,
				input.throughSeq,
				input.guide.throughSeq,
				this.now(),
			);
			outcome = "success";
			if (token) this.diagnostics?.progress(token);
		} catch {
			outcome = this.controller.signal.aborted ? "cancelled" : "failure";
			reason = this.controller.signal.aborted ? "stopped" : "classification_failed";
			if (!this.controller.signal.aborted && this.projects.list().some((project) => project.id === job.projectId))
				this.pending.set(key, { ...job, at: this.now() + 3_600_000 });
		} finally {
			if (token) {
				if (this.controller.signal.aborted) {
					outcome = "cancelled";
					reason = "stopped";
				}
				this.diagnostics?.end(token, outcome, reason, undefined, this.pending.get(key)?.at);
			}
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
