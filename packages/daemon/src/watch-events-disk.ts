import type { DatabaseSync } from "node:sqlite";
import { NOTICE_HOURLY_CAP, NOTICE_WINDOW_MS, noticeDeadline, noticeInvolvesSession } from "./notice-dispatcher.ts";
import type { WatchNotice, WatchObservation, WatchTransition } from "./watch-delivery.ts";
import type { Watch } from "./watches.ts";

/** Called only on the SQLite worker. Match/consume/freeze are transactional. */
export class WatchEventsDisk {
	private readonly db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(`
			CREATE TABLE IF NOT EXISTS watch_observations (source TEXT PRIMARY KEY, version TEXT NOT NULL, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS watch_causes (session_id TEXT PRIMARY KEY, origin TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS watch_states (source TEXT PRIMARY KEY, state TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS watch_cursors (source TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS watch_control (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS watch_pending (
    watch_id TEXT PRIMARY KEY, event_id INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, data TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS watch_sequence (id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL);
   INSERT OR IGNORE INTO watch_sequence VALUES (1,0);
   CREATE TABLE IF NOT EXISTS watch_delivery (request_id TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL, data TEXT NOT NULL, delivered_at INTEGER);
   CREATE UNIQUE INDEX IF NOT EXISTS watch_one_frozen ON watch_delivery((1)) WHERE delivered_at IS NULL;
   CREATE TABLE IF NOT EXISTS watch_idle (id INTEGER PRIMARY KEY CHECK(id = 1), busy INTEGER NOT NULL, idle_at INTEGER NOT NULL);
   INSERT OR IGNORE INTO watch_idle VALUES(1,0,0);
  `);
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	observe(events: WatchObservation[], self?: string, inside = false): number {
		if (events.length > 128) throw new Error("Watch observation batch too large");
		self ??= this.control();
		const apply = () => {
			let matched = 0;
			const frozen = this.db.prepare("SELECT last_event_id FROM watch_delivery WHERE delivered_at IS NULL").get();
			const cutoff = Number(frozen?.last_event_id ?? -1);
			const consumed = new Set<string>();
			for (const event of events) {
				const key = `${event.event}:${event.source}`;
				const record = () =>
					this.db
						.prepare(
							"INSERT INTO watch_observations VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET version=excluded.version,at=excluded.at",
						)
						.run(key, event.version, Date.now());
				if (event.event.startsWith("chat.")) {
					const cause = this.db.prepare("SELECT origin FROM watch_causes WHERE session_id=?").get(event.source);
					if (cause) {
						consumed.add(event.source);
						if (cause.origin === self) {
							record();
							continue;
						}
					}
				}
				const chatSubjects = event.targets.filter((target) => target.kind === "chat").map((target) => target.id);
				if (
					noticeInvolvesSession(
						self,
						event.originSessionId,
						...(event.event.startsWith("chat.") ? [event.source] : []),
						...chatSubjects,
					)
				) {
					record();
					continue;
				}
				const now = Date.now();
				const watches = new Map<string, Watch>();
				for (const target of event.targets) {
					const rows = this.db
						.prepare(
							"SELECT data FROM watches WHERE event = ? AND target_kind = ? AND target_id = ? AND target_scope = ? AND (expires_at IS NULL OR expires_at > ?)",
						)
						.all(event.event, target.kind, target.id, target.missionId ?? "", now);
					for (const row of rows) {
						const watch: Watch = JSON.parse(String(row.data));
						watches.set(watch.id, watch);
					}
				}
				if (!watches.size) continue;
				const previous = this.db.prepare("SELECT version FROM watch_observations WHERE source = ?").get(key);
				if (previous?.version === event.version) continue;
				this.db
					.prepare(
						"INSERT INTO watch_observations VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET version=excluded.version, at=excluded.at",
					)
					.run(key, event.version, now);
				for (const watch of watches.values()) {
					if (watch.createdAt > event.at || (watch.filter?.outcome && watch.filter.outcome !== event.outcome))
						continue;
					const old = this.db.prepare("SELECT event_id, data FROM watch_pending WHERE watch_id = ?").get(watch.id);
					if (!old && Number(this.db.prepare("SELECT COUNT(*) AS n FROM watch_pending").get()!.n) >= 10000)
						throw new Error("Pending watch limit reached");
					const id = Number(
						this.db.prepare("UPDATE watch_sequence SET value=value+1 WHERE id=1 RETURNING value").get()!.value,
					);
					const prior = old && Number(old.event_id) > cutoff ? JSON.parse(String(old.data)) : undefined;
					const item = {
						watchId: watch.id,
						note: watch.note,
						event: event.event,
						text: event.text.slice(0, 1000),
						count: (prior?.count ?? 0) + 1,
					};
					this.db
						.prepare(
							"INSERT INTO watch_pending VALUES(?,?,?,?,?) ON CONFLICT(watch_id) DO UPDATE SET first_at=CASE WHEN watch_pending.event_id<=? THEN excluded.first_at ELSE watch_pending.first_at END,event_id=excluded.event_id,last_at=excluded.last_at,data=excluded.data",
						)
						.run(watch.id, id, event.at, event.at, JSON.stringify(item), cutoff);
					if (watch.mode === "once") this.db.prepare("DELETE FROM watches WHERE id=?").run(watch.id);
					matched++;
				}
			}
			for (const id of consumed) this.db.prepare("DELETE FROM watch_causes WHERE session_id=?").run(id);
			// Bound transition dedupe independently of subscription churn.
			this.db.exec(
				"DELETE FROM watch_observations WHERE source IN (SELECT source FROM watch_observations ORDER BY at DESC LIMIT -1 OFFSET 50000)",
			);
			return matched;
		};
		return inside ? apply() : this.transaction(apply);
	}
	control(): string | undefined {
		const row = this.db.prepare("SELECT session_id FROM watch_control WHERE id=1").get();
		return row ? String(row.session_id) : undefined;
	}
	setControl(id: string): void {
		this.db
			.prepare("INSERT INTO watch_control VALUES(1,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id")
			.run(id);
	}
	transition(input: WatchTransition, self?: string): number {
		return this.transaction(() => {
			const previous = this.db.prepare("SELECT state, revision FROM watch_states WHERE source=?").get(input.source);
			if (previous?.state === input.state) return 0;
			const revision = Number(previous?.revision ?? 0) + 1;
			this.db
				.prepare(
					"INSERT INTO watch_states VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET state=excluded.state,revision=excluded.revision,at=excluded.at",
				)
				.run(input.source, input.state, revision, Date.now());
			this.db.exec(
				"DELETE FROM watch_states WHERE source IN (SELECT source FROM watch_states ORDER BY at DESC LIMIT -1 OFFSET 50000)",
			);
			return previous && input.candidate
				? this.observe([{ ...input.candidate, version: String(revision) }], self, true)
				: 0;
		});
	}
	cursor(source: string): number {
		return Number(this.db.prepare("SELECT cursor FROM watch_cursors WHERE source=?").get(source)?.cursor ?? 0);
	}
	consume(source: string, events: WatchObservation[], self?: string): number {
		return this.transaction(() => {
			const cursor = this.cursor(source);
			const fresh = events.filter((event) => Number(event.version) > cursor);
			if (!fresh.length) return 0;
			const matched = this.observe(fresh, self, true);
			this.db
				.prepare("INSERT INTO watch_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor")
				.run(source, Math.max(...fresh.map((event) => Number(event.version))));
			return matched;
		});
	}
	attributeSessionRun(sessionId: string, origin: string): void {
		if (
			!this.db.prepare("SELECT 1 FROM watch_causes WHERE session_id=?").get(sessionId) &&
			Number(this.db.prepare("SELECT COUNT(*) AS n FROM watch_causes").get()!.n) >= 50000
		)
			throw new Error("Watch cause limit reached");
		this.db
			.prepare("INSERT INTO watch_causes VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET origin=excluded.origin")
			.run(sessionId, origin);
	}
	activity(busy: boolean, now: number): void {
		this.db
			.prepare("UPDATE watch_idle SET busy=?,idle_at=? WHERE id=1 AND busy<>?")
			.run(busy ? 1 : 0, now, busy ? 1 : 0);
	}
	deadline(now: number): number | undefined {
		const pending = this.db
			.prepare("SELECT MIN(first_at) AS first_at, MAX(last_at) AS last_at FROM watch_pending")
			.get()!;
		if (pending.first_at === null) return;
		const activity = this.db.prepare("SELECT * FROM watch_idle WHERE id=1").get()!;
		const capped = this.db
			.prepare(
				"SELECT delivered_at FROM watch_delivery WHERE delivered_at > ? ORDER BY delivered_at DESC LIMIT 1 OFFSET ?",
			)
			.get(now - NOTICE_WINDOW_MS, NOTICE_HOURLY_CAP - 1);
		const frozen = this.db.prepare("SELECT 1 FROM watch_delivery WHERE delivered_at IS NULL").get();
		return noticeDeadline(
			{
				firstAt: Number(pending.first_at),
				lastAt: Number(pending.last_at),
				idleAt: Number(activity.idle_at),
				busy: activity.busy === 1,
				retry: !!frozen,
				cappedAt: capped ? Number(capped.delivered_at) : undefined,
			},
			now,
		);
	}
	prepare(now: number): WatchNotice | undefined {
		return this.transaction(() => {
			this.db.prepare("DELETE FROM watch_delivery WHERE delivered_at<=?").run(now - NOTICE_WINDOW_MS);
			const at = this.deadline(now);
			if (at === undefined || at > now) return;
			const frozen = this.db.prepare("SELECT data FROM watch_delivery WHERE delivered_at IS NULL").get();
			if (frozen) return JSON.parse(String(frozen.data));
			const rows = this.db.prepare("SELECT event_id, data FROM watch_pending ORDER BY event_id LIMIT 100").all();
			if (!rows.length) return;
			const lastEventId = Number(rows.at(-1)!.event_id);
			const notice: WatchNotice = {
				requestId: `watch-notice:${lastEventId}`,
				lastEventId,
				items: rows.map((row) => JSON.parse(String(row.data))),
				overflow: Number(this.db.prepare("SELECT COUNT(*) AS n FROM watch_pending").get()!.n) - rows.length,
			};
			this.db
				.prepare("INSERT INTO watch_delivery VALUES(?,?,?,NULL)")
				.run(notice.requestId, lastEventId, JSON.stringify(notice));
			return notice;
		});
	}
	acknowledge(notice: WatchNotice, now: number): void {
		this.transaction(() => {
			const changed = this.db
				.prepare("UPDATE watch_delivery SET delivered_at=? WHERE request_id=? AND delivered_at IS NULL")
				.run(now, notice.requestId).changes;
			if (changed) this.db.prepare("DELETE FROM watch_pending WHERE event_id<=?").run(notice.lastEventId);
		});
	}
	pending(): WatchNotice | undefined {
		const row = this.db.prepare("SELECT data FROM watch_delivery WHERE delivered_at IS NULL").get();
		return row ? JSON.parse(String(row.data)) : undefined;
	}
}
