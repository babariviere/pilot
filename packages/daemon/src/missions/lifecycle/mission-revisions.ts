import { createHash, randomUUID } from "node:crypto";
import type { MissionRevisionDelta, MissionRevisionProposal } from "@pilot/protocol";
import { Conflict, NotFound } from "../../runtime/contracts/errors.ts";
import { canonicalJSON } from "../../transport/operations/operation-journal.ts";
import type { MissionDbPort } from "../mission-database.ts";

export const MISSION_REVISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_revision_proposals (
 id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(mission_id,operation_id)
);
CREATE INDEX IF NOT EXISTS mission_revision_latest ON mission_revision_proposals(mission_id);
`;

interface Port extends MissionDbPort {
	/** Refuses a proposal for a thread that is not open with a handoff. */
	assertTopic(id: string, topicId: string): void;
	source(id: string): unknown;
	assertPlanner(id: string, actor: { sessionId?: string }): void;
	validate(id: string, delta: MissionRevisionDelta): void;
	apply(id: string, proposal: MissionRevisionProposal, humanSource: string): void;
}
export const revisionDigest = (value: unknown): string =>
	createHash("sha256").update(canonicalJSON(value)).digest("hex");

/** A revision that only adds tasks changes nothing a working chat uses: no Pause, and task progress does not stale it. */
export function addsOnly(delta: MissionRevisionDelta): boolean {
	return (
		!!delta.newTasks?.length &&
		delta.goal === undefined &&
		delta.markdown === undefined &&
		!delta.tasks?.length &&
		!delta.decisions?.length &&
		!delta.corrections?.length
	);
}

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
	/** Exact lookup after an unknown proposal/preview reply. Never creates a replacement operation. */
	lookup(id: string, operationId: string): MissionRevisionProposal | null {
		const row = this.port.one(
			"SELECT record FROM mission_revision_proposals WHERE mission_id=? AND operation_id=?",
			id,
			operationId,
		);
		return row ? JSON.parse(String(row.record)) : null;
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
	/**
	 * The proposal to review next. Each thread keeps its own latest proposal, and Revisit (no thread) keeps one; a newer
	 * proposal replaces only the one of its own thread, and a confirmation ends only its own. One that still applies
	 * comes first, then the oldest. `waiting` counts the others. Stale proposals remain inspectable, not applicable.
	 */
	pending(id: string): { proposal: MissionRevisionProposal; current: boolean; waiting: number } | null {
		const latest = new Map<string, MissionRevisionProposal | undefined>();
		for (const row of this.port.all(
			"SELECT record FROM mission_revision_proposals WHERE mission_id=? ORDER BY rowid",
			id,
		)) {
			const proposal = JSON.parse(String(row.record)) as MissionRevisionProposal;
			latest.set(proposal.topicId ?? "", proposal.confirmation ? undefined : proposal);
		}
		const open = [...latest.values()]
			.filter((p): p is MissionRevisionProposal => !!p)
			.map((proposal) => ({ proposal, current: this.applies(id, proposal) }));
		const next = open.find((p) => p.current) ?? open[0];
		return next ? { ...next, waiting: open.length - 1 } : null;
	}
	/**
	 * Whether a proposal still applies to the mission as it is now. Any change stales a proposal that edits the mission.
	 * A proposal that only adds tasks needs only its dependencies, so task progress since does not stale it.
	 */
	private applies(id: string, proposal: MissionRevisionProposal): boolean {
		if (proposal.source === this.source(id)) return true;
		if (!addsOnly(proposal.delta)) return false;
		try {
			this.port.validate(id, proposal.delta);
			return true;
		} catch {
			return false;
		}
	}
	/** Explicit user re-preview after Pause. Never alters/reconfirms the original or admits a turn. */
	async repreview(
		id: string,
		proposalId: string,
		input: { operationId: string; source: string; digest: string },
	): Promise<MissionRevisionProposal> {
		if (
			!input ||
			typeof input !== "object" ||
			Object.keys(input).some((k) => !["operationId", "source", "digest"].includes(k))
		)
			throw new Error("Unknown re-preview field");
		const original = this.get(id, proposalId);
		if (input.digest !== original.digest) throw new Conflict("Saved revision digest changed");
		return this.save(
			id,
			{
				operationId: input.operationId,
				source: input.source,
				summary: original.summary,
				delta: original.delta,
				...(original.topicId ? { topicId: original.topicId } : {}),
			},
			{},
			{ id: original.id, digest: original.digest },
		);
	}
	async propose(
		id: string,
		input: { operationId: string; source: string; summary: string; delta: MissionRevisionDelta; topicId?: string },
		actor: { sessionId?: string },
	): Promise<MissionRevisionProposal> {
		return this.save(id, input, actor);
	}
	private async save(
		id: string,
		input: { operationId: string; source: string; summary: string; delta: MissionRevisionDelta; topicId?: string },
		actor: { sessionId?: string },
		repreviewOf?: { id: string; digest: string },
	): Promise<MissionRevisionProposal> {
		this.port.assertPlanner(id, actor);
		if (
			!input ||
			typeof input !== "object" ||
			Object.keys(input).some((key) => !["operationId", "source", "summary", "delta", "topicId"].includes(key))
		)
			throw new Error("Unknown revision request field");
		revisionText(input.operationId, 128);
		revisionText(input.summary, 1000);
		if (input.topicId !== undefined) revisionText(input.topicId, 128);
		if (Buffer.byteLength(JSON.stringify(input.delta) ?? "") > 64 * 1024) throw new Error("Revision exceeds 64 KiB");
		const request = structuredClone({
			...input,
			authorSessionId: actor.sessionId ?? null,
			...(repreviewOf ? { repreviewOf } : {}),
		});
		const digest = revisionDigest(request);
		const result = this.port.transaction(
			() => {
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
				if (repreviewOf && this.get(id, repreviewOf.id).confirmation)
					throw new Conflict("Confirmed revision is history, not a new proposal");
				if (input.source !== this.source(id)) throw new Conflict("Mission revision source changed");
				if (request.topicId !== undefined && !repreviewOf) this.port.assertTopic(id, request.topicId);
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
			},
			{ reconcile: true },
		);
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
		const result = this.port.transaction(
			() => {
				const proposal = this.get(id, proposalId);
				if (input.digest !== proposal.digest) throw new Conflict("Reviewed revision digest changed");
				if (proposal.confirmation) {
					if (proposal.confirmation.humanSource !== input.humanSource)
						throw new Conflict("Revision already confirmed differently");
					return proposal; // Historical receipt, never renewed authority or replay.
				}
				if (!this.applies(id, proposal))
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
			},
			{ reconcile: true },
		);
		await this.port.durable();
		this.port.changed(id);
		return result;
	}
}
