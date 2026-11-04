/** Bounded, host-owned review receipts. Model checkpoints never drive source progress. */
import { createHash } from "node:crypto";
import type {
	DiagnosticContextResponse,
	DiagnosticHistoryPage,
	InsightsCheckpoint,
	InsightsHistoryRequest,
	InsightsReviewDispatch,
	InsightsReviewRecord,
	InsightsReviewRun,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { InsightsAdmission } from "./insights-admission.ts";
import type { InsightsDb } from "./insights-backlog.ts";

export const INSIGHTS_REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_runs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, run_id TEXT NOT NULL, binding TEXT NOT NULL, request TEXT NOT NULL,
 state TEXT NOT NULL, detail TEXT NOT NULL, packet TEXT, report_key TEXT,
 UNIQUE(session_id,run_id)
);
CREATE INDEX IF NOT EXISTS insights_runs_scope ON insights_runs(session_id,seq);
CREATE TABLE IF NOT EXISTS insights_inventory (
 scope TEXT PRIMARY KEY, after_id TEXT
);
CREATE TABLE IF NOT EXISTS insights_sources (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session_id TEXT NOT NULL,
 project_id TEXT, position TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0,
 UNIQUE(scope,session_id)
);
CREATE INDEX IF NOT EXISTS insights_sources_queue ON insights_sources(scope,reviewed,seq);
CREATE TABLE IF NOT EXISTS insights_patterns (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 pattern TEXT NOT NULL, finding_key TEXT NOT NULL, PRIMARY KEY(mission_id,pattern)
);
CREATE TABLE IF NOT EXISTS insights_review_reads (
 run_seq INTEGER NOT NULL REFERENCES insights_runs(seq) ON DELETE CASCADE,
 cursor INTEGER NOT NULL, PRIMARY KEY(run_seq,cursor)
);
`;

type Position = {
	stream: string | null;
	before: number | null;
	anchor: { id: number; hash: string } | null;
};
type Source = { sessionId: string; projectId: string | null; position: Position };
type Packet = {
	pages: Array<{ sessionId: string; projectId: string | null; receipt: DiagnosticContextResponse }>;
	updates: Source[];
	inventoryAfter: string | null;
	checkpoints: InsightsCheckpoint[];
	gaps: string[];
};
type Read = (request: InsightsHistoryRequest) => Promise<DiagnosticContextResponse>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = (v: unknown): v is string =>
	typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(v);
const fresh = (): Position => ({ stream: null, before: null, anchor: null });
const active = (s: string) => ["preparing", "ready", "sent"].includes(s);
function validate(request: InsightsReviewDispatch): void {
	if (
		!request ||
		Object.keys(request).sort().join(",") !== "bounds,runId,windowEnd,windowStart" ||
		!uuid(request.runId) ||
		![request.windowStart, request.windowEnd].every(
			(s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT/u.test(s) && Number.isFinite(Date.parse(s)),
		) ||
		![request.windowStart, request.windowEnd].every(
			(s) => s.length <= 40 && /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/u.test(s),
		) ||
		Date.parse(request.windowStart) > Date.parse(request.windowEnd) ||
		!request.bounds ||
		Object.keys(request.bounds).sort().join(",") !== "entriesPerPage,historyPages,inventoryPages" ||
		!Object.values(request.bounds).every((v) => Number.isSafeInteger(v) && v >= 1) ||
		request.bounds.inventoryPages > 4 ||
		request.bounds.historyPages < 2 ||
		request.bounds.historyPages > 8 ||
		request.bounds.entriesPerPage > 20
	)
		throw new Conflict("Invalid bounded review dispatch");
}

export class InsightsReviews {
	private readonly db: InsightsDb;
	private readonly listeners = new Set<() => void>();
	constructor(db: InsightsDb) {
		this.db = db;
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Notify only after the corresponding transaction is durable. Listeners do passive lookups. */
	changed(): void {
		for (const listener of this.listeners) listener();
	}
	private scope(admission: InsightsAdmission): string {
		admission.revalidate();
		this.db.validateMission(admission.binding.missionId, admission.binding.projectId);
		return hash(admission.binding);
	}
	/** Startup only, before admitting dispatch. A saved placement is never automatically replayed. */
	recover(): void {
		this.db.run(
			"UPDATE insights_runs SET state='interrupted',detail='Daemon restarted; input/report completion unknown. Start a distinct run, never replay.' WHERE state IN ('preparing','ready','sent')",
		);
	}
	private row(sessionId: string, runId: string) {
		return this.db.one("SELECT * FROM insights_runs WHERE session_id=? AND run_id=?", sessionId, runId);
	}
	private public(row: NonNullable<ReturnType<InsightsReviews["row"]>>): InsightsReviewRun {
		const request = JSON.parse(row.request as string) as InsightsReviewDispatch;
		return {
			runId: request.runId,
			state: row.state as InsightsReviewRun["state"],
			windowStart: request.windowStart,
			windowEnd: request.windowEnd,
			reportKey: row.report_key as string | null,
			detail: row.detail as string,
		};
	}
	async status(admission: InsightsAdmission, runId: string): Promise<InsightsReviewRun | null> {
		const scope = this.scope(admission);
		const row = this.row(admission.binding.reportSessionId, runId);
		if (row && row.binding !== scope) throw new Conflict("Review binding changed");
		await this.db.durable();
		this.scope(admission);
		return row ? this.public(row) : null;
	}
	/** Synchronous reservation closes overlap before the first await. Existing IDs are lookup only. */
	async reserve(admission: InsightsAdmission, request: InsightsReviewDispatch): Promise<boolean> {
		validate(request);
		const inserted = this.db.transaction(() => {
			const scope = this.scope(admission);
			const old = this.row(admission.binding.reportSessionId, request.runId);
			if (old) {
				if (old.binding !== scope || old.request !== JSON.stringify(request))
					throw new Conflict("Review run identity changed");
				return false;
			}
			if (
				this.db.one(
					"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent')",
					admission.binding.reportSessionId,
				)
			)
				throw new Conflict("A review is already active");
			this.db.run(
				"INSERT INTO insights_runs(mission_id,session_id,run_id,binding,request,state,detail) VALUES (?,?,?,?,?,'preparing','Reserved; no report yet')",
				admission.binding.missionId,
				admission.binding.reportSessionId,
				request.runId,
				scope,
				JSON.stringify(request),
			);
			return true;
		});
		await this.db.durable();
		this.scope(admission);
		return inserted;
	}
	/** Stop/revocation/shutdown fence synchronously, then wait for durable terminal state. */
	async interrupt(
		sessionId: string,
		state: "cancelled" | "interrupted" | "unknown",
		detail: string,
		runId?: string,
	): Promise<void> {
		this.db.run(
			"UPDATE insights_runs SET state=?,detail=? WHERE session_id=? AND state IN ('preparing','ready','sent') AND (? IS NULL OR run_id=?)",
			state,
			detail,
			sessionId,
			runId ?? null,
			runId ?? null,
		);
		await this.db.durable();
		this.changed();
	}
	interruptAll(): Promise<void> {
		this.recover();
		return this.db.durable();
	}
	/** An explicit normalized target/mechanism label deduplicates even when a new UUID is proposed.
	 * Semantic equivalence remains a review judgement, never a host-certified inference.
	 */
	pattern(admission: InsightsAdmission, key: string, pattern?: string): void {
		this.scope(admission);
		if (!pattern) {
			if (
				this.db.one(
					"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent')",
					admission.binding.reportSessionId,
				)
			)
				throw new Conflict(
					"Review findings require a stable target/mechanism patternKey; inspect prior findings first",
				);
			return;
		}
		const mission = admission.binding.missionId;
		const old = this.db.one(
			"SELECT finding_key FROM insights_patterns WHERE mission_id=? AND pattern=?",
			mission,
			pattern,
		);
		if (old && old.finding_key !== key)
			throw new Conflict(`Recurring pattern already tracked by ${old.finding_key}; get and amend it`);
		const assigned = this.db.one(
			"SELECT pattern FROM insights_patterns WHERE mission_id=? AND finding_key=?",
			mission,
			key,
		);
		if (assigned && assigned.pattern !== pattern) throw new Conflict("Finding pattern identity is immutable");
		this.db.run(
			"INSERT OR IGNORE INTO insights_patterns(mission_id,pattern,finding_key) VALUES (?,?,?)",
			mission,
			pattern,
			key,
		);
	}
	assertActive(admission: InsightsAdmission, runId: string): void {
		const scope = this.scope(admission);
		const row = this.row(admission.binding.reportSessionId, runId);
		if (!row || row.binding !== scope || !active(String(row.state)))
			throw new Conflict("Review is terminal or unavailable; never replay");
	}
	hasActive(admission: InsightsAdmission): boolean {
		this.scope(admission);
		return !!this.db.one(
			"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent')",
			admission.binding.reportSessionId,
		);
	}
	async sent(admission: InsightsAdmission, runId: string): Promise<void> {
		if ((await this.status(admission, runId))?.state === "partial") return;
		this.assertActive(admission, runId);
		this.db.run(
			"UPDATE insights_runs SET state='sent',detail='Input placed; not report completion' WHERE session_id=? AND run_id=?",
			admission.binding.reportSessionId,
			runId,
		);
		await this.db.durable();
		this.assertActive(admission, runId);
		this.changed();
	}
	/** Prefetch a bounded packet without waking source workers. Positions commit only with the report. */
	async prepare(admission: InsightsAdmission, request: InsightsReviewDispatch, read: Read): Promise<void> {
		this.assertActive(admission, request.runId);
		const scope = this.scope(admission);
		const packet: Packet = {
			pages: [],
			updates: [],
			inventoryAfter: null,
			checkpoints: [],
			gaps: [
				"Bounded local sample, not comprehensive coverage. Reader has no since/until filter; requested dates are review context, not certified source coverage.",
				"Artifact source/rendering, attachments and private reasoning were not inspected. Repository/guardrail state and monetary baselines are unverified unless supported by admitted evidence.",
				"Inventory is mutable, not an atomic snapshot. New/deleted/reordered chats and unread/truncated content may remain; no absence claim is justified.",
			],
		};
		let after =
			(this.db.one("SELECT after_id FROM insights_inventory WHERE scope=?", scope)?.after_id as string | null) ??
			null;
		const discovered: Source[] = [];
		for (let n = 0; n < request.bounds.inventoryPages; n++) {
			this.assertActive(admission, request.runId);
			const response = await read({ action: "chats", ...(after ? { after } : {}), limit: 4 });
			this.assertActive(admission, request.runId);
			if (!this.validEnvelope(admission, response) || response.status !== "available" || response.page.truncated) {
				packet.gaps.push("Inventory unavailable/partial; continuation retained, or reset if its chat was deleted.");
				if (response.status === "missing") after = null;
				break;
			}
			const data = response.data as { chats?: Array<{ id: string; projectId?: string }> } | undefined;
			if (
				!Array.isArray(data?.chats) ||
				data.chats.length > 20 ||
				data.chats.some((c) => !uuid(c.id)) ||
				(response.page.more && (!uuid(response.page.after) || response.page.after === after))
			) {
				throw new Conflict("Invalid inventory reader receipt");
			}
			for (const c of data.chats)
				if (c.id !== admission.binding.reportSessionId)
					discovered.push({
						sessionId: c.id,
						projectId: typeof c.projectId === "string" ? c.projectId : null,
						position: fresh(),
					});
			after = response.page.more ? response.page.after! : null;
			if (!response.page.more) break;
		}
		packet.inventoryAfter = after;
		if (after)
			packet.gaps.push(
				"Inventory has further pages; its continuation is durable, not discarded at the weekly boundary.",
			);
		// Queue inventory immediately, but do not consume positions before a report is saved.
		this.db.transaction(() => {
			this.assertActive(admission, request.runId);
			for (const s of discovered)
				this.db.run(
					"INSERT INTO insights_sources(scope,session_id,project_id,position) VALUES (?,?,?,?) ON CONFLICT(scope,session_id) DO UPDATE SET project_id=excluded.project_id",
					scope,
					s.sessionId,
					s.projectId,
					JSON.stringify(s.position),
				);
		});
		const sources = this.db.all(
			"SELECT session_id,project_id,position FROM insights_sources WHERE scope=? ORDER BY reviewed,seq LIMIT ?",
			scope,
			request.bounds.historyPages,
		);
		let remaining = request.bounds.historyPages;
		for (const row of sources) {
			if (!remaining) break;
			this.assertActive(admission, request.runId);
			const source: Source = {
				sessionId: String(row.session_id),
				projectId: row.project_id as string | null,
				position: JSON.parse(row.position as string),
			};
			let position = source.position;
			// Resume only after checking the prior boundary in the current stream. Counts against the page budget.
			const probe = position.before !== null && position.anchor !== null;
			let before = probe ? position.anchor!.id + 1 : (position.before ?? undefined);
			let response = await read({
				action: "history",
				sessionId: source.sessionId,
				...(before === undefined ? {} : { before }),
				limit: probe ? 1 : Math.min(4, request.bounds.entriesPerPage),
			});
			remaining--;
			this.assertActive(admission, request.runId);
			let page = this.historyReceipt(admission, source.sessionId, response, before);
			packet.pages.push({ sessionId: source.sessionId, projectId: source.projectId, receipt: response });
			// Rotate unavailable sources too; an offline chat must not starve the queue.
			packet.updates.push({ ...source, position });
			if (!page) {
				packet.gaps.push(`Unavailable source ${source.sessionId}; position retained, not treated as empty.`);
				continue;
			}
			const stream = page.source.streamId ?? null;
			if (probe) {
				const anchor = page.entries.find((e) => e.entryId === position.anchor!.id);
				if (!stream) {
					packet.gaps.push(
						`Unknown stream ${source.sessionId}; unfinished position retained, no continuity claimed.`,
					);
				} else if (stream !== position.stream || !anchor || hash(anchor) !== position.anchor!.hash) {
					position = fresh();
					packet.gaps.push(
						`Changed/unknown stream or boundary ${source.sessionId}; restart from newest, no cursor continuity claimed.`,
					);
				} else if (remaining) {
					before = position.before!;
					response = await read({
						action: "history",
						sessionId: source.sessionId,
						before,
						limit: Math.min(4, request.bounds.entriesPerPage),
					});
					remaining--;
					this.assertActive(admission, request.runId);
					page = this.historyReceipt(admission, source.sessionId, response, before);
					packet.pages.push({ sessionId: source.sessionId, projectId: source.projectId, receipt: response });
					if (page && page.source.streamId === stream) position = this.nextPosition(page, stream, position);
					else packet.gaps.push(`Unavailable/changed continuation ${source.sessionId}; position retained.`);
				} else
					packet.gaps.push(
						`Boundary-only probe ${source.sessionId}; continuation retained. Use at least two history pages to advance anchored sources.`,
					);
			} else if (stream && position.stream && stream !== position.stream) {
				position = fresh();
				packet.gaps.push(
					`Changed stream ${source.sessionId}; restart newest on a later run, no continuity claimed.`,
				);
			} else {
				position = this.nextPosition(page, stream, position);
			}
			packet.updates[packet.updates.length - 1] = { ...source, position };
			packet.checkpoints.push({
				sessionId: source.sessionId,
				streamId: stream,
				before: position.before,
				after: null,
				throughEntry: page?.entries.at(-1)?.entryId ?? null,
				coverage: "partial",
				gaps: ["Reader receipt only; not comprehensive review or storage-incarnation proof."],
			});
			if (response.page.truncated || page?.pagination.truncatedEntries)
				packet.gaps.push(`Truncated source ${source.sessionId}; omitted content remains unreviewed.`);
		}
		this.db.transaction(() => {
			this.assertActive(admission, request.runId);
			// A single packet is intentionally bounded, even for large excerpt entries.
			if (Buffer.byteLength(JSON.stringify(packet)) > 640 * 1024) throw new Conflict("Review packet exceeds bound");
			this.db.run(
				"UPDATE insights_runs SET state='ready',packet=?,detail='Evidence prepared; report not saved' WHERE session_id=? AND run_id=?",
				JSON.stringify(packet),
				admission.binding.reportSessionId,
				request.runId,
			);
		});
		await this.db.durable();
		this.assertActive(admission, request.runId);
	}
	private nextPosition(page: DiagnosticHistoryPage, stream: string | null, prior: Position): Position {
		// Unknown identity never licenses discarding an unfinished cursor. Empty scan-only pages do advance.
		if (!stream) return prior;
		const anchor = page.entries[0];
		return page.pagination.more && page.pagination.nextBefore !== undefined
			? {
					stream,
					before: page.pagination.nextBefore,
					anchor: anchor ? { id: anchor.entryId, hash: hash(anchor) } : null,
				}
			: fresh();
	}
	private validEnvelope(admission: InsightsAdmission, response: DiagnosticContextResponse): boolean {
		return (
			response?.schemaVersion === 1 &&
			hash(response.host) === hash(admission.binding.host) &&
			Number.isFinite(Date.parse(response.collectedAt)) &&
			response.page?.scanned >= 0 &&
			response.page.scanned <= 200 &&
			response.page.maxBytes === 65536
		);
	}
	private historyReceipt(
		admission: InsightsAdmission,
		id: string,
		response: DiagnosticContextResponse,
		before?: number,
	): DiagnosticHistoryPage | null {
		if (!this.validEnvelope(admission, response)) throw new Conflict("Invalid history envelope");
		if (response.status !== "available" || response.page.truncated) return null;
		const p = response.data as unknown as DiagnosticHistoryPage;
		if (
			p?.schemaVersion !== 1 ||
			p.target?.sessionId !== id ||
			p.target.chatUrl !== `pilot://chat/${id}` ||
			hash(p.target.host) !== hash(admission.binding.host)
		)
			throw new Conflict("History receipt target mismatch");
		if (p.source?.availability !== "available") return null;
		if (
			!Array.isArray(p.entries) ||
			p.entries.length > 20 ||
			!p.pagination ||
			p.pagination.before !== before ||
			p.pagination.returned !== p.entries.length ||
			p.pagination.scannedEntries > 200 ||
			(p.pagination.more &&
				(!Number.isSafeInteger(p.pagination.nextBefore) ||
					p.pagination.nextBefore! < 1 ||
					p.pagination.nextBefore! >= (before ?? Number.MAX_SAFE_INTEGER)))
		)
			throw new Conflict("Invalid history continuation receipt");
		let previous = 0;
		for (const e of p.entries) {
			if (
				!Number.isSafeInteger(e.entryId) ||
				e.entryId <= previous ||
				e.entryId >= (before ?? Number.MAX_SAFE_INTEGER) ||
				e.ref !== `diagnostic-history:v1:${id}:${e.entryId}` ||
				typeof e.excerpt !== "string"
			)
				throw new Conflict("Invalid history entry receipt");
			previous = e.entryId;
		}
		return p;
	}
	private parts(packet: Packet) {
		return packet.pages.flatMap((p): unknown[] => {
			const history = p.receipt.data as unknown as DiagnosticHistoryPage | undefined;
			return history?.entries?.length
				? history.entries.map((entry) => ({
						...p,
						receipt: { ...p.receipt, data: { ...history, entries: [entry] } },
					}))
				: [p];
		});
	}
	/** One bounded excerpt per call. Access receipts do not certify semantic inspection or delivery. */
	context(admission: InsightsAdmission, cursor: number) {
		const scope = this.scope(admission);
		const row = this.db.one(
			"SELECT * FROM insights_runs WHERE session_id=? ORDER BY seq DESC LIMIT 1",
			admission.binding.reportSessionId,
		);
		if (!row || row.binding !== scope || !active(String(row.state)) || !row.packet)
			throw new Conflict("No prepared active review");
		const packet = JSON.parse(row.packet as string) as Packet;
		// One excerpt at a time keeps the outer backlog response below 64 KiB even at reader limits.
		const parts = this.parts(packet);
		if (cursor > parts.length) throw new Conflict("Invalid review context cursor");
		if (cursor < parts.length)
			this.db.run("INSERT OR IGNORE INTO insights_review_reads(run_seq,cursor) VALUES (?,?)", row.seq!, cursor);
		return {
			run: this.public(row),
			evidence: parts[cursor] ?? null,
			nextCursor: cursor + 1 < parts.length ? cursor + 1 : null,
			readerPages: packet.pages.length,
			excerptParts: parts.length,
			gaps: packet.gaps,
			previousReports: this.db.all(
				"SELECT key,revision,updated_at FROM insights_items WHERE mission_id=? AND kind='report' ORDER BY seq DESC LIMIT 5",
				admission.binding.missionId,
			),
			unresolvedRuns: this.db.one(
				"SELECT COUNT(*) AS count,MIN(json_extract(request,'$.windowStart')) AS earliestWindowStart FROM insights_runs WHERE session_id=? AND seq<? AND state!='partial'",
				admission.binding.reportSessionId,
				row.seq!,
			),
			pendingSources: this.db.one("SELECT COUNT(*) AS count FROM insights_sources WHERE scope=?", scope),
			limitations:
				"Excerpt parts split original reader receipts, pagination.returned refers to the original page. Page prior findings with list/get before proposing; not a change feed. No date filter, comprehensive coverage, artifact inspection or storage-incarnation proof. Old sweeps may defer newer activity. Prior interrupted windows remain unresolved.",
		};
	}
	/** Within the report transaction: derive coverage from receipts, never model checkpoint text. */
	finish(admission: InsightsAdmission, key: string, record: InsightsReviewRecord): InsightsReviewRecord {
		const row = this.row(admission.binding.reportSessionId, key);
		if (!row) {
			if (this.hasActive(admission)) throw new Conflict("Report key must match the active review run");
			return record; // Outside dispatched reviews, legacy model-authored reports remain claims only.
		}
		this.assertActive(admission, key);
		if (!row.packet || !["ready", "sent"].includes(String(row.state)))
			throw new Conflict("Review evidence not ready");
		const request = JSON.parse(row.request as string) as InsightsReviewDispatch;
		if (request.windowStart !== record.windowStart || request.windowEnd !== record.windowEnd)
			throw new Conflict("Report window does not match reserved run");
		const packet = JSON.parse(row.packet as string) as Packet;
		const reads = this.db.one("SELECT COUNT(*) AS count FROM insights_review_reads WHERE run_seq=?", row.seq!);
		if (Number(reads?.count) !== this.parts(packet).length)
			throw new Conflict(
				"Read all review_context pages before saving this report; access is not semantic review proof",
			);
		const scope = this.scope(admission);
		for (const s of packet.updates)
			this.db.run(
				"UPDATE insights_sources SET position=?,reviewed=? WHERE scope=? AND session_id=?",
				JSON.stringify(s.position),
				row.seq!,
				scope,
				s.sessionId,
			);
		this.db.run(
			"INSERT INTO insights_inventory(scope,after_id) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id",
			scope,
			packet.inventoryAfter,
		);
		this.db.run(
			"UPDATE insights_runs SET state='partial',report_key=?,detail='Bounded report persisted; not comprehensive coverage, approval, delivery or benefit proof' WHERE session_id=? AND run_id=?",
			key,
			admission.binding.reportSessionId,
			key,
		);
		return {
			...record,
			status: "partial",
			checkpoints: packet.checkpoints,
			gaps: [...packet.gaps, ...record.gaps].slice(0, 20),
			markdown: `${record.markdown}\n\n### Coverage limits (host)\n${packet.gaps.map((g) => `- ${g}`).join("\n")}\n- Previous unfinished windows remain unresolved; saved reports do not prove coverage. Fixes require separate approval and implementation.`,
		};
	}
}
