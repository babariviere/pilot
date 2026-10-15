import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SlackCaseEdit, SlackCommonCase, SlackCommonCaseList, SlackSeverity } from "@pilot/protocol";
import type { TriageGuideDisk } from "./triage-guide-disk.ts";

const WINDOW = 30 * 86_400_000;
export const CASE_LIMIT = 200;
export interface CaseItem {
	id: string;
	summary: string;
	severity: SlackSeverity;
	label: string | null;
	seen: number;
	caseId: string | null;
}
export interface CaseInput {
	items: CaseItem[];
	cases: Array<{ id: string; name: string; description: string; firstSeen: number; lastSeen: number }>;
	revision: number;
	truncated: boolean;
}
export interface CaseGroup {
	caseId: string | null;
	name: string;
	description: string;
	itemIds: string[];
}
export const CASE_SCHEMA = {
	type: "array",
	maxItems: 100,
	items: {
		type: "object",
		additionalProperties: false,
		required: ["caseId", "name", "description", "itemIds"],
		properties: {
			caseId: { type: ["string", "null"] },
			name: { type: "string", minLength: 1, maxLength: 80 },
			description: { type: "string", minLength: 1, maxLength: 240 },
			itemIds: { type: "array", maxItems: 200, items: { type: "string" } },
		},
	},
};
function short(value: unknown, max: number): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value);
}
/** Model tokens are local ordinals, not trusted database IDs. Stable memberships cannot be moved by a model. */
export function parseCases(value: unknown, input: CaseInput): CaseGroup[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid common cases");
	const seen = new Set<string>(),
		cases = new Set<string>();
	for (const group of value) {
		if (
			!group ||
			Object.keys(group).sort().join() !== "caseId,description,itemIds,name" ||
			!short(group.name, 80) ||
			!short(group.description, 240) ||
			!Array.isArray(group.itemIds) ||
			!group.itemIds.length ||
			group.itemIds.length > CASE_LIMIT ||
			(group.caseId !== null && (!input.cases.some((c) => c.id === group.caseId) || cases.has(group.caseId)))
		)
			throw new Error("Invalid common cases");
		if (group.caseId) cases.add(group.caseId);
		for (const token of group.itemIds) {
			if (
				typeof token !== "string" ||
				!/^(0|[1-9]\d*)$/.test(token) ||
				!input.items[Number(token)] ||
				seen.has(token)
			)
				throw new Error("Invalid common case member");
			const item = input.items[Number(token)]!;
			if (item.caseId && item.caseId !== group.caseId) throw new Error("Common case membership is stable");
			seen.add(token);
		}
	}
	if (seen.size !== input.items.length) throw new Error("Incomplete common cases");
	return value;
}

/** All SQL, grouping and aggregation run on the tracking worker. No Slack text is stored or read here. */
export class SlackCaseDisk {
	private db: DatabaseSync;
	private triage: TriageGuideDisk;
	constructor(db: DatabaseSync, triage: TriageGuideDisk) {
		this.db = db;
		this.triage = triage;
		db.exec(`CREATE TABLE IF NOT EXISTS slack_cases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,manual_name INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,first_seen INTEGER NOT NULL);
		 CREATE INDEX IF NOT EXISTS slack_cases_project ON slack_cases(project_id,last_seen);
		 CREATE TABLE IF NOT EXISTS slack_case_revisions(project_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
		 CREATE INDEX IF NOT EXISTS slack_case_recent ON tracked_items(project_id,updated_at DESC,id) WHERE kind='slack' AND active=1;`);
	}
	input(projectId: string, now: number): CaseInput {
		const rows = this.db
			.prepare(`SELECT id,title,metadata,slack_overrides,slack_case_id,updated_at FROM tracked_items
		 WHERE project_id=? AND kind='slack' AND active=1 AND updated_at>=? AND
		 coalesce(json_extract(slack_overrides,'$.type'),json_extract(metadata,'$.type'),'unknown')='bug'
		 ORDER BY updated_at DESC,id LIMIT ?`)
			.all(projectId, now - WINDOW, CASE_LIMIT + 1);
		const items = rows.slice(0, CASE_LIMIT).map((row) => {
			const meta = JSON.parse(String(row.metadata)),
				override = JSON.parse(String(row.slack_overrides));
			return {
				id: String(row.id),
				summary: String(row.title).slice(0, 240),
				severity: override.severity ?? meta.severity ?? "low",
				label: Object.hasOwn(override, "label") ? override.label : (meta.label ?? null),
				seen: Number(row.updated_at),
				caseId: row.slack_case_id ? String(row.slack_case_id) : null,
			};
		});
		return {
			items,
			cases: this.db
				.prepare(
					"SELECT id,name,description,first_seen AS firstSeen,last_seen AS lastSeen FROM slack_cases WHERE project_id=? ORDER BY last_seen DESC LIMIT 100",
				)
				.all(projectId) as unknown as CaseInput["cases"],
			revision: Number(
				this.db.prepare("SELECT revision FROM slack_case_revisions WHERE project_id=?").get(projectId)?.revision ??
					0,
			),
			truncated: rows.length > CASE_LIMIT,
		};
	}
	retire(projectId: string, now: number): boolean {
		if (
			!this.db
				.prepare("SELECT id FROM slack_cases WHERE project_id=? AND last_seen<? LIMIT 1")
				.get(projectId, now - WINDOW)
		)
			return false;
		this.db.exec("BEGIN");
		try {
			this.db
				.prepare(
					"UPDATE tracked_items SET slack_case_id=NULL WHERE project_id=? AND slack_case_id IN (SELECT id FROM slack_cases WHERE project_id=? AND last_seen<?)",
				)
				.run(projectId, projectId, now - WINDOW);
			this.db.prepare("DELETE FROM slack_cases WHERE project_id=? AND last_seen<?").run(projectId, now - WINDOW);
			this.bump(projectId);
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	list(projectId: string, now: number): SlackCommonCaseList {
		const input = this.input(projectId, now),
			all: SlackCommonCase[] = [];
		for (const entry of input.cases) {
			const items = input.items.filter((item) => item.caseId === entry.id);
			if (!items.length) continue;
			const severityMix = { low: 0, medium: 0, high: 0, critical: 0 };
			const labels = new Map<string, number>();
			let recent = 0;
			for (const item of items) {
				severityMix[item.severity]++;
				if (item.label) labels.set(item.label, (labels.get(item.label) ?? 0) + 1);
				if (item.seen >= now - WINDOW / 2) recent++;
			}
			all.push({
				...entry,
				count: items.length,
				severityMix,
				label: [...labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
				firstSeen: entry.firstSeen,
				lastSeen: entry.lastSeen,
				trend: recent > items.length - recent ? "rising" : recent < items.length - recent ? "fading" : "steady",
			});
		}
		return {
			cases: all.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id)),
			windowDays: 30,
			windowLimit: CASE_LIMIT,
			truncated: input.truncated,
		};
	}
	save(projectId: string, input: CaseInput, groups: CaseGroup[], now: number): boolean {
		parseCases(groups, input);
		const current = this.input(projectId, now);
		if (input.cases.length + groups.filter((group) => !group.caseId).length > 100)
			throw new Error("Common case limit reached");
		if (current.revision !== input.revision || JSON.stringify(current.items) !== JSON.stringify(input.items))
			return false;
		this.db.exec("BEGIN");
		try {
			for (const group of groups) {
				const id = group.caseId ?? randomUUID();
				const lastSeen = Math.max(...group.itemIds.map((token) => input.items[Number(token)]!.seen));
				const firstSeen = Math.min(...group.itemIds.map((token) => input.items[Number(token)]!.seen));
				this.db
					.prepare(`INSERT INTO slack_cases(id,project_id,name,description,last_seen,first_seen) VALUES (?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET name=CASE WHEN manual_name=1 THEN name ELSE excluded.name END,description=excluded.description,last_seen=max(last_seen,excluded.last_seen),first_seen=min(first_seen,excluded.first_seen)`)
					.run(id, projectId, group.name.trim(), group.description.trim(), lastSeen, firstSeen);
				for (const token of group.itemIds)
					this.db
						.prepare("UPDATE tracked_items SET slack_case_id=? WHERE id=? AND project_id=?")
						.run(id, input.items[Number(token)]!.id, projectId);
			}
			// Empty identities retain their history for 30 days, then retire (including stale memberships).
			this.db
				.prepare(
					"UPDATE tracked_items SET slack_case_id=NULL WHERE project_id=? AND slack_case_id IN (SELECT id FROM slack_cases WHERE project_id=? AND last_seen<?)",
				)
				.run(projectId, projectId, now - WINDOW);
			const retired = this.db
				.prepare("DELETE FROM slack_cases WHERE project_id=? AND last_seen<?")
				.run(projectId, now - WINDOW);
			if (groups.length || retired.changes) this.bump(projectId);
			this.db.exec("COMMIT");
			return !!groups.length || !!retired.changes;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	edit(projectId: string, id: string, edit: SlackCaseEdit, now: number): void {
		if (!edit || typeof edit !== "object") throw new Error("Invalid common case edit");
		const entry = this.db.prepare("SELECT * FROM slack_cases WHERE id=? AND project_id=?").get(id, projectId);
		if (!entry) throw new Error("Unknown common case");
		if (edit.action === "rename" || edit.action === "split") {
			if (!short(edit.name, 80)) throw new Error("Invalid common case name");
		} else if (edit.action !== "merge") throw new Error("Invalid common case edit");
		const keys =
			edit.action === "rename" ? "action,name" : edit.action === "merge" ? "action,targetId" : "action,itemIds,name";
		if (Object.keys(edit).sort().join() !== keys) throw new Error("Invalid common case edit");
		this.db.exec("BEGIN");
		try {
			if (edit.action === "rename")
				this.db.prepare("UPDATE slack_cases SET name=?,manual_name=1 WHERE id=?").run(edit.name.trim(), id);
			if (edit.action === "merge") {
				if (
					edit.targetId === id ||
					!this.db.prepare("SELECT id FROM slack_cases WHERE id=? AND project_id=?").get(edit.targetId, projectId)
				)
					throw new Error("Invalid merge target");
				this.db
					.prepare("UPDATE tracked_items SET slack_case_id=? WHERE project_id=? AND slack_case_id=?")
					.run(edit.targetId, projectId, id);
				this.db
					.prepare("UPDATE slack_cases SET last_seen=max(last_seen,?),first_seen=min(first_seen,?) WHERE id=?")
					.run(entry.last_seen!, entry.first_seen!, edit.targetId);
				this.db.prepare("DELETE FROM slack_cases WHERE id=?").run(id);
			}
			if (edit.action === "split") {
				if (this.input(projectId, now).cases.length >= 100) throw new Error("Common case limit reached");
				const members = this.input(projectId, now).items.filter((item) => item.caseId === id);
				if (
					!Array.isArray(edit.itemIds) ||
					!edit.itemIds.length ||
					edit.itemIds.length >= members.length ||
					edit.itemIds.some((itemId) => !members.some((item) => item.id === itemId)) ||
					new Set(edit.itemIds).size !== edit.itemIds.length
				)
					throw new Error("Invalid split members");
				const newId = randomUUID();
				this.db
					.prepare("INSERT INTO slack_cases VALUES (?,?,?,?,1,?,?)")
					.run(
						newId,
						projectId,
						edit.name.trim(),
						entry.description!,
						Math.max(...members.filter((item) => edit.itemIds.includes(item.id)).map((item) => item.seen)),
						Math.min(...members.filter((item) => edit.itemIds.includes(item.id)).map((item) => item.seen)),
					);
				for (const itemId of edit.itemIds)
					this.db
						.prepare("UPDATE tracked_items SET slack_case_id=? WHERE id=? AND project_id=?")
						.run(newId, itemId, projectId);
			}
			this.triage.append(projectId, "slack", {
				itemId: id,
				summary: String(entry.name),
				correctedAt: now,
				values: {
					caseEdit: {
						action: edit.action,
						...(edit.action === "rename" || edit.action === "split"
							? { name: edit.name }
							: { targetId: edit.targetId }),
						...(edit.action === "split" ? { itemCount: edit.itemIds.length } : {}),
					},
				},
			});
			this.bump(projectId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private bump(projectId: string): void {
		this.db
			.prepare(
				"INSERT INTO slack_case_revisions VALUES (?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1",
			)
			.run(projectId);
	}
}
