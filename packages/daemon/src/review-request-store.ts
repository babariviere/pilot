/** Optional global requests share missions.sqlite with exact native feedback. */
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { NativeReviewComparison, ReviewDispositionTarget, ReviewRequestState } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { targetKey } from "./human-review-store.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export const REVIEW_REQUEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_requests (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 lineage TEXT NOT NULL, target_digest TEXT NOT NULL, session_id TEXT NOT NULL, record TEXT NOT NULL,
 UNIQUE(lineage,target_digest)
);
CREATE INDEX IF NOT EXISTS review_request_session ON review_requests(session_id,sequence);
CREATE INDEX IF NOT EXISTS review_request_target ON review_requests(target_digest,sequence);
CREATE TABLE IF NOT EXISTS review_request_history (
 request_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(request_id,revision)
);
CREATE TABLE IF NOT EXISTS review_request_operations (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL
);
`;
export type ReviewRequestActor =
	| { kind: "native-user" }
	| { kind: "coordinator"; sessionId: string; missionId: string };
export interface ReviewRequestRecord {
	requestId: string;
	sequence: number;
	revision: number;
	state: ReviewRequestState;
	actor: ReviewRequestActor;
	changedBy: ReviewRequestActor;
	operationId: string;
	target: ReviewDispositionTarget;
	comparison: NativeReviewComparison;
	lineage: string;
	title: string;
	reason: string;
	createdAt: number;
	updatedAt: number;
	replacesRequestId: string | null;
	replacesExpectedRevision: number | null;
	replacedByRequestId: string | null;
}
export interface ReviewRequestReceipt {
	operationId: string;
	actor: ReviewRequestActor;
	payloadHash: string;
	/** Original effect, never a claim that this is still the current state. */
	requestId: string;
	revision: number;
	state: ReviewRequestState;
	target: ReviewDispositionTarget;
}
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	all(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue>[];
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
}
const parse = <T>(row: Record<string, SQLInputValue> | undefined, field = "record"): T | undefined =>
	row ? JSON.parse(String(row[field])) : undefined;
export const requestLineage = (actor: ReviewRequestActor, t: ReviewDispositionTarget) =>
	payloadHash(
		canonicalJSON({
			actor,
			projectId: t.projectId,
			sessionId: t.sessionId,
			repositoryId: t.repositoryId,
			changeId: t.changeId,
			layer: t.layer,
		}),
	);

export class ReviewRequestStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	get(id: string): ReviewRequestRecord | undefined {
		return parse(this.port.one("SELECT record FROM review_requests WHERE id=?", id));
	}
	operation(id: string) {
		const row = this.port.one("SELECT actor,payload,receipt FROM review_request_operations WHERE id=?", id);
		return row
			? {
					actor: JSON.parse(String(row.actor)) as ReviewRequestActor,
					payload: String(row.payload),
					receipt: JSON.parse(String(row.receipt)) as ReviewRequestReceipt,
				}
			: undefined;
	}
	lookup(id: string, actor: ReviewRequestActor, payload?: string) {
		const op = this.operation(id);
		if (op && (canonicalJSON(op.actor) !== canonicalJSON(actor) || (payload !== undefined && payload !== op.payload)))
			throw new Conflict("Review request operation actor or payload changed");
		return op?.receipt;
	}
	private save(record: ReviewRequestRecord) {
		const json = JSON.stringify(record);
		this.port.run("UPDATE review_requests SET record=? WHERE id=?", json, record.requestId);
		this.port.run(
			"INSERT INTO review_request_history(request_id,revision,record) VALUES(?,?,?)",
			record.requestId,
			record.revision,
			json,
		);
	}
	private receipt(id: string, actor: ReviewRequestActor, payload: string, record: ReviewRequestRecord) {
		const receipt: ReviewRequestReceipt = {
			operationId: id,
			actor,
			payloadHash: payloadHash(payload),
			requestId: record.requestId,
			revision: record.revision,
			state: record.state,
			target: record.target,
		};
		this.port.run(
			"INSERT INTO review_request_operations(id,actor,payload,receipt) VALUES(?,?,?,?)",
			id,
			canonicalJSON(actor),
			payload,
			JSON.stringify(receipt),
		);
		return receipt;
	}
	suggest(
		id: string,
		actor: ReviewRequestActor,
		payload: string,
		input: {
			target: ReviewDispositionTarget;
			comparison: NativeReviewComparison;
			title: string;
			reason: string;
			replacesRequestId: string | null;
			replacesExpectedRevision: number | null;
		},
		revalidate: () => void,
	): ReviewRequestReceipt {
		return this.port.transaction(() => {
			revalidate();
			const exact = this.lookup(id, actor, payload);
			if (exact) return exact;
			const lineage = requestLineage(actor, input.target),
				key = targetKey(input.target);
			const duplicate = parse<ReviewRequestRecord>(
				this.port.one("SELECT record FROM review_requests WHERE lineage=? AND target_digest=?", lineage, key),
			);
			if (duplicate) {
				const original = this.history(duplicate.requestId, 0)[0];
				if (
					!original ||
					original.title !== input.title ||
					original.reason !== input.reason ||
					original.replacesRequestId !== input.replacesRequestId ||
					original.replacesExpectedRevision !== input.replacesExpectedRevision
				)
					throw new Conflict("Exact suggestion exists with different content");
				// Even another operation cannot revive a withdrawn/replaced suggestion.
				return this.receipt(id, actor, payload, duplicate);
			}
			const prior = input.replacesRequestId ? this.get(input.replacesRequestId) : undefined;
			if (
				input.replacesRequestId &&
				(!prior ||
					prior.lineage !== lineage ||
					prior.revision !== input.replacesExpectedRevision ||
					!["pending", "snoozed"].includes(prior.state))
			)
				throw new Conflict("Replacement lineage, revision or state changed");
			const now = Date.now(),
				requestId = randomUUID();
			this.port.run(
				"INSERT INTO review_requests(id,lineage,target_digest,session_id,record) VALUES(?,?,?,?,?)",
				requestId,
				lineage,
				key,
				input.target.sessionId,
				"{}",
			);
			const sequence = Number(this.port.one("SELECT sequence FROM review_requests WHERE id=?", requestId)!.sequence);
			const record: ReviewRequestRecord = {
				requestId,
				sequence,
				revision: 1,
				state: "pending",
				actor,
				changedBy: actor,
				operationId: id,
				target: input.target,
				comparison: input.comparison,
				lineage,
				title: input.title,
				reason: input.reason,
				createdAt: now,
				updatedAt: now,
				replacesRequestId: input.replacesRequestId,
				replacesExpectedRevision: input.replacesExpectedRevision,
				replacedByRequestId: null,
			};
			if (prior)
				this.save({
					...prior,
					revision: prior.revision + 1,
					state: "replaced",
					changedBy: actor,
					operationId: id,
					updatedAt: now,
					replacedByRequestId: requestId,
				});
			this.save(record);
			return this.receipt(id, actor, payload, record);
		});
	}
	transition(
		id: string,
		actor: ReviewRequestActor,
		payload: string,
		requestId: string,
		expectedRevision: number,
		state: ReviewRequestState,
		reason: string,
		revalidate: () => void,
	) {
		return this.port.transaction(() => {
			revalidate();
			const exact = this.lookup(id, actor, payload);
			if (exact) return exact;
			const prior = this.get(requestId);
			if (!prior || prior.revision !== expectedRevision) throw new Conflict("Review request revision changed");
			if (
				!["pending", "snoozed"].includes(prior.state) ||
				state === prior.state ||
				(state === "pending" && prior.state !== "snoozed")
			)
				throw new Conflict("Unsupported request transition");
			if (
				actor.kind === "coordinator" &&
				(state !== "retired" || canonicalJSON(prior.actor) !== canonicalJSON(actor))
			)
				throw new Conflict("Only the original coordinator may retire its optional suggestion");
			if (actor.kind === "native-user" && !["withdrawn", "snoozed", "pending"].includes(state))
				throw new Conflict("Unsupported native request action");
			const next = {
				...prior,
				revision: prior.revision + 1,
				state,
				reason,
				changedBy: actor,
				operationId: id,
				updatedAt: Date.now(),
			};
			this.save(next);
			return this.receipt(id, actor, payload, next);
		});
	}
	page(after: number, sessionId?: string) {
		const rows = this.port.all(
			`SELECT record FROM review_requests WHERE sequence>?${sessionId === undefined ? "" : " AND session_id=?"} ORDER BY sequence LIMIT 21`,
			after,
			...(sessionId === undefined ? [] : [sessionId]),
		);
		const records = rows.slice(0, 20).map((r) => parse<ReviewRequestRecord>(r)!);
		return { records, next: rows.length > 20 ? records.at(-1)!.sequence : null };
	}
	history(id: string, after: number) {
		return this.port
			.all(
				"SELECT record FROM review_request_history WHERE request_id=? AND revision>? ORDER BY revision LIMIT 20",
				id,
				after,
			)
			.map((r) => parse<ReviewRequestRecord>(r)!);
	}
	/** Exact comparison attention only, including terminal requests. Never changes or resumes them. */
	forTarget(target: ReviewDispositionTarget) {
		const records = this.port
			.all("SELECT record FROM review_requests WHERE target_digest=? ORDER BY sequence LIMIT 101", targetKey(target))
			.map((r) => parse<ReviewRequestRecord>(r)!);
		return {
			records: records.slice(0, 100).map((r) => ({
				requestId: r.requestId,
				revision: r.revision,
				state: r.state,
				operationId: r.operationId,
				updatedAt: r.updatedAt,
			})),
			complete: records.length <= 100,
		};
	}
	requirement(target: ReviewDispositionTarget): {
		identity: string;
		state: "requested" | "not_requested" | "withdrawn" | "unknown";
	} {
		const rows = this.port.all(
			"SELECT record FROM review_requests WHERE target_digest=? ORDER BY sequence LIMIT 101",
			targetKey(target),
		);
		const records = rows.map((r) => parse<ReviewRequestRecord>(r)!);
		return {
			identity: payloadHash(
				canonicalJSON({
					target: targetKey(target),
					requests: records.map((r) => [r.requestId, r.revision, r.state]),
				}),
			),
			state:
				records.length > 100
					? "unknown"
					: records.some((r) => ["pending", "snoozed"].includes(r.state))
						? "requested"
						: records.length
							? "withdrawn"
							: "not_requested",
		};
	}
	durable() {
		return this.port.durable();
	}
}
