import type { DatabaseSync } from "node:sqlite";
import type { LinearSize } from "@pilot/protocol";
import { isLinearSize } from "./linear-size-value.ts";

export type SizeReservation = { state: "reserved" } | { state: "cached"; size: LinearSize };
export class LinearSizeDisk {
	private db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(
			`CREATE TABLE IF NOT EXISTS linear_sizes(project_id TEXT,external_id TEXT,version INTEGER,size TEXT NOT NULL,PRIMARY KEY(project_id,external_id));`,
		);
	}
	reserve(projectId: string, externalId: string, version: number): SizeReservation {
		const row = this.db
			.prepare("SELECT version,size FROM linear_sizes WHERE project_id=? AND external_id=?")
			.get(projectId, externalId);
		if (row && Number(row.version) >= version) return { state: "cached", size: row.size as LinearSize };
		// Unknown is durable before any fetching/model work. Interrupted and failed attempts never replay this update.
		this.db
			.prepare(
				`INSERT INTO linear_sizes VALUES (?,?,?,'unknown') ON CONFLICT(project_id,external_id) DO UPDATE SET version=excluded.version,size='unknown'`,
			)
			.run(projectId, externalId, version);
		return { state: "reserved" };
	}
	finish(projectId: string, externalId: string, version: number, size: LinearSize): void {
		if (!isLinearSize(size)) throw new Error("Invalid Linear size");
		this.db
			.prepare("UPDATE linear_sizes SET size=? WHERE project_id=? AND external_id=? AND version=?")
			.run(size, projectId, externalId, version);
	}
}
