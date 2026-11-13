import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { MissionRevisionDelta, MissionRevisionProposal } from "../../protocol/src/mission-revision.ts";
import { Conflict, NotFound } from "./errors.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const MISSION_REVISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_revision_proposals (
 id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(mission_id,operation_id)
);
CREATE INDEX IF NOT EXISTS mission_revision_latest ON mission_revision_proposals(mission_id);
`;

interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
	source(id: string): unknown;
	assertPlanner(id: string, actor: { sessionId?: string }): void;
	validate(id: string, delta: MissionRevisionDelta): void;
	apply(id: string, proposal: MissionRevisionProposal, humanSource: string): void;
	changed(id: string): void;
}
export const revisionDigest = (value: unknown): string =>
	createHash("sha256").update(canonicalJSON(value)).digest("hex");

export function revisionText(value: unknown, limit: number): string {
	if (typeof value !== "string" || !value.trim() || Array.from(value).length > limit)
		throw new Error(`Revision text must contain 1 to ${limit} characters`);
	if (value !== value.trim()) throw new Error("Revision text must be trimmed before review");
	return value;
}

/** Saved proposals are inert. Only the trusted user route can confirm exact saved bytes. */
export class MissionRevisions {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	source(id: string): string {
		return revisionDigest(this.port.source(id));
	}
	get(id: string, proposalId: string): MissionRevisionProposal {
		const row = this.port.one(
			"SELECT record FROM mission_revision_proposals WHERE mission_id=? AND id=?",
			id,
			proposalId,
		);
		if (!row) throw new NotFound("Unknown mission revision");
		return JSON.parse(String(row.record));
	}
	latestConfirmed(id: string): { id: string; summary: string } | undefined {
		const row = this.port.one(
			"SELECT record FROM mission_revision_proposals WHERE mission_id=? AND json_extract(record,'$.confirmation.by')='user' ORDER BY rowid DESC LIMIT 1",
			id,
		);
		if (!row) return;
		const proposal = JSON.parse(String(row.record)) as MissionRevisionProposal;
		return { id: proposal.id, summary: proposal.summary };
	}
	async propose(
		id: string,
		input: { operationId: string; source: string; summary: string; delta: MissionRevisionDelta },
		actor: { sessionId?: string },
	): Promise<MissionRevisionProposal> {
		this.port.assertPlanner(id, actor);
		if (
			!input ||
			typeof input !== "object" ||
			Object.keys(input).some((key) => !["operationId", "source", "summary", "delta"].includes(key))
		)
			throw new Error("Unknown revision request field");
		revisionText(input.operationId, 128);
		revisionText(input.summary, 1000);
		if (Buffer.byteLength(JSON.stringify(input.delta) ?? "") > 64 * 1024) throw new Error("Revision exceeds 64 KiB");
		const request = structuredClone({ ...input, authorSessionId: actor.sessionId ?? null });
		const digest = revisionDigest(request);
		const result = this.port.transaction(() => {
			const prior = this.port.one(
				"SELECT record FROM mission_revision_proposals WHERE mission_id=? AND operation_id=?",
				id,
				input.operationId,
			);
			if (prior) {
				const proposal = JSON.parse(String(prior.record)) as MissionRevisionProposal;
				if (proposal.digest !== digest) throw new Conflict("Revision operationId has different bytes");
				return proposal;
			}
			if (input.source !== this.source(id)) throw new Conflict("Mission revision source changed");
			this.port.validate(id, request.delta);
			const proposal: MissionRevisionProposal = {
				version: 1,
				id: randomUUID(),
				missionId: id,
				...request,
				digest,
				createdAt: Date.now(),
			};
			this.port.run(
				"INSERT INTO mission_revision_proposals VALUES(?,?,?,?)",
				proposal.id,
				id,
				input.operationId,
				canonicalJSON(proposal),
			);
			return proposal;
		});
		await this.port.durable();
		return result;
	}
	async confirm(
		id: string,
		proposalId: string,
		input: { digest: string; humanSource: string },
	): Promise<MissionRevisionProposal> {
		if (
			!input ||
			typeof input !== "object" ||
			Object.keys(input).some((key) => !["digest", "humanSource"].includes(key))
		)
			throw new Error("Unknown confirmation field");
		revisionText(input.humanSource, 1000);
		const result = this.port.transaction(() => {
			const proposal = this.get(id, proposalId);
			if (input.digest !== proposal.digest) throw new Conflict("Reviewed revision digest changed");
			if (proposal.confirmation) {
				if (proposal.confirmation.humanSource !== input.humanSource)
					throw new Conflict("Revision already confirmed differently");
				return proposal; // Historical receipt, never renewed authority or replay.
			}
			if (proposal.source !== this.source(id))
				throw new Conflict("Mission revision source changed; review a new proposal");
			this.port.validate(id, proposal.delta);
			this.port.apply(id, proposal, input.humanSource);
			proposal.confirmation = { by: "user", at: Date.now(), humanSource: input.humanSource };
			this.port.run(
				"UPDATE mission_revision_proposals SET record=? WHERE id=?",
				canonicalJSON(proposal),
				proposal.id,
			);
			return proposal;
		});
		await this.port.durable();
		this.port.changed(id);
		return result;
	}
}
