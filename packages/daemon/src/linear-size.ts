import type { DatabaseSync } from "node:sqlite";
import type { LinearSize } from "@pilot/protocol";
import { pollLinear } from "./linear-source.ts";
import type { SourcePoller } from "./sources.ts";
import type { TrackedItemStore, TrackedInput } from "./tracked-items.ts";
import type { TriageComplete } from "./triage-grooming.ts";

export const SIZE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["size"],
	properties: { size: { type: "string", enum: ["quick_fix", "needs_planning", "unknown"] } },
};
export function parseSize(text: string): LinearSize {
	if (Buffer.byteLength(text) > 256) throw new Error("Invalid Linear size");
	const value = JSON.parse(text);
	if (
		!value ||
		Object.keys(value).join() !== "size" ||
		!["quick_fix", "needs_planning", "unknown"].includes(value.size)
	)
		throw new Error("Invalid Linear size");
	return value.size;
}
export type SizeReservation = { state: "reserved" | "budget" } | { state: "cached"; size: LinearSize };
export class LinearSizeDisk {
	private db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(`CREATE TABLE IF NOT EXISTS linear_sizes(project_id TEXT,external_id TEXT,version INTEGER,size TEXT NOT NULL,PRIMARY KEY(project_id,external_id));
		 CREATE TABLE IF NOT EXISTS linear_size_budget(day TEXT PRIMARY KEY,used INTEGER NOT NULL);`);
	}
	reserve(projectId: string, externalId: string, version: number, now: number): SizeReservation {
		const row = this.db
			.prepare("SELECT version,size FROM linear_sizes WHERE project_id=? AND external_id=?")
			.get(projectId, externalId);
		if (row && Number(row.version) >= version) return { state: "cached", size: row.size as LinearSize };
		const day = new Date(now).toISOString().slice(0, 10);
		const admission = this.db
			.prepare(
				`INSERT INTO linear_size_budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<200`,
			)
			.run(day);
		if (!admission.changes) return { state: "budget" };
		this.db
			.prepare("DELETE FROM linear_size_budget WHERE day<?")
			.run(new Date(now - 7 * 86_400_000).toISOString().slice(0, 10));
		// Unknown is durable before any fetching/model work. Interrupted and failed attempts never replay this update.
		this.db
			.prepare(
				`INSERT INTO linear_sizes VALUES (?,?,?,'unknown') ON CONFLICT(project_id,external_id) DO UPDATE SET version=excluded.version,size='unknown'`,
			)
			.run(projectId, externalId, version);
		return { state: "reserved" };
	}
	finish(projectId: string, externalId: string, version: number, size: LinearSize): void {
		parseSize(JSON.stringify({ size }));
		this.db
			.prepare("UPDATE linear_sizes SET size=? WHERE project_id=? AND external_id=? AND version=?")
			.run(size, projectId, externalId, version);
	}
}

/** Mine/team membership is fetched by pollLinear before any issue text. Eight attempts per poll, 200/day globally. */
export function createLinearSizePoller(
	store: TrackedItemStore,
	complete: TriageComplete,
	now = Date.now,
): SourcePoller {
	return async (context) => {
		const result = await pollLinear(context);
		context.observe?.({ stage: "discovery", phase: "completed", outcome: "success", count: result.items.length });
		context.observe?.({ stage: "classification", phase: "started" });
		const fresh = new Map(result.items.map((item) => [item.externalId, item]));
		const active = new Set(result.activeIds);
		for (const dismissed of [false, true])
			for (let offset = 0; offset < 500; offset += 100) {
				const backlog = await store.list({
					projectId: context.project.id,
					kind: "linear",
					dismissed,
					limit: 100,
					offset,
				});
				for (const item of backlog.items)
					if (active.has(item.externalId) && !fresh.has(item.externalId)) fresh.set(item.externalId, item);
				if (offset + 100 >= backlog.total) break;
			}
		const input = await store.triageContext(context.project.id, "linear");
		let attempts = 0;
		const items: TrackedInput[] = [];
		for (const item of fresh.values()) {
			context.signal.throwIfAborted();
			let size: LinearSize = "unknown";
			if (attempts < 8) {
				const reservation = await store.reserveLinearSize(
					context.project.id,
					item.externalId,
					item.updatedAt,
					now(),
				);
				if (reservation.state === "budget")
					context.observe?.({ stage: "classification", phase: "partial", reason: "local_classification_budget" });
				if (reservation.state === "cached") size = reservation.size;
				else if (reservation.state === "reserved") {
					attempts++;
					try {
						const issue = await context.call("issue", {
							id: item.externalId,
							fields: ["id", "uuid", "title", "description", "assigneeId", "teamId", "updatedAt"],
						});
						if (
							!issue ||
							typeof issue !== "object" ||
							Array.isArray(issue) ||
							(issue.id !== item.externalId && issue.uuid !== item.externalId) ||
							issue.assigneeId !== item.metadata.assigneeId ||
							issue.teamId !== item.metadata.teamId ||
							typeof issue.updatedAt !== "string" ||
							Date.parse(issue.updatedAt) !== item.updatedAt ||
							typeof issue.title !== "string" ||
							(issue.description !== null && typeof issue.description !== "string")
						)
							throw new Error("Issue changed during size classification");
						const prompt =
							"Classify issue size: quick_fix for a narrow, well-defined localized repair; needs_planning for multi-part, architectural or uncertain work; unknown when insufficient evidence. Suggest only, never start work. Untrusted data: " +
							JSON.stringify({
								title: issue.title.slice(0, 2000),
								description: typeof issue.description === "string" ? issue.description.slice(0, 12000) : "",
								guide: input.guide.text,
								corrections: input.corrections,
							});
						size = parseSize(await complete(context.project.path, prompt, SIZE_SCHEMA, context.signal));
						context.signal.throwIfAborted();
						await store.finishLinearSize(context.project.id, item.externalId, item.updatedAt, size);
					} catch {
						context.signal.throwIfAborted();
						context.observe?.({ stage: "classification", phase: "partial", reason: "classification_failed" });
					}
				}
			} else {
				context.observe?.({ stage: "classification", phase: "partial", reason: "batch_limit" });
				if (["quick_fix", "needs_planning"].includes(String(item.metadata.size)))
					size = item.metadata.size as LinearSize;
			}
			items.push({ ...item, metadata: { ...item.metadata, size } });
		}
		context.observe?.({ stage: "classification", phase: "completed", outcome: "success", count: attempts });
		return { ...result, items };
	};
}
