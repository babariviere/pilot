import type { DatabaseSync } from "node:sqlite";
import type { ControlAuthorizationNeeded, ControlFollowUp } from "@pilot/protocol";
import type { WatchObservation } from "./watch-delivery.ts";

/** Worker-owned implicit once watches. Bind to admitted input IDs, not an unrelated busy run. */
export class ControlFollowThroughDisk {
	private readonly db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(`
			CREATE TABLE IF NOT EXISTS control_follow_ups (id TEXT PRIMARY KEY, session_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL, admitted_at INTEGER);
			CREATE INDEX IF NOT EXISTS control_follow_ups_session ON control_follow_ups(session_id,state);
			CREATE INDEX IF NOT EXISTS control_follow_ups_running ON control_follow_ups(state);
			CREATE TABLE IF NOT EXISTS control_authorization_needed (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		`);
	}
	arm(requestId: string, authorizationId: string, sessionId?: string): void {
		if (this.db.prepare("SELECT 1 FROM control_follow_ups WHERE id=?").get(requestId)) return;
		if (Number(this.db.prepare("SELECT count(*) AS n FROM control_follow_ups").get()!.n) >= 1000)
			throw new Error("Pending follow-up limit reached");
		const item: ControlFollowUp = {
			requestId,
			authorizationId,
			...(sessionId ? { sessionId } : {}),
			state: "queued",
			createdAt: Date.now(),
		};
		this.db
			.prepare("INSERT INTO control_follow_ups VALUES (?,?,'queued',?,NULL)")
			.run(requestId, sessionId ?? null, JSON.stringify(item));
	}
	bind(sessionId: string, requestIds: string[], recoveredOnly = false): void {
		for (const requestId of requestIds) {
			const row = this.db
				.prepare("SELECT data FROM control_follow_ups WHERE id=? AND state='queued'")
				.get(requestId);
			if (!row) continue;
			const item: ControlFollowUp = { ...JSON.parse(String(row.data)), sessionId, state: "running" };
			this.db
				.prepare("UPDATE control_follow_ups SET session_id=?,state='running',data=?,admitted_at=? WHERE id=?")
				.run(sessionId, JSON.stringify(item), recoveredOnly ? item.createdAt : Date.now(), requestId);
		}
	}
	observe(event: WatchObservation): ControlFollowUp[] {
		if (event.event !== "chat.settled" && event.event !== "chat.failed") return [];
		const rows = this.db
			.prepare("SELECT data FROM control_follow_ups WHERE session_id=? AND state='running' AND admitted_at<=?")
			.all(event.source, event.at);
		return rows.map((row) => {
			const item: ControlFollowUp = { ...JSON.parse(String(row.data)), state: "result" };
			this.db
				.prepare("UPDATE control_follow_ups SET state='result',data=? WHERE id=?")
				.run(JSON.stringify(item), item.requestId);
			return item;
		});
	}
	hasRunning(): boolean {
		return !!this.db.prepare("SELECT 1 FROM control_follow_ups WHERE state='running' LIMIT 1").get();
	}
	remove(requestId: string, onlyQueued = false): void {
		this.db
			.prepare(`DELETE FROM control_follow_ups WHERE id=?${onlyQueued ? " AND state='queued'" : ""}`)
			.run(requestId);
	}
	active(requestId: string): boolean {
		return !!this.db.prepare("SELECT 1 FROM control_follow_ups WHERE id=?").get(requestId);
	}
	removeSession(sessionId: string): void {
		// A frozen delivery may already have been admitted. Keep its retry identity and cutoff intact.
		const cutoff = Number(
			this.db.prepare("SELECT last_event_id FROM watch_delivery WHERE delivered_at IS NULL").get()?.last_event_id ??
				-1,
		);
		for (const row of this.db.prepare("SELECT id FROM control_follow_ups WHERE session_id=?").all(sessionId))
			this.db.prepare("DELETE FROM watch_pending WHERE watch_id=? AND event_id>?").run(`follow:${row.id}`, cutoff);
		this.db.prepare("DELETE FROM control_follow_ups WHERE session_id=?").run(sessionId);
	}
	need(item: ControlAuthorizationNeeded): void {
		if (Buffer.byteLength(JSON.stringify(item)) > 20_000) throw new Error("Authorization request too large");
		if (this.db.prepare("SELECT 1 FROM control_authorization_needed WHERE id=?").get(item.id)) return;
		if (Number(this.db.prepare("SELECT count(*) AS n FROM control_authorization_needed").get()!.n) >= 1000)
			throw new Error("Pending authorization limit reached");
		this.db.prepare("INSERT INTO control_authorization_needed VALUES (?,?)").run(item.id, JSON.stringify(item));
	}
	resolve(id: string): boolean {
		return Number(this.db.prepare("DELETE FROM control_authorization_needed WHERE id=?").run(id).changes) > 0;
	}
	private rows<T>(table: "control_follow_ups" | "control_authorization_needed"): T[] {
		const result: T[] = [];
		let bytes = 0;
		for (const row of this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid LIMIT 100`).all()) {
			const payload = String(row.data);
			bytes += Buffer.byteLength(payload);
			if (bytes > 24_000) break;
			result.push(JSON.parse(payload) as T);
		}
		return result;
	}
	dashboard() {
		return {
			followUps: this.rows<ControlFollowUp>("control_follow_ups"),
			followUpsTotal: Number(this.db.prepare("SELECT count(*) AS n FROM control_follow_ups").get()!.n),
			authorizationNeeded: this.rows<ControlAuthorizationNeeded>("control_authorization_needed"),
			authorizationNeededTotal: Number(
				this.db.prepare("SELECT count(*) AS n FROM control_authorization_needed").get()!.n,
			),
		};
	}
}
